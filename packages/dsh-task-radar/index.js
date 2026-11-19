/**
 * Host half of the task radar bundle.
 *
 * Two jobs:
 * 1. `/x-radar/beacon` — filesystem diagnostics for the Client half (the desktop
 *    window has no image-visible surface for the agent, so the Client reports
 *    `apply / registered / inject / render` here).
 * 2. `/x-radar/radar` — the radar feed the native floating HUD polls. It joins
 *    DSH sessions (title + running) with Agent Bridge runs (needs-approval /
 *    finished-unread) into one small JSON document.
 *
 * Routes are registered inside `ctx.effect` so a replaced plugin generation
 * releases them; the fixed fallback path list keeps a live page working when an
 * older generation still owns the preferred prefix.
 */
import { execFile, execFileSync, spawn } from 'node:child_process'

const TASK_STATUS_ZH = {
  pending: '待处理', in_progress: '进行中', completed: '已完成',
  cancelled: '已取消', blocked: '受阻', ready: '就绪',
}
function zhTask(status) {
  if (!status) return null
  return TASK_STATUS_ZH[status] ?? String(status)
}

import { fileURLToPath } from 'node:url'
import { chmodSync, appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export const name = 'dsh-task-radar'
export const inject = ['webServer']

const LOG_DIR = '/tmp/dsh-task-radar'
const BRIDGE_DIR = join(homedir(), '.dsh', 'agent-bridge')
const ARTIFACT_KEEP_MS = 6 * 60 * 60 * 1000
// 会话内提问（'user-questions/request'）的「只看不动」旁听记录。
// 桌面提问卡由 api-remotes 的转发 listener 负责显示；雷达只旁听一份文本，
// 记录后立刻把请求交还下游 —— 不接管、不阻塞、不改变任何他人的行为。
// 接管（不 next() 直接自己回执）是另一个产品决策，见 docs/research/radar-optimize-prep.md。
const QUESTION_TAP_TTL_MS = 10 * 60 * 1000
const questionTap = new Map()
// 接管窗口（用户裁定 2026-11-18）：20s 内没人答就 next() 让渡回桌面提问卡。
const QUESTION_HOLD_MS = Number(process.env.DSH_TASK_RADAR_ANSWER_MS ?? 20000)
/** 正在被雷达接管的请求：requestId -> { token, sessionId, questions, settle, at, timer }。 */
const questionHold = new Map()
let questionWatcher
// 运行时状态按宿主隔离（N-14）：两个 DSH 宿主共用 ~/.dsh/agent-bridge 时，
// 旧版把 seen.json / jump.json / radar-url.json / hud.pid / radar-sessions.json
// 全放在根目录 —— 对方的端口会被写进 radar-url.json（HUD 转 offline），
// hud.pid 被对方 supervisor 当成自己的（互杀，hud.log 出现 shutdown: signal 15）。
// 端口就绪后统一切到 ~/.dsh/agent-bridge/hosts/<port>/；根目录只留一份兼容镜像。
const HOSTS_DIR = join(BRIDGE_DIR, 'hosts')
let STATE_DIR = BRIDGE_DIR
let STATE_PORT
function stateFile(name) { return join(STATE_DIR, name) }
function seenFile() { return stateFile('seen.json') }
function jumpFile() { return stateFile('jump.json') }
function urlFile() { return stateFile('radar-url.json') }
function hudPidFile() { return stateFile('hud.pid') }
function trackFile() { return stateFile('radar-sessions.json') }

/** 旧根目录 → 宿主目录的一次性迁移（只搬「属于本宿主」的用户态文件）。 */
function migrateLegacyState(dir) {
  for (const name of ['seen.json', 'radar-sessions.json']) {
    const target = join(dir, name)
    const legacy = join(BRIDGE_DIR, name)
    if (existsSync(target) || !existsSync(legacy)) continue
    try {
      copyFileSync(legacy, target)
      log(`state.migrate ${name} legacy=${legacy} host=${target}`)
    } catch (error) {
      log(`state.migrate.failed ${name} ${String(error && error.message ? error.message : error)}`)
    }
  }
}

/** 端口就绪后把状态目录切到 hosts/<port>/；重复调用是幂等的。 */
function useHostState(port) {
  if (!Number.isFinite(port) || port <= 0) return STATE_DIR
  const dir = join(HOSTS_DIR, String(port))
  if (STATE_DIR === dir) return dir
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    log(`state.host.mkdir.failed port=${port} ${String(error && error.message ? error.message : error)}`)
    return STATE_DIR
  }
  migrateLegacyState(dir)
  STATE_DIR = dir
  STATE_PORT = port
  log(`state.host port=${port} dir=${dir}`)
  return dir
}
const HUD_BIN = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, 'native', 'RadarHUD')
const PREFERRED = ['/x-radar', '/x-radar-b', '/x-radar-c', '/x-radar-d']

// 日志轮转（t5 F-05）：beacon.log 单文件超过 10MB 就滚成 .1/.2/.3，最多留三份。
// 不轮转的话按住户机实测 51.7 B/s 约 2.3 天就能把单文件顶到 10MB，且没有任何上限。
const LOG_MAX_BYTES = 10 * 1024 * 1024
const LOG_KEEP = 3

function rotateIfNeeded(path) {
  try {
    if (!existsSync(path)) return
    if (statSync(path).size < LOG_MAX_BYTES) return
    for (let index = LOG_KEEP; index >= 1; index -= 1) {
      const from = index === 1 ? path : `${path}.${index - 1}`
      const to = `${path}.${index}`
      if (!existsSync(from)) continue
      if (index === LOG_KEEP && existsSync(to)) rmSync(to, { force: true })
      renameSync(from, to)
    }
  } catch {}
}

function log(line) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const logPath = join(LOG_DIR, 'beacon.log')
    rotateIfNeeded(logPath)
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`)
  } catch {}
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function readSeen() {
  const raw = readJson(seenFile(), {})
  return raw !== null && typeof raw === 'object' ? raw : {}
}

const VERIFY_DIR = join(BRIDGE_DIR, 'verify')

/** 读 L1 判别层的裁决（没有就返回空）。 */
function readVerdict(runId) {
  const dir = join(VERIFY_DIR, runId)
  const verdict = readJson(join(dir, 'verdict.json'), null)
  const rounds = readJson(join(dir, 'rounds.json'), null)
  const contract = readJson(join(dir, 'contract.json'), null)
  return {
    verdict: verdict?.verdict ?? null,
    reason: verdict?.reason ?? null,
    missing: Array.isArray(verdict?.missing) ? verdict.missing.slice(0, 3) : [],
    round: rounds?.round ?? 0,
    hasContract: contract !== null && typeof contract === 'object',
  }
}

/**
 * 通知门：只有判别为 verified 才允许呈现「完成」。
 * worker 自称 done 但没有契约/没有裁决 → unverified（不给完成提醒）。
 */
/** 判别层首次安装时间：更早的历史任务不带验收契约，按「已完成」呈现，不制造噪声。 */
function judgeInstalledAt() {
  const info = readJson(join(BRIDGE_DIR, 'judge-installed.json'), null)
  return Number(info?.at ?? 0)
}

function gateStatus(workerStatus, judged) {
  if (workerStatus !== 'done') return workerStatus
  // 没有任务契约 = 普通外部任务，跑完就算完成；只有签了契约的才过验收门。
  if (!judged.hasContract) return 'done'
  switch (judged.verdict) {
    case 'verified': return 'done'
    case 'needs_revision': return 'rework'
    case 'blocked': return 'blocked'
    default: return 'verifying'
  }
}

/** 失败原因的兜底文案：reason 码本身对用户没意义，翻译成一句人话。 */
function reasonText(reason) {
  switch (reason) {
    case 'no_live_waiter':
      return '审批对象已丢失（宿主重启过，没有活着的等待方）'
    case 'timeout':
      return '运行超时'
    case 'spawn_failed':
      return '进程启动失败'
    case 'process-exited':
      return '子进程已经退出（process-exited）'
    case 'stale-running':
      return '超过 10 分钟没有任何新事件（可能卡住了）'
    default:
      return null
  }
}

/** 从 events.jsonl 尾部找最后一条错误文本：优先 kind=error 的 message，其次 stderr 文本。 */
function lastRunErrorText(id) {
  try {
    const file = join(BRIDGE_DIR, 'runs', id, 'events.jsonl')
    const raw = readFileSync(file, 'utf8')
    const lines = raw.split('\n')
    const from = Math.max(0, lines.length - 400)
    for (let index = lines.length - 1; index >= from; index -= 1) {
      const line = lines[index]
      if (line.length === 0) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      const text = event?.message ?? event?.text ?? event?.error ?? null
      if (event?.kind === 'error' && typeof text === 'string' && text.trim() !== '') return text.trim()
      if (event?.stream === 'stderr' && typeof text === 'string' && text.trim() !== '') return text.trim()
    }
  } catch {}
  return null
}

/** feed 只给 200 字（面板一行放不下），详情页从 run meta 拿全量。 */
/// 最后一条事件的 kind：判断僵尸 run 到底跑到哪一步（`turn.end` = 其实已经跑完）。
function lastRunEventKind(id) {
  let text = null
  try {
    text = readFileSync(join(BRIDGE_DIR, 'runs', id, 'events.jsonl'), 'utf8')
  } catch {
    return null
  }
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0 && index >= lines.length - 400; index -= 1) {
    const line = lines[index].trim()
    if (line === '') continue
    try {
      const event = JSON.parse(line)
      const kind = typeof event.kind === 'string' ? event.kind : typeof event.type === 'string' ? event.type : null
      if (kind !== null) return kind
    } catch {}
  }
  return null
}

function clipError(text) {
  if (typeof text !== 'string') return null
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat === '') return null
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat
}

// ---- 雷达自己的小账本（t14 续）------------------------------------------------
// 桥不认识 retryOf，也不认识「从雷达里移除」：这两件事都是**视图层**的语义，
// 所以记在雷达自己的 state 目录里，不往桥的 meta.json 里塞字段（避免两个写者打架）。
const STALE_RUN_MS = 10 * 60 * 1000

function retriesFile() {
  return join(STATE_DIR, 'retries.json')
}

function hiddenFile() {
  return join(STATE_DIR, 'hidden-sessions.json')
}

function hiddenRunsFile() {
  return join(STATE_DIR, 'hidden-runs.json')
}

// ---- 后台任务（job）账本 ------------------------------------------------------
// 用户口径（2026-11-19）：「后台任务在跑，但胶囊显示没有」——DSH 的 row.running 只表示
// 「有一轮对话在跑」，bash 的 run_in_background 之类 job 在 turn 结束后仍然活着，此时
// 会话 running=false，雷达就把它当空闲了。job 归 ctx.jobs 管，这里订阅它的生命周期事件
// 维护「哪些会话还有活 job」，供 feed 把这类会话重新算作「进行中」。
// 订阅失败（老宿主没有 jobs 服务）时退化成按需 list(sessionId) 扫描，绝不阻塞 feed。
const liveJobs = new Map()
let jobsSubscription = 'none'
let jobsFallbackAt = 0
const jobsFallbackCache = new Map()

function jobOwnerId(job) {
  const owner = job?.owner
  if (owner === undefined || owner === null) return ''
  const id = owner.id ?? owner
  return typeof id === 'string' ? id : ''
}

function watchJobs(ctx) {
  const jobs = ctx.get('jobs')
  if (jobs === undefined || jobs === null) {
    jobsSubscription = 'unavailable'
    log('job watch unavailable ctx.jobs')
    return () => {}
  }
  const events = jobs.events
  if (events === undefined || typeof events.subscribe !== 'function') {
    jobsSubscription = 'unavailable'
    log('job watch unavailable jobs.events')
    return () => {}
  }
  let dispose
  try {
    dispose = events.subscribe({ owners: 'all' }, (event) => {
      const owner = jobOwnerId(event?.job)
      if (owner === '') return
      const status = event?.job?.status
      if (event.type === 'registered' || event.type === 'progress' || event.type === 'stopping') {
        if (event.type === 'registered') {
          liveJobs.set(owner, (liveJobs.get(owner) ?? 0) + 1)
          log(`job registered owner=${owner.slice(0, 12)} id=${event.job?.id} kind=${event.job?.kind}`)
        }
        return
      }
      if (event.type === 'settled' || event.type === 'removed') {
        const next = Math.max(0, (liveJobs.get(owner) ?? 0) - 1)
        if (next === 0) liveJobs.delete(owner)
        else liveJobs.set(owner, next)
        if (event.type === 'settled') {
          log(`job settled owner=${owner.slice(0, 12)} id=${event.job?.id} status=${status}`)
        }
      }
    })
    jobsSubscription = 'events'
    log('job watch listening')
  } catch (error) {
    jobsSubscription = 'unavailable'
    log(`job watch subscribe failed ${error?.message ?? error}`)
    return () => {}
  }
  return () => {
    try { dispose?.() } catch {}
  }
}

/// 兜底：没有事件流时按会话 list 一次（5s 缓存，最多看 60 个最近会话），只数为「活 job」。
function jobCountFallback(ctx, sessionIds) {
  const jobs = ctx.get('jobs')
  if (jobs === undefined || typeof jobs.list !== 'function') return 0
  const now = Date.now()
  if (now - jobsFallbackAt > 5000) {
    jobsFallbackAt = now
    jobsFallbackCache.clear()
    for (const id of sessionIds.slice(0, 60)) {
      try {
        const list = jobs.list(id) ?? []
        const live = list.filter(
          (job) =>
            jobOwnerId(job) === id && (job.status === 'running' || job.status === 'stopping'),
        ).length
        if (live > 0) jobsFallbackCache.set(id, live)
      } catch {}
    }
  }
  return 0
}

function liveJobCount(ctx, sessionId, fallbackIds) {
  if (jobsSubscription === 'events') {
    const direct = liveJobs.get(sessionId)
    if (direct !== undefined) return direct
    return 0
  }
  if (jobsSubscription === 'none') return 0
  jobCountFallback(ctx, fallbackIds ?? [])
  return jobsFallbackCache.get(sessionId) ?? 0
}

function readHiddenRuns() {
  return readMap(hiddenRunsFile())
}

function hideRun(runId) {
  const map = readMap(hiddenRunsFile())
  map[runId] = { at: Date.now() }
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(hiddenRunsFile(), JSON.stringify(map, null, 2))
  } catch {}
}

function readMap(path) {
  const data = readJson(path, null)
  return data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
}

/// 被重试顶替掉的旧 run：重试成功那一刻起就不再出现在列表里（用户口径「旧行消失」）。
function supersededRuns() {
  const map = readMap(retriesFile())
  const out = {}
  for (const entry of Object.values(map)) {
    if (entry !== null && typeof entry === 'object' && typeof entry.retryOf === 'string') out[entry.retryOf] = true
  }
  return out
}

function readRetryOf(runId) {
  const record = readMap(retriesFile())[runId]
  return record && typeof record.retryOf === 'string' ? record.retryOf : null
}

function writeRetryOf(runId, retryOfId) {
  const map = readMap(retriesFile())
  map[runId] = { retryOf: retryOfId, at: Date.now() }
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(retriesFile(), JSON.stringify(map, null, 2))
  } catch {}
}

function readHiddenSessions() {
  return readMap(hiddenFile())
}

function hideSession(sessionId) {
  const map = readMap(hiddenFile())
  map[sessionId] = { at: Date.now() }
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(hiddenFile(), JSON.stringify(map, null, 2))
  } catch {}
}

/// 僵尸 running：桥只在「宿主重启后审批没人接」时对账（needs-approval），
/// 子进程被 OS 杀掉/崩溃留下的 running 没有任何人收尾，胶囊就会永远停在「进行中」。
/// 这里在**读侧**兜底：running 且 updatedAt 超过 10 分钟没动 → 按最后一条 turn.end 判 done，
/// 否则 failed(reason=stale-running)。只改 feed 里的视图，不写桥的 meta（写者仍是桥）。
/// 进程级即时判定（t14 续 2）：桥的 run 记录里带 spawn 出来的子进程 pid。
/// 子进程被 OS 杀掉/崩溃退出后，桥不会落状态，`kill(pid, 0)` 立刻能看出「进程没了」——
/// 这种情况不该等 10 分钟，必须马上落终态，否则胶囊会一直绿着「进行中」。
/// 返回 true / false；拿不到 pid 时返回 null（未知，不影响其它判定）。
function processAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 1) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM = 进程在，但不是我们的（仍然算活着）；ESRCH = 进程已经没了。
    return error?.code === 'EPERM'
  }
}

function staleRunStatus(run, now) {
  if (run.status !== 'running' && run.status !== 'starting' && run.status !== 'queued') return null
  const ageMs = now - (Number(run.updatedAt) || 0)
  if (!(ageMs > STALE_RUN_MS)) return null
  return { ageMs }
}

function bridgeRuns() {
  let ids = []
  try {
    ids = readdirSync(join(BRIDGE_DIR, 'runs'))
  } catch {
    return []
  }
  const seen = readSeen()
  const runs = []
  for (const id of ids) {
    const meta = readJson(join(BRIDGE_DIR, 'runs', id, 'meta.json'), null)
    if (meta === null || typeof meta !== 'object') continue
    const judged = readVerdict(id)
    runs.push({
      id,
      agent: meta.agent ?? 'codex',
      title: typeof meta.prompt === 'string' ? meta.prompt : id,
      // 通知门：run 自称 done 也要过 L1 判别才算「完成」。
      status: gateStatus(meta.status ?? 'unknown', judged),
      rawStatus: meta.status ?? 'unknown',
      verdict: judged.verdict ?? null,
      round: judged.round ?? 0,
      hasContract: judged.hasContract,
      missing: judged.missing ?? [],
      updatedAt: Date.parse(meta.updatedAt ?? meta.createdAt ?? '') || Date.now(),
      seen: Boolean(seen[id]),
      finalAnswer: meta.finalAnswer ?? null,
      // 桥对账过的终态会带 reason=no_live_waiter：面板据此解释「为什么失败」。
      reason: meta.reason ?? null,
      // 人类可读的失败原因（t14 bug 3）：桥把 spawn/退出码等原始错误写在这里。
      error: typeof meta.error === 'string' && meta.error.trim() !== '' ? meta.error.trim() : null,
      // 详情页要判断「有没有内容可展示」：没有事件的历史 run 不能再给一个空面板。
      eventCount: Number.isFinite(meta.eventCount) ? meta.eventCount : null,
      pid: Number.isFinite(meta.pid) ? meta.pid : null,
      // 一眼能否分辨「真在跑」和「进程没了还在写 running」（t14 续 2）。
      pidAlive: processAlive(Number.isFinite(meta.pid) ? meta.pid : null),
      // 重试产生的 run 记在雷达自己的账本里（桥不认 retryOf，见 README 已知限制）。
      retryOf: readRetryOf(id),
    })
  }
  return runs
}

function json(response, status, body) {
  const text = JSON.stringify(body)
  if (typeof response.writeHead === 'function') {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(text)
    return
  }
  return new Response(text, { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

async function underTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(undefined), ms))])
}

/** 子会话（subagent / fork 出来的工作单元）不算独立任务，胶囊只统计顶层会话。 */
function childSessionIds(ctx) {
  const ids = new Set()
  try {
    const sessions = ctx.get('sessions')
    const list = typeof sessions?.list === 'function' ? sessions.list() : []
    for (const session of list) {
      const header = session?.header ?? {}
      const parent = header.parentSession ?? header.parentSessionId ?? session?.parentSession
      if (parent !== undefined && parent !== null && parent !== '') ids.add(String(session?.id ?? ''))
    }
  } catch {}
  return ids
}

let diagDone = false

/** One-shot shape probe so the fallback path can be fixed with facts instead of guesses. */
async function diagOnce(ctx) {
  if (diagDone) return
  diagDone = true
  const out = {}
  try {
    const controller = ctx.get('sessionController')
    out.controller = typeof controller === 'undefined' ? 'undefined' : typeof controller
    out.hasList = typeof controller?.list === 'function'
    if (out.hasList) {
      const r = await underTimeout(Promise.resolve().then(() => controller.list()), 1500)
      out.listType = Array.isArray(r) ? 'array' : typeof r
      out.listKeys = r && !Array.isArray(r) ? Object.keys(r).slice(0, 8) : undefined
      const rows = Array.isArray(r) ? r : Array.isArray(r?.items) ? r.items : []
      out.rowCount = rows.length
      out.firstRowKeys = rows[0] ? Object.keys(rows[0]).slice(0, 20) : undefined
      out.firstRowJson = rows[0] ? JSON.stringify(rows[0]).slice(0, 700) : undefined
    }
  } catch (err) {
    out.controllerError = String(err?.message ?? err)
  }
  try {
    const sessions = ctx.get('sessions')
    const list = typeof sessions?.list === 'function' ? sessions.list() : []
    out.sessionCount = list.length
    const first = list[0]
    out.sessionKeys = first ? Object.keys(first).slice(0, 20) : undefined
    out.headerKeys = first?.header ? Object.keys(first.header).slice(0, 20) : undefined
    out.sessionJson = first ? JSON.stringify(first).slice(0, 600) : undefined
  } catch (err) {
    out.sessionsError = String(err?.message ?? err)
  }
  log(`host.diag ${JSON.stringify(out)}`)
}

/** Session titles/status come from `sessionController`; it is a Remote, so never let it throw the feed. */
async function sessionItems(ctx) {
  const out = []
  const controller = ctx.get('sessionController')
  // 双击会话行选「仅从雷达移除」的人不想再看到这行：feed 层永久过滤。
  const hidden = readHiddenSessions()
  const hiddenSessionIds = Object.fromEntries(Object.keys(hidden).map((key) => [key, true]))
  if (controller !== undefined && typeof controller.list === 'function') {
    const summaries = await underTimeout(
      Promise.resolve()
        .then(() => controller.list())
        .catch(() => undefined),
      1500,
    )
    const rows = Array.isArray(summaries)
      ? summaries
      : Array.isArray(summaries?.items)
        ? summaries.items
        : undefined
    if (rows !== undefined) {
      const describe = (row) => {
        const values = row?.projections?.values ?? {}
        const title =
          (typeof values.title === 'string' && values.title.trim()) ||
          (typeof row?.projections?.sessionTitle === 'string' && row.projections.sessionTitle) ||
          (typeof row?.cwd === 'string' ? basename(row.cwd) : undefined)
        return {
          id: String(row?.sessionId ?? ''),
          parentId: String(row?.parentSessionId ?? row?.parentSession ?? ''),
          running: row?.running === true,
          agent: 'dsh',
          preset: typeof values.agentPreset === 'string' ? values.agentPreset : undefined,
          tokens: Number(values?.tokenUsage?.totalTokens ?? 0) || 0,
          title: typeof title === 'string' && title.length > 0 ? title : String(row?.sessionId ?? 'session'),
          formatStatus: typeof row?.formatStatus === 'string' ? row.formatStatus : undefined,
          origin: typeof row?.origin === 'string' ? row.origin : undefined,
          // 团队判定：看板 enabled，或者它的 subagent 目录里出现过 agent-teams: 前缀的成员
          // （有些会话是用 subagent 工具临时起了一支 team，看板没开但成员确实在跑）。
          team:
            values?.agentTeam?.enabled === true ||
            (Array.isArray(values?.subagentCatalog) &&
              values.subagentCatalog.some(
                (entry) => typeof entry?.label === 'string' && entry.label.startsWith('agent-teams:'),
              )),
          catalog: Array.isArray(values?.subagentCatalog) ? values.subagentCatalog : [],
          tasks: Array.isArray(values?.agentTeam?.tasks) ? values.agentTeam.tasks : [],
          updatedAt: Number(row?.updatedAt ?? 0) || 0,
          // DSH 侧唯一可信的「用户碰过这个会话」信号：最后一条人类输入的时间。
          // 行上没有 completionUnread / retainedBy（实测字段只有 sessionId/updatedAt/
          // agentAvailable/formatStatus/running/blank/cwd/origin/parentSessionId/projections），
          // 所以未读对账只能用「又跑起来了 / 说过话 / 行消失」这些硬事实。
          lastPromptAt: Number.isFinite(values?.sessionListMetadata?.lastPromptAt)
            ? Number(values.sessionListMetadata.lastPromptAt)
            : null,
        }
      }
      const described = rows.map(describe).filter((row) => row.id !== '')
      const byId = new Map(described.map((row) => [row.id, row]))
      // 子会话按父会话归档：胶囊里**只出现父会话**，子会话挂到父会话下面（点开才看得到）。
      const childrenOf = new Map()
      for (const row of described) {
        if (!row.parentId || !byId.has(row.parentId)) continue
        const bucket = childrenOf.get(row.parentId) ?? []
        bucket.push(row)
        childrenOf.set(row.parentId, bucket)
      }
      const toChild = (row) => ({
        id: row.id,
        title: row.title,
        status: row.running ? 'running' : 'idle',
        agent: row.agent,
        preset: row.preset,
        tokens: row.tokens,
        origin: row.origin,
        updatedAt: row.updatedAt,
      })
      // agent team 的成员名单：subagentCatalog（id→label）+ task board（ownerId→任务/状态）
      const FINISHED_TTL_MS = 30 * 60 * 1000
      const fresh = (child) => {
        const done = (child.taskStatus ?? '').includes('已完成') || child.status === 'idle'
        if (!done) return true
        const at = Number(child.updatedAt ?? 0)
        return at > 0 && Date.now() - at <= FINISHED_TTL_MS
      }
      const teamMembers = (row, kids) => {
        const kidById = new Map(kids.map((kid) => [kid.id, kid]))
        const shortRole = (label) => {
          if (typeof label !== 'string') return null
          const parts = label.split(':').filter((part) => part.length > 0)
          return parts.length > 1 ? parts[parts.length - 1] : label
        }
        const members = []
        const seen = new Set()
        for (const entry of row.catalog) {
          const id = String(entry?.id ?? '')
          if (!id) continue
          seen.add(id)
          const kid = kidById.get(id) ?? null
          const task = row.tasks.find((item) => String(item?.ownerId ?? '') === id) ?? null
          const label = typeof entry?.label === 'string' ? entry.label : null
          // 只把真正的团队成员算进来：agent-teams: 前缀，或看板上确实有它的任务
          if (label !== null && !label.startsWith('agent-teams:') && task === null) continue
          members.push({
            id,
            role: shortRole(label),
            title: typeof task?.subject === 'string' ? task.subject : (kid?.title ?? null),
            status: kid?.running ? 'running' : 'idle',
            taskStatus:
              typeof task?.status === 'string'
                ? zhTask(task.status)
                : kid?.running
                  ? '进行中'
                  : null,
            tokens: kid?.tokens ?? 0,
            updatedAt: kid?.updatedAt ?? 0,
          })
        }
        // 有任务但没有 catalog 记录的成员（例如被 reassign 过的）也列出来，别让进度凭空缺人
        for (const task of row.tasks) {
          const id = String(task?.ownerId ?? '')
          if (!id || seen.has(id)) continue
          seen.add(id)
          const kid = kidById.get(id) ?? null
          members.push({
            id,
            role: null,
            title: typeof task?.subject === 'string' ? task.subject : null,
            status: kid?.running ? 'running' : 'idle',
            taskStatus: typeof task?.status === 'string' ? zhTask(task.status) : null,
            tokens: kid?.tokens ?? 0,
            updatedAt: kid?.updatedAt ?? 0,
          })
        }
        return members.filter(fresh).sort(
          (a, b) =>
            Number(b.status === 'running') - Number(a.status === 'running') ||
            Number(a.taskStatus === 'completed') - Number(b.taskStatus === 'completed') ||
            b.updatedAt - a.updatedAt,
        )
      }

      // 后台 job 兜底扫描只看最近活跃的一批会话，避免每轮把 200+ 会话都 list 一遍。
      const jobFallbackIds = described
        .filter((row) => !row.parentId || !byId.has(row.parentId))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((row) => row.id)
      for (const row of described) {
        const kids = childrenOf.get(row.id) ?? []
        const isTop = !row.parentId || !byId.has(row.parentId)
        // 父会话本身没在跑、但有子会话在跑 → 父会话也算「正在处理」（用户口径：
        // 一个父会话调了四个智能体，界面上只看到一个父会话在处理）。
        const runningFromChildren = kids.some((kid) => kid.running)
        if (isTop) {
          // 双击会话行选「仅从雷达移除」后，永久不再出现在列表（feed 层过滤，不动 DSH 数据）。
          if (hiddenSessionIds[row.id] === true) continue
          const members = row.team ? teamMembers(row, kids) : []
          // 规则 B：主列表只放主会话，子会话一律挂到主会话详情里；
          // 普通会话的子 agent 也要能看到（不只是 agent team）。
          const visibleKids = kids.filter(fresh).map(toChild)
          // 用户口径（2026-11-19）：后台 job 在跑也算「进行中」。row.running 只跟「有一轮
          // 对话在跑」有关，turn 结束后 job 还活着时它是 false，胶囊就会把这条会话当空闲。
          const jobCount = liveJobCount(ctx, row.id, jobFallbackIds)
          const runningByJob = row.running !== true && jobCount > 0
          out.push({
            id: row.id,
            kind: 'session',
            agent: row.agent,
            preset: row.preset,
            title: row.title,
            status: row.running || runningFromChildren || runningByJob ? 'running' : 'idle',
            // 为什么算「进行中」：turn=真在跑对话，job=后台任务还在跑，children=子会话在跑。
            runningBy: row.running ? 'turn' : runningByJob ? 'job' : runningFromChildren ? 'children' : undefined,
            jobs: jobCount > 0 ? jobCount : undefined,
            // 只有 agent team 才展开成员进度；普通 session 的子 agent 不进列表（用户口径）。
            team: row.team,
            childCount: row.team ? members.length : visibleKids.length,
            children: row.team ? members : visibleKids.length > 0 ? visibleKids : undefined,
            // 阶段视图：任务看板就是这条会话的分阶段计划
            stages: row.team
              ? (row.tasks ?? [])
                  .filter((task) => task && typeof task.subject === 'string' && task.subject)
                  .slice(0, 12)
                  .map((task) => ({
                    subject: String(task.subject).slice(0, 90),
                    status: typeof task.status === 'string' ? zhTask(task.status) : '',
                  }))
              : undefined,
            tokens: row.tokens,
            goal: row.goal,
            formatStatus: row.formatStatus,
            // 宿主没有「未读」字段，但行上有 lastPromptAt（最后一次人类输入时间）。
            // 完成时间早于它 = 用户在这之后还进这个会话说过话 ⇒ 一定看过了。
            lastPromptAt: row.lastPromptAt ?? null,
            updatedAt: row.updatedAt,
          })
        }
        // 孤儿会话（父会话已经不在列表里）单独成行，否则任务会凭空消失。
      }
      return { items: out, source: 'sessionController' }
    }
  }
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  const list = typeof sessions?.list === 'function' ? sessions.list() : []
  const entries = []
  for (const session of list) {
    let title
    try {
      title =
        (typeof session?.header?.title === 'string' && session.header.title) ||
        (typeof session?.displayTitle === 'string' && session.displayTitle) ||
        (typeof session?.header?.cwd === 'string' ? basename(session.header.cwd) : undefined)
    } catch {}
    let running = false
    try {
      running = agents?.get?.(session.id)?.status === 'running'
    } catch {}
    const header = session?.header ?? {}
    entries.push({
      id: String(session?.id ?? ''),
      parentId: String(header.parentSession ?? header.parentSessionId ?? session?.parentSession ?? ''),
      title: title ?? String(session?.id ?? 'session'),
      running,
      updatedAt: Number(header.createdAt ?? 0) || 0,
    })
  }
  const ids = new Set(entries.map((entry) => entry.id))
  const kidsOf = new Map()
  for (const entry of entries) {
    if (!entry.parentId || !ids.has(entry.parentId)) continue
    const bucket = kidsOf.get(entry.parentId) ?? []
    bucket.push(entry)
    kidsOf.set(entry.parentId, bucket)
  }
  for (const entry of entries) {
    if (entry.parentId && ids.has(entry.parentId)) continue
    const kids = kidsOf.get(entry.id) ?? []
    out.push({
      id: entry.id,
      kind: 'session',
      agent: 'dsh',
      title: entry.title,
      status: entry.running || kids.some((kid) => kid.running) ? 'running' : 'idle',
      childCount: kids.length,
      children: kids.map((kid) => ({ id: kid.id, title: kid.title, status: kid.running ? 'running' : 'idle', agent: 'dsh', updatedAt: kid.updatedAt })),
      updatedAt: entry.updatedAt,
    })
  }
  return { items: out, source: 'sessions' }
}

async function pendingApprovals(port) {
  if (!port) return []
  try {
    // include_token=1：桥默认对列表脱敏 token（N-03），雷达要替用户下决定，必须显式索取。
    const response = await fetch(`http://127.0.0.1:${port}/agent-bridge/approvals?include_token=1`, {
      signal: AbortSignal.timeout(1200),
    })
    if (!response.ok) return []
    const body = await response.json()
    return Array.isArray(body?.approvals) ? body.approvals : []
  } catch {
    return []
  }
}

/**
 * 桥侧两类「需要人」的事件共用一条队列：审批（requestApproval）和提问
 * （requestUserInput / workbuddy 待确认卡）。它们的应答格式不同，所以在雷达
 * 上分成 kind=approval / kind=question，避免把提问也画成「等你批准」。
 */
function approvalKind(approval) {
  const method = String(approval?.method ?? '')
  // claude 的 PreToolUse 把工具名放在 params.tool 里（AskUserQuestion /
  // request_user_input），只看 method 会把它当成普通工具放行——那样用户的
  // 问题只会以「批准/拒绝」出现，文案完全没有题干。
  const tool = String(approval?.params?.tool ?? approval?.params?.toolName ?? '')
  const hint = `${method} ${tool}`
  return /requestUserInput|request_user_input|AskUserQuestion|question/i.test(hint) ? 'question' : 'approval'
}

/** 提问类事件的题干（codex 的 questions[] / 单条 prompt）。 */
function questionText(approval) {
  const params = approval?.params
  // claude 的 AskUserQuestion 把问题放在 params.input.questions 里，codex 的
  // requestUserInput 放在 params.questions 里，两处都认。
  const list = params?.questions ?? params?.input?.questions
  if (Array.isArray(list)) {
    const texts = list
      .map((entry) => {
        if (typeof entry === 'string') return entry
        const text = entry?.question ?? entry?.text ?? entry?.header ?? entry?.prompt
        if (typeof text !== 'string') return undefined
        const options = Array.isArray(entry?.options)
          ? entry.options.map((o) => (typeof o === 'string' ? o : o?.label ?? o?.value)).filter(Boolean)
          : []
        return options.length ? `${text}（${options.join(' / ')}）` : text
      })
      .filter((text) => typeof text === 'string' && text.trim())
    if (texts.length) {
      // 标题只放问题原文：选项由面板逐条渲染（2.20），塞进标题会挤掉题干。
      const first = (list[0]?.question ?? list[0]?.text ?? list[0]?.prompt ?? list[0] ?? '').toString().trim().replace(/\s+/g, ' ')
      // 标题就是问题原文（t5 验收④）：不再加「等你回答：」前缀，行内副标题已经说明是提问。
      return texts.length > 1 ? `${first.slice(0, 52)}（等 ${texts.length} 问）` : first.slice(0, 60)
    }
  }
  const single = params?.prompt ?? params?.question ?? params?.input?.question
  if (typeof single === 'string' && single.trim()) return single.trim().replace(/\s+/g, ' ').slice(0, 60)
  return undefined
}

/** 提问的结构化形态：每问带 id 与 options，供 HUD 逐条渲染可点选项（2.20）。 */
function questionsOf(approval) {
  const params = approval?.params
  const list = params?.questions ?? params?.input?.questions
  if (!Array.isArray(list)) return []
  return list
    .map((entry, index) => {
      if (typeof entry === 'string') return { id: String(index), question: entry, options: [] }
      const text = entry?.question ?? entry?.text ?? entry?.header ?? entry?.prompt
      const id = entry?.id ?? entry?.questionId ?? `q${index}`
      const raw = Array.isArray(entry?.options) ? entry.options : []
      const options = raw.map((option, oi) =>
        typeof option === 'string'
          ? { id: option, label: option }
          : {
              id: String(option?.id ?? option?.value ?? option?.label ?? `o${oi}`),
              label: String(option?.label ?? option?.value ?? option?.id ?? `选项${oi + 1}`),
              description: typeof option?.description === 'string' ? option.description : undefined,
            })
      if (typeof text !== 'string' || !text.trim()) return null
      return { id: String(id), question: text.trim(), options }
    })
    .filter(Boolean)
}

/**
 * 提问回执的线形状由 codex 的 ToolRequestUserInputResponse 定死：
 * `{ answers: { <questionId>: { answers: ["<label>"] } } }`（值本身是对象，
 * 且内层 answers 数组必填）。HUD 只发 label，若直接透传裸字符串，codex 会
 * 在 events 里记「returned empty answers」，用户的选择被彻底丢掉（实测）。
 * 这里做一次归一化：字符串/数组/已嵌套对象都能收敛到线形状。
 */
function normalizeQuestionAnswers(answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null
  const out = {}
  for (const [questionId, value] of Object.entries(answers)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.answers)) {
      out[questionId] = { answers: value.answers.map((entry) => String(entry)) }
    } else if (Array.isArray(value)) {
      out[questionId] = { answers: value.map((entry) => String(entry)) }
    } else if (value !== undefined && value !== null) {
      out[questionId] = { answers: [String(value)] }
    }
  }
  return Object.keys(out).length ? out : null
}

/**
 * 审批/桥内提问是否已经没有活着的等待方（用户现场：胶囊停在一个点了必然失败的页面）。
 * 判据（任一命中即失效）：
 *   - 桥自己标了 stale（宿主重启后没有 waiter）；
 *   - 关联 run 已是终态（done/failed/killed/cancelled）——没人再等这个决定；
 *   - 关联 run 有 pid 且进程已经不在（`pidAlive === false`）。
 * 返回失效原因字符串，活着返回 null。
 */
function staleApprovalReason(approval, runsById) {
  if (approval?.stale === true) return 'no-waiter'
  const runId = typeof approval?.runId === 'string' && approval.runId !== '' ? approval.runId : null
  if (runId === null) return null
  const run = runsById?.get(runId)
  if (run === undefined) return null
  const terminal = new Set(['done', 'failed', 'killed', 'cancelled'])
  if (terminal.has(String(run.status))) return 'run-terminal'
  if (run.pidAlive === false) return 'pid-dead'
  return null
}

function describeApproval(approval) {
  const params = approval?.params ?? {}
  const input = params.input ?? {}
  const asked = questionText(approval)
  if (asked) return asked
  const direct =
    (typeof approval?.title === 'string' ? approval.title : undefined) ??
    params.command ??
    params.reason ??
    params.item?.command ??
    params.item?.reason ??
    params.prompt ??
    input.command ??
    input.file_path ??
    input.path ??
    input.pattern ??
    input.url
  if (typeof direct === 'string' && direct.trim()) {
    const text = direct.trim().replace(/\s+/g, ' ')
    // 用户 2026-11-16 要求：行文案要自己说清楚是谁在等什么，不要只有一句「回复确认消息」。
    const agent = String(approval?.agent ?? '').toLowerCase()
    if (agent === 'workbuddy') return `WorkBuddy 等你确认：${text.slice(0, 60)}`
    return text
  }
  const method = String(approval?.method ?? 'approval')
  return method.replace(/^item\//, '').replace(/\/requestApproval$/, '')
}

function artifactItems() {
  try {
    const payload = JSON.parse(readFileSync(join(BRIDGE_DIR, 'artifacts.json'), 'utf8'))
    const items = Array.isArray(payload?.items) ? payload.items : []
    const fresh = items.filter((item) => Date.now() - Number(item.updatedAt ?? 0) <= ARTIFACT_KEEP_MS)
    return fresh.slice(0, 3).map((item) => ({
      id: `artifact:${item.path}`,
      kind: 'artifact',
      agent: item.kind ?? 'file',
      title: item.name ?? item.relative ?? '未命名产物',
      status: 'done',
      path: item.path,
      updatedAt: Number(item.updatedAt ?? Date.now()),
    }))
  } catch {
    return []
  }
}

/** 提问的可见文本：header 优先（短），否则问题原文。 */
function questionHeadline(question) {
  if (question === undefined || question === null) return ''
  const raw = typeof question.header === 'string' && question.header.trim() !== ''
    ? question.header
    : (typeof question.question === 'string' ? question.question : '')
  return raw.replace(/\s+/g, ' ').trim()
}

/**
 * 旁听一条会话内提问（prepend listener 里调用）：只记文本与选项，然后调用方必须 next()。
 * 气泡/桌面卡是否显示不归这里管，所以这里绝不 return 答案。
 */
function tapQuestion(request) {
  try {
    const sessionId = request?.agent?.session?.id ?? request?.agent?.id
    if (sessionId === undefined || sessionId === null) return
    const questions = Array.isArray(request.questions)
      ? request.questions.slice(0, 9).map((question, index) => ({
          // 没有 id 的题用 q0/q1 兜底：HUD 的自由文本入口用同一套，否则回执 id 对不上。
          id: String(question?.id ?? `q${index}`),
          question: typeof question?.question === 'string' ? question.question : '',
          header: typeof question?.header === 'string' ? question.header : null,
          options: Array.isArray(question?.options)
            ? question.options.slice(0, 9).map((option) => ({
                label: typeof option?.label === 'string' ? option.label : String(option ?? ''),
                description: typeof option?.description === 'string' ? option.description : null,
              }))
            : null,
          multiSelect: question?.multiSelect === true,
        }))
      : []
    const record = { questions, at: Date.now() }
    questionTap.set(String(sessionId), record)
    log(`question tap session=${String(sessionId).slice(0, 12)} n=${questions.length} head=${questionHeadline(questions[0]).slice(0, 24)}`)
    return record
  } catch (error) {
    // 旁听失败绝不能让提问本身失败：调用方无条件 next()。
    log(`question tap error ${String(error && error.message ? error.message : error).slice(0, 200)}`)
    return undefined
  }
}

/**
 * 权威「谁在等回答」：typertGateway 里未决的 forwarded Remote 事件。
 * 一次调用取全部，比逐会话 state() 便宜；不可用时返回 null（feed 退化为只靠旁听记录）。
 */
function pendingQuestionSessions(ctx) {
  try {
    const gateway = ctx.get('typertGateway')
    if (gateway === undefined || gateway === null || typeof gateway.getPendingRemoteEvents !== 'function') return null
    const out = new Set()
    for (const info of gateway.getPendingRemoteEvents()) {
      if (info?.event !== 'user-questions/request') continue
      out.add(String(info.agentId))
    }
    return out
  } catch (error) {
    log(`questions pending error ${String(error && error.message ? error.message : error).slice(0, 200)}`)
    return null
  }
}

/** 短随机串（请求 id / 一次性 token）。 */
function randomToken(length) {
  let out = ''
  while (out.length < length) out += Math.random().toString(36).slice(2)
  return out.slice(0, length)
}

/**
 * 有没有活着的 Web 客户端（Typert 连接的浏览器/桌面页）。
 * 有客户端时桌面提问卡会正常弹出，雷达**不许**接管（用户裁定第 2 条）；探测不到也按「有」处理。
 */
function hasLiveWebClient(ctx) {
  try {
    const gateway = ctx.get('typertGateway')
    if (gateway !== undefined && gateway !== null && typeof gateway.hasLiveClient === 'function') {
      return gateway.hasLiveClient() !== false
    }
  } catch (error) {
    log(`question client probe error ${String(error && error.message ? error.message : error).slice(0, 160)}`)
  }
  return true
}

/** 接管前提：HUD 活着 + 没有活客户端。任一不成立都必须 next()，把请求还给桌面卡。 */
function takeoverVerdict(ctx) {
  if (!hudAlive(hudPid())) return 'hud-dead'
  if (hasLiveWebClient(ctx)) return 'client-live'
  return 'ok'
}

function stopQuestionWatcher() {
  if (questionWatcher === undefined) return
  try { clearInterval(questionWatcher) } catch { /* ignore */ }
  questionWatcher = undefined
}

/** HUD 死了就没人在面板上作答：立刻把还在手上的请求全部让渡，别让模型侧干等（R-05）。 */
function ensureQuestionWatcher() {
  if (questionWatcher !== undefined) return
  questionWatcher = setInterval(() => {
    if (questionHold.size === 0) { stopQuestionWatcher(); return }
    if (hudAlive(hudPid())) return
    for (const [requestId, held] of [...questionHold]) {
      log(`question yield hud-dead request=${requestId}`)
      held.settle('yield', undefined)
    }
  }, 1000)
}

/**
 * 接管一条会话内提问：登记成可被 `/x-radar/question-answer` 作答的条目，
 * 并在 QUESTION_HOLD_MS 后无条件 next() 让渡（返回下游的答案）。
 */
function holdQuestion(ctx, request, next, tap) {
  const requestId = randomToken(12)
  const token = randomToken(16)
  const sessionId = String(request?.agent?.session?.id ?? request?.agent?.id ?? '')
  const questions = Array.isArray(tap?.questions) ? tap.questions : []
  return new Promise((resolve) => {
    let done = false
    const settle = (why, answers) => {
      if (done) return
      done = true
      try { clearTimeout(timer) } catch { /* ignore */ }
      questionHold.delete(requestId)
      if (questionHold.size === 0) stopQuestionWatcher()
      if (why === 'answered') {
        // shape=array 是 t13 定稿的回执形状 {answers:[{id,selected,custom?}]}；日志留证便于门禁 grep。
        const customCount = answers.filter((entry) => typeof entry?.custom === 'string').length
        const ids = answers.map((entry) => String(entry?.id ?? '')).join(',')
        log(`question answered request=${requestId} session=${sessionId.slice(0, 12)} ` +
          `n=${answers.length} shape=array ids=${ids} custom=${customCount}`)
        resolve({ answers })
        return
      }
      log(`question yield ${why} request=${requestId} session=${sessionId.slice(0, 12)}`)
      // 让渡 = 交回下游（桌面提问卡 / 别的 answerer）。下游失败要照原样抛出去。
      resolve(next())
    }
    const timer = setTimeout(() => settle('yield', undefined), QUESTION_HOLD_MS)
    questionHold.set(requestId, { token, sessionId, questions, settle, at: Date.now() })
    if (tap !== undefined) {
      tap.requestId = requestId
      tap.token = token
      tap.takenOverAt = Date.now()
    }
    ensureQuestionWatcher()
    log(`question hold request=${requestId} session=${sessionId.slice(0, 12)} n=${questions.length} ms=${QUESTION_HOLD_MS}`)
  })
}

/**
 * HUD 回执校验：官方形状是数组 `{answers:[{id, selected:[label], custom?}]}`（用户裁定第 5 条）。
 * 只接受本请求里出现过的 question id / option label；返回 null 表示形状不合法。
 */
function normalizeDshAnswers(raw, questions) {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const byId = new Map()
  for (const question of questions ?? []) byId.set(String(question.id), question)
  const out = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') return null
    const id = String(entry.id ?? '')
    const question = byId.get(id)
    if (question === undefined) return null
    const selected = (Array.isArray(entry.selected) ? entry.selected : [])
      .map((value) => String(value))
      .filter((value) => (question.options ?? []).some((option) => option.label === value))
    const custom = typeof entry.custom === 'string' && entry.custom.trim() !== '' ? entry.custom.trim().slice(0, 200) : undefined
    if (selected.length === 0 && custom === undefined) return null
    if (question.multiSelect !== true && selected.length > 1) return null
    out.push({ id, selected, ...(custom === undefined ? {} : { custom }) })
  }
  return out
}

/** 某会话正在被接管的请求（feed 用：HUD 要知道这条能就地提交、还有多久让渡）。 */
function holdForSession(sessionId) {
  for (const [requestId, held] of questionHold) {
    if (held.sessionId === String(sessionId)) return { requestId, ...held }
  }
  return undefined
}

const SOURCE_DSH = 'dsh'

/**
 * 会话内提问 → feed 条目（kind=question，source=dsh）。
 * 与桥里的提问（pendingApprovals 那条路）共用 kind，但 source 区分来源（t4 §0 D2）。
 */
function dshQuestionItems(ctx, sessions) {
  const pending = pendingQuestionSessions(ctx)
  const source = pending === null ? 'unavailable' : 'typertGateway'
  if (pending === null || pending.size === 0) return { items: [], pending: pending ?? new Set(), source }
  const byId = new Map()
  for (const session of sessions?.items ?? []) {
    if (typeof session?.id === 'string' && session.id !== '') byId.set(session.id, session)
  }
  const nowMs = Date.now()
  // 已经没有等待方的接管条目立即作废（会话里答完了/超时让渡了）：不能留着可点入口。
  for (const [id, held] of [...questionHold.entries()]) {
    if (pending.has(held.sessionId)) continue
    log(`stale question dropped id=${id} session=${String(held.sessionId).slice(0, 12)} reason=no-waiter`)
    held.settle('yield', undefined)
  }
  for (const [id, tap] of [...questionTap.entries()]) {
    if (pending.has(id)) continue
    if (nowMs - Number(tap?.at ?? 0) < 5_000) continue
    questionTap.delete(id)
    log(`stale question dropped id=question:${String(id).slice(0, 12)} reason=no-waiter`)
  }
  const items = []
  for (const id of pending) {
    const tap = questionTap.get(id)
    if (tap !== undefined && nowMs - Number(tap.at ?? 0) > QUESTION_TAP_TTL_MS) questionTap.delete(id)
    const questions = Array.isArray(tap?.questions) && tap.questions.length > 0 ? tap.questions : undefined
    const session = byId.get(id)
    const headline = questionHeadline(questions?.[0])
    const fallback = typeof session?.title === 'string' && session.title !== '' ? session.title : '会话在等你回答'
    const held = holdForSession(id)
    items.push({
      kind: 'question',
      id: `question:${id}`,
      source: SOURCE_DSH,
      sessionId: id,
      agent: 'dsh',
      title: headline === '' ? fallback : headline,
      // 结构化问题与选项原样透传，HUD 面板逐条渲染（与桥内提问同形状）。
      questions,
      status: 'needs-answer',
      updatedAt: Number(tap?.at ?? nowMs),
      // 被接管才有回执通道：HUD 拿这组字段直接提交，字段缺失=只能提醒（回 DSH 里答）。
      ...(held === undefined ? {} : {
        answerRequest: held.requestId,
        answerToken: held.token,
        answerExpiresInMs: Math.max(0, QUESTION_HOLD_MS - (nowMs - Number(held.at ?? nowMs))),
      }),
    })
  }
  return { items, pending, source }
}

/** feed 截断上限：面板一屏 6 行 + 滚动，40 条足够覆盖一屏之外的真实任务。 */
const MAX_ITEMS = 40

async function buildRadar(ctx) {
  void diagOnce(ctx)
  // 端口要先知道：待批准队列是向桥（同一宿主进程）取的 HTTP 接口。
  let port
  try {
    port = ctx.get('webServer')?.port
  } catch {}
  const runs = bridgeRuns()
  const sessions = await sessionItems(ctx)
  const approvals = await pendingApprovals(port)
  // 会话内提问（DSH 自己的 ask_user_question）是独立于桥的第二套机制：单独取，单独标 source。
  const dshQuestions = dshQuestionItems(ctx, sessions)
  const pendingAnswerIds = dshQuestions.pending
  const items = []

  const runsById = new Map(runs.map((run) => [run.id, run]))
  for (const approval of approvals) {
    // 僵尸审批/提问（用户现场 2026-11-19：胶囊停在一个永远点不动的「取消/回答」页）：
    // 没有活 waiter、run 已终态、或子进程已死 → 一律判失效，不进 feed，也不给可点入口。
    const staleReason = staleApprovalReason(approval, runsById)
    if (staleReason !== null) {
      log(`stale approval dropped id=${String(approval.id).slice(0, 12)} ` +
        `run=${String(approval.runId ?? '-').slice(0, 12)} agent=${approval.agent ?? '-'} reason=${staleReason}`)
      continue
    }
    const kind = approvalKind(approval)
    items.push({
      kind,
      id: `approval:${approval.id}`,
      approvalId: String(approval.id),
      // 桥每次审批都发一个一次性的 token：HUD 的 accept/decline 要回传它，
      // 否则任何人都能凭 id 替别人放行（F-02）。
      approvalToken: typeof approval.token === 'string' ? approval.token : null,
      // 宿主重启后遗留的审批没有活 waiter：HUD 要说明「已无法处理」，
      // 而不是给用户一个点了必然失败的按钮。
      stale: approval.stale === true,
      runId: approval.runId ?? null,
      agent: typeof approval.agent === 'string' ? approval.agent : 'codex',
      title: describeApproval(approval),
      // 提问把结构化选项原样透传给 HUD：面板逐条渲染、选中即回执（2.20）。
      questions: kind === 'question' ? questionsOf(approval) : undefined,
      status: kind === 'question' ? 'needs-answer' : 'needs-approval',
      updatedAt: Date.parse(approval.at ?? '') || Date.now(),
    })
  }

  // 会话内提问排在所有批准之前渲染（用户在等人答，这是当下唯一可动作的事）。
  for (const item of dshQuestions.items) items.push(item)

  // 队列里没有对应审批的 run 一律不算「待批准」：桥在启动时会把这类 run 对账成 failed，
  // 但雷达也要能独立识别（旧数据/桥没来得及对账时不再显示自相矛盾的行）。
  const approvalRunIds = new Set(
    items.filter((item) => typeof item.runId === 'string' && item.runId !== '').map((item) => item.runId),
  )
  const orphanNoted = new Set()
  const ACTIVE_RUN = new Set(['running', 'starting', 'queued', 'needs-approval'])
  const superseded = supersededRuns()
  const hiddenRuns = readHiddenRuns()
  // 「返工中/待验收」必须是**有活动的**：verdict=needs_revision 只是历史裁决，不代表现在
  // 真有一次重跑在跑（用户口径 2026-11-19：「依旧显示 codex 返工中，实际没有任何东西」）。
  // 真发起返工时桥会起一条新 run（雷达账本记 retryOf）→ 旧行被 superseded 隐藏、新行显示
  // 「进行中」，所以这里不存在「有活的续跑却仍是 rework」的行；剩下的 rework 一律按无活动处理。
  const REVISION_TTL_MS = 30 * 60 * 1000
  for (const run of runs) {
    // 双击/批量清掉的测试 run：永久不再出现在列表（不删桥的数据）。
    if (hiddenRuns[run.id] !== undefined) continue
    // 只有两类 run 进面板：①正在跑/等批准的；②有任务契约、真的过闸判别的。
    // 无契约的历史 run（含接入判别层之前的测试 run）一律不进胶囊，避免面板被噪声灌满。
    if (superseded[run.id] === true) {
      log(`run superseded by retry id=${run.id.slice(0, 8)}`)
      continue
    }
    const active = ACTIVE_RUN.has(run.status)
    // 刚跑完的（60 分钟内）也要留，否则完成提醒永远不会触发；更早的历史 run 才排除。
    const recent = Date.now() - Number(run.updatedAt ?? 0) <= 60 * 60 * 1000
    if (!active && run.hasContract !== true && !recent) continue
    let status = run.status
    let reason = run.reason ?? null
    if (status === 'needs-approval' && !approvalRunIds.has(run.id)) {
      // 审批队列里没有它 = 没有可裁决对象（宿主重启后 waiter 丢失）。
      status = 'failed'
      reason = 'no_live_waiter'
      if (!orphanNoted.has(run.id)) {
        orphanNoted.add(run.id)
        log(`radar run orphaned id=${run.id.slice(0, 8)} from=needs-approval to=failed reason=no_live_waiter`)
      }
    }
    // 失败行必须能说「为什么失败」（t14 bug 3）：meta.error → 最后一条错误事件 → reason 码兜底。
    let error = null
    // 僵尸 running（t14 续 bug 1 / 2）：桥只对账 needs-approval；子进程崩掉留下的 running 没人收尾。
    // 分两级：进程没了（kill(pid,0)=ESRCH）立刻落终态；进程还在但 10 分钟没动静才算 stale。
    const stale = staleRunStatus({ status, updatedAt: run.updatedAt }, Date.now())
    const runningish = status === 'running' || status === 'starting' || status === 'queued'
    if (runningish && run.pidAlive === false) {
      const tail = lastRunEventKind(run.id)
      status = tail === 'turn.end' ? 'done' : 'failed'
      if (tail === 'turn.end') {
        log(`process-exited run=${run.id.slice(0, 8)} agent=${run.agent} pid=${run.pid} last=turn.end -> done`)
      } else {
        reason = 'process-exited'
        error = '进程已退出（process-exited）'
        log(`process-exited run=${run.id.slice(0, 8)} agent=${run.agent} pid=${run.pid} last=${tail ?? 'none'} -> failed`)
      }
    } else if (stale !== null) {
      const tail = lastRunEventKind(run.id)
      status = tail === 'turn.end' ? 'done' : 'failed'
      reason = tail === 'turn.end' ? reason : 'stale-running'
      if (tail !== 'turn.end') error = '超过 10 分钟没有任何新事件（可能卡住了，stale-running）'
      log(`stale-running run=${run.id.slice(0, 8)} agent=${run.agent} ageMin=${Math.round(stale.ageMs / 60000)} last=${tail ?? 'none'} -> ${status}`)
    }
    if ((status === 'done' || status === 'failed') && run.seen) status = 'idle'
    if (status === 'idle' || status === 'unknown') {
      status = run.verdict === 'needs_revision'
        ? 'rework'
        : run.verdict === 'verified'
          ? 'done'
          : run.hasContract
            ? 'unverified'
            : 'idle'
    }
    if (status === 'idle') continue
    // 无活动的裁决态降级：返工要绑定活的续跑，待验收/未验证超过 30 分钟就当作历史噪声。
    let note = null
    const revisionAge = Date.now() - Number(run.updatedAt ?? 0)
    if (status === 'rework') {
      if (revisionAge > REVISION_TTL_MS) {
        log(`rework stale run=${run.id.slice(0, 8)} ageMin=${Math.round(revisionAge / 60000)} -> hidden`)
        continue
      } else {
        // 降级成「已完成」，但诚实说明：验收没过，也没有自动返工。
        status = 'done'
        note = '验收未通过，未自动返工'
        log(`rework unbound run=${run.id.slice(0, 8)} -> done (no live continuation)`)
      }
    } else if (status === 'verifying' || status === 'unverified') {
      if (revisionAge > REVISION_TTL_MS) {
        log(`${status} stale run=${run.id.slice(0, 8)} ageMin=${Math.round(revisionAge / 60000)} -> hidden`)
        continue
      }
      note = status === 'verifying' ? '等裁决（判别层没有回话）' : '没签验收契约，按完成处理'
    }
    // 判别层判「受阻」但没有可处置的审批/提问（用户现场：行上写「需你决定」，点开却没有任何可点项）：
    // 这种 blocked 是历史裁决，不是真在等人 → 降级为 failed 并写明原因，交给失败动作页（重试/复制/清掉）。
    if (status === 'blocked') {
      const actionable = approvals.some((approval) => approval?.runId === run.id)
      if (!actionable) {
        status = 'failed'
        reason = 'blocked-no-action'
        error = '判别层判「受阻」，但没有可处置的审批或提问（blocked-no-action）'
        log(`blocked-no-action run=${run.id.slice(0, 8)} -> failed`)
      } else {
        log(`blocked actionable run=${run.id.slice(0, 8)} approvals=1`)
      }
    }
    if (run.seen === true && (status === 'done' || status === 'failed' || status === 'unverified')) continue
    if (status === 'failed' && error === null) {
      // 降级时已经写过的人话原因（blocked-no-action 等）优先，别再被 run.error 覆盖掉。
      error = clipError(run.error) ?? clipError(lastRunErrorText(run.id)) ?? clipError(reasonText(reason)) ?? null
    }
    items.push({ ...run, kind: 'run', status, reason, error, note })
  }
  // 会话完成后的保留：running→idle 的瞬间记一笔，60 分钟内且没看过就留在胶囊里可点。
  const TRACK_FILE = trackFile()
  const FINISHED_KEEP_MS = 60 * 60 * 1000
  let track = { running: {}, finished: {}, titles: {}, started: {}, finishedAt: {} }
  try {
    const saved = JSON.parse(readFileSync(TRACK_FILE, 'utf8'))
    track = {
      running: saved.running ?? {}, finished: saved.finished ?? {},
      titles: saved.titles ?? {}, started: saved.started ?? {},
      finishedAt: saved.finishedAt ?? {},
    }
  } catch {}
  const nowMs = Date.now()
  const seenSet = new Set(Object.keys(readSeen()))
  for (const session of sessions.items) {
    const id = session.id
    if (!id) continue
    if (session.title) track.titles[id] = session.title
    if (session.status === 'running') {
      if (seenSet.has(id)) {
        const seen = readSeen()
        delete seen[id]
        try { writeFileSync(seenFile(), JSON.stringify(seen, null, 2)) } catch {}
        seenSet.delete(id)
      }
      track.running[id] = nowMs
      if (track.started[id] === undefined) track.started[id] = nowMs
      delete track.finished[id]
    }
  }
  for (const session of sessions.items) {
    const id = session.id
    if (!id) continue
    if (session.status === 'running') {
      // 等回答的会话不再计入「进行中」：胶囊必须能说「在等你回答」，而不是「在忙」（t4 §0 D1）。
      // 它的可见行由 dshQuestions 的 kind=question 条目负责，这里不重复出一行。
      if (pendingAnswerIds.has(id)) continue
      items.push({ ...session, startedAt: track.started[id] ?? nowMs })
      continue
    }
    if (track.running[id] !== undefined) {
      track.finished[id] = nowMs
      track.finishedAt[id] = nowMs
      delete track.running[id]
    }
  }
  // DSH 事实优先：会话又跑起来 / 用户在它里面说过话 / 行已经消失 ⇒ 视为「已消费」，清掉自记未读。
  const sessionById = new Map()
  for (const item of sessions.items) {
    if (item.kind === 'session' && typeof item.id === 'string') sessionById.set(item.id, item)
  }
  for (const [id, at] of Object.entries(track.finished)) {
    const finishedAtMs = Number(track.finishedAt[id] ?? at)
    const row = sessionById.get(id)
    const lastPrompt = row?.lastPromptAt
    let clearSource = null
    if (row === undefined) clearSource = 'dsh-gone'
    else if (row.status === 'running') clearSource = 'dsh-running'
    else if (Number.isFinite(lastPrompt) && lastPrompt > finishedAtMs) clearSource = 'dsh-prompt'
    if (clearSource !== null) {
      log(`session unread clear id=${id} source=${clearSource}`)
      delete track.finished[id]
      delete track.finishedAt[id]
      delete track.started[id]
      continue
    }
    if (nowMs - Number(at) > FINISHED_KEEP_MS || seenSet.has(id)) {
      delete track.finished[id]
      delete track.started[id]
      delete track.finishedAt[id]
      continue
    }
    const title = track.titles[id] ?? id
    // startedAt 是「第一次看到这个会话在跑」的时间，不是本次任务的开始时间：历史会话可能
    // 落后几百上千小时，详情里算「耗时」会算出 3000+ 小时这种噪声（用户 2026-11-19 报）。
    // 只有差值落在可解释的窗口内（≤6 小时）才把它当作本次耗时，否则不下发 startedAt，
    // 让详情只显示「完成于 <相对时间>」。
    const doneAtMs = track.finishedAt[id] ?? Number(at)
    const startedAtMs = track.started[id]
    const observedMs = Number.isFinite(startedAtMs) ? doneAtMs - Number(startedAtMs) : NaN
    const usableStarted = Number.isFinite(observedMs) && observedMs > 0 && observedMs <= 6 * 60 * 60 * 1000
      ? startedAtMs
      : undefined
    items.push({
      kind: 'session',
      id,
      title,
      startedAt: usableStarted,
      finishedAt: doneAtMs,
      status: 'done',
      agent: 'dsh',
      updatedAt: Number(at),
    })
  }
  try {
    writeFileSync(TRACK_FILE, JSON.stringify(track))
  } catch {}

  // 用户口径（2026-11-13）：胶囊数字 = 正在进行的顶层会话数；
  // 子智能体/子会话不计入，审批与完成未看只作为次要提示。
  // 完成未看的唯一键：run 用 id#run，session 用 id#<finishedAt 毫秒>（updatedAt 会随后续
  // 事件前移，同一轮会被误判成新事件）。HUD 的通知计数与点击清单一律用这批 id 派生，
  // 保证「标题 N = ids.size = counts.doneUnread」（t17 的 finding：三者曾各算各的）。
  const doneKeys = new Set()
  const doneUnreadIds = []
  for (const item of items) {
    if (item.status !== 'done' || typeof item.id !== 'string') continue
    const round = item.finishedAt === undefined || item.finishedAt === null
      ? Math.trunc(Number(item.updatedAt ?? 0))
      : Math.trunc(Number(item.finishedAt) * 1000)
    const key = item.kind === 'session' ? `${item.id}#${round}` : `${item.id}#run`
    if (doneKeys.has(key)) continue
    doneKeys.add(key)
    doneUnreadIds.push(item.id)
    if (doneUnreadIds.length >= 200) break
  }

  const counts = {
    running: items.filter((item) => item.kind === 'session' && item.status === 'running').length,
    // 审批与提问都算「等你处理」：胶囊红呼吸 + 告警横幅都看这个数。
    approvals: items.filter((item) => item.kind === 'approval' || item.kind === 'question').length,
    questions: items.filter((item) => item.kind === 'question').length,
    failed: items.filter((item) => item.kind === 'run' && item.status === 'failed').length,
    doneUnread: doneUnreadIds.length,
  }
  // 会话内提问（DSH 自己的 ask_user_question）单独计数：排障时能区分「桥在等」与「会话在等」。
  counts.questionsDsh = items.filter((item) => item.kind === 'question' && item.source === SOURCE_DSH).length
  counts.pending = counts.running

  // 办公产物：最近 6 小时内生成的 docx / xlsx / pptx / pdf，最多 3 条（点一下在 Finder 定位）。
  // 代确认次数（bridge 写 ~/.dsh/agent-bridge/workbuddy-confirms.json，一行一次）
  try {
    const confirmFile = join(BRIDGE_DIR, 'workbuddy-confirms.json')
    if (existsSync(confirmFile)) {
      const lines = readFileSync(confirmFile, 'utf8').split('\n').filter(Boolean)
      const today = new Date().toISOString().slice(0, 10)
      counts.autoConfirmed = lines.filter((line) => line.includes(today)).length
    }
  } catch {}
  const artifacts = artifactItems()
  if (artifacts.length) {
    items.splice(items.length, 0, ...artifacts)
    counts.artifacts = artifacts.length
  }

  // t14 bug 2：排序口径 = 先问「能不能动手」，再看「出没出问题」，最后才是完成。
  // question(0) > approval(1) > failed(2) > running(3) > rework/blocked(4) > verifying(5) > done(6) > artifact/其它(7)
  // 旧版把 done 和 failed 排前面、running 靠后，于是 16 条 done 一铺，running 与 failed 被截断掉。
  const priorityOf = (item) => {
    if (item.kind === 'question') return 0
    if (item.kind === 'approval') return 1
    if (item.kind === 'run' && item.status === 'failed') return 2
    if (item.kind === 'session' && item.status === 'running') return 3
    if (item.kind === 'run' && ['running', 'starting', 'queued', 'needs-approval'].includes(item.status)) return 3
    if (item.status === 'rework' || item.status === 'blocked') return 4
    if (item.status === 'verifying' || item.status === 'unverified') return 5
    if (item.status === 'done') return 6
    return 7
  }
  for (const item of items) item.priority = priorityOf(item)
  items.sort((left, right) => (left.priority - right.priority) || ((right.updatedAt ?? 0) - (left.updatedAt ?? 0)))

  // t14 bug 3 附带项：同一 agent 的连续同标题 done 折叠成一条（带 count），
  // 否则真实任务永远被自己的 smoke/测试 run 挤出列表。细节：只折叠相邻的，跨状态不折叠。
  const folded = []
  const doneGroups = new Map()
  for (const item of items) {
    if (item.kind === 'run' && item.status === 'done') {
      const key = `${item.agent ?? ''}|${item.title ?? ''}`
      const kept = doneGroups.get(key)
      if (kept !== undefined) {
        kept.count = (kept.count ?? 1) + 1
        continue
      }
      doneGroups.set(key, item)
    }
    folded.push(item)
  }
  items.length = 0
  items.push(...folded)

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    counts,
    // 未读完成的完整 id 清单（不受 items.slice(12) 截断影响），HUD 用它做标题数、
    // 点击清单一与去重键，避免「25 个任务完成」但只清掉可见的 12 条。
    doneUnreadIds,
    items: items.slice(0, MAX_ITEMS),
    total: items.length,
    sources: { sessions: sessions.source, runs: runs.length, questions: dshQuestions.source },
    clientHalf: clientHalfState(),
    dsh: { port: port ?? null, url: port === undefined ? null : `http://127.0.0.1:${port}` },
  }
}

// feed 快照缓存（t5 M4：p50 59.2ms > 门 50ms，54ms 全在每次请求都 await sessionController.list()）。
// HUD 每 2s 拉一次、突发重连会连拉多次，1s 快照足够新，且把 p50 从「每次都等 list()」变成「大多命中」。
// 单飞：并发请求共用一次 buildRadar，避免缓存过期时同时打多份 list()。
const SNAPSHOT_TTL_MS = 1000
let snapshotAt = 0
let snapshotBody = null
let snapshotInflight = null

function refreshSnapshot(ctx) {
  if (snapshotInflight) return snapshotInflight
  snapshotInflight = buildRadar(ctx)
    .then((body) => {
      snapshotAt = Date.now()
      snapshotBody = body
      return body
    })
    .finally(() => { snapshotInflight = null })
  // 后台刷新的失败不能变成未捕获拒绝：留着旧快照，下次请求再试。
  snapshotInflight.catch(() => {})
  return snapshotInflight
}

// 让下一次 /radar 立刻重建：置已读、批/拒之后必须马上看到新状态，不能等 TTL。
function invalidateSnapshot() {
  snapshotAt = 0
  snapshotBody = null
}

// stale-while-revalidate：有快照就立刻返回（p50 从「每次等 list()」降到 1ms 级），
// 过期了在后台补一份；只有冷启动那一次要等 list()。
async function buildRadarCached(ctx) {
  if (snapshotBody) {
    const ageMs = Date.now() - snapshotAt
    if (ageMs >= SNAPSHOT_TTL_MS) refreshSnapshot(ctx)
    return { body: snapshotBody, cached: true, ageMs }
  }
  return { body: await refreshSnapshot(ctx), cached: false, ageMs: 0 }
}

function radarRoute(ctx) {
  const inner = async (request) => {
    const url = new URL(request.url, 'http://localhost')
    const tail = url.pathname.replace(/^\/x-radar(-[a-z])?\/?/, '')
    if (tail === 'beacon') return beaconResponse(url)
    if (tail === 'radar') {
      let body
      let cached = false
      try {
        const snapshot = await buildRadarCached(ctx)
        body = snapshot.body
        cached = snapshot.cached
      } catch (error) {
        log(`radar error ${String(error && error.stack ? error.stack : error).slice(0, 600)}`)
        return new Response(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }), {
          status: 500,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      log(`radar counts pending=${body.counts.pending} running=${body.counts.running} approvals=${body.counts.approvals} questions=${body.counts.questions} qdsh=${body.counts.questionsDsh} rows=${body.items.length} src=${body.sources.sessions} cached=${cached ? 1 : 0}`)
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    if (tail === 'jump') {
      // HUD 点了某条会话行：落一个信箱文件，页面侧的 client 半下一次轮询时消费。
      // 8s 没人 ack 就降级成「打开 App」（PRD 2.22/2.23），并且不把这条当成功。
      const sessionId = url.searchParams.get('session') ?? ''
      if (!sessionId) {
        return new Response(JSON.stringify({ ok: false, error: 'session is required' }), {
          status: 400,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      const stamp = Date.now()
      const record = noteJump(sessionId)
      // 记下「这次真正写到哪个路径」：宿主启动最初几秒 useHostState() 可能把 STATE_DIR
      // 从根目录切到 hosts/<port>/，超时回调若重新算 jumpFile() 会读到空 → 误判 acked
      // （N-16）。record.path 让写入方与超时回调永远看同一个文件。
      const writtenPath = jumpFile()
      record.path = writtenPath
      lastJumpPath = writtenPath
      try {
        mkdirSync(dirname(writtenPath), { recursive: true })
        writeFileSync(writtenPath, JSON.stringify({ sessionId, at: stamp, id: record.id }))
      } catch {}
      const half = clientHalfState()
      log(`jump requested id=${record.id} session=${sessionId.slice(0, 8)} client=${half.active ? 'active' : 'inactive'}`)
      setTimeout(() => {
        if (record.state !== 'pending') return
        // 只认「ack 路由把 record.state 改成 acked」这一条成功路径（N-16）：
        // 文件不存在 ≠ 已被消费——可能是路径切换/被别的进程删掉，一律按 degraded 处理，
        // 该 open -a 就 open -a，绝不把没打开的跳转标成成功。
        let queued = false
        const path = record.path ?? jumpFile()
        try {
          const raw = JSON.parse(readFileSync(path, 'utf8'))
          queued = Boolean(raw) && Number(raw.at ?? 0) === stamp
        } catch {}
        record.state = 'degraded'
        record.degradeReason = queued ? 'no-ack' : 'mailbox-missing'
        log(`jump timeout id=${record.id} path=${path} queued=${queued ? 'yes' : 'no'} -> degraded`)
        if (process.env.DSH_TASK_RADAR_JUMP_OPEN === '0') {
          // 测试/回归用：不真的把 App 端到前台，只记降级结论。
          log(`jump.degraded id=${record.id} session=${sessionId.slice(0, 8)} client=inactive open=skipped reason=${record.degradeReason}`)
          try {
            unlinkSync(path)
          } catch {}
          return
        }
        try {
          execFile('/usr/bin/open', ['-a', 'DeepSeek Harness'], { timeout: 4000 }, (error) => {
            if (error) log(`jump.degraded id=${record.id} session=${sessionId.slice(0, 8)} open=error ${error.message} reason=${record.degradeReason}`)
            else log(`jump.degraded id=${record.id} session=${sessionId.slice(0, 8)} client=inactive open=ok reason=${record.degradeReason}`)
          })
        } catch (error) {
          log(`jump.degraded id=${record.id} session=${sessionId.slice(0, 8)} open=throw ${error?.message ?? error}`)
        }
        try {
          unlinkSync(path)
        } catch {}
      }, JUMP_ACK_TIMEOUT_MS).unref?.()
      return new Response(JSON.stringify({ ok: true, id: record.id, client: half.active ? 'active' : 'inactive', timeoutMs: JUMP_ACK_TIMEOUT_MS }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }

    if (tail === 'question-answer') {
      // HUD 面板就地作答：只认被接管（holdQuestion 登记）的请求 + 一次性 token。
      // 用户裁定第 5 条：回执形状是数组 `{answers:[{id, selected:[label], custom?}]}`。
      const requestId = url.searchParams.get('request') ?? ''
      const token = url.searchParams.get('token') ?? ''
      const held = questionHold.get(requestId)
      const fail = (status, error) => new Response(JSON.stringify({ ok: false, error }), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
      if (held === undefined) {
        log(`question answer rejected request=${requestId.slice(0, 12)} reason=not-pending`)
        return fail(410, 'request not pending')
      }
      if (token === '' || token !== held.token) {
        log(`question answer rejected request=${requestId.slice(0, 12)} reason=bad-token`)
        return fail(403, 'bad token')
      }
      let parsed
      try {
        parsed = JSON.parse(url.searchParams.get('answers') ?? '')
      } catch {
        return fail(400, 'answers must be JSON array')
      }
      const answers = normalizeDshAnswers(parsed, held.questions)
      if (answers === null) {
        log(`question answer rejected request=${requestId.slice(0, 12)} reason=bad-shape`)
        return fail(400, 'answers must be [{id, selected:[label], custom?}]')
      }
      held.settle('answered', answers)
      invalidateSnapshot()
      return new Response(JSON.stringify({ ok: true, request: requestId, answered: answers.length }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    if (tail === 'questions') {
      // 排障用：会话内提问的两路证据（权威未决集合 + 旁听到的文本）。
      const pending = pendingQuestionSessions(ctx)
      const taps = []
      for (const [sessionId, tap] of questionTap) {
        taps.push({
          sessionId,
          ageMs: Date.now() - Number(tap.at ?? 0),
          questions: (tap.questions ?? []).map((question) => ({
            id: question.id,
            header: question.header,
            question: String(question.question ?? '').slice(0, 120),
            options: (question.options ?? []).map((option) => option.label),
          })),
        })
      }
      const gateway = (() => {
        try {
          return typeof ctx.get('typertGateway')?.getPendingRemoteEvents === 'function' ? 'typertGateway' : 'unavailable'
        } catch { return 'unavailable' }
      })()
      return new Response(JSON.stringify({
        ok: true,
        source: gateway,
        pending: pending === null ? null : [...pending],
        holds: [...questionHold].map(([requestId, held]) => ({
          request: requestId,
          sessionId: held.sessionId,
          ageMs: Date.now() - Number(held.at ?? 0),
          remainingMs: Math.max(0, QUESTION_HOLD_MS - (Date.now() - Number(held.at ?? 0))),
          questions: (held.questions ?? []).map((question) => ({ id: question.id, multiSelect: question.multiSelect === true })),
        })),
        taps,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }

    if (tail === 'health') {
      // `clientLive`：宿主此刻是否有活着的 Web 客户端。R-03/U-04 的判据要用它区分
      // 「页面没在轮询」和「压根没人打开页面」——后者不该记成产品缺陷（t14 门禁收紧项）。
      const clientHalf = clientHalfState()
      const clientLive = hasLiveWebClient(ctx) === true
      return new Response(JSON.stringify({
        ok: true,
        clientLive,
        clientHalf,
        host: { port: STATE_PORT ?? null, dir: STATE_DIR, clientBuild: CLIENT_BUILD || null },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }

    if (tail === 'jump-status') {
      // HUD 轮询这里的结论：acked / degraded / pending。unknown/过期 = 失败路径。
      const id = url.searchParams.get('id') ?? ''
      const record = jumpById(id)
      if (!record) {
        return new Response(JSON.stringify({ ok: false, state: 'unknown', id }), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      return new Response(JSON.stringify({ ok: true, id: record.id, sessionId: record.sessionId, state: record.state, ageMs: Date.now() - record.at }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    if (tail === 'jump-pending') {
      // 页面侧的 client 半来取；超过 15 秒的请求视为过期，不再打扰用户。
      let body = { sessionId: null, reload: lastClientBuild !== '' && lastClientBuild !== CLIENT_BUILD }
      for (const path of jumpCandidatePaths()) {
        try {
          const raw = JSON.parse(readFileSync(path, 'utf8'))
          if (raw && typeof raw.sessionId === 'string' && Date.now() - Number(raw.at ?? 0) < 15000) {
            body = {
              sessionId: raw.sessionId,
              mailbox: path === jumpFile() ? 'host' : 'legacy',
              reload: lastClientBuild !== '' && lastClientBuild !== CLIENT_BUILD,
            }
            break
          }
        } catch {}
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    if (tail === 'jump-ack') {
      const ackId = url.searchParams.get('id') ?? ''
      let acked = ackId ? jumpById(ackId) : undefined
      if (!acked) {
        // 老 client 不传 id：把最近一条还挂着的跳转认成 acked。
        for (const record of recentJumps.values()) if (record.state === 'pending') acked = record
      }
      if (acked) {
        acked.state = 'acked'
        acked.ackedAt = Date.now()
        log(`jump acked id=${acked.id} session=${String(acked.sessionId).slice(0, 8)} lag=${acked.ackedAt - acked.at}ms`)
      }
      for (const path of jumpCandidatePaths()) {
        try {
          unlinkSync(path)
        } catch {}
      }
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
    }
    if (tail === 'debug-sessions') {
      // 排障用：把 sessionController / sessions 看到的原始条目吐出来。
      const out = { controller: null, store: null, agents: [] }
      try {
        const controller = ctx.get('sessionController')
        const summaries = await controller.list(AbortSignal.timeout(1500))
        out.controller = summaries
      } catch (error) {
        out.controller = { error: String(error?.message ?? error) }
      }
      try {
        const store = ctx.get('sessions')?.list?.() ?? []
        out.store = store.map((session) => ({
          id: session?.id,
          title: session?.header?.title ?? null,
          parent: session?.header?.parentSession ?? session?.header?.parentSessionId ?? null,
          cwd: session?.header?.cwd ?? null,
        }))
      } catch (error) {
        out.store = { error: String(error?.message ?? error) }
      }
      try {
        const agents = ctx.get('agents')
        if (agents && typeof agents.list === 'function') {
          out.agents = agents.list().map((agent) => ({ id: agent?.id, status: agent?.status }))
        }
      } catch {}
      return new Response(JSON.stringify(out), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    if (tail === 'approval-decide') {
      // HUD 内联审批：代理到桥的审批队列（桥是同一宿主进程里的另一个插件）。
      const approvalId = url.searchParams.get('id') ?? ''
      const token = url.searchParams.get('token') ?? ''
      const decision = url.searchParams.get('decision') === 'accept' ? 'accept' : 'decline'
      // 提问的回执是 {answers:{<questionId>:<option>}}，不是 allow/deny（2.20）：
      // HUD 把「选了哪个选项」编码进 answers（JSON），同时兼容 answer=qid:label。
      let answers = null
      const rawAnswers = url.searchParams.get('answers')
      if (rawAnswers) {
        try {
          const parsed = JSON.parse(rawAnswers)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) answers = parsed
        } catch (error) {
          log(`approval decide bad answers json: ${String(error?.message ?? error)}`)
        }
      }
      const single = url.searchParams.get('answer')
      if (!answers && single && single.includes(':')) {
        const at = single.indexOf(':')
        answers = { [single.slice(0, at)]: single.slice(at + 1) }
      }
      // 归一化成 codex 要的线形状（{qid:{answers:[label]}}），否则选择会丢。
      const rawAnswerMap = answers
      answers = normalizeQuestionAnswers(answers)
      if (!approvalId) {
        return new Response(JSON.stringify({ ok: false, error: 'missing id' }), {
          status: 400,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      }
      let result = { ok: false }
      try {
        const port = ctx.get('webServer')?.port
        const response = await fetch(`http://127.0.0.1:${port}/agent-bridge/approvals/${encodeURIComponent(approvalId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // token 是桥发的一次性凭据：缺失/不匹配时桥回 403，HUD 会保留详情并提示重试。
          body: JSON.stringify(answers ? { answers, token } : { decision, token }),
          signal: AbortSignal.timeout(2500),
        })
        result = await response.json().catch(() => ({ ok: response.ok }))
        result.status = response.status
      } catch (error) {
        result = { ok: false, error: String(error?.message ?? error) }
      }
      const answersNote = answers ? JSON.stringify(answers) : '-'
      const rawNote = answers && rawAnswerMap !== answers ? ` raw=${JSON.stringify(rawAnswerMap)}` : ''
      const dismissedNote = result.dismissed === true ? ' dismissed=yes(reason=no_live_waiter)' : ''
      log(`approval decide id=${approvalId.slice(0, 8)} decision=${decision} answers=${answersNote}${rawNote} ok=${result.ok === true} status=${result.status ?? '-'}${dismissedNote}`)
      // 桥回 404（审批不存在/已过期）和 403（token 不匹配）都要原样透出，
      // 不能一律 502 —— HUD 靠状态码区分「过时」和「桥挂了」。
      const passthrough = [400, 403, 404, 409]
      const status = result.ok ? 200 : passthrough.includes(result.status) ? result.status : 502
      // 批/拒成功或失败都动过审批队列，快照一律作废，避免 HUD 立刻刷新时看到旧的 pending。
      invalidateSnapshot()
      return new Response(JSON.stringify(result), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    if (tail === 'seen') {
      // `id` 允许逗号分隔多个：HUD 的「全部标为已读」一次请求写完。
      const ids = (url.searchParams.get('id') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      if (ids.length === 0) {
        return new Response(JSON.stringify({ ok: false, error: 'id is required' }), {
          status: 400,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      const seen = readSeen()
      const now = Date.now()
      for (const id of ids) seen[id] = now
      let persisted = true
      try {
        mkdirSync(STATE_DIR, { recursive: true })
        writeFileSync(seenFile(), JSON.stringify(seen, null, 2))
      } catch (error) {
        persisted = false
        log(`markSeen failed ids=${ids.length} error=${error?.message ?? error}`)
      }
      // 回读校验：写没写进去用户看不出来（现场：点了「已完成」行，刷新后还在），所以必须自证。
      const reread = persisted ? readSeen() : {}
      const missing = ids.filter((id) => reread[id] === undefined)
      // 会话完成条目置读后同步从 radar-sessions.json 删掉，不然 feed 与账本各说各话。
      let trackRemoved = 0
      if (persisted) {
        try {
          const file = trackFile()
          const saved = JSON.parse(readFileSync(file, 'utf8'))
          for (const id of ids) {
            if (saved.finished?.[id] !== undefined) {
              delete saved.finished[id]
              delete saved.started[id]
              delete saved.finishedAt[id]
              trackRemoved += 1
            }
          }
          writeFileSync(file, JSON.stringify(saved))
        } catch {}
      }
      if (persisted) log(`markSeen ok ids=${ids.length} track=${trackRemoved}`)
      if (missing.length > 0) log(`markSeen failed ids=${missing.length} missing=${missing.slice(0, 3).join(',')}`)
      invalidateSnapshot()
      return new Response(JSON.stringify({
        ok: persisted && missing.length === 0,
        marked: ids.length,
        verified: missing.length === 0,
        missing,
        track: trackRemoved,
      }), {
        status: persisted ? 200 : 500,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    if (tail === 'retry') {
      // 失败行的「重试」：用同一个 prompt/agent/cwd 重新起一个 run。
      // 桥的 POST /agent-bridge/runs 不认 retryOf，所以在雷达自己的账本里记一份
      // （feed 的 item.retryOf 就从这个账本读）。
      const runId = (url.searchParams.get('run') ?? '').trim()
      if (runId === '') {
        return new Response(JSON.stringify({ ok: false, error: 'run is required' }), {
          status: 400,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      const meta = readJson(join(BRIDGE_DIR, 'runs', runId, 'meta.json'), null)
      if (meta === null || typeof meta !== 'object' || typeof meta.prompt !== 'string' || meta.prompt.trim() === '') {
        return new Response(JSON.stringify({ ok: false, error: 'run not found or has no prompt' }), {
          status: 404,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      const bridgePort = ctx.get('webServer')?.port
      if (!Number.isFinite(bridgePort) || bridgePort <= 0) {
        return new Response(JSON.stringify({ ok: false, error: 'webServer port unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      const bridge = `http://127.0.0.1:${bridgePort}/agent-bridge/runs`
      try {
        const created = await fetch(bridge, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: meta.prompt,
            agent: meta.agent === 'claude' ? 'claude' : 'codex',
            cwd: typeof meta.cwd === 'string' ? meta.cwd : undefined,
            ...(typeof meta.model === 'string' && meta.model ? { model: meta.model } : {}),
          }),
          signal: AbortSignal.timeout(6000),
        })
        const body = await created.json().catch(() => null)
        if (!created.ok || body === null || typeof body.runId !== 'string') {
          log(`retry failed run=${runId.slice(0, 8)} status=${created.status} body=${JSON.stringify(body).slice(0, 160)}`)
          return new Response(JSON.stringify({ ok: false, error: 'bridge rejected retry', status: created.status, body }), {
            status: 502,
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
          })
        }
        writeRetryOf(body.runId, runId)
        const seen = readSeen()
        seen[runId] = Date.now()
        try {
          mkdirSync(STATE_DIR, { recursive: true })
          writeFileSync(seenFile(), JSON.stringify(seen, null, 2))
        } catch {}
        invalidateSnapshot()
        log(`retry run=${runId.slice(0, 8)} -> new=${body.runId.slice(0, 8)} agent=${body.agent ?? '?'}`)
        return new Response(JSON.stringify({ ok: true, runId: body.runId, retryOf: runId, agent: body.agent ?? null }), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      } catch (error) {
        log(`retry error run=${runId.slice(0, 8)} ${String(error && error.message ? error.message : error)}`)
        return new Response(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }), {
          status: 502,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
    }
    if (tail === 'hide-session') {
      // 双击会话行选「仅从雷达移除」：写 hidden-sessions.json（永久过滤）+ seen。
      // 只动雷达自己的视图，不碰 DSH 的会话数据（删会话只能在 DSH 里做）。
      const sessionId = (url.searchParams.get('session') ?? '').trim()
      if (sessionId === '') {
        return new Response(JSON.stringify({ ok: false, error: 'session is required' }), {
          status: 400,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      hideSession(sessionId)
      const seen = readSeen()
      seen[sessionId] = Date.now()
      try {
        mkdirSync(STATE_DIR, { recursive: true })
        writeFileSync(seenFile(), JSON.stringify(seen, null, 2))
      } catch {}
      invalidateSnapshot()
      log(`session hidden id=${sessionId.slice(0, 8)}`)
      return new Response(JSON.stringify({ ok: true, hidden: sessionId }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    if (tail === 'jobs') {
      // 排障：后台 job 的观察状态（订阅是否装上、哪些会话还有活 job）。
      const want = url.searchParams.get('session') ?? ''
      const live = [...liveJobs.entries()].map(([owner, count]) => ({ session: owner, jobs: count }))
      const probe = want === '' ? null : { session: want, jobs: liveJobCount(ctx, want, [want]) }
      return new Response(JSON.stringify({ ok: true, subscription: jobsSubscription, live, probe }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    if (tail === 'purge-tests') {
      // 用户口径（2026-11-19）：自测用的 run（`只回答两个字：可以` 这类）不能长期占据列表。
      // 只藏不删：桥的数据保持原样，雷达层写 hidden-runs.json 永久过滤。
      const runs = bridgeRuns()
      const patterns = ['只回答两个字', 'selftest', 'testproc', 'staletest']
      const custom = String(url.searchParams.get('match') ?? '').trim()
      if (custom !== '') patterns.push(custom)
      const hit = []
      for (const run of runs) {
        if (readHiddenRuns()[run.id] !== undefined) continue
        const title = typeof run.title === 'string' ? run.title : ''
        if (!patterns.some((pattern) => title.includes(pattern))) continue
        hideRun(run.id)
        hit.push(run.id)
      }
      invalidateSnapshot()
      log(`purge-tests matched=${hit.length} patterns=${patterns.join('|')}`)
      return new Response(JSON.stringify({ ok: true, hidden: hit.length, runs: hit }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    if (tail === 'clear-done') {
      // t14 bug 4：「清除已完成」= 全部标已读 + 清掉会话 finished 记账，
      // 否则下次重启 radar-sessions.json 里的 finished 会再把 done 行放回来。
      const fresh = await buildRadar(ctx)
      const ids = Array.isArray(fresh.doneUnreadIds) ? fresh.doneUnreadIds : []
      let trackCleared = 0
      if (ids.length > 0) {
        const seen = readSeen()
        const now = Date.now()
        for (const id of ids) seen[id] = now
        try {
          mkdirSync(STATE_DIR, { recursive: true })
          writeFileSync(seenFile(), JSON.stringify(seen, null, 2))
        } catch {}
        try {
          const track = readJson(trackFile(), null)
          if (track !== null && typeof track === 'object') {
            for (const id of ids) {
              if (track.finished?.[id] !== undefined) {
                delete track.finished[id]
                delete track.started[id]
                delete track.finishedAt[id]
                trackCleared += 1
              }
            }
            writeFileSync(trackFile(), JSON.stringify(track))
          }
        } catch {}
        invalidateSnapshot()
      }
      log(`panel clear-done n=${ids.length} track=${trackCleared}`)
      return new Response(JSON.stringify({ ok: true, cleared: ids.length, track: trackCleared }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    return new Response(JSON.stringify({ ok: false, error: 'not found', path: tail }), {
      status: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }
  return async (request) => {
    try {
      return await inner(request)
    } catch (error) {
      log(`radar route error ${String(error && error.message ? error.message : error).slice(0, 400)}`)
      return new Response(JSON.stringify({ ok: false, error: 'internal' }), {
        status: 500,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }
  }
}

// 客户端半边是否真的加载过：0.8.0 的整合包漏掉 client.js 时，HUD 点了行只会
// 写信箱没人消费，所以 jump 的日志里要能看出「页面侧在不在」（R-01 诊断）。
let clientBeacons = 0
let lastClientBuild = ''
let lastClientBeaconAt = 0

// client 半边（页面里跑的 client.js 战报）是否真的在轮询。宿主刚起来的前 30s
// 页面可能还没重载完成，所以 active 的判定要带启动宽限（N-14 / PRD 2.22）。
const HOST_BOOT_AT = Date.now()
// 页面侧 client 半的构建指纹：由 scripts/sync-suite-bundle.sh 在打包时把 __RADAR_CLIENT_BUILD__
// 替换成 client.js 自己的 sha256。页面 beacon 回传它，宿主就能判断「这个页面加载的还是旧 bundle」，
// 从而让页面自己 location.reload()（自愈），并在 HUD 上给一次可见提示。
const CLIENT_BUILD = (() => {
  // 打包时由 scripts/sync-suite-bundle.sh 写出的 sidecar（client.js 里注入的就是这个值）。
  // 不能在这里现算 client.js 的 sha：文件里嵌着这个值，会自引用。
  try {
    const path = fileURLToPath(new URL('./client-build.json', import.meta.url))
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed?.build === 'string' ? parsed.build.slice(0, 16) : 'unknown'
  } catch {
    return 'unknown'
  }
})()

const CLIENT_BEACON_STALE_MS = Number(process.env.DSH_TASK_RADAR_CLIENT_STALE_MS) > 0 ? Number(process.env.DSH_TASK_RADAR_CLIENT_STALE_MS) : 30000
const JUMP_ACK_TIMEOUT_MS = Number(process.env.DSH_TASK_RADAR_JUMP_ACK_MS) > 0 ? Number(process.env.DSH_TASK_RADAR_JUMP_ACK_MS) : 8000

function clientHalfState() {
  const now = Date.now()
  const sinceBoot = now - HOST_BOOT_AT
  const age = lastClientBeaconAt > 0 ? now - lastClientBeaconAt : null
  const fresh = age !== null && age <= CLIENT_BEACON_STALE_MS
  const booting = sinceBoot < CLIENT_BEACON_STALE_MS && lastClientBeaconAt === 0
  return {
    active: fresh || booting,
    lastBeacon: lastClientBeaconAt > 0 ? new Date(lastClientBeaconAt).toISOString() : null,
    ageMs: age,
    sinceBootMs: sinceBoot,
    staleAfterMs: CLIENT_BEACON_STALE_MS,
    beacons: clientBeacons,
    build: lastClientBuild || null,
    hostBuild: CLIENT_BUILD,
    // 页面加载的是旧 bundle（指纹不一致）→ 需要整页重载才能恢复跳转能力。
    reload: lastClientBuild !== '' && lastClientBuild !== CLIENT_BUILD,
    hint: fresh || booting ? null : '跳转需重载页面（client 半边没在轮询）',
  }
}

// 跳转信箱的结果：HUD 点完行要等这里从 pending 变成 acked / degraded 才敢
// markSeen（PRD 2.23）。只保留最近 60s 的记录，避免无限增长。
const recentJumps = new Map()
/// 最近一次真正写出去的 jump 信箱路径（N-16：STATE_DIR 可能在写入后切换）。
let lastJumpPath = ''

/// jump 信箱的所有候选位置：最近写过的、当前宿主目录的、旧版根目录的。
/// client 轮询与 ack 清理都遍历它，避免「写在 A、读的是 B」。
function jumpCandidatePaths() {
  const out = []
  for (const path of [lastJumpPath, jumpFile(), join(BRIDGE_DIR, 'jump.json')]) {
    if (typeof path === 'string' && path && !out.includes(path)) out.push(path)
  }
  return out
}

function noteJump(sessionId) {
  const id = `jump-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  recentJumps.set(id, { id, sessionId, at: Date.now(), state: 'pending' })
  for (const [key, value] of recentJumps) {
    if (Date.now() - value.at > 60000) recentJumps.delete(key)
  }
  return recentJumps.get(id)
}

function jumpById(id) {
  return id ? recentJumps.get(id) : undefined
}

function beaconResponse(url) {
  const event = url.searchParams.get('e') ?? 'unknown'
  const detail = url.searchParams.get('d') ?? ''
  const build = (url.searchParams.get('b') ?? '').slice(0, 32)
  if (event.startsWith('client.') || event === 'apply') {
    clientBeacons += 1
    lastClientBeaconAt = Date.now()
    if (build && build !== lastClientBuild) {
      lastClientBuild = build
      log(`client build=${build} host=${CLIENT_BUILD} ${build === CLIENT_BUILD ? 'match' : 'stale → 需要整页重载'}`)
    }
  }
  log(`client.${event}${detail ? ` ${detail}` : ''}`)
  // 页面收到 stale 就在自己这一侧重载（旧 bundle 的 client 半没有这段逻辑，所以第一次升级仍需手动刷新一次；
  // 之后每次升级都能自愈）。
  const headers = { 'content-type': 'text/plain', 'cache-control': 'no-store' }
  if (build && build !== CLIENT_BUILD) headers['x-radar-reload'] = '1'
  return new Response('ok', { status: 200, headers })
}


/**
 * Publish the radar URL for the native HUD, then start it if the binary exists.
 *
 * The URL file is the stable contract: the DSH webserver port changes on every
 * restart, so the HUD re-reads this file instead of depending on its argv.
 * The HUD owns a single-instance lock, so a second generation launching it is a
 * no-op; we only kill a child we started ourselves.
 */
// hud.pid 现在落在 hosts/<port>/ 下，并且内容带 ownerPort（HUD 写入的 JSON）：
// supervisor 只认「自己端口启动的」HUD，跨宿主不再互杀（N-14）。

/** 只信 pid 文件里的数字还不够：必须确认那个 pid 现在真的是 RadarHUD，
 * 否则一个被用户手改/复用的 pid 文件会让我们 SIGTERM 掉无关进程（R-03）。 */
function isRadarProcess(pid) {
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return command.includes('RadarHUD')
  } catch {
    return false
  }
}

function hudPid() {
  let raw
  try {
    raw = String(readFileSync(hudPidFile(), 'utf8')).trim()
  } catch {
    return undefined
  }
  if (raw.startsWith('{')) {
    try {
      const saved = JSON.parse(raw)
      const pid = Number(saved?.pid)
      if (!Number.isFinite(pid) || pid <= 1) return undefined
      const owner = Number(saved?.ownerPort ?? saved?.port)
      return { pid, owner: Number.isFinite(owner) ? owner : undefined }
    } catch {
      return undefined
    }
  }
  const pid = Number(raw)
  return Number.isFinite(pid) && pid > 1 ? { pid, owner: STATE_PORT } : undefined
}

/** 归属校验：进程得真是 RadarHUD，且 pid 文件记的 ownerPort 必须是本宿主端口。 */
function hudAlive(handle) {
  if (handle === undefined) return false
  const { pid, owner } = typeof handle === 'number' ? { pid: handle, owner: undefined } : handle
  if (owner !== undefined && STATE_PORT !== undefined && owner !== STATE_PORT) {
    log(`host.hud.foreign pid=${pid} owner=${owner} self=${STATE_PORT} (不是本宿主的 HUD，不动)`)
    return false
  }
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  return isRadarProcess(pid)
}

/** 结束一个「确认是自己人」的旧 HUD；身份/归属不符时只清 pid 文件，绝不动进程。 */
function stopHud(handle, why) {
  let killed = false
  const pid = handle === undefined ? undefined : typeof handle === 'number' ? handle : handle.pid
  if (handle !== undefined && hudAlive(handle)) {
    try {
      process.kill(pid, 'SIGTERM')
      killed = true
      log(`host.hud.stale_killed pid=${pid} why=${why}`)
    } catch (error) {
      log(`host.hud.kill.failed pid=${pid} ${String(error && error.message)}`)
    }
  } else if (pid !== undefined) {
    log(`host.hud.pid.dropped pid=${pid} why=${why} (不是 RadarHUD、不是本宿主、或已退出)`)
  }
  try {
    rmSync(hudPidFile(), { force: true })
  } catch {}
  return killed
}

/** 兼容镜像：根目录 radar-url.json 只在「不存在 / 已经指向自己 / 已过期」时刷新，
 *  这样两个宿主并存时不会互相把对方的端口覆盖掉（HUD 与 CLI 都读 hosts/<port>/）。 */
/** 端口上是否还有进程在 listen（同步、~20ms）：用来判断根目录镜像该不该让位。 */
function portListening(port) {
  if (!Number.isFinite(port) || port <= 0) return false
  try {
    execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

function mirrorLegacyUrl(url, port) {
  const legacy = join(BRIDGE_DIR, 'radar-url.json')
  let current
  try {
    current = JSON.parse(readFileSync(legacy, 'utf8'))
  } catch {
    current = undefined
  }
  const currentPort = Number(current?.port)
  const fresh = current && currentPort === port
  // 根文件指向的端口还活着 = 另一个宿主在用，别抢（多宿主并存的关键）。
  const takenByLiveHost = Number.isFinite(currentPort) && currentPort !== port && portListening(currentPort)
  const stale = !current || !Number.isFinite(Number(current.updatedAt)) || Date.now() - Number(current.updatedAt) > 10 * 60 * 1000
  if (fresh || takenByLiveHost || !stale) return
  try {
    writeFileSync(legacy, JSON.stringify({ url, port, updatedAt: Date.now(), mirror: true }, null, 2))
    log(`host.url.mirror port=${port} (兼容旧读法；权威文件在 hosts/${port}/radar-url.json)`)
  } catch {}
}

/**
 * 写 radar-url.json 并**读回校验**（N-02）。
 *
 * HUD 每 2s 重读这个文件，写错一次它就整段离线；所以写完必须回读确认端口一致，
 * 不一致立刻记日志（而不是静默留一个坏文件给下一轮轮询）。
 */
function writeUrlFile(port) {
  const url = `http://127.0.0.1:${port}/x-radar/radar`
  useHostState(port)
  const target = urlFile()
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(target, JSON.stringify({ url, port, host: String(port), updatedAt: Date.now() }, null, 2))
  } catch (error) {
    log(`host.url.write.failed port=${port} ${String(error && error.message ? error.message : error)}`)
    return undefined
  }
  let saved
  try {
    saved = JSON.parse(readFileSync(target, 'utf8'))
  } catch (error) {
    log(`host.url.verify.failed port=${port} unreadable ${String(error && error.message ? error.message : error)}`)
    return undefined
  }
  if (saved?.port !== port || typeof saved?.url !== 'string' || !saved.url.includes(`:${port}/`)) {
    log(`host.url.verify.mismatch wanted=${port} got=${String(saved?.port)} url=${String(saved?.url)}`)
    return undefined
  }
  mirrorLegacyUrl(url, port)
  return url
}

/** 端口就绪时把 URL 文件修回期望值；已一致则什么都不做（供 supervisor 每轮调用）。 */
function repairUrlFile(port, control) {
  useHostState(port)
  let saved
  try {
    saved = JSON.parse(readFileSync(urlFile(), 'utf8'))
  } catch {
    saved = undefined
  }
  if (saved?.port === port && typeof saved?.url === 'string' && saved.url.includes(`:${port}/`)) return false
  const url = writeUrlFile(port)
  if (url !== undefined) {
    control.urlRepairs = (control.urlRepairs ?? 0) + 1
    log(`host.url.repair port=${port} was=${String(saved?.port)} repairs=${control.urlRepairs}`)
    return true
  }
  return false
}

/**
 * 保证 HUD 在跑：
 * - 端口没就绪时不放弃，交给 apply 里的 2s 重试（R-02：旧版直接 return undefined，
 *   于是「第一次 apply 端口是 undefined」就永远没有胶囊）；
 * - 已有进程但已死 / pid 身份不符时清理后重启；
 * - 记每次启动/复活，失败不吞。
 */
function ensureHud(port, control) {
  if (process.env.DSH_TASK_RADAR_HUD === '0') {
    if (control.disabledLogged !== true) {
      control.disabledLogged = true
      log('host.hud.disabled')
    }
    return undefined
  }
  // 端口「0」不等于就绪：cordis 早期 webServer.port 可能是 0，写进 URL 文件会让运行中的
  // HUD 在下一个 2s 轮询里连到 127.0.0.1:0 并转 offline（实测 08:49:24 发生）。
  if (!Number.isFinite(port) || port <= 0) {
    log('host.hud.wait-port port=' + String(port))
    return undefined
  }
  useHostState(port)
  writeUrlFile(port)
  const existing = hudPid()
  if (hudAlive(existing)) return existing.pid
  if (existing !== undefined) stopHud(existing, 'stale-or-foreign')
  if (!existsSync(HUD_BIN)) {
    log(`host.hud.missing ${HUD_BIN}`)
    return undefined
  }
  if (control.starts >= 40) {
    log('host.hud.giveup restarts>=40')
    return undefined
  }
  control.starts += 1
  try {
    if (existsSync(HUD_BIN)) chmodSync(HUD_BIN, 0o755)
  } catch {}
  let child
  try {
    // --state-dir：HUD 读写 hosts/<port>/ 下的 radar-url.json / hud.pid，
    // 不再和别的宿主抢同一个文件（N-14）。
    child = spawn(HUD_BIN, ['--url', 'auto', '--interval', '2', '--state-dir', STATE_DIR], {
      detached: true,
      stdio: 'ignore',
    })
  } catch (error) {
    log(`host.hud.spawn.failed ${String(error && error.message ? error.message : error)}`)
    return undefined
  }
  // spawn 的失败是异步的（EACCES/ENOENT），必须监听，否则连日志都没有。
  child.on('error', (error) => log(`host.hud.spawn.error ${String(error && error.message ? error.message : error)}`))
  child.on('exit', (code, signal) => log(`host.hud.exit code=${code ?? 'null'} signal=${signal ?? 'null'}`))
  child.unref()
  log(`host.hud.start port=${port} pid=${child.pid ?? 'unknown'} attempt=${control.starts}`)
  return child.pid
}

/**
 * 把 client 半边的状态挂到整合包的 /agent-suite/health 上。
 *
 * radar 是唯一知道「页面侧 client 有没有在轮询」的成员，但 health 归 bundle
 * 所有（bundle/index.js）。这里不复制路由，而是在运行时给共享的 status
 * 对象套一层快照，bundle 的 health 就会多出 clientHalf 字段（PRD 2.22）。
 */
function attachClientHalfToSuiteHealth() {
  try {
    const suite = globalThis.__dshAgentSuiteStatus
    if (!suite || typeof suite.snapshot !== 'function' || suite.snapshot.__radarClientHalf) return
    const base = suite.snapshot.bind(suite)
    const wrapped = () => ({ ...base(), clientHalf: clientHalfState() })
    wrapped.__radarClientHalf = true
    suite.snapshot = wrapped
    log('host.health.client_half attached')
  } catch (error) {
    log(`host.health.client_half failed ${error?.message ?? error}`)
  }
}

export function apply(ctx) {
  log('host.apply')
  attachClientHalfToSuiteHealth()
  // 旁听会话内提问：prepend 让自己排在 api-remotes 的转发 listener 之前（它接手后
  // 不再 next()，晚注册的 listener 永远轮不到）。这里只记文本，随即 next() 交还下游：
  // 桌面提问卡照常由 Web 端弹出，雷达不接管、不改任何人的行为。
  // 旁听是增强项：宿主或测试桩没有 ctx.on 时不能让整个插件起不来（smoke 的假 ctx 就是这种）。
  if (typeof ctx?.on === 'function') {
    try {
      ctx.on('user-questions/request', (request, next) => {
        const tap = tapQuestion(request)
        const verdict = takeoverVerdict(ctx)
        if (verdict !== 'ok') {
          // 不接管：HUD 不在 / 有活客户端（桌面卡会正常弹出）。旁听记录留着给 feed 用。
          return next()
        }
        return holdQuestion(ctx, request, next, tap)
      }, true)
      log('question tap listening')
    } catch (error) {
      log(`question tap listen failed ${error?.message ?? error}`)
    }
  } else {
    log('question tap unavailable ctx.on')
  }
  // 后台 job 生命周期：订阅失败只是少了「后台任务算进行中」，不影响 feed。
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => watchJobs(ctx))
    } catch (error) {
      log(`job watch effect failed ${error?.message ?? error}`)
    }
  } else {
    watchJobs(ctx)
  }
  ctx.effect(() => {
    let bound
    for (const path of PREFERRED) {
      let dispose
      try {
        dispose = ctx.webServer.register({ kind: 'prefix', path, resource: radarRoute(ctx) })
      } catch {
        continue
      }
      bound = { path, dispose }
      break
    }
    if (bound === undefined) {
      log('host.route.failed')
      return () => {}
    }
    log(`host.route ${bound.path}`)

    const control = { starts: 0, disabledLogged: false, stopped: false }
    let portTimer
    let supervisor
    const portNow = () => {
      try {
        const port = ctx.get('webServer')?.port
        return Number.isFinite(port) && port > 0 ? port : undefined
      } catch {
        return undefined
      }
    }
    const ensure = (why) => {
      if (control.stopped) return
      const port = portNow()
      if (port === undefined) {
        log(`host.hud.wait_port why=${why}`)
        return
      }
      ensureHud(port, control)
    }
    ensure('apply')
    // 端口在 apply 时可能还没绑定：2s 一次重试，直到拿到端口再启动 HUD。
    if (portNow() === undefined) {
      portTimer = setInterval(() => {
        if (control.stopped) return
        if (portNow() !== undefined) {
          clearInterval(portTimer)
          portTimer = undefined
          ensure('port-ready')
        }
      }, 2000)
      portTimer.unref?.()
    }
    // 守护：HUD 崩了/被杀了要自己回来，而不是等下一次宿主重启。
    supervisor = setInterval(() => {
      if (control.stopped) return
      const port = portNow()
      if (port === undefined) return
      // 先自愈 URL 文件：HUD 活着但文件被写成 port:0 时，把文件修回期望端口就能救回来
      // （N-02：旧版只在 HUD 死亡时才动作，写错一次就得等宿主重启）。
      repairUrlFile(port, control)
      const handle = hudPid()
      if (hudAlive(handle)) return
      log(`host.hud.revive pid=${handle?.pid ?? 'none'}`)
      ensureHud(port, control)
    }, 20000)
    supervisor.unref?.()
    // 文件守护：比 supervisor 更勤（3s），把「radar-url.json 被写坏」的离线窗口压到一次轮询内。
    const urlGuard = setInterval(() => {
      if (control.stopped) return
      const port = portNow()
      if (port === undefined) return
      repairUrlFile(port, control)
    }, 3000)
    urlGuard.unref?.()
    return () => {
      control.stopped = true
      log('host.dispose')
      if (portTimer !== undefined) clearInterval(portTimer)
      if (urlGuard !== undefined) clearInterval(urlGuard)
      if (supervisor !== undefined) clearInterval(supervisor)
      // 换代/卸载：还挂在手上的会话内提问必须让渡，不能留一个没人回答的 waterfall（R-05）。
      for (const held of [...questionHold.values()]) held.settle('yield', undefined)
      stopQuestionWatcher()
      try {
        bound.dispose()
      } catch {}
      // 只杀确认是自己人的 HUD：pid 被复用、或 pid 文件属于别的宿主时不动别人的进程。
      const handle = hudPid()
      if (hudAlive(handle)) {
        try {
          process.kill(handle.pid, 'SIGTERM')
          log(`host.hud.dispose_killed pid=${handle.pid}`)
        } catch {}
      }
    }
  })
}
