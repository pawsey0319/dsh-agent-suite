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

import { chmodSync, appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export const name = 'dsh-task-radar'
export const inject = ['webServer']

const LOG_DIR = '/tmp/dsh-task-radar'
const BRIDGE_DIR = join(homedir(), '.dsh', 'agent-bridge')
const ARTIFACT_KEEP_MS = 6 * 60 * 60 * 1000
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

function log(line) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    appendFileSync(join(LOG_DIR, 'beacon.log'), `${new Date().toISOString()} ${line}\n`)
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

      for (const row of described) {
        const kids = childrenOf.get(row.id) ?? []
        const isTop = !row.parentId || !byId.has(row.parentId)
        // 父会话本身没在跑、但有子会话在跑 → 父会话也算「正在处理」（用户口径：
        // 一个父会话调了四个智能体，界面上只看到一个父会话在处理）。
        const runningFromChildren = kids.some((kid) => kid.running)
        if (isTop) {
          const members = row.team ? teamMembers(row, kids) : []
          out.push({
            id: row.id,
            kind: 'session',
            agent: row.agent,
            preset: row.preset,
            title: row.title,
            status: row.running || runningFromChildren ? 'running' : 'idle',
            // 只有 agent team 才展开成员进度；普通 session 的子 agent 不进列表（用户口径）。
            team: row.team,
            childCount: row.team ? members.length : 0,
            children: row.team ? members : undefined,
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
  const items = []

  for (const approval of approvals) {
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

  // 队列里没有对应审批的 run 一律不算「待批准」：桥在启动时会把这类 run 对账成 failed，
  // 但雷达也要能独立识别（旧数据/桥没来得及对账时不再显示自相矛盾的行）。
  const approvalRunIds = new Set(
    items.filter((item) => typeof item.runId === 'string' && item.runId !== '').map((item) => item.runId),
  )
  const orphanNoted = new Set()
  const ACTIVE_RUN = new Set(['running', 'starting', 'queued', 'needs-approval'])
  for (const run of runs) {
    // 只有两类 run 进面板：①正在跑/等批准的；②有任务契约、真的过闸判别的。
    // 无契约的历史 run（含接入判别层之前的测试 run）一律不进胶囊，避免面板被噪声灌满。
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
    if (run.seen === true && (status === 'done' || status === 'failed' || status === 'unverified')) continue
    items.push({ ...run, kind: 'run', status, reason })
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
      items.push({ ...session, startedAt: track.started[id] ?? nowMs })
      continue
    }
    if (track.running[id] !== undefined) {
      track.finished[id] = nowMs
      track.finishedAt[id] = nowMs
      delete track.running[id]
    }
  }
  for (const [id, at] of Object.entries(track.finished)) {
    if (nowMs - Number(at) > FINISHED_KEEP_MS || seenSet.has(id)) {
      delete track.finished[id]
      delete track.started[id]
      delete track.finishedAt[id]
      continue
    }
    const title = track.titles[id] ?? id
    items.push({
      kind: 'session',
      id,
      title,
      startedAt: track.started[id],
      finishedAt: track.finishedAt[id] ?? Number(at),
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

  // 审批有时限（桥侧 5 分钟无响应即自动拒绝），所以排最前。
  // 旧版直接用 rank[status] 相减：failed/starting 这类没登记的 status 会让
  // 比较函数返回 NaN，整张面板的顺序就变得不可预测（R-13）。
  const rank = { 'needs-answer': 0, 'needs-approval': 0, done: 1, failed: 1, running: 2, rework: 2, verifying: 2, idle: 3 }
  const rankOf = (status) => (Object.hasOwn(rank, status) ? rank[status] : 4)
  items.sort((left, right) => (rankOf(left.status) - rankOf(right.status)) || ((right.updatedAt ?? 0) - (left.updatedAt ?? 0)))

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    counts,
    // 未读完成的完整 id 清单（不受 items.slice(12) 截断影响），HUD 用它做标题数、
    // 点击清单一与去重键，避免「25 个任务完成」但只清掉可见的 12 条。
    doneUnreadIds,
    items: items.slice(0, 12),
    total: items.length,
    sources: { sessions: sessions.source, runs: runs.length },
    clientHalf: clientHalfState(),
    dsh: { port: port ?? null, url: port === undefined ? null : `http://127.0.0.1:${port}` },
  }
}

function radarRoute(ctx) {
  const inner = async (request) => {
    const url = new URL(request.url, 'http://localhost')
    const tail = url.pathname.replace(/^\/x-radar(-[a-z])?\/?/, '')
    if (tail === 'beacon') return beaconResponse(url)
    if (tail === 'radar') {
      let body
      try {
        body = await buildRadar(ctx)
      } catch (error) {
        log(`radar error ${String(error && error.stack ? error.stack : error).slice(0, 600)}`)
        return new Response(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }), {
          status: 500,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      log(`radar counts pending=${body.counts.pending} running=${body.counts.running} approvals=${body.counts.approvals} rows=${body.items.length} src=${body.sources.sessions}`)
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

    if (tail === 'health') {
      return new Response(JSON.stringify({ ok: true, clientHalf: clientHalfState(), host: { port: STATE_PORT ?? null, dir: STATE_DIR } }), {
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
      let body = { sessionId: null }
      for (const path of jumpCandidatePaths()) {
        try {
          const raw = JSON.parse(readFileSync(path, 'utf8'))
          if (raw && typeof raw.sessionId === 'string' && Date.now() - Number(raw.at ?? 0) < 15000) {
            body = { sessionId: raw.sessionId, mailbox: path === jumpFile() ? 'host' : 'legacy' }
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
      if (ids.length > 0) {
        const seen = readSeen()
        const now = Date.now()
        for (const id of ids) seen[id] = now
        try {
          mkdirSync(STATE_DIR, { recursive: true })
          writeFileSync(seenFile(), JSON.stringify(seen, null, 2))
        } catch {}
      }
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
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
let lastClientBeaconAt = 0

// client 半边（页面里跑的 client.js 战报）是否真的在轮询。宿主刚起来的前 30s
// 页面可能还没重载完成，所以 active 的判定要带启动宽限（N-14 / PRD 2.22）。
const HOST_BOOT_AT = Date.now()
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
  if (event.startsWith('client.') || event === 'apply') {
    clientBeacons += 1
    lastClientBeaconAt = Date.now()
  }
  log(`client.${event}${detail ? ` ${detail}` : ''}`)
  return new Response('ok', {
    status: 200,
    headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
  })
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
