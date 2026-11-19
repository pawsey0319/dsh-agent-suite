/**
 * dsh-judge —— R8 的 L1 验收判别层（P2.5a–c 的最小可运行实现）。
 *
 * 职责边界（见 docs/PRD.md §5.9）：
 *   - 只读核验 + 结构化裁决 + 整改单；不授权、不改 DoD、不直接面对用户。
 *   - 无 contract 不得 verified；确定性检查失败不烧 LLM token。
 *
 * 数据面（全部落在 ~/.dsh/agent-bridge/verify/ 下）：
 *   <runId>/contract.json    任务契约（一旦签发不可变）
 *   <runId>/verdict.json     最近一次裁决
 *   <runId>/history.jsonl    每次裁决追加一行（审计）
 *   <runId>/rounds.json      返工轮次计数
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, statSync, renameSync, unlinkSync } from 'node:fs'
import { join, dirname, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

/** 按「码点」截断，绝不在代理对中间砍断（emoji 安全）。
 *  数组原样按元素切；其它值转字符串后按 Array.from 切。
 *  审计项 E-02/F-03：`str.slice(0,N)` 可能产生孤立代理 → JSON/UTF-8 往返出现 U+FFFD。 */
function uslice(value, count) {
  if (Array.isArray(value)) return value.slice(0, count)
  const text = value === null || value === undefined ? '' : String(value)
  const chars = Array.from(text)
  return chars.length > count ? chars.slice(0, count).join('') : text
}


export const name = 'dsh-judge'
export const inject = ['webServer']

const ROOT = join(homedir(), '.dsh', 'agent-bridge')
const VERIFY = join(ROOT, 'verify')
const CONFIG = join(ROOT, 'judge.json')
const PREFIXES = ['/dsh-judge', '/dsh-judge-b', '/dsh-judge-c']

const DEFAULTS = {
  autonomy: 'L2',          // L0 关 / L1 只建议 / L2 自动返工 / L3 自动返工+主动推进
  maxRounds: 2,            // 默认最多打回 2 轮
  driftThreshold: 0.4,
  judge: null,             // {protocol:'openai'|'anthropic', baseUrl, model, apiKeyEnv}
}

function ensureDir(p) { mkdirSync(p, { recursive: true }) }
function readJson(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch (error) {
    // 文件不存在是正常的；存在但读不动/解析不了必须留痕，否则配置写坏了
    // 会表现为「判别层莫名其妙不工作」（F-19）。
    if (existsSync(p)) log(`json unreadable ${p}: ${String(error && error.message ? error.message : error)}`)
    return fallback
  }
}
/** 原子写：先写同目录临时文件再 rename，避免半个 JSON 被下一次读进来（t22 / S-03）。 */
function writeJson(p, v) {
  ensureDir(dirname(p))
  const tmp = `${p}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, JSON.stringify(v, null, 2))
  try {
    renameSync(tmp, p)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    throw error
  }
}

/**
 * 读返工轮次（t22 / S-03）：rounds.json 读坏/被写坏时，用 history.jsonl 里最大的 round 兜底，
 * 并且结果一律夹到 [0, maxRounds]，保证「文件坏了也不会多打回一轮」。
 */
function readRounds(runId, maxRounds) {
  const paths = runPaths(runId)
  const raw = readJson(paths.rounds, null)
  let round = Number.isFinite(raw?.round) ? Number(raw.round) : null
  let recoveredFrom = null
  if (round === null) {
    let max = 0
    try {
      if (existsSync(paths.history)) {
        for (const line of readFileSync(paths.history, 'utf8').split('\n')) {
          const text = line.trim()
          if (text === '') continue
          try {
            const row = JSON.parse(text)
            const value = Number(row?.round)
            if (Number.isFinite(value) && value > max) max = value
          } catch { /* 坏行忽略 */ }
        }
      }
    } catch (error) {
      log(`rounds history unreadable ${paths.history}: ${String(error && error.message ? error.message : error)}`)
    }
    if (raw !== null || max > 0) {
      round = max
      recoveredFrom = 'history'
      log(`rounds recovered from history max=${max} run=${runId}`)
    } else {
      round = 0
    }
  }
  if (!Number.isFinite(round) || round < 0) round = 0
  if (Number.isFinite(maxRounds) && round > maxRounds) round = maxRounds
  return {
    agent: raw?.agent ?? null,
    cwd: raw?.cwd ?? null,
    lastRunId: raw?.lastRunId ?? null,
    round,
    recoveredFrom,
  }
}

function readConfig() {
  const raw = readJson(CONFIG, {})
  return { ...DEFAULTS, ...raw, judge: raw.judge ?? DEFAULTS.judge }
}

function runPaths(runId) {
  const dir = join(VERIFY, runId)
  return {
    dir,
    contract: join(dir, 'contract.json'),
    verdict: join(dir, 'verdict.json'),
    history: join(dir, 'history.jsonl'),
    rounds: join(dir, 'rounds.json'),
  }
}

/* ---------------------------------------------------------------- 确定性检查 */

function checkFileExists(spec) {
  const p = isAbsolute(spec.path) ? spec.path : resolve(spec.cwd ?? process.cwd(), spec.path)
  const ok = existsSync(p)
  if (!ok) return { ok, detail: `文件不存在：${p}` }
  const st = statSync(p)
  if (spec.minBytes && st.size < spec.minBytes) {
    return { ok: false, detail: `文件过小：${p} ${st.size}B < ${spec.minBytes}B` }
  }
  return { ok: true, detail: `${p} (${st.size}B)` }
}

function checkCommand(spec) {
  const cwd = spec.cwd ?? process.cwd()
  const argv = Array.isArray(spec.argv) ? spec.argv : null
  if (!argv || argv.length === 0) return { ok: false, detail: '检查项缺少 argv（不允许 shell 字符串，避免注入）' }
  const timeout = Math.min(Math.max(spec.timeoutMs ?? 120000, 1000), 600000)
  try {
    const out = execFileSync(argv[0], argv.slice(1), {
      cwd, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, detail: (out ?? '').slice(-400).trim() || 'ok' }
  } catch (err) {
    const tail = `${err.stdout ?? ''}${err.stderr ?? ''}`.slice(-400).trim()
    return { ok: false, detail: tail || String(err.message ?? err) }
  }
}

function checkMinLines(spec) {
  const p = isAbsolute(spec.path) ? spec.path : resolve(spec.cwd ?? process.cwd(), spec.path)
  if (!existsSync(p)) return { ok: false, detail: `文件不存在：${p}` }
  const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').length
  const ok = lines >= (spec.minLines ?? 1)
  return { ok, detail: `${p} 非空行 ${lines} / 要求 ${spec.minLines}` }
}

function runDeterministic(contract) {
  const checks = Array.isArray(contract.checks) ? contract.checks : []
  const results = checks.map((c) => {
    const base = { type: c.type, label: c.label ?? c.type }
    // 契约里的 cwd 是「这次任务的工作目录」：检查项没写 cwd 时必须继承它，
    // 否则相对路径会落到宿主进程的 cwd 上，把正确的产物判成缺失（F-05）。
    if (c.cwd === undefined && typeof contract.cwd === 'string' && contract.cwd !== '') {
      c = { ...c, cwd: contract.cwd }
    }
    try {
      if (c.type === 'file-exists') return { ...base, ...checkFileExists(c) }
      if (c.type === 'command') return { ...base, ...checkCommand(c) }
      if (c.type === 'min-lines') return { ...base, ...checkMinLines(c) }
      return { ...base, ok: false, detail: `不支持的检查类型：${c.type}` }
    } catch (err) {
      return { ...base, ok: false, detail: String(err?.message ?? err) }
    }
  })
  return { results, failed: results.filter((r) => !r.ok) }
}

/* ---------------------------------------------------------------- LLM 判别 */

function judgePrompt(contract, evidence) {
  return [
    '你是只读验收判别器。你只能依据下面的「任务契约」与「产物证据」判断任务是否真的完成。',
    '规则：',
    '1. 不得假定未提供的内容存在；worker 自述不算证据。',
    '2. 缺少验收清单里的任一项 → needs_revision，并给出可执行的 required_fixes。',
    '3. 需要用户授权、方向有歧义、或契约本身不成立 → blocked，并给出 user_questions。',
    '4. 只在全部满足时给 verified。',
    '输出必须是**单个 JSON 对象**，不要 Markdown 代码块，字段：',
    '{"verdict":"verified|needs_revision|blocked","confidence":0-1,"met":[],"missing":[],"evidence":[],"required_fixes":[],"user_questions":[]}',
    '',
    '## 任务契约',
    JSON.stringify(contract, null, 2),
    '',
    '## 产物证据',
    JSON.stringify(evidence, null, 2),
  ].join('\n')
}

function parseVerdict(text) {
  if (!text) return null
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const v = JSON.parse(trimmed.slice(start, end + 1))
    if (!['verified', 'needs_revision', 'blocked'].includes(v.verdict)) return null
    return {
      verdict: v.verdict,
      confidence: typeof v.confidence === 'number' ? v.confidence : 0.5,
      met: Array.isArray(v.met) ? v.met : [],
      missing: Array.isArray(v.missing) ? v.missing : [],
      evidence: Array.isArray(v.evidence) ? v.evidence : [],
      required_fixes: Array.isArray(v.required_fixes) ? v.required_fixes : [],
      user_questions: Array.isArray(v.user_questions) ? v.user_questions : [],
    }
  } catch { return null }
}

/** 取密钥：先看宿主环境变量，再回落到 DSH 凭据文件 ~/.dsh/.credentials.yaml 的 refs 段。 */
function resolveApiKey(judge) {
  const envName = judge?.apiKeyEnv
  if (!envName) return judge?.apiKey ?? undefined
  if (process.env[envName]) return process.env[envName]
  try {
    const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const m = text.match(new RegExp(`^\\s*${envName}\\s*:\\s*(\\S+)\\s*$`, 'm'))
    if (m) return m[1].replace(/^["']|["']$/g, '')
  } catch {}
  return judge?.apiKey ?? undefined
}

async function callJudge(cfg, contract, evidence) {
  const judge = cfg.judge
  const apiKey = resolveApiKey(judge)
  if (!judge?.baseUrl || !judge?.model || !apiKey) return { skipped: 'judge_not_configured' }
  const prompt = judgePrompt(contract, evidence)
  const isAnthropic = (judge.protocol ?? 'openai') === 'anthropic'
  // 网关的 baseUrl 常常已经带 /v1，不能再拼一次（否则 /v1/v1/... 404）。
  const base = judge.baseUrl.replace(/\/$/, '')
  const root = /\/v1$/.test(base) ? base : `${base}/v1`
  const url = isAnthropic ? `${root}/messages` : `${root}/chat/completions`
  const headers = isAnthropic
    ? { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }
  const body = isAnthropic
    ? { model: judge.model, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }
    : { model: judge.model, temperature: 0, messages: [{ role: 'user', content: prompt }] }
  try {
    const res = await fetch(url, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(judge.timeoutMs ?? 45000),
    })
    const raw = await res.text()
    if (!res.ok) return { skipped: 'judge_http_error', detail: `${res.status} ${uslice(raw, 300)}` }
    const data = JSON.parse(raw)
    const text = isAnthropic
      ? (data.content ?? []).map((c) => c.text ?? '').join('')
      : (data.choices?.[0]?.message?.content ?? '')
    const verdict = parseVerdict(text)
    return verdict ? { verdict } : { skipped: 'judge_unparsable', detail: uslice(String(text), 300) }
  } catch (err) {
    return { skipped: 'judge_error', detail: String(err?.message ?? err) }
  }
}

/* ---------------------------------------------------------------- 证据与主流程 */

async function fetchRun(port, runId) {
  if (!port) return null
  try {
    const res = await fetch(`http://127.0.0.1:${port}/agent-bridge/runs/${runId}?limit=400`, {
      signal: AbortSignal.timeout(2500),
    })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

function summarizeEvidence(runPayload) {
  const run = runPayload?.run ?? {}
  const events = runPayload?.events ?? []
  const kinds = {}
  for (const e of events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1
  return {
    runId: run.id,
    agent: run.agent,
    status: run.status,
    durationMs: run.durationMs ?? null,
    finalAnswer: run.finalAnswer ?? null,
    usage: run.usage ?? null,
    eventCount: events.length,
    kinds,
    tail: events.slice(-12).map((e) => ({ seq: e.seq, kind: e.kind, text: e.text ?? e.title ?? '' })),
  }
}

async function verifyRun({ runId, port, contractOverride }) {
  const cfg = readConfig()
  const paths = runPaths(runId)
  const contract = contractOverride ?? readJson(paths.contract, null)

  if (!contract) {
    const verdict = {
      verdict: 'blocked', confidence: 1,
      met: [], missing: ['没有任务契约（contract.json）'],
      evidence: [], required_fixes: [],
      user_questions: ['这条任务没有验收标准，我先不判定它「完成」。要我按你的原话生成一份 DoD 吗？'],
      reason: 'no_contract', at: Date.now(),
    }
    persist(runId, verdict)
    return verdict
  }

  const det = runDeterministic(contract)
  if (det.failed.length > 0) {
    // 确定性检查失败：直接打回，不烧判别 token。
    const verdict = {
      verdict: 'needs_revision', confidence: 1,
      met: det.results.filter((r) => r.ok).map((r) => r.label),
      missing: det.failed.map((r) => `${r.label}: ${r.detail}`),
      evidence: det.results.map((r) => ({ check: r.label, ok: r.ok, detail: r.detail })),
      required_fixes: det.failed.map((r) => `修复检查项「${r.label}」：${r.detail}`),
      user_questions: [], reason: 'deterministic_failed', at: Date.now(),
    }
    persist(runId, verdict)
    return verdict
  }

  const payload = await fetchRun(port, runId)
  const evidence = summarizeEvidence(payload)
  const judged = await callJudge(cfg, contract, { deterministic: det.results, run: evidence })
  if (judged.skipped) {
    const verdict = {
      verdict: 'unverified', confidence: 0,
      met: det.results.map((r) => r.label),
      missing: ['缺少 LLM 判别（未配置判别模型）'],
      evidence: [{ deterministic: det.results }],
      required_fixes: [],
      user_questions: [`判别模型还没配，先按「未验证完成」处理。要在 ${CONFIG} 里填 judge 配置吗？`],
      reason: judged.skipped, detail: judged.detail ?? null, at: Date.now(),
    }
    persist(runId, verdict)
    return verdict
  }
  const verdict = { ...judged.verdict, reason: 'judged', at: Date.now() }
  persist(runId, verdict)
  return verdict
}

function persist(runId, verdict) {
  const paths = runPaths(runId)
  writeJson(paths.verdict, verdict)
  appendFileSync(paths.history, JSON.stringify({ at: Date.now(), ...verdict }) + '\n')
}

/* ---------------------------------------------------------------- 返工回灌 */

async function rework({ runId, port, verdict, prompt }) {
  const cfg = readConfig()
  if (cfg.autonomy === 'L0' || cfg.autonomy === 'L1') {
    return { reworked: false, reason: `autonomy_${cfg.autonomy}` }
  }
  const paths = runPaths(runId)
  const rounds = readRounds(runId, cfg.maxRounds)
  if (rounds.round >= cfg.maxRounds) {
    return { reworked: false, reason: 'max_rounds', round: rounds.round }
  }
  const fixes = (verdict.required_fixes ?? []).map((f, i) => `${i + 1}. ${f}`).join('\n')
  const missing = (verdict.missing ?? []).map((m) => `- ${m}`).join('\n')
  const nextRound = rounds.round + 1
  const body = {
    agent: rounds.agent ?? 'codex',
    prompt: [prompt ?? '', '', '上一轮未通过验收，请只补齐下面这些点后重新交付：', fixes, '', '还缺：', missing, '', '不要解释，直接改。'].join('\n'),
    cwd: rounds.cwd ?? process.cwd(),
    reworkOf: runId,
    round: nextRound,
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/agent-bridge/runs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { reworked: false, reason: 'dispatch_failed', detail: data }
    writeJson(paths.rounds, { ...rounds, round: nextRound, lastRunId: data.runId })
    appendFileSync(paths.history, JSON.stringify({ at: Date.now(), event: 'rework', round: nextRound, runId: data.runId }) + '\n')
    return { reworked: true, round: nextRound, runId: data.runId }
  } catch (err) {
    return { reworked: false, reason: 'dispatch_error', detail: String(err?.message ?? err) }
  }
}

/* ---------------------------------------------------------------- HTTP */

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function readBody(req) {
  return new Promise((resolveBody) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy() })
    req.on('end', () => {
      try { resolveBody(data ? JSON.parse(data) : {}) } catch { resolveBody({}) }
    })
    req.on('error', () => resolveBody({}))
  })
}

function log(message) {
  const line = `${new Date().toISOString()} [dsh-judge] ${message}`
  process.stderr.write(`${line}\n`)
  // 判别层以前只写 stderr，宿主不重定向就全丢（F-10）。
  try {
    mkdirSync(ROOT, { recursive: true })
    appendFileSync(join(ROOT, 'judge.log'), `${line}\n`)
  } catch {}
}

export function apply(ctx) {
  const port = ctx.webServer?.port ?? null
  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://local')
    const tail = url.pathname.replace(/^\/(dsh-judge)(-[a-z])?\/?/, '')

    if (req.method === 'GET' && (tail === '' || tail === 'health')) {
      const cfg = readConfig()
      return json(res, 200, { ok: true, autonomy: cfg.autonomy, maxRounds: cfg.maxRounds, judge: cfg.judge ? { model: cfg.judge.model, protocol: cfg.judge.protocol ?? 'openai' } : null })
    }

    if (req.method === 'GET' && tail === 'contract') {
      const runId = url.searchParams.get('run')
      if (!runId) return json(res, 400, { ok: false, error: 'run required', code: 'run_required' })
      return json(res, 200, readJson(runPaths(runId).contract, null) ?? { missing: true })
    }

    if (req.method === 'POST' && tail === 'contract') {
      const body = await readBody(req)
      if (!body.runId) return json(res, 400, { ok: false, error: 'runId required', code: 'run_required' })
      const paths = runPaths(body.runId)
      if (existsSync(paths.contract)) {
        return json(res, 409, { error: 'contract_immutable', detail: '契约一旦签发不可修改；扩范围请新建任务' })
      }
      const contract = {
        runId: body.runId,
        issuedAt: Date.now(),
        issuedBy: body.issuedBy ?? 'user',
        originalAsk: body.originalAsk ?? '',
        checks: Array.isArray(body.checks) ? body.checks : [],
        expectations: Array.isArray(body.expectations) ? body.expectations : [],
        artifacts: Array.isArray(body.artifacts) ? body.artifacts : [],
        risk: body.risk ?? 'normal',
        cwd: body.cwd ?? null,
      }
      writeJson(paths.contract, contract)
      return json(res, 200, { ok: true, contract })
    }

    if (req.method === 'GET' && tail === 'verdict') {
      const runId = url.searchParams.get('run')
      if (!runId) return json(res, 400, { ok: false, error: 'run required', code: 'run_required' })
      return json(res, 200, readJson(runPaths(runId).verdict, null) ?? { missing: true })
    }

    if (req.method === 'POST' && tail === 'verify') {
      const body = await readBody(req)
      if (!body.runId) return json(res, 400, { ok: false, error: 'runId required', code: 'run_required' })
      const verdict = await verifyRun({ runId: body.runId, port: ctx.webServer?.port ?? port })
      let reworkResult = null
      if (verdict.verdict === 'needs_revision' && body.rework !== false) {
        reworkResult = await rework({ runId: body.runId, port: ctx.webServer?.port ?? port, verdict, prompt: body.prompt })
      }
      return json(res, 200, { ok: true, verdict, rework: reworkResult })
    }

    if (req.method === 'GET' && tail === 'list') {
      const dir = VERIFY
      const ids = existsSync(dir) ? readdirSyncSafe(dir) : []
      const rows = ids.map((id) => ({
        runId: id,
        verdict: readJson(join(dir, id, 'verdict.json'), null)?.verdict ?? null,
        rounds: readRounds(id, readConfig().maxRounds).round,
      }))
      return json(res, 200, { ok: true, count: rows.length, rows })
    }

    return json(res, 404, { ok: false, error: 'not found', path: url.pathname })
  }

  ctx.effect(() => {
    for (const prefix of PREFIXES) {
      const safeHandler = async (request, response) => {
        try {
          await handler(request, response)
        } catch (error) {
          log(`judge route error ${prefix}: ${error && error.message}`)
          try {
            response.writeHead(500, { 'content-type': 'application/json' })
            response.end(JSON.stringify({ ok: false, error: String(error && error.message) }))
          } catch {}
        }
      }
      let dispose
      try {
        dispose = ctx.webServer.register({ kind: 'prefix', path: prefix, handler: safeHandler })
      } catch (error) {
        // 前缀被别的插件占了就换下一个，而不是让 apply 整个炸掉（F-22）。
        log(`judge prefix unavailable ${prefix}: ${error && error.message}`)
        continue
      }
      if (dispose) {
        log(`judge routes at ${prefix}`)
        return () => dispose()
      }
    }
    log('judge: no prefix could be registered')
    return () => {}
  })
}

function readdirSyncSafe(p) {
  // ESM 里没有 require()：旧实现在这里静默返回 []，于是 /list 永远是 0 条（F-04）。
  try { return readdirSync(p) } catch { return [] }
}
