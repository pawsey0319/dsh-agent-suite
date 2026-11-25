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
import { chmodSync, appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** 按「码点」截断，绝不在代理对中间砍断（emoji 安全）。
 *  数组原样按元素切；其它值转字符串后按 Array.from 切。
 *  审计项 E-02/F-03：`str.slice(0,N)` 可能产生孤立代理 → JSON/UTF-8 往返出现 U+FFFD。 */
function uslice(value, count) {
  if (Array.isArray(value)) return value.slice(0, count)
  const text = value === null || value === undefined ? '' : String(value)
  const chars = Array.from(text)
  return chars.length > count ? chars.slice(0, count).join('') : text
}


export const name = 'dsh-task-radar'
export const inject = ['webServer']

const LOG_DIR = '/tmp/dsh-task-radar'
// DSH_AGENT_BRIDGE_DIR 只给测试/自检用：默认仍是 ~/.dsh/agent-bridge。
// 有了它，声明式 adapter 的自检才能把 bridge 目录挪到 /tmp，不碰真实用户目录。
const BRIDGE_DIR = process.env.DSH_AGENT_BRIDGE_DIR !== undefined && process.env.DSH_AGENT_BRIDGE_DIR !== ''
  ? process.env.DSH_AGENT_BRIDGE_DIR
  : join(homedir(), '.dsh', 'agent-bridge')
const ARTIFACT_KEEP_MS = 6 * 60 * 60 * 1000
// 会话内提问（'user-questions/request'）的「只看不动」旁听记录。
// 桌面提问卡由 api-remotes 的转发 listener 负责显示；雷达只旁听一份文本，
// 记录后立刻把请求交还下游 —— 不接管、不阻塞、不改变任何他人的行为。
// 接管（不 next() 直接自己回执）是另一个产品决策，见 docs/research/radar-optimize-prep.md。
const QUESTION_TAP_TTL_MS = 10 * 60 * 1000
const questionTap = new Map()
/**
 * 接管的最长持有时间（t22 / S-01）：接管只在「没有活跃 Web 客户端」时发生，
 * 所以这里**不再**是「20s 后自动让渡」——那样会在没人能答的时候把请求从面板上抽走。
 * 现在的让渡条件是事件驱动的：HUD 死掉、或页面重新连上（桌面卡接管）。
 * 这个常量只作为最后兜底，避免极端情况下模型侧无限等待。
 */
const QUESTION_HOLD_MS = Number(process.env.DSH_TASK_RADAR_ANSWER_MS ?? 600000)
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

// 跨端口迁移的用户态文件：宿主端口每次重启都会变（51164→62044→62212→53574…），
// 只按根目录迁移会把「胶囊位置 / 隐藏名单 / 重试记录」全丢掉，用户看到的是窗口跳回默认位。
const INHERIT_FILES = [
  'hud-window.json',
  'hidden-runs.json',
  'hidden-sessions.json',
  'retries.json',
  'seen.json',
  'radar-sessions.json',
]

/**
 * 兄弟宿主目录「是否已退役」（t22 / S-06）。
 *
 * 端口每次重启都变，所以换端口必须能继承 seen/hidden 这些用户态；但**并发运行的另一个宿主**
 * 的 seen 绝不能拷进来（会把 A 宿主的「已读」带成 B 宿主的，用户看到条目凭空消失）。
 * 判据：它自己的 hud.pid 已经死了，且目录 10 分钟没有写入 —— 退役端口，同族。
 */
function retiredSibling(item, nowMs) {
  if (nowMs - item.mtime <= 10 * 60 * 1000) return false
  const handle = readPidFile(join(item.base, 'hud.pid'))
  if (Number.isFinite(handle?.pid) && processAlive(handle.pid) === true) return false
  return true
}

/** seen.json 的版本号（t22 / S-06）：新不被旧覆盖，判据是 sidecar 里的 updatedAt。 */
function seenMetaFile(dir) {
  return join(dir, 'seen-meta.json')
}

function writeSeenMeta(dir, updatedAt) {
  try {
    writeJsonAtomic(seenMetaFile(dir), { schema: 1, port: basename(dir), updatedAt })
  } catch {}
}

function seenUpdatedAt(dir) {
  try {
    const meta = JSON.parse(readFileSync(seenMetaFile(dir), 'utf8'))
    if (Number.isFinite(meta?.updatedAt)) return Number(meta.updatedAt)
  } catch {}
  try {
    return statSync(join(dir, 'seen.json')).mtimeMs
  } catch {
    return 0
  }
}

/** 新宿主目录首次出现时，从最近活跃的兄弟宿主目录继承上面这些用户态文件。 */
function migrateSiblingState(dir) {
  let siblings = []
  try {
    siblings = readdirSync(HOSTS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && join(HOSTS_DIR, entry.name) !== dir)
      .map((entry) => {
        const base = join(HOSTS_DIR, entry.name)
        return { port: entry.name, base, mtime: fileMtime(base) }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return
  }
  if (siblings.length === 0) return
  // 逐文件选源：最新兄弟目录可能只写过一个文件，所以每个文件各自找「最近写过它的那个目录」。
  const copied = []
  const sources = new Set()
  const nowMs = Date.now()
  for (const name of INHERIT_FILES) {
    const target = join(dir, name)
    if (existsSync(target)) continue
    // t22 / S-06：只从**已退役**的同族目录继承；并发宿主的目录一律跳过并留痕。
    const candidates = siblings.filter((item) => existsSync(join(item.base, name)))
    const source = candidates.find((item) => retiredSibling(item, nowMs))
    if (!source) {
      if (candidates.length > 0) {
        log(`state.inherit.skipped ${name} reason=live-sibling candidates=${candidates.map((item) => item.port).join('+')}`)
      }
      continue
    }
    if (name === 'seen.json' && seenUpdatedAt(source.base) <= seenUpdatedAt(dir)) {
      log(`state.inherit.skipped ${name} reason=not-newer from=${source.port}`)
      continue
    }
    try {
      copyFileSync(join(source.base, name), target)
      if (name === 'seen.json') writeSeenMeta(dir, Date.now())
      copied.push(name)
      sources.add(source.port)
    } catch (error) {
      log(`state.inherit.failed ${name} from=${source.port} ${String(error && error.message ? error.message : error)}`)
    }
  }
  if (copied.length > 0) {
    log(`state migrated from=${[...sources].join('+')} files=${copied.join(',')}`)
  }
}

/** 目录的活跃度代理值：radar-url.json / seen.json / hud.pid 三者里最新的 mtime。 */
function fileMtime(base) {
  let score = 0
  for (const name of ['radar-url.json', 'seen.json', 'hud.pid']) {
    try {
      score = Math.max(score, statSync(join(base, name)).mtimeMs)
    } catch {}
  }
  return score
}

/**
 * 统一的 seen 落盘（t22 / S-06 + S-08）：原子写 + sidecar 版本号。
 * 任何绕过它的 writeFileSync 都会让「新不被旧覆盖」失效，所以调用点一律走这里。
 */
function saveSeen(seen) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeJsonAtomic(seenFile(), seen)
  writeSeenMeta(STATE_DIR, Date.now())
}

/**
 * 原子写 JSON（t22 / S-08）：先写同目录临时文件再 rename。
 * 直接用 writeFileSync 覆盖时，进程在写到一半被杀会把账本截断成 `{}`（未读/隐藏全部重置）。
 */
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value))
  try {
    renameSync(tmp, file)
  } catch (error) {
    try { unlinkSync(tmp) } catch {}
    throw error
  }
}

/** 内容没变就不写盘（t22 / S-08）：2s 轮询每轮重写 8–16KB 账本没有意义。 */
const lastJsonWrite = new Map()
function writeJsonIfChanged(file, value) {
  const text = JSON.stringify(value)
  if (lastJsonWrite.get(file) === text) return false
  writeJsonAtomic(file, value)
  lastJsonWrite.set(file, text)
  return true
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
  migrateSiblingState(dir)
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

/**
 * 「已读」时间戳（t51 / CD-1）。
 *
 * 旧实现把 seen 当布尔集合：只要 id 在里面就算读过。两处踩坑：
 * ① 为了让「又跑起来的会话」重新算未读，清账逻辑会无条件 `delete seen[id]`，
 *    把用户刚刚置读的记录一起抹掉 —— clear-done 于是每轮都能「再清一次」，
 *    counts 永远回到原值（真机 cleared=150 / passes=6 / doneUnread=25）。
 * ② 同一会话再完成一次（finishedAt 变大）后，集合里那条旧记录会把**新的**完成吃掉。
 * 现在统一成时间戳比较：unread ⟺ finishedAt > seenAt；数字即毫秒，
 * 旧格式 `true`（只有「读过」没有时间）按「最新」算，避免把历史已读翻成未读。
 */
function seenAtOf(seen, id) {
  const value = seen?.[id]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value === true) return Number.MAX_SAFE_INTEGER
  return 0
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
    missing: Array.isArray(verdict?.missing) ? uslice(verdict.missing, 3) : [],
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
  return flat.length > 200 ? `${uslice(flat, 200)}…` : flat
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
          log(`job registered owner=${uslice(owner, 12)} id=${event.job?.id} kind=${event.job?.kind}`)
        }
        return
      }
      if (event.type === 'settled' || event.type === 'removed') {
        const next = Math.max(0, (liveJobs.get(owner) ?? 0) - 1)
        if (next === 0) liveJobs.delete(owner)
        else liveJobs.set(owner, next)
        if (event.type === 'settled') {
          log(`job settled owner=${uslice(owner, 12)} id=${event.job?.id} status=${status}`)
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
    for (const id of uslice(sessionIds, 60)) {
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

/**
 * 状态变更路由的同源判定（t22 / X-01、X-02）：照 dsh-project-journal 的 crossOriginReason 口径。
 * 返回 null 表示同源；否则返回拒绝原因（写进 403 的 detail）。
 * 只用「浏览器会自动加」的请求头，命令行 curl 不带这些头也放行（本机进程本来就是可信的）。
 */
function sameOriginReason(request) {
  const header = (name) => {
    try {
      return request?.headers?.get?.(name) ?? null
    } catch {
      return null
    }
  }
  const site = String(header('sec-fetch-site') ?? '').toLowerCase()
  if (site === 'cross-site' || site === 'same-site') return `Sec-Fetch-Site: ${site}`
  const hostHeader = String(header('host') ?? '').toLowerCase()
  const hostName = hostHeader.split(':')[0]
  const hostPort = hostHeader.split(':')[1] ?? ''
  const sameHost = (name, port) => {
    const near = name === hostName
      || (hostName === 'localhost' && name === '127.0.0.1')
      || (hostName === '127.0.0.1' && name === 'localhost')
    return near && (port === '' || hostPort === '' || port === hostPort)
  }
  for (const name of ['origin', 'referer']) {
    const value = header(name)
    if (value === null || value === '') continue
    let parsed
    try {
      parsed = new URL(value)
    } catch {
      return `${name} 不是合法 URL：${uslice(value, 80)}`
    }
    const port = parsed.port === '' ? (parsed.protocol === 'https:' ? '443' : '80') : parsed.port
    if (!sameHost(parsed.hostname.toLowerCase(), port)) return `${name} 与宿主不同源：${parsed.origin}`
  }
  return null
}

/** 会改宿主状态的雷达路由：只允许 GET + 同源（t22 / X-01）。 */
const MUTATING_TAILS = new Set([
  'seen', 'clear-done', 'hide-session', 'hide-run', 'retry', 'question-answer',
  'approval-decide', 'jump', 'jump-pending', 'jump-ack', 'purge-tests', 'adapter-inject', 'adapter-answer',
])

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
      out.listKeys = r && !Array.isArray(r) ? uslice(Object.keys(r), 8) : undefined
      const rows = Array.isArray(r) ? r : Array.isArray(r?.items) ? r.items : []
      out.rowCount = rows.length
      out.firstRowKeys = rows[0] ? uslice(Object.keys(rows[0]), 20) : undefined
      out.firstRowJson = rows[0] ? uslice(JSON.stringify(rows[0]), 700) : undefined
    }
  } catch (err) {
    out.controllerError = String(err?.message ?? err)
  }
  try {
    const sessions = ctx.get('sessions')
    const list = typeof sessions?.list === 'function' ? sessions.list() : []
    out.sessionCount = list.length
    const first = list[0]
    out.sessionKeys = first ? uslice(Object.keys(first), 20) : undefined
    out.headerKeys = first?.header ? uslice(Object.keys(first.header), 20) : undefined
    out.sessionJson = first ? uslice(JSON.stringify(first), 600) : undefined
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
                    subject: uslice(String(task.subject), 90),
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
      return texts.length > 1 ? `${uslice(first, 52)}（等 ${texts.length} 问）` : uslice(first, 60)
    }
  }
  const single = params?.prompt ?? params?.question ?? params?.input?.question
  if (typeof single === 'string' && single.trim()) return uslice(single.trim().replace(/\s+/g, ' '), 60)
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
    if (agent === 'workbuddy') return `WorkBuddy 等你确认：${uslice(text, 60)}`
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
    return uslice(fresh, 3).map((item) => ({
      id: `artifact:${item.path}`,
      kind: 'artifact',
      agent: item.kind ?? 'file',
      title: item.title ?? item.name ?? item.relative ?? '未命名产物',
      category: item.category ?? item.kind ?? 'file',
      sizeBytes: Number.isFinite(item.sizeBytes) ? item.sizeBytes : (Number.isFinite(item.size) ? item.size : 0),
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
      ? uslice(request.questions, 9).map((question, index) => ({
          // 没有 id 的题用 q0/q1 兜底：HUD 的自由文本入口用同一套，否则回执 id 对不上。
          id: String(question?.id ?? `q${index}`),
          question: typeof question?.question === 'string' ? question.question : '',
          header: typeof question?.header === 'string' ? question.header : null,
          options: Array.isArray(question?.options)
            ? uslice(question.options, 9).map((option) => ({
                label: typeof option?.label === 'string' ? option.label : String(option ?? ''),
                description: typeof option?.description === 'string' ? option.description : null,
              }))
            : null,
          multiSelect: question?.multiSelect === true,
        }))
      : []
    const record = { questions, at: Date.now() }
    questionTap.set(String(sessionId), record)
    log(`question tap session=${uslice(String(sessionId), 12)} n=${questions.length} head=${uslice(questionHeadline(questions[0]), 24)}`)
    return record
  } catch (error) {
    // 旁听失败绝不能让提问本身失败：调用方无条件 next()。
    log(`question tap error ${uslice(String(error && error.message ? error.message : error), 200)}`)
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
    log(`questions pending error ${uslice(String(error && error.message ? error.message : error), 200)}`)
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
    log(`question client probe error ${uslice(String(error && error.message ? error.message : error), 160)}`)
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

let questionWatcherCtx = null

/**
 * 持有期间的让渡巡检（1s）：
 *   - HUD 死了 → 没人在面板上作答，立刻让渡（R-05，避免模型侧干等）；
 *   - 页面重新连上（出现活跃 Web 客户端）→ 桌面提问卡才是权威入口，让渡给它（t22 / S-02）。
 * 除这两种事件外**不主动让渡**：接管的前提就是「当时没有客户端」。
 */
function ensureQuestionWatcher(ctx) {
  if (ctx !== undefined) questionWatcherCtx = ctx
  if (questionWatcher !== undefined) return
  questionWatcher = setInterval(() => {
    if (questionHold.size === 0) { stopQuestionWatcher(); return }
    const live = questionWatcherCtx === null ? true : hudAlive(hudPid())
    if (!live) {
      for (const [requestId, held] of [...questionHold]) {
        log(`question yield reason=hud-dead request=${requestId}`)
        held.settle('yield', undefined)
      }
      return
    }
    if (questionWatcherCtx !== null && hasLiveWebClient(questionWatcherCtx)) {
      for (const [requestId, held] of [...questionHold]) {
        log(`question yield reason=client-live request=${requestId}`)
        held.settle('yield', undefined)
      }
    }
  }, 1000)
}

/**
 * 接管一条会话内提问：登记成可被 `/x-radar/question-answer` 作答的条目。
 * 让渡是事件驱动的（HUD 死 / 客户端回来），只在 QUESTION_HOLD_MS 兜底超时（t22 / S-01、S-02）。
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
        log(`question answered request=${requestId} session=${uslice(sessionId, 12)} ` +
          `n=${answers.length} shape=array ids=${ids} custom=${customCount}`)
        resolve({ answers })
        return
      }
      log(`question yield ${why} request=${requestId} session=${uslice(sessionId, 12)}`)
      // 让渡 = 交回下游（桌面提问卡 / 别的 answerer）。下游失败要照原样抛出去。
      resolve(next())
    }
    // 兜底上限（默认 10 分钟）：只在 HUD 活着、客户端也没回来、但就是没人作答时生效。
    const timer = setTimeout(() => settle('yield-timeout', undefined), QUESTION_HOLD_MS)
    questionHold.set(requestId, { token, sessionId, questions, settle, at: Date.now() })
    if (tap !== undefined) {
      tap.requestId = requestId
      tap.token = token
      tap.takenOverAt = Date.now()
    }
    ensureQuestionWatcher(ctx)
    log(`question hold request=${requestId} session=${uslice(sessionId, 12)} n=${questions.length} maxMs=${QUESTION_HOLD_MS}`)
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
    const custom = typeof entry.custom === 'string' && entry.custom.trim() !== '' ? uslice(entry.custom.trim(), 200) : undefined
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
    log(`stale question dropped id=${id} session=${uslice(String(held.sessionId), 12)} reason=no-waiter`)
    held.settle('yield', undefined)
  }
  for (const [id, tap] of [...questionTap.entries()]) {
    if (pending.has(id)) continue
    if (nowMs - Number(tap?.at ?? 0) < 5_000) continue
    questionTap.delete(id)
    log(`stale question dropped id=question:${uslice(String(id), 12)} reason=no-waiter`)
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

// ═══════════════════════════════════════════════════════════════════════════
// 多 agent adapter 层（分支 feat/multi-agent-notify）
//
// 目的：把「DSH 之外的 agent 也在等你看一眼」这件事塞进同一只胶囊。
// 结构：每家 agent 一个 descriptor，注册进统一 bus；feed 只消费**规范化事件**。
// 规则（三条硬约束，来自 docs/specs/multi-agent-notify-spec.md）：
//   1. 只读观察。除 DSH 已有的回执通道外，不代点、不发送任何对外消息、不改别人的配置。
//   2. 降级必须诚实。拿不到的状态标 unsupported/partial，绝不伪造「等回答」。
//   3. 故障隔离。任何一家抛错/超时只影响它自己：其余事件照常，计数不清零。
// ═══════════════════════════════════════════════════════════════════════════
const ADAPTER_POLL_TIMEOUT_MS = 400
const ADAPTER_EVENT_TTL_MS = 2 * 60 * 60 * 1000
// R3-M1：终态（done/failed）不受 2h TTL 约束。真实 rollout 的 completed_at 可能就是几小时前，
// 按 TTL 过滤会把「这条跑完了」整条吃掉（复审实测 now−3h 被丢）。入库、出库都走这一个判断。
const adapterEventFresh = (event, now) => event?.kind === 'done' || event?.kind === 'failed'
  || now - Number(event?.ts ?? 0) <= ADAPTER_EVENT_TTL_MS
// 用户口径（2026-11-24）：外部 agent 的「已完成」行只占 3 小时，之后不再出现在列表里（不删账本，
// 手动「清除已完成」照旧可清）。以前终态免疫全部 TTL，导致 34 小时前的自测 run 还占着胶囊。
const ADAPTER_DONE_DISPLAY_MS = Math.max(1, Number(process.env.DSH_TASK_RADAR_DONE_HOURS ?? 3)) * 60 * 60 * 1000
const adapterEventVisible = (event, now) => {
  if (!adapterEventFresh(event, now)) return false
  if (event?.kind !== 'done' && event?.kind !== 'failed') return true
  return now - Number(event?.ts ?? 0) <= ADAPTER_DONE_DISPLAY_MS
}
const ADAPTER_MAX_EVENTS = 200
/**
 * t53：running 的终态兜底。
 *
 * 用户报的是「codex 任务永远显示运行中」：rollout 末行明明已经是 `task_complete`，胶囊却一直是 running。
 * 两个原因都在这层：①终止事件没被识别（只有 task_complete，没有 abort/failed）→ 已补；
 * ②**已经结束的那一轮留下的 running 事件没人收回**——store 里 running 与 done 并存时，
 * 折叠代表行按「更严重」取 running，于是永远运行中。所以这里对**所有** adapter 统一兜底：
 * running 超过 10 分钟、且这 10 分钟它的数据源没有任何新增（progress 没更新），就落 failed。
 *
 * 判「有没有进程」优先用 `processAlive()`（有 codex CLI 在跑才配叫 running）；
 * 进程已经没了但日志没写终态 → `process-exited`；进程还在但十分钟没动静 → `stale-no-progress`。
 */
const ADAPTER_STALE_RUNNING_MS = (() => {
  // 默认 10 分钟；用例需要把窗口压到几百毫秒才能在一轮测试里看到降级（与其它 env 钩子同风格）。
  const override = Number(process.env.DSH_TASK_RADAR_STALE_RUNNING_MS)
  return Number.isFinite(override) && override > 0 ? override : 10 * 60 * 1000
})()
/** 每家 adapter 最近一次「数据源有新增」的时刻（poll 出了事件/撤回/新增字节都算）。 */
const adapterProgressAt = new Map()

/** 本机是否有匹配的命令行进程（只读 `ps`，不看 UI、不点任何东西）。 */
function cliProcessAlive(pattern) {
  if (process.env.DSH_TASK_RADAR_FAKE_PROC === '1') return true
  if (process.env.DSH_TASK_RADAR_FAKE_PROC === '0') return false
  try {
    const listing = execFileSync('ps', ['-Ao', 'command'], { encoding: 'utf8', timeout: 2000 })
    for (const line of listing.split('\n')) {
      if (line.trim() === '') continue
      if (line.includes('RadarHUD') || line.includes('dsh-task-radar')) continue
      if (pattern.test(line)) return true
    }
  } catch {}
  return false
}
/** 心跳（t39 P1）：超过这么久没有一次成功探测，就标 stale 而不是继续冒充 full/partial。 */
const ADAPTER_STALE_MS = 90 * 1000
/** 熔断（t39 P1）：连续 3 次失败后 60s 内不再探测，避免每 2s 打一次挂掉的家。 */
const ADAPTER_BREAKER_THRESHOLD = 3
const ADAPTER_BREAKER_COOLDOWN_MS = 60 * 1000
// ── 事件词表（t39 / P0-2）────────────────────────────────────────────────
// 规格 §1.2：提醒态只有四类 needs-input | needs-approval | done | failed，另外允许
// running 作为**非提醒态**（只表达「在跑」，不进红/黄呼吸、不算未读）。
// 旧词 question / approval 仍被接受，但会映射到新词并**记一条弃用日志**（不再静默拒绝）。
const ADAPTER_CANON_KINDS = new Set(['needs-input', 'needs-approval', 'done', 'failed', 'running'])
const ADAPTER_LEGACY_KINDS = new Map([['question', 'needs-input'], ['approval', 'needs-approval']])
/** 已见过哪些家还在用旧词：只记一次日志，避免每 2s 刷屏。 */
const adapterLegacySeen = new Set()
/** 被规范化层拒掉的事件：reason -> 次数（排障能看出「为什么没进来」，累计值）。 */
const adapterRejectReasons = new Map()
/** 本轮 feed 拒掉的条数（counts.rejected 用它，避免拿累计值冒充「这一轮有几条被拒」）。 */
let adapterPassRejects = 0
/** id -> 最近一轮观察结果（t39 F7：`feed.adapters` 与 `GET /adapters` 必须是**同一套投影**，
 *  否则两处 note/完整性能各说各话——比如 hooks 已装、/adapters 还写「未安装」）。 */
const adapterLastStatus = new Map()
/** 遇到过未知 kind 的原始值：只记前 10 种，避免脏数据把日志灌满。 */
const adapterUnknownKinds = new Set()

/** 出站脱敏（t39 / P0-5）：凭据形状一律遮蔽。宁可少显示，也不把 token 印在屏幕上。 */
const ADAPTER_REDACT_RULES = [
  [/sk-[A-Za-z0-9_-]{8,}/g, '<redacted>'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>'],
  [/gh[pousr]_[A-Za-z0-9]{8,}/g, '<redacted>'],
  [/xox[baprs]-[A-Za-z0-9-]{8,}/g, '<redacted>'],
  // 长 base64/hex 串（>=32）：常见于把整个 token/证书塞进 title 的日志
  [/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, '<redacted>'],
  [/\b[a-f0-9]{40,}\b/gi, '<redacted>'],
]

function redactSecrets(text) {
  if (typeof text !== 'string' || text === '') return text
  let out = text
  for (const [pattern, replacement] of ADAPTER_REDACT_RULES) out = out.replace(pattern, replacement)
  return out
}

/** 契约校验失败时统一记账（t39 / P0-4）：reason 进计数，日志只留一条短行。 */
function noteAdapterReject(descriptor, reason, raw) {
  const key = reason
  adapterRejectReasons.set(key, (adapterRejectReasons.get(key) ?? 0) + 1)
  adapterPassRejects += 1
  const agent = descriptor === null || descriptor === undefined ? '-' : descriptor.id
  log(`adapter event rejected agent=${agent} reason=${reason} raw=${uslice(String(raw === undefined ? '' : JSON.stringify(raw) ?? ''), 80)}`)
}
/** id -> descriptor（注册顺序即数据源条的展示顺序基准，实际顺序由 adapterOrder 固定） */
const adapterRegistry = new Map()
/** id -> Map(dedupeKey -> event)：同一条事件被重复上报时只留一份（spec §1.4-b） */
const adapterStore = new Map()
/** id -> { ok, error, at, probeMs, pollMs, rejected }：数据源条与排障用 */
const adapterHealth = new Map()
/** 被 poll 主动撤回的事件条数（t52：question.replied / 过期要能收回提示）。 */
let adapterRetracted = 0
/** t53：被终态兜底降级的 running 条数（进 /x-radar/adapters 与日志统计）。 */
let adapterSettled = 0
/** 故障隔离自测注入：id -> 'throw' | 'timeout'（只由 /x-radar/adapter-inject 写入） */
const adapterFault = new Map()
/** 文件类 adapter 的读取偏移：path -> { offset, ino }，避免每 2s 重读整个日志 */
const adapterOffsets = new Map()
/** 数据源条的固定顺序（spec §3.2-b：dsh → codex → claude → 其它按字母序，不按健康度跳） */
const ADAPTER_ORDER = ['dsh', 'codex', 'claude']

/**
 * 注册一家 adapter（t39 / P0-3 生命周期面）。
 *
 * 一家 adapter = 一个对象，实现四个可选方法：
 *   probe(ctx)       → { installed, running, completeness, note }      必须能答「装没装/在不在跑」
 *   poll(ctx, now)   → 原始事件数组                                      可选（推送型 adapter 不实现）
 *   answer(id, body) → 就地处置（只有拿到真实回执通道的家才实现）          可选
 *   capabilities     → { observe, answer, toastOnly, done }              声明「能做什么」
 *
 * 关键：**新增一家 agent 不需要改这里的代码**——把同样的对象挂在
 * `~/.dsh/agent-bridge/adapters.d/*.json` 里（声明式），启动时与每次 `GET /x-radar/adapters`
 * 都会被扫进来（见 loadDeclaredAdapters）。
 */
function registerAdapter(descriptor) {
  const id = String(descriptor.id ?? '')
  if (id === '') {
    log('adapter register rejected reason=id-missing')
    return null
  }
  const declared = descriptor.capabilities ?? {}
  const capabilities = {
    observe: declared.observe !== false,
    // answer 只认「真的实现了 answer()」的家，避免底条/详情承诺一个做不到的动作。
    answer: declared.answer === true && typeof descriptor.answer === 'function',
    toastOnly: declared.toastOnly === true || descriptor.toastOnly === true,
    // t54：done 也要显式声明。只有能拿到「这一轮结束」的家才算；没有会话生命周期事件的
    // 通道（workbuddy 的 audit-log）必须报 false，否则界面会暗示「它会给你完成提醒」。
    done: declared.done ?? (descriptor.completeness === 'full' || descriptor.completeness === 'partial'),
  }
  const entry = {
    channel: 'none',
    completeness: 'unsupported',
    ...descriptor,
    id,
    capabilities,
    probe: typeof descriptor.probe === 'function' ? descriptor.probe : undefined,
    poll: typeof descriptor.poll === 'function' ? descriptor.poll : undefined,
    answer: typeof descriptor.answer === 'function' ? descriptor.answer : undefined,
  }
  adapterRegistry.set(id, entry)
  if (!adapterStore.has(id)) adapterStore.set(id, new Map())
  // completeness 先记 unknown：第一次探测前不能冒充 full/partial（spec §3.1 fail-closed）。
  if (!adapterHealth.has(id)) {
    adapterHealth.set(id, {
      ok: true, error: null, at: 0, probeMs: 0, pollMs: 0, rejected: 0,
      completeness: 'unknown',
      // 心跳/熔断（t39 P1）：连续 3 次失败 → 60s 内不再探测，避免每 2s 打一次挂掉的家。
      consecutiveFailures: 0,
      breakerUntil: 0,
      lastOkAt: 0,
    })
  }
  return entry
}

// ── 声明式 adapter（t39 / P0-3）：不改进程内代码也能加一家 ──────────────────
/** 目录：`~/.dsh/agent-bridge/adapters.d/*.json`（用户级，端口变了也不丢） */
const ADAPTER_DECL_DIR = join(BRIDGE_DIR, 'adapters.d')

/** 按 `a.b.c` 取字段；取不到返回 undefined。 */
function pickPath(record, path) {
  if (typeof path !== 'string' || path === '') return undefined
  let cursor = record
  for (const part of path.split('.')) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined
    cursor = cursor[part]
  }
  return cursor
}

/** 一份声明式 adapter 的清单 → descriptor。故意只支持「文件追加 + 字段映射」这一种形态：
 *  能覆盖 Claude/Codex/DuMate 这类 JSONL 日志，又不需要在宿主里执行任意代码（安全边界）。 */
function declaredDescriptor(manifest, path) {
  const id = String(manifest.id ?? '')
  if (id === '' || manifest.source === undefined) return null
  const source = manifest.source
  const file = typeof source.path === 'string' ? source.path.replace(/^~/, homedir()) : ''
  if (file === '') return null
  const kind = String(source.kind ?? manifest.kind ?? 'needs-input')
  const mapping = source.map ?? {}
  return {
    id,
    label: String(manifest.label ?? id.toUpperCase()),
    channel: 'declared',
    completeness: manifest.completeness === 'partial' ? 'partial' : 'partial',
    note: manifest.note ?? `声明式 adapter（${path}）`,
    capabilities: { observe: true, answer: false, toastOnly: manifest.toastOnly === true },
    probe() {
      const exists = existsSync(file)
      return {
        installed: exists,
        running: null,
        completeness: exists ? 'partial' : 'unsupported',
        note: exists ? `读 ${file}` : `未找到 ${file}`,
      }
    },
    poll() {
      const text = readAppendedText(file)
      if (text === '') return []
      const events = []
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('#')) continue
        let record
        try {
          record = JSON.parse(trimmed)
        } catch {
          continue
        }
        const sessionRef = pickPath(record, mapping.sessionRef ?? 'sessionId') ?? pickPath(record, 'session') ?? pickPath(record, 'sid')
        const title = pickPath(record, mapping.title ?? 'title') ?? pickPath(record, 'message') ?? pickPath(record, 'name')
        const detail = pickPath(record, mapping.detail ?? 'detail') ?? pickPath(record, 'message')
        const rawTs = pickPath(record, mapping.ts ?? 'timestamp') ?? pickPath(record, 'ts')
        const tsValue = typeof rawTs === 'number' ? rawTs : Date.parse(String(rawTs ?? ''))
        const eventKind = mapping.kind === undefined ? kind : String(pickPath(record, mapping.kind) ?? kind)
        const receipt = {
          answerRequest: pickPath(record, mapping.answerRequest ?? 'answerRequest'),
          answerToken: pickPath(record, mapping.answerToken ?? 'answerToken'),
          approvalId: pickPath(record, mapping.approvalId ?? 'approvalId'),
        }
        events.push({
          kind: eventKind,
          title: typeof title === 'string' ? title : '',
          detail: typeof detail === 'string' ? detail : '',
          sessionRef: typeof sessionRef === 'string' ? sessionRef : String(sessionRef ?? ''),
          ts: Number.isFinite(tsValue) ? tsValue : Date.now(),
          completeness: 'partial',
          ...(typeof receipt.answerRequest === 'string' ? { answerRequest: receipt.answerRequest } : {}),
          ...(typeof receipt.answerToken === 'string' ? { answerToken: receipt.answerToken } : {}),
          ...(typeof receipt.approvalId === 'string' ? { approvalId: receipt.approvalId } : {}),
        })
      }
      return events
    },
  }
}

/** 扫 `adapters.d/*.json`：已注册的跳过（幂等），坏的只打日志不抛。 */
function loadDeclaredAdapters() {
  let names
  try {
    names = readdirSync(ADAPTER_DECL_DIR).filter((name) => name.endsWith('.json')).sort()
  } catch {
    return { loaded: 0, skipped: 0, failed: 0 }
  }
  let loaded = 0
  let skipped = 0
  let failed = 0
  for (const name of names) {
    const path = join(ADAPTER_DECL_DIR, name)
    try {
      const manifest = JSON.parse(readFileSync(path, 'utf8'))
      const id = String(manifest.id ?? '')
      if (id !== '' && adapterRegistry.has(id)) {
        skipped += 1
        continue
      }
      const descriptor = declaredDescriptor(manifest, path)
      if (descriptor === null) {
        failed += 1
        log(`adapter declare invalid file=${name} reason=missing-id-or-source`)
        continue
      }
      registerAdapter(descriptor)
      loaded += 1
      log(`adapter declared id=${descriptor.id} file=${name}`)
    } catch (error) {
      failed += 1
      log(`adapter declare failed file=${name} err=${uslice(String(error && error.message ? error.message : error), 120)}`)
    }
  }
  return { loaded, skipped, failed }
}

function adapterList() {
  const list = [...adapterRegistry.values()]
  const rank = (id) => {
    const index = ADAPTER_ORDER.indexOf(id)
    return index === -1 ? ADAPTER_ORDER.length : index
  }
  return list.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))
}

/** 单家 adapter 的「保护壳」：注入故障、超时、异常都在这里掐断，绝不外溢到别的家。 */
async function guardedAdapterCall(id, label, run) {
  const injected = adapterFault.get(id)
  if (injected === 'throw') throw new Error(`injected ${label} failure`)
  const work = Promise.resolve().then(run)
  if (injected === 'timeout') {
    // 关键：不能 race 真实 run()——同步 probe 会在微任务里先返回，注入就白做了。
    // 这里直接换成一个永不 resolve 的 promise，让外层超时分支真的触发。
    return Promise.race([new Promise(() => {}), new Promise((resolve) => setTimeout(() => resolve(ADAPTER_TIMEOUT_MARK), ADAPTER_POLL_TIMEOUT_MS))])
      .then((value) => {
        if (value === ADAPTER_TIMEOUT_MARK) throw new Error(`injected ${label} timeout ${ADAPTER_POLL_TIMEOUT_MS}ms`)
        return value
      })
  }
  let timer
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(ADAPTER_TIMEOUT_MARK), ADAPTER_POLL_TIMEOUT_MS)
    timer.unref?.()
  })
  try {
    const value = await Promise.race([work, timeout])
    if (value === ADAPTER_TIMEOUT_MARK) throw new Error(`${label} timeout ${ADAPTER_POLL_TIMEOUT_MS}ms`)
    return value
  } finally {
    clearTimeout(timer)
  }
}
const ADAPTER_TIMEOUT_MARK = Symbol('adapter-timeout')

/** 规范化：任何一家交上来的原始事件都收敛成同一形状；不合格的直接拒（spec §1.3 / t39 P0-2/P0-4/P0-5）。
 *
 * 拒收理由（都会进 counts.rejected 与日志，绝不静默吞掉）：
 *   kind-unknown     词表外（且不是可映射的旧词）
 *   title-missing    没有可显示的一行标题
 *   session-missing  sessionRef 为空——拿不到会话就进不了队列（spec §1.5 分水岭）
 *   completeness-missing  既没自报也没声明，无法诚实标注降级
 *   not-object       压根不是对象
 */
function normalizeAdapterEvent(descriptor, raw, options) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    noteAdapterReject(descriptor, 'not-object', raw)
    return null
  }
  const rawKind = String(raw.kind ?? '')
  let kind = rawKind
  if (ADAPTER_LEGACY_KINDS.has(rawKind)) {
    kind = ADAPTER_LEGACY_KINDS.get(rawKind)
    const legacyKey = `${descriptor === null || descriptor === undefined ? '-' : descriptor.id}:${rawKind}`
    if (!adapterLegacySeen.has(legacyKey)) {
      adapterLegacySeen.add(legacyKey)
      log(`adapter kind deprecated agent=${descriptor === null || descriptor === undefined ? '-' : descriptor.id} from=${rawKind} to=${kind}`)
    }
  }
  if (!ADAPTER_CANON_KINDS.has(kind)) {
    if (!adapterUnknownKinds.has(rawKind) && adapterUnknownKinds.size < 10) {
      adapterUnknownKinds.add(rawKind)
      log(`adapter kind unknown value=${uslice(rawKind, 32)}`)
    }
    noteAdapterReject(descriptor, 'kind-unknown', raw)
    return null
  }
  const rawTitle = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (rawTitle === '') {
    noteAdapterReject(descriptor, 'title-missing', raw)
    return null
  }
  const sessionRef = typeof raw.sessionRef === 'string' ? raw.sessionRef.trim() : ''
  if (sessionRef === '') {
    noteAdapterReject(descriptor, 'session-missing', raw)
    return null
  }
  // t43 / M1：hook 入口与 poll 入口共用这一个校验函数，但**契约要求不同**：
  // poll 是适配器自己的观测，允许回落到声明值；hook 是外部进程递进来的事实，
  // 必须自带 completeness，否则就是幽灵行（宿主里根本没有这条待办）。
  const declaredCompleteness = descriptor === null || descriptor === undefined ? undefined : descriptor.completeness
  const explicitCompleteness = raw.completeness === 'partial' || raw.completeness === 'full' ? raw.completeness : null
  const requireExplicit = options !== null && options !== undefined && options.requireExplicitCompleteness === true
  const completeness = explicitCompleteness !== null
    ? explicitCompleteness
    : (requireExplicit ? null : (declaredCompleteness === 'partial' || declaredCompleteness === 'full' ? declaredCompleteness : null))
  if (completeness === null) {
    noteAdapterReject(descriptor, 'completeness-missing', raw)
    return null
  }
  const agent = descriptor === null || descriptor === undefined ? String(raw.agent ?? 'unknown') : descriptor.id
  const ts = Number.isFinite(raw.ts) ? Number(raw.ts) : Date.now()
  // dedupeKey 缺省不再带 agent 前缀：item.id 已经是 `<agent>#<dedupeKey>`，
  // 再拼一次会得到 `claude:claude:…` 这种重复前缀（t39 P0-1）。
  const agentPrefix = `${agent}:`
  let dedupeKey = typeof raw.dedupeKey === 'string' && raw.dedupeKey !== ''
    ? uslice(redactSecrets(raw.dedupeKey), 160)
    : `${kind}:${sessionRef}:${Math.round(ts / 1000)}`
  // 生产者常把 agent 名拼进 dedupeKey；item.id 是 `<agent>#<dedupeKey>`，再留一次就成
  // `codex#codex:…` 的重复前缀（t39 P0-1 明确点名这条）。这里削掉一次。
  if (dedupeKey.startsWith(agentPrefix)) dedupeKey = dedupeKey.slice(agentPrefix.length)
  const detail = typeof raw.detail === 'string' && raw.detail.trim() !== ''
    ? uslice(redactSecrets(raw.detail), 600)
    : null
  return {
    agent,
    kind,
    eventKind: kind,
    title: uslice(redactSecrets(rawTitle), 160),
    // detail 可选；没有就保持 null，让 HUD 不画空占位（t39 P0-4）。
    detail,
    sessionRef: uslice(sessionRef, 120),
    ts,
    dedupeKey,
    options: Array.isArray(raw.options) ? raw.options.slice(0, 8).map((option) => redactSecrets(String(option))) : undefined,
    // R3-H1：声明式 adapter 若自己带回了回执通道（answerRequest/answerToken/approvalId），
    // 必须原样带到 item 上——否则折叠成一个桶后，桶里那些待办就再也点不动了。
    answerRequest: typeof raw.answerRequest === 'string' && raw.answerRequest !== '' ? uslice(raw.answerRequest, 80) : undefined,
    answerToken: typeof raw.answerToken === 'string' && raw.answerToken !== '' ? uslice(raw.answerToken, 80) : undefined,
    approvalId: typeof raw.approvalId === 'string' && raw.approvalId !== '' ? uslice(raw.approvalId, 120) : undefined,
    // t52：DuMate 的 question ID（que_…）——HUD 用它做「复制问题 ID」与排障关联。
    questionRef: typeof raw.questionRef === 'string' && raw.questionRef !== '' ? uslice(raw.questionRef, 80) : undefined,
    // 别家若给出了对应的 DSH 会话（例如从 DSH 派出去的任务），点击优先跳 DSH。
    dshSession: typeof raw.dshSession === 'string' && raw.dshSession !== '' ? uslice(raw.dshSession, 120) : undefined,
    // t53：降级/终止原因（task-complete / task-failed / aborted / process-exited / stale-no-progress）。
    // 它决定了行文案与日志，不能让所有失败都写成同一个 `adapter-failed`。
    reason: typeof raw.reason === 'string' && raw.reason !== '' ? uslice(raw.reason, 40) : undefined,
    completeness,
    toastOnly: raw.toastOnly === true,
  }
}

function pushAdapterEvent(descriptor, event) {
  const store = adapterStore.get(descriptor.id) ?? new Map()
  store.set(event.dedupeKey, event)
  const now = Date.now()
  // R3-M1：终态事件（done/failed）不按 TTL 删。用户要的是「这条跑完了」，而真实 rollout 的
  // completed_at 可能就是几小时前——按事件自身 ts 过滤会把「完成」整条吃掉（复审实测 now−3h 被丢）。
  // 终态只受 ADAPTER_MAX_EVENTS 上限约束，且淘汰时优先淘汰非终态的最旧条目。
  const isTerminal = (event) => event?.kind === 'done' || event?.kind === 'failed'
  for (const [key, value] of store) {
    if (isTerminal(value)) continue
    if (now - value.ts > ADAPTER_EVENT_TTL_MS) store.delete(key)
  }
  if (store.size > ADAPTER_MAX_EVENTS) {
    const ordered = [...store.entries()].sort((a, b) => {
      const terminalDelta = Number(isTerminal(a[1])) - Number(isTerminal(b[1]))
      if (terminalDelta !== 0) return terminalDelta
      return a[1].ts - b[1].ts
    })
    for (const [key] of ordered.slice(0, store.size - ADAPTER_MAX_EVENTS)) store.delete(key)
  }
  adapterStore.set(descriptor.id, store)
}

/**
 * t53：把所有 adapter 的 running 事件做终态兜底。
 *
 * 规则（对 codex / dumate / workbuddy 一视同仁）：
 *   - running 的 ts 距今 < 10 分钟 → 不动（真在跑）。
 *   - 进程已退出（`processAlive()` 明确返回 false）→ failed，reason=process-exited，文案带「进程已退出」。
 *   - 进程还在但数据源 10 分钟没新增 → failed，reason=stale-no-progress。
 *   - 无法判进程（adapter 没实现 processAlive）→ 只看「有没有新进展」。
 * 降级后打一行日志，便于 grep 复盘；返回降级条数。
 */
function adapterSettleStaleRunning(descriptor, now) {
  const store = adapterStore.get(descriptor.id)
  if (store === undefined || store.size === 0) return 0
  let settled = 0
  for (const [key, event] of [...store.entries()]) {
    if (event.kind !== 'running') continue
    const seenAt = Number(event.ts ?? 0)
    const alive = typeof descriptor.processAlive === 'function' ? descriptor.processAlive() : null
    const progressAt = Math.max(adapterProgressAt.get(descriptor.id) ?? 0, seenAt)
    const idleMs = now - progressAt
    // t55：**没有进程持有就一定不是 running**——这条判定不需要等 10 分钟窗口。
    // 旧实现把「age < 窗口」放在最前面 continue，于是 CLI 已经退出、日志也不再写的行
    // 还要再挂 10 分钟才变 failed（用户口径：「明明没在跑却显示运行中」）。
    if (alive !== false) {
      if (!Number.isFinite(seenAt) || now - seenAt < ADAPTER_STALE_RUNNING_MS) continue
      if (idleMs < ADAPTER_STALE_RUNNING_MS) continue
    }
    // 0.7.2 兜底：同一次会话已经有过「不早于这条 running」的终态事件时，这条 running 就是
    // 撤回键错配留下的残影，静默收回，不要改写成 failed（否则用户看到「失败但清不掉」）。
    // 必须比较 ts：DuMate 在同一 session 里跑完一轮又开新一轮时，旧 done 的 ts 更小，
    // 新 running 不能被误删。
    const superseded = [...store.values()].some(other => other !== event
      && other.sessionRef === event.sessionRef
      && (other.kind === 'done' || other.kind === 'failed')
      && Number(other.ts ?? 0) >= seenAt)
    if (superseded) {
      store.delete(key)
      adapterRetracted += 1
      log(`adapter retract id=${descriptor.id} key=${uslice(key, 48)} reason=superseded`)
      continue
    }
    const reason = alive === false ? 'process-exited' : 'stale-no-progress'
    // 窗口文案按实际窗口给单位（用例会把窗口压到几百毫秒，写「0 分钟」就成了误导）。
    const windowText = ADAPTER_STALE_RUNNING_MS >= 60000
      ? `${Math.round(ADAPTER_STALE_RUNNING_MS / 60000)} 分钟`
      : `${Math.max(1, Math.round(ADAPTER_STALE_RUNNING_MS / 1000))} 秒`
    const detail = alive === false
      ? `进程已退出：${descriptor.label} 的 CLI 不在运行，且日志没有写终态`
      : `超过 ${windowText}没有新增日志（stale-no-progress）`
    store.delete(key)
    const failedKey = `${event.dedupeKey}:settled:${reason}`
    store.set(failedKey, {
      ...event,
      kind: 'failed',
      eventKind: 'failed',
      ts: now,
      dedupeKey: failedKey,
      reason,
      detail,
      // 行文案：把「正在运行」换成「没有完成」，别让用户看到「运行中 · 进程已退出」这种自相矛盾。
      title: uslice(String(event.title ?? '').replace(/正在运行|正在跑/, '没有完成'), 160),
    })
    adapterSettled += 1
    settled += 1
    log(`adapter stale id=${descriptor.id} key=${uslice(key, 48)} reason=${reason} ageMin=${Math.round((now - seenAt) / 60000)} idleMin=${Math.round(idleMs / 60000)}`)
  }
  return settled
}

/** 从偏移处读新增内容（只读、不写、不改 mtime）。文件被轮转（变小/inode 变）时从头读。 */
function readAppendedText(path, maxBytes = 512 * 1024) {
  let info
  try {
    info = statSync(path)
  } catch {
    return ''
  }
  const previous = adapterOffsets.get(path)
  let offset = previous !== undefined && previous.ino === info.ino && previous.offset <= info.size ? previous.offset : 0
  if (info.size - offset > maxBytes) offset = info.size - maxBytes
  let text = ''
  try {
    const fd = openSync(path, 'r')
    try {
      const length = Math.min(info.size - offset, maxBytes)
      if (length > 0) {
        const buffer = Buffer.alloc(length)
        readSync(fd, buffer, 0, length, offset)
        text = buffer.toString('utf8')
      }
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
  adapterOffsets.set(path, { offset: info.size, ino: info.ino })
  return text
}

// ── DSH（沿用现有通道，full）────────────────────────────────────────────────
registerAdapter({
  id: 'dsh',
  label: 'DSH',
  completeness: 'full',
  channel: 'host',
  note: '会话内提问与桥内审批走宿主通道（既有实现）',
  // 能力声明（t39 P0-3）：DSH 是唯一「确实能就地作答」的一家——被接管的提问有一次性 token。
  capabilities: { observe: true, answer: true, toastOnly: false, done: true },
  probe() {
    return { installed: true, running: null }
  },
  /**
   * 就地作答（唯一真正能写回的一家）：payload = { request, token, answers:[{id,selected,custom?}] }。
   * 与 `/x-radar/question-answer` 共用 `questionHold` 的一次性 token，避免出现第二条语义。
   */
  answer(payload) {
    const requestId = String(payload?.request ?? '')
    const token = String(payload?.token ?? '')
    const held = questionHold.get(requestId)
    if (held === undefined) return { ok: false, status: 410, error: 'request not pending' }
    if (token === '' || token !== held.token) return { ok: false, status: 403, error: 'bad token' }
    const answers = normalizeDshAnswers(payload?.answers, held.questions)
    if (answers === null) return { ok: false, status: 400, error: 'answers must be [{id, selected:[label], custom?}]' }
    held.settle('answered', answers)
    // 这里没有 ctx（adapterAnswer 是纯函数），靠 1s TTL 的下一次请求重建。
    invalidateSnapshot()
    return { ok: true, answered: answers.length }
  },
})

// ── Claude Code（hooks 推送，四态齐全；未装 hooks 则明确 unsupported）────────
const CLAUDE_DIR = join(homedir(), '.claude')
const CLAUDE_SETTINGS = join(CLAUDE_DIR, 'settings.json')
/** sid -> { kind, title, detail, ts, dedupeKey }：hook 是推送，这里只做「当前态」的落地 */
const claudeLive = new Map()
/**
 * 事件指纹（t39 F3）：同一会话的两条不同批准必须共存。
 *
 * 只用 `sid + kind` 做键时，「Bash: make build」会被后到的「git push --force」顶掉，
 * 而且 counts/rejected 都不动——用户永远看不到第一条（t37 已实测复现）。
 * 这里把「工具名 + 命令/问题摘要」折成 32 位 hash 塞进键里（djb2，不引依赖）。
 */
function eventFingerprint(parts) {
  const text = parts.map((part) => String(part ?? '')).join('\u0001')
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0
  return hash.toString(36)
}
/** 从 hook 的 stdin JSON 里抽字段（Claude 只保证 stdin，query 变量是猜的，t39 F5）。 */
function parseHookPayload(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let data
  try {
    data = JSON.parse(uslice(raw, 20000))
  } catch {
    return null
  }
  if (data === null || typeof data !== 'object') return null
  const toolInput = data.tool_input ?? data.toolInput ?? null
  const command = typeof toolInput === 'string'
    ? toolInput
    : toolInput !== null && typeof toolInput === 'object'
      ? (toolInput.command ?? toolInput.description ?? toolInput.question ?? toolInput.prompt ?? JSON.stringify(toolInput))
      : ''
  // R5-M3：真实 StopFailure payload 把原因放在**顶层**（`error` / `error.message` /
  // `stop_reason` / `reason`），并没有 tool_input。旧代码只认 tool_input，于是
  // 「优先取 error.message」这条路径在真机上永远走不到。候选顺序写在 spec §5-d。
  const topLevelDetail = data.error?.message ?? data.error ?? data.stop_reason ?? data.reason
  return {
    event: uslice(String(data.hook_event_name ?? data.event ?? ''), 40),
    sessionId: uslice(String(data.session_id ?? data.sessionId ?? ''), 80),
    toolName: uslice(String(data.tool_name ?? data.toolName ?? ''), 80),
    detail: uslice(String(topLevelDetail ?? command ?? ''), 240),
    cwd: uslice(String(data.cwd ?? ''), 200),
  }
}

function claudeSettings() {
  try {
    const parsed = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8'))
    return { exists: true, settings: parsed, hooks: parsed?.hooks }
  } catch {
    return { exists: false, settings: null, hooks: null }
  }
}

function claudeHooksInstalled() {
  const { hooks } = claudeSettings()
  return hooks !== null && typeof hooks === 'object' && Object.keys(hooks).length > 0
}

// 规范词表（t39 P0-2）：内置生产者直接产出 needs-input / needs-approval / done / failed / running。
// 旧词 question / approval 仍被 normalizeAdapterEvent 接受（给外部/声明式 adapter 的弃用映射）。
const CLAUDE_EVENT_KIND = {
  PermissionRequest: 'needs-approval',
  Elicitation: 'needs-input',
  Stop: 'done',
  StopFailure: 'failed',
  Notification: 'done',
}

registerAdapter({
  id: 'claude',
  label: 'CLAUDE',
  completeness: 'full',
  channel: 'hooks',
  note: 'hooks 未安装：用 /x-radar/claude-hook-config 取引导（本分支不代写用户配置）',
  // t43 / M4：snapshot 首帧（本轮观测还没跑）也必须是运行时事实，不能照抄声明文案。
  noteNow() {
    const installed = existsSync(CLAUDE_DIR)
    if (!installed) return '未检测到 ~/.claude'
    return claudeHooksInstalled() ? 'hooks 已装（PermissionRequest/Elicitation/Stop/StopFailure）' : '~/.claude 存在但 settings.json 无 hooks 键'
  },
  probe() {
    const installed = existsSync(CLAUDE_DIR)
    const hooks = claudeHooksInstalled()
    return {
      installed: installed && hooks,
      running: claudeLive.size > 0,
      // 装上 hooks 才是 full；没装就诚实标 unsupported（spec §3.1 fail-closed）。
      completeness: installed && hooks ? 'full' : 'unsupported',
      note: !installed ? '未检测到 ~/.claude' : hooks ? 'hooks 已装（PermissionRequest/Elicitation/Stop/StopFailure）' : '~/.claude 存在但 settings.json 无 hooks 键',
    }
  },
  poll() {
    const now = Date.now()
    const events = []
    for (const [liveKey, live] of claudeLive) {
      if (now - live.ts > ADAPTER_EVENT_TTL_MS) {
        claudeLive.delete(liveKey)
        continue
      }
      // t43 / M6：对外只暴露纯 sessionRef（存进 live 的那份），指纹只留在 dedupeKey 里。
      const sessionRef = live.sessionRef ?? liveKey.split('|')[0]
      events.push({ kind: live.kind, title: live.title, detail: live.detail, sessionRef, ts: live.ts, dedupeKey: live.dedupeKey, completeness: 'partial' })
    }
    return events
  },
})

/** Claude hook 落点：`GET /x-radar/claude-hook?ev=PermissionRequest&sid=…&title=…`。
 *  为什么是 GET：宿主 webserver 只放行 GET/HEAD（POST 会 405），所以 hooks 配 `type: command`
 *  跑一条 curl 最稳；命令由 /x-radar/claude-hook-config 生成，用户自己粘贴。 */
function claudeHook(url) {
  // F5：优先吃 hooks 从 stdin 递进来的整包 JSON（session_id/tool_name/hook_event_name/tool_input），
  // query 只作兼容旧引导的回落——`$CLAUDE_SESSION_ID`/`$CLAUDE_TOOL_NAME` 并不是 Claude 的契约变量。
  const payload = parseHookPayload(url.searchParams.get('raw') ?? '')
  const ev = payload?.event || url.searchParams.get('ev') || ''
  // t43 / M1：**不要**在缺 session_id 时回落成 'claude'——那会造出「有行、但宿主没有这条待办」的
  // 幽灵行，且永远触发不了 session-missing。缺就留空，交给 normalizeAdapterEvent 拒收并计数。
  const sid = uslice(
    payload !== null && payload !== undefined
      ? String(payload.sessionId ?? '')
      : String(url.searchParams.get('sid') ?? url.searchParams.get('session') ?? ''),
    80,
  )
  const kind = CLAUDE_EVENT_KIND[ev]
  if (kind === undefined) {
    log(`claude hook ignored ev=${uslice(ev, 24)}`)
    return { ok: false, error: 'unknown event', accepted: false }
  }
  const toolName = payload?.toolName || url.searchParams.get('title') || url.searchParams.get('tool') || ''
  const payloadDetail = payload?.detail || url.searchParams.get('detail') || ''
  // t43 / M6b：待办行的标题必须是**问题正文首句**（截 60 字），工具名挪到副行。
  // Elicitation 的正文来自 tool_input.question/prompt（parseHookPayload 已挑出来放在 detail 里）。
  const isPending = kind === 'needs-input' || kind === 'needs-approval'
  const rawTitle = isPending && payloadDetail !== '' ? uslice(payloadDetail, 60) : toolName
  const detail = isPending && toolName !== '' && toolName !== rawTitle
    ? uslice([toolName, payloadDetail].filter((part) => part !== '').join(' · '), 240)
    : payloadDetail
  const noOptions = kind === 'needs-input' || kind === 'needs-approval'
  // F3：指纹进键（工具名 + 命令/问题摘要），让同会话的两条不同批准各自成行。
  const fingerprint = eventFingerprint([kind, rawTitle, detail])
  const liveKey = `${sid}|${fingerprint}`
  if (kind === 'done' || kind === 'failed') {
    // 终态清掉该会话全部「进行中」，并把终态推给 bus（dedupeKey 带时间戳防重复上报）。
    for (const key of [...claudeLive.keys()]) {
      if (key === sid || key.startsWith(`${sid}|`)) claudeLive.delete(key)
    }
    const ts = Date.now()
    // R3-H2：终态行不能拿事件名（StopFailure）当标题、也不能把整包 JSON 当正文。
    // 失败给人话「Claude 会话失败：<摘要>」，摘要优先取 error.message；没有就退回固定说法。
    const readable = humanText(payloadDetail) ?? humanText(detail)
    const fixedFailure = ev === 'StopFailure' ? '会话被中断' : '会话失败'
    const failureText = readable ?? fixedFailure
    // t47：摘要**等于**固定说法时不再加括号后缀（否则会写出「会话被中断（会话被中断）」）。
    const failureTitle = failureText === fixedFailure
      ? `Claude 会话失败：${fixedFailure}`
      : (ev === 'StopFailure' ? `Claude 会话失败：会话被中断（${failureText}）` : `Claude 会话失败：${failureText}`)
    const title = kind === 'done'
      ? (readable === undefined ? 'Claude 任务完成' : uslice(`Claude 任务完成：${readable}`, 80))
      : uslice(failureTitle, 80)
    // t43 / M1：事件自带 completeness（hooks 只能观察、不能代答 ⇒ partial），
    // 这样 hook 入口走的是「必须显式 completeness」的严格分支。
    return { ok: true, accepted: true, event: { kind, title, detail: kind === 'failed' ? failureText : (readable ?? detail), sessionRef: sid, ts, completeness: 'partial', dedupeKey: `claude:${sid}:${kind}:${ts}` } }
  }
  const ts = Date.now()
  const title = rawTitle || (kind === 'needs-approval' ? 'Claude 在等批准' : 'Claude 在等你回答')
  const dedupeKey = `claude:${sid}:${kind}:${fingerprint}`
  // t43 / M6：claudeLive 的 key 是 `${sid}|${fingerprint}`（内部复合键），
  // 所以 sessionRef 必须单独存一份——否则 poll 会把 `sess-x|kid` 直接暴露到 feed 里。
  claudeLive.set(liveKey, { kind, title, detail, ts, dedupeKey, sessionRef: sid })
  if (noOptions) {
    // 只观察：返回 ask 让 Claude 自己的界面继续弹卡，用户仍然在那边处理（不接管）。
  }
  return { ok: true, accepted: true, event: { kind, title, detail, sessionRef: sid, ts, completeness: 'partial', dedupeKey } }
}

/** 一键写入 hooks 的「引导」：只输出片段 + 现状检测，绝不代写（禁止项）。 */
function claudeHookConfig(ctx) {
  let port
  try {
    port = ctx.get('webServer')?.port
  } catch {}
  const base = Number.isFinite(port) ? `http://127.0.0.1:${port}/x-radar/claude-hook` : 'http://127.0.0.1:<port>/x-radar/claude-hook'
  // F5：只依赖 claude 的契约——hooks 把整包 JSON 从 stdin 递进来。整包转成 raw 参数发走，
  // 插件侧 parseHookPayload 解析（session_id/tool_name/hook_event_name/tool_input）。
  // `-G --data-urlencode` 负责把空格/中文/`+`/`&` 编好；`-m 2 || true` 不阻塞 claude。
  const hook = (ev) => ({
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: `payload=$(cat); curl -sS -m 2 -G "${base}?ev=${ev}" --data-urlencode "raw=$payload" >/dev/null 2>&1 || true`,
      },
    ],
  })
  const settings = claudeSettings()
  return {
    ok: true,
    hooksInstalled: claudeHooksInstalled(),
    settingsPath: CLAUDE_SETTINGS,
    settingsExists: settings.exists,
    snippet: {
      hooks: {
        PermissionRequest: [hook('PermissionRequest')],
        Elicitation: [hook('Elicitation')],
        Stop: [hook('Stop')],
        StopFailure: [hook('StopFailure')],
      },
    },
    applyHint: `把 snippet.hooks 合并进 ${CLAUDE_SETTINGS} 的 "hooks" 键（本分支不代写；合并后重启 Claude Code 生效）`,
  }
}

/**
 * Claude hook 落点（GET）：`GET /x-radar/claude-hook?ev=PermissionRequest&sid=…&title=…`。
 * 只登记事件、不代答：Claude 自己的界面继续弹卡，用户在那边处理；胶囊只负责「让你看见」。
 */
function claudeAccept(url) {
  const descriptor = adapterRegistry.get('claude')
  const result = claudeHook(url)
  if (descriptor !== undefined && result !== null && typeof result === 'object' && result.event !== undefined) {
    // t43 / M1：hook 入口用严格模式（必须显式 completeness + 非空 sessionRef）。
    const event = normalizeAdapterEvent(descriptor, result.event, { requireExplicitCompleteness: true })
    if (event !== null) {
      pushAdapterEvent(descriptor, event)
      log(`claude hook accepted kind=${event.kind} sid=${uslice(String(event.sessionRef ?? ''), 16)}`)
      return result
    }
    // t43 / M1：契约校验没过就不是「已接收」。原来无论如何都回 accepted=true，
    // 于是 hook 以为送达、用户在雷达里却看不到（幽灵行的另一半原因）。
    log(`claude hook rejected ev=${uslice(String(result?.event?.kind ?? '-'), 24)}`)
    return { ok: false, accepted: false, error: 'rejected by contract validation' }
  }
  return result
}

// ── DuMate / 百度搭子（内嵌 opencode 的事件日志镜像，只读，partial）──────────
//
// 事实来源（t52）：`~/Library/Application Support/qianfan-desktop-app/log/desktop-main/AgtEvent.log`。
// 每行都带 shell 前缀，**必须先剥掉再解析**：
//   `2026-11-23T17:07:12.345\tDEBUG\t\t[AgtEvent]\t-         \tevent: {"type":...}`
// 实测事件（9.2MB 日志）：message.part.delta / message.part.updated / message.updated /
// session.status(273) / session.updated(221) / session.turn.completed(23) / session.idle(23) /
// question.asked(2) / question.replied(2) / question.deadline.updated(7)。
// 四态映射：session.status.status.type=busy → running；idle 或 turn.completed → done；
// question.asked → needs-input（replied / deadline 过期 → 收回）；error/exception/abort → failed。
const DUMATE_EVENT_LOG = process.env.DSH_TASK_RADAR_DUMATE_LOG !== undefined && process.env.DSH_TASK_RADAR_DUMATE_LOG !== ''
  ? process.env.DSH_TASK_RADAR_DUMATE_LOG
  : join(homedir(), 'Library', 'Application Support', 'qianfan-desktop-app', 'log', 'desktop-main', 'AgtEvent.log')
const DUMATE_DIR = join(homedir(), 'Library', 'Application Support', 'qianfan-desktop-app')
const DUMATE_TAIL_BYTES = 256 * 1024
const DUMATE_SESSION_TTL_MS = 6 * 60 * 60 * 1000
const DUMATE_QUESTION_TTL_MS = 10 * 60 * 1000
const DUMATE_TERMINAL_MS = 30 * 60 * 1000
/** sessionId -> { sid, title, directory, status, since, at, idleAt, question, pendingDone, failed, doneTurn } */
const dumateSessions = new Map()
const dumateSeen = new Set()
const dumateQuestionKeys = new Map()
const dumateStats = { bytes: 0, lines: 0, emitted: 0, pollMs: 0, lastBytes: 0, retracted: 0, sessions: 0 }

function dumateState(sid) {
  let state = dumateSessions.get(sid)
  if (state === undefined) {
    state = {
      sid, title: '', directory: '', status: 'unknown',
      since: 0, at: 0, idleAt: 0, question: null, pendingDone: null, failed: null, doneTurn: null,
    }
    dumateSessions.set(sid, state)
  }
  return state
}

/** 日志行形如：`2026-11-23T11:01:18.820\tDEBUG\t\t[AgtEvent]\t-\t \tevent: {json}` */
function parseDumateLine(line) {
  const index = line.indexOf('event: ')
  if (index === -1) return null
  let parsed
  try {
    parsed = JSON.parse(line.slice(index + 7))
  } catch {
    return null
  }
  // 时间戳取行首的时间（本地时区），而不是读取时刻：否则「昨天跑完的一批 turn」
  // 会在第一次读日志时被当成刚完成，全挤进未读里。
  let ts = Date.now()
  const head = line.slice(0, 23)
  const stamp = Date.parse(head)
  if (Number.isFinite(stamp)) ts = stamp
  return { event: parsed, ts }
}

function dumateNoteOf(question) {
  const header = String(question?.header ?? '').trim()
  if (header !== '') return uslice(redactSecrets(header), 80)
  const text = String(question?.question ?? '').trim().split('\n')[0]
  return uslice(redactSecrets(text), 80) || 'DuMate 在等你回答'
}

registerAdapter({
  id: 'dumate',
  label: 'DUMATE',
  stats() { return { ...dumateStats } },
  completeness: 'partial',
  channel: 'log-sse',
  note: '读取 opencode 事件日志（增量 tail）；busy/idle 判运行、question.* 判等回答',
  // t53：DuMate 的日志由桌面端进程写；进程没了却还留着 busy 状态时，不能继续说「正在运行」。
  processAlive() {
    return cliProcessAlive(/DuMate|qianfan-desktop/i)
  },
  probe() {
    const installed = existsSync(DUMATE_DIR)
    let running = false
    let ageMs = null
    try {
      const info = statSync(DUMATE_EVENT_LOG)
      ageMs = Date.now() - info.mtimeMs
      running = ageMs < 5 * 60 * 1000
    } catch {}
    return {
      installed,
      running,
      completeness: installed ? 'partial' : 'unsupported',
      note: installed ? (ageMs === null ? '日志不可读' : `日志 ${Math.round(ageMs / 1000)}s 前更新`) : '未检测到 qianfan-desktop-app',
    }
  },
  poll() {
    const startedAt = Date.now()
    const text = readAppendedText(DUMATE_EVENT_LOG, DUMATE_TAIL_BYTES)
    const bytes = text === '' ? 0 : Buffer.byteLength(text, 'utf8')
    dumateStats.lastBytes = bytes
    dumateStats.pollMs = 0
    const now = Date.now()
    const retract = new Set()
    if (text !== '') {
      dumateStats.bytes += bytes
      for (const line of text.split('\n')) {
        const wrapped = parseDumateLine(line)
        if (wrapped === null) continue
        dumateStats.lines += 1
        const parsed = wrapped.event
        const ts = wrapped.ts
        const type = String(parsed.type ?? '')
        const props = parsed.properties ?? {}
        const sid = String(props.sessionID ?? props.sessionId ?? props.info?.id ?? '')
        if (sid === '') continue
        const state = dumateState(sid)
        state.at = Math.max(state.at, ts)

        if (type === 'session.updated') {
          const info = props.info ?? {}
          if (typeof info.title === 'string' && info.title.trim() !== '') state.title = uslice(redactSecrets(info.title.trim()), 80)
          if (typeof info.directory === 'string') state.directory = info.directory
          continue
        }
        if (type === 'session.status') {
          // 真实形状是 `status: { type: 'busy' | 'idle' }`（不是字符串）——旧实现读成
          // `String(props.status)` 得到 `[object Object]`，于是 running 永远判不出来。
          const status = props.status !== null && typeof props.status === 'object'
            ? String(props.status.type ?? '')
            : String(props.status ?? '')
          if (status === 'busy' || status === 'running') {
            if (state.status !== 'busy') state.since = ts
            state.status = 'busy'
            state.idleAt = 0
            state.failed = null
          } else if (status === 'idle') {
            state.status = 'idle'
            state.idleAt = Math.max(state.idleAt, ts)
          }
          continue
        }
        if (type === 'session.idle') {
          state.status = 'idle'
          state.idleAt = Math.max(state.idleAt, ts)
          continue
        }
        if (type === 'session.turn.completed') {
          const status = String(props.status ?? 'completed').toLowerCase()
          const requestID = String(props.requestID ?? '')
          if (status === 'completed' || status === 'success' || status === 'ok') {
            state.doneTurn = { requestID, ts }
          } else {
            // status 是机器码（error/failed/abort…），别直接拼进标题（会得到「失败：error：」）。
            state.failed = { ts, message: '这一轮没有完成', reason: uslice(redactSecrets(status), 40) }
          }
          continue
        }
        if (type === 'question.asked') {
          state.question = {
            id: String(props.id ?? ''),
            questions: Array.isArray(props.questions) ? props.questions : [],
            askedAt: ts,
            deadlineAt: 0,
          }
          continue
        }
        if (type === 'question.replied') {
          const requestID = String(props.requestID ?? '')
          if (state.question !== null && (requestID === '' || state.question.id === requestID)) {
            state.question = null
          }
          continue
        }
        if (type === 'question.deadline.updated') {
          const requestID = String(props.requestID ?? '')
          const deadlineAt = Number(props.deadlineAt)
          if (state.question !== null && (requestID === '' || state.question.id === requestID)) {
            if (Number.isFinite(deadlineAt) && deadlineAt > 0) state.question.deadlineAt = deadlineAt
          }
          continue
        }
        if (/(error|exception|failed|abort|rejected)/i.test(type)) {
          const message = props.message ?? props.error ?? props.detail ?? props.reason ?? '这一轮没有完成'
          state.failed = { ts, message: uslice(redactSecrets(String(message)), 160), reason: uslice(type, 40) }
          continue
        }
      }
    }

    const events = []
    for (const state of [...dumateSessions.values()]) {
      if (now - state.at > DUMATE_SESSION_TTL_MS) {
        dumateSessions.delete(state.sid)
        continue
      }
      const sid = state.sid
      const suffix = state.title === '' ? '' : `：${state.title}`
      // ① 等回答：一个问题一条事件（同会话折叠后展开就是逐题）
      if (state.question !== null) {
        const question = state.question
        const expiredByDeadline = question.deadlineAt > 0 && now > question.deadlineAt
        const expiredByTtl = question.deadlineAt === 0 && now - question.askedAt > DUMATE_QUESTION_TTL_MS
        if (expiredByDeadline || expiredByTtl) {
          for (const key of dumateQuestionKeys.get(sid) ?? []) retract.add(key)
          dumateQuestionKeys.set(sid, [])
          state.question = null
        } else {
          const keys = []
          question.questions.forEach((ask, index) => {
            const qid = question.id === '' ? `${sid}:${index}` : question.id
            const key = `${sid}:question:${qid}:${index}`
            keys.push(key)
            const already = dumateSeen.has(key)
            if (already) return
            dumateSeen.add(key)
            const options = Array.isArray(ask?.options)
              ? ask.options.slice(0, 8).map((option) => uslice(redactSecrets(String(option?.label ?? option ?? '')), 60)).filter((label) => label !== '')
              : []
            events.push({
              kind: 'needs-input',
              title: `${dumateNoteOf(ask)}${suffix}`,
              detail: uslice(redactSecrets(String(ask?.question ?? '')), 600),
              options: options.length > 0 ? options : undefined,
              sessionRef: sid,
              questionRef: qid,
              ts: question.askedAt,
              dedupeKey: key,
              completeness: 'partial',
            })
          })
          dumateQuestionKeys.set(sid, keys)
        }
      } else if (dumateQuestionKeys.has(sid)) {
        for (const key of dumateQuestionKeys.get(sid) ?? []) retract.add(key)
        dumateQuestionKeys.delete(sid)
      }
      // ② 运行中：busy 期间一直有一条 running（同 key 覆盖，不刷屏）
      if (state.status === 'busy') {
        events.push({
          kind: 'running',
          title: `DuMate 正在运行${suffix}`,
          sessionRef: sid,
          ts: state.since > 0 ? state.since : state.at,
          dedupeKey: `${sid}:running`,
          completeness: 'partial',
        })
        continue
      }
      // ③ 失败：错误事件/非 completed 的 turn
      // 失败优先：turn.completed 的 status 不是 completed 就已经定性了这一轮；
      // 紧随其后的 session.idle 只是「不再忙」，不能把失败翻成完成（t52 实测翻车点）。
      if (state.failed !== null) {
        const key = `${sid}:failed:${Math.round(state.failed.ts / 1000)}`
        if (!dumateSeen.has(key)) {
          dumateSeen.add(key)
          retract.add(`${sid}:running`)
          events.push({
            kind: 'failed',
            title: `DuMate 任务失败：${state.failed.message}${suffix}`,
            detail: state.failed.reason === undefined ? state.failed.message : `${state.failed.message}（${state.failed.reason}）`,
            sessionRef: sid,
            ts: state.failed.ts,
            dedupeKey: key,
            completeness: 'partial',
          })
        }
        continue
      }
      // ④ 完成：idle（或 turn.completed 且已 idle）后一条 done
      const idleAt = state.idleAt > 0 ? state.idleAt : (state.doneTurn !== null ? state.doneTurn.ts : 0)
      if (idleAt > 0 && now - idleAt <= DUMATE_TERMINAL_MS) {
        const requestID = state.doneTurn !== null ? state.doneTurn.requestID : ''
        const key = `${sid}:done:${requestID === '' ? Math.round(idleAt / 1000) : requestID}`
        if (!dumateSeen.has(key)) {
          dumateSeen.add(key)
          retract.add(`${sid}:running`)
          events.push({
            kind: 'done',
            title: `DuMate 任务完成${suffix}`,
            sessionRef: sid,
            ts: idleAt,
            dedupeKey: key,
            completeness: 'partial',
          })
        }
      }
    }
    dumateStats.sessions = dumateSessions.size
    dumateStats.emitted += events.length
    dumateStats.retracted += retract.size
    dumateStats.pollMs = Date.now() - startedAt
    if (bytes > 0 || retract.size > 0) {
      log(`dumate poll bytes=${bytes} lines=${dumateStats.lines} live=${events.length} retract=${retract.size} sessions=${dumateSessions.size} ms=${dumateStats.pollMs}`)
    }
    return { events, retract: [...retract] }
  },
})

// ── WorkBuddy（audit-log 只读 + 心跳注册表，partial）─────────────────────────
const WORKBUDDY_DIR = join(homedir(), '.workbuddy')
const WORKBUDDY_AUDIT = join(WORKBUDDY_DIR, 'audit-log')
const WORKBUDDY_SESSIONS = join(WORKBUDDY_DIR, 'sessions')
// t54：审计日志路径可用 DSH_TASK_RADAR_WORKBUDDY_AUDIT 指到夹具目录（用例不改用户真实日志）。
const WORKBUDDY_AUDIT_OVERRIDE = process.env.DSH_TASK_RADAR_WORKBUDDY_AUDIT
const workbuddySeen = new Set()
const workbuddyStats = { lines: 0, emitted: 0, ignored: 0, unknown: 0, approvals: 0 }
const workbuddyUnknownTypes = new Set()

/** 安全决策里「需要人处理」的 decision 取值（真机观测到 allowed/info/approved，
 *  denied/needs-approval/blocked 来自 WorkBuddy 的拒绝/待批/拦截分支）。 */
const WORKBUDDY_PENDING_DECISIONS = new Set(['denied', 'needs-approval', 'blocked', 'ask-matched'])
/** 已经落定的 decision：纯审计流水，绝不能当待办（否则每次 allow 都冒一条）。 */
const WORKBUDDY_SETTLED_DECISIONS = new Set(['allowed', 'approved', 'info'])

/** 从一条 audit-log 记录判定它是不是「等人处理」的安全决策（t54）。
 *
 * 真机字段是 `eventType` / `category` / `decision` / `commandPreview`，
 * 旧实现只认字面量 `file-safety.needs-approval`，于是 99% 的记录都落成 `?`、产出恒 0 条。
 * 这里的判据是「安全类别 + decision 未落定」，eventType 只作为二次线索。
 */
function workbuddyVerdict(record) {
  const eventType = String(record?.eventType ?? '')
  const category = String(record?.category ?? (eventType.includes('.') ? eventType.split('.')[0] : ''))
  const decision = String(record?.decision ?? '').toLowerCase()
  const safety = category === 'command-safety' || category === 'file-safety'
    || eventType.startsWith('command-safety.') || eventType.startsWith('file-safety.')
  if (!safety) return { pending: false, reason: 'unknown-type' }
  if (WORKBUDDY_SETTLED_DECISIONS.has(decision)) return { pending: false, reason: 'settled' }
  if (WORKBUDDY_PENDING_DECISIONS.has(decision)) return { pending: true, reason: decision }
  // decision 缺失时，eventType 的尾段仍能表达「待批/被拒/被拦」。
  if (/\.(needs-approval|denied|blocked)$/.test(eventType)) return { pending: true, reason: eventType.split('.').pop() }
  return { pending: false, reason: 'no-decision' }
}

/** 运行时说明：把「未识别事件类型」的真实取值暴露出来，便于发现 WorkBuddy 又加了新事件。
 *
 * 必须同时给 `probe().note` 用——`adapterSnapshot` 取的是「最近一次观测的 note」，
 * 只在 noteNow() 里写会被 probe 的「日志 Ns 前更新」盖掉（t54 实测）。
 */
function workbuddyNote() {
  if (workbuddyUnknownTypes.size === 0) {
    return '只读 audit-log：只有安全决策事件，没有会话生命周期事件，因此不提供完成态'
  }
  return `只读 audit-log：只有安全决策事件，不提供完成态；未识别事件类型 ${[...workbuddyUnknownTypes].slice(0, 3).join('、')}（不出条目）`
}

/** 一句话说明这条待办问的是什么：命令/路径预览优先，其次规则命中说明。 */
function workbuddyPreview(record) {
  const preview = String(record?.commandPreview ?? '').trim()
  if (preview !== '') return uslice(redactSecrets(preview), 300)
  const paths = record?.messageParams?.paths ?? record?.messageParams?.path ?? ''
  const text = Array.isArray(paths) ? paths.join(', ') : String(paths)
  if (text !== '') return uslice(redactSecrets(text), 300)
  const rule = String(record?.messageParams?.matchedRule ?? '')
  return rule === '' ? '' : uslice(redactSecrets(rule), 300)
}

function workbuddyAuditFile(now = new Date()) {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const base = WORKBUDDY_AUDIT_OVERRIDE !== undefined && WORKBUDDY_AUDIT_OVERRIDE !== '' ? WORKBUDDY_AUDIT_OVERRIDE : WORKBUDDY_AUDIT
  return join(base, `${day}.jsonl`)
}

registerAdapter({
  id: 'workbuddy',
  label: 'WB',
  completeness: 'partial',
  channel: 'audit-log',
  // t54：能力边界要写死并说明原因——audit-log 只有安全决策事件（command/file-safety），
  // 没有会话生命周期事件，所以**不可能**给出完成态。这里报 done=false，绝不伪造 done。
  capabilities: { observe: true, answer: false, toastOnly: false, done: false },
  note: '只读 audit-log：只有安全决策事件，没有会话生命周期事件，因此不提供完成态',
  stats() { return { ...workbuddyStats } },
  // 运行时说明：把「未识别事件类型」的真实取值暴露出来，便于发现 WorkBuddy 又加了新事件。
  noteNow() { return workbuddyNote() },
  // t53：WorkBuddy 的命令行/守护进程还在才算 running（心跳文件也可能停在旧时间）。
  processAlive() {
    return cliProcessAlive(/WorkBuddy|workbuddy/i)
  },
  probe() {
    const installed = existsSync(WORKBUDDY_DIR)
    let running = false
    try {
      if (existsSync(WORKBUDDY_SESSIONS)) {
        for (const name of readdirSync(WORKBUDDY_SESSIONS)) {
          if (!name.endsWith('.json')) continue
          try {
            const beat = JSON.parse(readFileSync(join(WORKBUDDY_SESSIONS, name), 'utf8'))
            if (Number.isFinite(beat?.lastHeartbeat) && Date.now() - beat.lastHeartbeat < 60 * 1000) running = true
          } catch {}
        }
      }
    } catch {}
    return { installed, running, completeness: installed ? 'partial' : 'unsupported', note: workbuddyNote() }
  },
  poll() {
    const path = workbuddyAuditFile()
    const text = readAppendedText(path, 512 * 1024)
    if (text === '') return []
    const events = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || !trimmed.startsWith('{')) continue
      let record
      try {
        record = JSON.parse(trimmed)
      } catch {
        continue
      }
      workbuddyStats.lines += 1
      const verdict = workbuddyVerdict(record)
      if (!verdict.pending) {
        // 落定的允许/已批记录是审计流水：不出条目（否则每次 allow 都冒一条噪声）。
        workbuddyStats.ignored += 1
        if (verdict.reason === 'unknown-type') {
          workbuddyStats.unknown += 1
          const eventType = String(record.eventType ?? '(无 eventType)')
          if (workbuddyUnknownTypes.size < 12) workbuddyUnknownTypes.add(eventType)
          log(`workbuddy note unknown eventType=${eventType}（不出条目）`)
        }
        continue
      }
      const key = `workbuddy:${record.id ?? record.requestId ?? record.timestamp ?? `${record.sessionId}:${record.sequence ?? ''}`}`
      if (workbuddySeen.has(key)) continue
      workbuddySeen.add(key)
      const preview = workbuddyPreview(record)
      const category = String(record.category ?? '')
      const title = category === 'file-safety' || String(record.eventType ?? '').startsWith('file-safety.')
        ? 'WorkBuddy 需要确认文件操作'
        : 'WorkBuddy 需要确认命令执行'
      workbuddyStats.emitted += 1
      workbuddyStats.approvals += 1
      log(`workbuddy pending decision=${String(record.decision ?? '')} eventType=${String(record.eventType ?? '')} reason=${verdict.reason}`)
      events.push({
        kind: 'needs-approval',
        title: preview === '' ? title : `${title}：${uslice(preview, 60)}`,
        detail: preview,
        sessionRef: String(record.sessionId ?? ''),
        ts: Number.isFinite(record.timestamp) ? Number(record.timestamp) : Date.now(),
        dedupeKey: key,
        completeness: 'partial',
        reason: `workbuddy-${verdict.reason}`,
      })
    }
    return events
  },
})

// ── Codex（rollout 只读扫描；本机 approval_policy=never，不产生「等批准」）──────
// t43：允许用环境变量指向别的 sessions 根目录（自测用；也顺手支持自定义 CODEX_HOME）。
const CODEX_SESSIONS = process.env.DSH_TASK_RADAR_CODEX_DIR !== undefined && process.env.DSH_TASK_RADAR_CODEX_DIR !== ''
  ? process.env.DSH_TASK_RADAR_CODEX_DIR
  : join(homedir(), '.codex', 'sessions')
const codexSeen = new Set()
// t43 / M3：两个账本。
// `codexSeen` 记「已处理过的 turn」（key 含 thread + 终态 ts），落盘到 STATE_DIR/codex-seen.json，
// 这样宿主重启后**不会重复上报**同一个完成事件，也不会因为「超过 10 分钟窗口」把它静静丢掉。
// `codexOffsets` 记每个 rollout 文件的 size/mtime，文件没变就一轮跳过（成本可控）。
const codexOffsets = new Map()
let codexSeenLoaded = false
function codexSeenFile() {
  return join(STATE_DIR, 'codex-seen.json')
}
function loadCodexSeen() {
  if (codexSeenLoaded) return
  codexSeenLoaded = true
  try {
    const raw = readFileSync(codexSeenFile(), 'utf8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) for (const key of parsed) if (typeof key === 'string') codexSeen.add(key)
  } catch {}
}
function rememberCodexSeen(key) {
  codexSeen.add(key)
  // 账本只留最近 400 条，避免无限增长（rollout 是按天分目录的，旧 key 没有价值）。
  const keys = [...codexSeen].slice(-400)
  codexSeen.clear()
  for (const item of keys) codexSeen.add(item)
  try {
    writeFileSync(codexSeenFile(), JSON.stringify(keys))
  } catch {}
}

function codexDayDirs(now = new Date()) {
  const dirs = []
  for (const shift of [0, -1]) {
    const day = new Date(now.getTime() + shift * 24 * 60 * 60 * 1000)
    dirs.push(join(CODEX_SESSIONS, String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')))
  }
  return dirs
}

/** 读 rollout 尾部若干行，判断这次 turn 走到哪了。只读、只取最后 40 行。 */
function codexTurnState(path) {
  const text = readFileSync(path, 'utf8')
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  const tail = lines.slice(-40)
  let cwd = ''
  let started = null
  let completed = null
  let failed = null
  // t53：把「这是哪种终止」带出去，日志与行文案据此区分 task-complete / aborted / task-failed。
  let failedKind = ''
  // t55：行的身份 = 这一次提问，而不是 cwd 目录名。
  // 旧实现拿 `basename(cwd)` 当标题，同一目录下的十几个 rollout 全叫「yun-x」，
  // 用户看到的是「Codex 没有完成：yun-x」——跨 rollout 串味、且看不出让它干什么。
  // 现在取该 rollout 里第一条**真人** user 输入（跳过 environment_context / skills_instructions
  // 这类注入），截 40 字；取不到才回落到目录名的短形式。
  let prompt = ''
  for (const line of lines) {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (String(record.type ?? '') !== 'response_item') continue
    const item = record.payload ?? {}
    if (String(item.type ?? '') !== 'message' || String(item.role ?? '') !== 'user') continue
    const parts = Array.isArray(item.content) ? item.content : []
    const body = parts
      .filter((part) => part !== null && typeof part === 'object' && typeof part.text === 'string')
      .map((part) => String(part.text))
      .join('\n')
      .trim()
    if (body === '') continue
    // 注入块：`<environment_context>` / `<skills_instructions>` 之类，不是用户的问题。
    if (body.startsWith('<') && body.indexOf('>') > 0) continue
    prompt = uslice(body.replace(/\s+/g, ' ').trim(), 40)
    break
  }
  for (const line of tail) {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const type = String(record.type ?? '')
    const payload = record.payload ?? {}
    if (type === 'turn_context' && typeof payload.cwd === 'string') cwd = payload.cwd
    // t53：codex 的终止事件不止 task_complete。真机里还见过 `turn_aborted`（用户 Esc）
    // 与 `task_failed`（工具/网络失败），以及裸 `error` 记录。旧实现只认 task_complete →
    // 「一轮已经结束」的 rollout 永远停在 running（用户看到的「codex 一直显示运行中」）。
    // t55：再把 `turn_canceled` / `turn_cancelled` / `interrupted` 纳入终态——
    // 删掉一轮不等于没结束，停在 running 才是最糟的谎。
    if (type === 'error') failed = String(payload.message ?? record.message ?? 'codex error')
    if (type === 'turn_aborted' || type === 'turn_canceled' || type === 'turn_cancelled' || type === 'interrupted') {
      failed = String(payload.reason ?? payload.message ?? type)
      failedKind = type
    }
    if (type === 'task_failed') {
      failed = String(payload.error ?? payload.message ?? 'task failed')
      failedKind = 'task_failed'
    }
    if (type === 'event_msg') {
      const inner = String(payload.type ?? '')
      if (inner === 'task_started') started = { ts: eventTimeMs(payload.started_at_ms, payload.started_at, Date.now()), turn: String(payload.turn_id ?? '') }
      if (inner === 'task_failed' || inner === 'turn_aborted' || inner === 'turn_canceled' || inner === 'interrupted') {
        // 失败/中断同样带 turn_id 与时间：用它的 ts 判定，而不是拿 mtime 当发生时间。
        failed = String(payload.error ?? payload.message ?? payload.reason ?? (inner === 'turn_aborted' ? 'turn aborted' : inner))
        failedKind = inner
      }
      if (inner === 'task_complete') {
        completed = {
          // R3-M1：`*_ms` 优先；秒级 `completed_at` 也要认（否则会退化成「现在」，把历史完成伪装成刚完成）。
          ts: eventTimeMs(payload.completed_at_ms, payload.completed_at, Date.now()),
          turn: String(payload.turn_id ?? ''),
          text: typeof payload.last_agent_message === 'string' ? payload.last_agent_message : '',
        }
      }
    }
  }
  return { cwd, started, completed, failed, failedKind, prompt }
}

registerAdapter({
  id: 'codex',
  label: 'CODEX',
  completeness: 'partial',
  channel: 'rollout-jsonl',
  note: 'approval_policy=never（本机采样 32/32）→ 不会出现「等批准」，不伪造该态',
  probe() {
    const installed = existsSync(join(homedir(), '.codex'))
    let running = false
    try {
      for (const dir of codexDayDirs()) {
        if (!existsSync(dir)) continue
        for (const name of readdirSync(dir)) {
          if (!name.endsWith('.jsonl')) continue
          if (statSync(join(dir, name)).mtimeMs > Date.now() - 5 * 60 * 1000) running = true
        }
      }
    } catch {}
    return { installed, running, completeness: installed ? 'partial' : 'unsupported' }
  },
  poll() {
    const events = []
    // t53：终态必须把同 thread 的 running 收回去。否则 store 里同时存在 running 与 done，
    // 折叠后代表行按「更严重」取 running → 这一轮明明结束了，胶囊却永远显示运行中。
    const retract = new Set()
    for (const dir of codexDayDirs()) {
      if (!existsSync(dir)) continue
      let names = []
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const path = join(dir, name)
        let info
        try {
          info = statSync(path)
        } catch {
          continue
        }
        // t43 / M3：**删掉 10 分钟 mtime 窗口**。原来超窗的 rollout 直接 continue，
        // 于是「完成」既不出行也不进 doneUnread，用户什么都看不到。
        // 现在只按 size+mtime 判「这一轮有没有新字节」，有就读（终态由 codexSeen 去重）。
        loadCodexSeen()
        const seenAt = codexOffsets.get(path)
        if (seenAt !== undefined && seenAt.size === info.size && seenAt.mtimeMs === info.mtimeMs) continue
        codexOffsets.set(path, { size: info.size, mtimeMs: info.mtimeMs })
        const state = codexTurnState(path)
        const thread = name.replace(/^rollout-/, '').replace(/\.jsonl$/, '')
        // t55：一行一轮 = 一条 rollout；标题给「这次让它干什么」，而不是 cwd 目录名。
        const label = state.prompt !== '' ? state.prompt : (state.cwd !== '' ? basename(state.cwd) : uslice(thread, 8))
        if (state.failed !== null) {
          const key = `codex:${thread}:failed`
          retract.add(`codex:${thread}:running`)
          if (!codexSeen.has(key)) {
            rememberCodexSeen(key)
            const why = state.failedKind === '' ? '' : `（${state.failedKind}）`
            events.push({
              kind: 'failed',
              title: `Codex 失败：${label}${why}`,
              detail: uslice(state.failed, 400),
              sessionRef: thread,
              ts: info.mtimeMs,
              dedupeKey: key,
              reason: state.failedKind === 'turn_aborted' ? 'aborted' : 'task-failed',
              completeness: 'partial',
            })
            log(`codex terminal thread=${uslice(thread, 24)} kind=${state.failedKind === '' ? 'error' : state.failedKind} -> failed`)
          }
          continue
        }
        if (state.completed !== null) {
          const key = `codex:${thread}:done:${state.completed.ts}`
          retract.add(`codex:${thread}:running`)
          if (!codexSeen.has(key)) {
            rememberCodexSeen(key)
            events.push({ kind: 'done', title: `Codex 完成：${label}`, detail: uslice(state.completed.text, 300), sessionRef: thread, ts: state.completed.ts || info.mtimeMs, dedupeKey: key, reason: 'task-complete', completeness: 'partial' })
            log(`codex terminal thread=${uslice(thread, 24)} kind=task_complete -> done`)
          }
          continue
        }
        if (state.started !== null) {
          events.push({ kind: 'running', title: `Codex 正在运行：${label}`, sessionRef: thread, ts: state.started.ts || info.mtimeMs, dedupeKey: `codex:${thread}:running`, completeness: 'partial' })
        }
      }
    }
    return { events, retract: [...retract] }
  },
  // t53：只有真的还有 codex CLI 在跑才算 running。没有进程时上层会把 running 降级成
  // failed(reason=process-exited) 并在文案里写「进程已退出」，绝不伪造运行中。
  processAlive() {
    return cliProcessAlive(/codex/i)
  },
})

// ── 豆包办公（无结构化通道：只允许一次性 toast，绝不进队列/计数）──────────────
registerAdapter({
  id: 'doubao',
  label: 'DOUBAO',
  completeness: 'partial',
  channel: 'none',
  toastOnly: true,
  note: '无 CDP/日志通道、任务在云端、拿不到 sessionRef → 只做一次性 toast，不进队列',
  probe() {
    return { installed: existsSync('/Applications/Doubao.app'), running: null, completeness: 'unsupported', note: '无可用通道（spec §3.1 fail-closed）' }
  },
})

// ── Comate 等「装了但没接口」的：显式 unsupported，不留白 ────────────────────
registerAdapter({
  id: 'comate',
  label: 'COMATE',
  completeness: 'unsupported',
  channel: 'none',
  note: 'ctrl-servers.json 指向死 pid（t33 实测），且无公开事件通道',
  probe() {
    return { installed: existsSync('/Applications/Comate.app'), running: false, completeness: 'unsupported' }
  },
})

/** 单条规范化事件 → feed item。id 前缀用 agent，避免和 DSH 的 session/approval id 撞车。 */
// R3-H2：adapter 的 detail 经常是整包 JSON（`{"error":"session aborted while waiting"}`），
// 直接塞进列表就是「不可读的机器串」。这里统一抽人话：JSON 优先取 error.message/error/message，
// 否则取首行；再按 200 字截断（截断走 uslice，避免切开代理对）。
function humanText(raw) {
  if (raw === undefined || raw === null) return undefined
  const text = typeof raw === 'string' ? raw : String(raw)
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      const candidate = parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? parsed?.detail ?? parsed?.reason
      if (typeof candidate === 'string' && candidate.trim() !== '') return uslice(candidate.trim(), 200)
    } catch {}
  }
  return uslice(trimmed.split('\n')[0], 200)
}

// R3-M1：codex rollout 里 `*_ms` 是毫秒，老格式/别处偶有秒级字段；两个都认，秒级 ×1000 兜底。
function eventTimeMs(ms, seconds, fallback) {
  const millis = Number(ms)
  if (Number.isFinite(millis) && millis > 0) return millis
  const secs = Number(seconds)
  if (Number.isFinite(secs) && secs > 0) return secs * 1000
  return fallback
}

function adapterItem(event) {
  // item.id 用 `#` 连接：规范事件里 dedupeKey 已不含 agent 前缀，这里再拼 agent 才是全局唯一，
  // 也不会出现 `agent:agent:` 的重复前缀（t39 P0-1）。
  const id = `${event.agent}#${event.dedupeKey}`
  const base = {
    id,
    agent: event.agent,
    source: event.agent,
    // 规范词表随行下发（HUD 仍用 kind/status 的展示口径，两者不冲突）。
    eventKind: event.eventKind,
    completeness: event.completeness,
    // 别家的会话不能按 DSH 的 sessionId 跳转：HUD 据此把「跳到会话」换成「看详情」。
    jumpable: false,
    sessionRef: event.sessionRef,
    // t52：点击时要用它「复制问题 ID」；没有就是 undefined（不画空占位）。
    questionRef: event.questionRef,
    // t53：终态原因（task-complete / task-failed / aborted / process-exited / stale-no-progress）。
    // done 行也要带——「这条为什么算完成」同样需要可复盘。
    reason: event.reason,
    dshSession: event.dshSession,
    updatedAt: event.ts,
  }
  if (event.kind === 'needs-input') {
    return {
      ...base,
      kind: 'question',
      status: 'needs-answer',
      title: event.title,
      detail: event.detail,
      // 有回执通道才「就地可答」；没有就只能是「回原工具里答」。
      answerRequest: event.answerRequest,
      answerToken: event.answerToken,
      dedupKey: `${id}#needs-input`,
      questions: event.options === undefined
        ? undefined
        : [{ id: event.dedupeKey, question: event.title, options: event.options }],
    }
  }
  if (event.kind === 'needs-approval') {
    return {
      ...base,
      kind: 'approval',
      status: 'needs-approval',
      title: event.title,
      detail: event.detail,
      answerRequest: event.answerRequest,
      answerToken: event.answerToken,
      approvalId: event.approvalId,
      dedupKey: `${id}#needs-approval`,
    }
  }
  if (event.kind === 'failed') {
    // F9：字段统一。adapter 事件只有 `detail`；feed 里失败行历史上用 `error`（HUD 的失败页读它），
    // 所以这里同时给两份：`detail` 是规范字段，`error` 是给 HUD 的兼容别名，不是第二套语义。
    // F9 + R3-H2：detail 是规范字段、error 是给 HUD 的兼容别名；两者都必须是**人话**。
    const readable = humanText(event.detail)
    return { ...base, kind: 'run', status: 'failed', title: event.title, detail: readable, error: readable, reason: event.reason ?? 'adapter-failed', dedupKey: `${id}#failed` }
  }
  if (event.kind === 'done') {
    // done 的 dedupKey 必须与 HUD 的 doneKey 同形：`<id>#<finishedAt 毫秒>`（HUD 用它判「这条提醒过没」）。
    return { ...base, kind: 'session', status: 'done', title: event.title, detail: event.detail, finishedAt: event.ts, dedupKey: `${id}#${Math.round(event.ts)}` }
  }
  return { ...base, kind: 'session', status: 'running', title: event.title, dedupKey: `${id}#running` }
}

/**
 * 取一轮多 agent 事件：探针 → 可选 poll → 规范化入库 → 产出 items 与数据源条。
 * 任何一家失败只写 adapterHealth，不影响别家、不清零计数（I-1…I-7）。
 */
/**
 * 单家 adapter 的一轮观察（探测 → 可选 poll → 入库）。
 * 独立成函数是为了能**并发**跑：串行累加 4 家 ×400ms 会让 feed 变成 1.6s（t37 实测 1.245s/3 家）。
 */
async function observeAdapter(descriptor, ctx, now) {
  const startedAt = Date.now()
  const health = adapterHealth.get(descriptor.id)
  const store = adapterStore.get(descriptor.id) ?? new Map()
  const live = []
  const pushLive = () => {
    for (const event of store.values()) {
      if (adapterEventFresh(event, now)) live.push(adapterItem(event))
    }
  }
  // 熔断中：跳过探测，也不清空已有事件（隔离要求：计数不清零），只把状态说清楚。
  if (health.breakerUntil > now) {
    const brokenFor = Math.max(0, Math.round((health.breakerUntil - now) / 1000))
    // t53：熔断期间更要兜底——探测都跑不动了，running 留着就是纯骗人。
    adapterSettleStaleRunning(descriptor, now)
    pushLive()
    const broken = {
      id: descriptor.id,
        label: descriptor.label,
        channel: descriptor.channel,
        // stale = 曾经探测成功、现在拿不到新数据；unknown = 从来没成功过（spec §3.3）。
        completeness: (health.lastOkAt ?? 0) > 0 ? 'stale' : 'unknown',
        supported: false,
        installed: false,
        running: null,
        note: `连续失败已熔断，${brokenFor}s 后重试`,
        error: health.error ?? null,
        breakerUntil: health.breakerUntil,
        consecutiveFailures: health.consecutiveFailures ?? 0,
        polled: 0,
      probeMs: health.probeMs ?? 0,
      pollMs: health.pollMs ?? 0,
    }
    adapterLastStatus.set(descriptor.id, broken)
    return { status: broken, items: live, staleForMs: 0 }
  }
  let probe = { installed: false, running: null }
  let polled = 0
  let error = null
  try {
    probe = (await guardedAdapterCall(descriptor.id, 'probe', () => descriptor.probe?.(ctx))) ?? {}
    health.probeMs = Date.now() - startedAt
    // 推送型 adapter（Claude hooks）在 probe 判「未装」时也可能已经有事件进来了：
    // 只要 bus 里有东西就照常 poll 出来，否则用户明明收到了钩子却看不到行。
    const storeHasEvents = store.size > 0
    if (descriptor.poll !== undefined && (probe.installed === true || storeHasEvents)) {
      const pollStartedAt = Date.now()
      const raw = (await guardedAdapterCall(descriptor.id, 'poll', () => descriptor.poll(ctx, now))) ?? []
      // t52：poll 可以回 `{ events, retract }` —— 有的源（DuMate 的 question.*）需要「撤回」：
      // 问题答完了/过期了，之前推上去的那条 needs-input 必须能被收回，否则会一直挂在胶囊上。
      const rawEvents = Array.isArray(raw) ? raw : (Array.isArray(raw.events) ? raw.events : [])
      const rawRetract = Array.isArray(raw) || raw === null || typeof raw !== 'object' ? [] : (Array.isArray(raw.retract) ? raw.retract : [])
      // 0.7.2：撤回键必须和入库键同一套归一化。normalizeAdapterEvent() 会把生产者带的
      // `<agent>:` 前缀削掉（store 里的键是 `<thread>:running`），而 codex 的 retract 一直
      // 写 `codex:<thread>:running` —— store.delete 永远 false 且失败不打日志，于是
      // 「先 poll 到 task_started、后 poll 到 task_complete」必然留下幽灵 running，
      // 10 分钟后被 settle 改写成 failed(stale-no-progress)，用户看到「codex 失败清不掉」。
      const retractPrefix = `${descriptor.id}:`
      for (const rawKey of rawRetract) {
        if (typeof rawKey !== 'string' || rawKey === '') continue
        const key = rawKey.startsWith(retractPrefix) ? rawKey.slice(retractPrefix.length) : rawKey
        if (store.delete(key)) {
          adapterRetracted += 1
          log(`adapter retract id=${descriptor.id} key=${uslice(key, 48)}`)
        } else {
          log(`adapter retract miss id=${descriptor.id} key=${uslice(key, 48)}`)
        }
      }
      for (const candidate of rawEvents) {
        const event = normalizeAdapterEvent(descriptor, candidate)
        if (event === null) continue
        pushAdapterEvent(descriptor, event)
        polled += 1
      }
      health.pollMs = Date.now() - pollStartedAt
      // t53：只要这一轮真的读到了新东西（事件/撤回/新增字节），就算「数据源有进展」，
      // 后面的 stale 兜底据此区分「真在跑」与「卡住/进程没了」。
      const stats = typeof descriptor.stats === 'function' ? descriptor.stats() : null
      const grew = polled > 0 || rawRetract.length > 0 || (stats !== null && Number(stats.lastBytes ?? 0) > 0)
      if (grew) adapterProgressAt.set(descriptor.id, Date.now())
    }
    // t53：poll 之后立刻兜底——用户要的是「这一轮结束了就别再显示运行中」，
    // 不能等到下一轮（甚至等不到：适配器如果不再产事件，running 就永远挂着）。
    adapterSettleStaleRunning(descriptor, now)
    health.ok = true
    health.error = null
    health.consecutiveFailures = 0
    health.breakerUntil = 0
    health.lastOkAt = Date.now()
  } catch (failure) {
    error = String(failure && failure.message ? failure.message : failure)
    health.ok = false
    health.error = error
    health.consecutiveFailures = (health.consecutiveFailures ?? 0) + 1
    if (health.consecutiveFailures >= ADAPTER_BREAKER_THRESHOLD) {
      health.breakerUntil = Date.now() + ADAPTER_BREAKER_COOLDOWN_MS
      log(`adapter breaker open id=${descriptor.id} failures=${health.consecutiveFailures} cooldown=${ADAPTER_BREAKER_COOLDOWN_MS}ms`)
    }
    // 单家挂了：把日志写清，但不 throw、不忽略其它家（MA-11/MA-12）。
    log(`adapter error id=${descriptor.id} err=${uslice(error, 160)}`)
  }
  health.at = now
  // 心跳：成功探测过但太久没再成功（文件被删、进程卡死）→ stale，不冒充 full/partial。
  const staleSince = (health.lastOkAt ?? 0) > 0 && now - health.lastOkAt > ADAPTER_STALE_MS ? now - health.lastOkAt : 0
  const completeness = error !== null
    ? 'unknown'
    : (staleSince > 0 ? 'stale' : (probe.completeness ?? descriptor.completeness))
  health.completeness = completeness
  pushLive()
  const observed = {
    id: descriptor.id,
    label: descriptor.label,
    channel: descriptor.channel,
    completeness,
    supported: descriptor.channel !== 'none' && (probe.installed ?? false),
    installed: probe.installed === true,
    running: probe.running ?? null,
    // t47 / R4-L2：探测失败时 note 必须是**运行时事实**（错误本身），不能退回声明文案——
    // 否则熔断/失败的适配器在 /adapters 里还写着「未安装，去取引导」，等于骗人。
    note: error !== null
      ? `探测失败：${uslice(error, 80)}`
      : (staleSince > 0 ? `心跳超时 ${Math.round(staleSince / 1000)}s 未更新` : (probe.note ?? descriptor.note ?? null)),
    error,
    polled,
    probeMs: health.probeMs ?? 0,
    pollMs: health.pollMs ?? 0,
    breakerUntil: health.breakerUntil ?? 0,
    consecutiveFailures: health.consecutiveFailures ?? 0,
  }
  adapterLastStatus.set(descriptor.id, observed)
  return { status: observed, items: live, staleForMs: staleSince }
}

/**
 * 取一轮多 agent 事件（t39 F1-①：**并发** + 总预算）。
 *
 * 旧实现串行累加：每家 400ms 上限 × 7 家最坏 2.8s，而 HUD 每 2s 拉一次 ⇒ 一旦几家卡住，
 * 胶囊刷新直接被拖垮。现在 `Promise.allSettled` 并发跑，整体再套一层 800ms 硬预算：
 * 超预算的家按「本轮探测超时」返回，不影响别家、不清零计数。
 */
const ADAPTER_FEED_BUDGET_MS = 800

async function adapterFeed(ctx) {
  const now = Date.now()
  adapterPassRejects = 0
  const descriptors = adapterList()
  const tasks = descriptors.map((descriptor) => observeAdapter(descriptor, ctx, now).catch((failure) => ({
    status: {
      id: descriptor.id,
      label: descriptor.label,
      channel: descriptor.channel,
      completeness: 'unknown',
      supported: false,
      installed: false,
      running: null,
      note: `本轮观察失败：${uslice(String(failure && failure.message ? failure.message : failure), 80)}`,
      error: String(failure && failure.message ? failure.message : failure),
      polled: 0,
      probeMs: 0,
      pollMs: 0,
    },
    items: [],
    staleForMs: 0,
  })))
  let settled
  let budgetHit = false
  const budget = new Promise((resolve) => {
    const timer = setTimeout(() => { budgetHit = true; resolve(null) }, ADAPTER_FEED_BUDGET_MS)
    timer.unref?.()
  })
  const all = Promise.allSettled(tasks)
  const raced = await Promise.race([all, budget])
  if (raced === null) {
    // 预算用尽：已完成的照常出，没完成的先按超时占位（不 await，避免把请求继续拖住）。
    settled = descriptors.map((descriptor, index) => ({ status: 'pending', descriptor, index }))
    all.then((results) => {
      // 迟到的结果仍然入库（下一个 2s 周期就能用上），但不阻塞本次响应。
      for (const result of results) if (result.status === 'fulfilled') applyLateObservation(result.value)
    }).catch(() => {})
  } else {
    settled = raced.map((result, index) => ({ ...result, descriptor: descriptors[index], index }))
  }
  const statuses = []
  const items = []
  for (const entry of settled) {
    if (entry.status === 'fulfilled') {
      statuses.push(entry.value.status)
      for (const item of entry.value.items) items.push(item)
      continue
    }
    if (entry.status === 'rejected') {
      log(`adapter observe rejected id=${entry.descriptor.id}`)
      continue
    }
    // 预算超时：给出诚实的占位状态，让数据源条显示「本轮超时」而不是空白。
    const budgetStatus = {
      id: entry.descriptor.id,
      label: entry.descriptor.label,
      channel: entry.descriptor.channel,
      completeness: 'unknown',
      supported: false,
      installed: false,
      running: null,
      note: `本轮探测超时（总预算 ${ADAPTER_FEED_BUDGET_MS}ms）`,
      error: 'feed budget exceeded',
      polled: 0,
      probeMs: 0,
      pollMs: 0,
    }
    adapterLastStatus.set(entry.descriptor.id, budgetStatus)
    statuses.push(budgetStatus)
    const store = adapterStore.get(entry.descriptor.id) ?? new Map()
    for (const event of store.values()) {
      // 可见性 = 新鲜度 + 终态 3 小时保留窗（账本不删，只是不再占列表）。
      if (adapterEventVisible(event, now)) items.push(adapterItem(event))
    }
  }
  if (budgetHit) log(`adapter feed budget hit ms=${ADAPTER_FEED_BUDGET_MS} adapters=${descriptors.length}`)
  // F7：feed 里这份与 `/x-radar/adapters` 必须是同一个投影（以前 feed 用本轮 statuses、
  // 路由用 adapterSnapshot，两边 note 会不一致：hooks 装好了 feed 还写「未安装」）。
  return { items, adapters: adapterSnapshot(now), rejected: adapterPassRejects, partialKinds: adapterPartialKinds(now) }
}

/** 预算超时后迟到的观察结果：只把事件与健康写回，不再参与本次响应。 */
function applyLateObservation(observation) {
  const id = observation?.status?.id
  if (typeof id !== 'string') return
  const health = adapterHealth.get(id)
  if (health !== undefined && observation.status !== undefined) {
    health.completeness = observation.status.completeness ?? health.completeness
    health.error = observation.status.error ?? null
    health.ok = observation.status.error === null
  }
}

/** 胶囊与数据源条共用的降级口径：哪些 kind 存在 partial 数据（spec §3.2）。
 *  内部按规范词表统计，对外仍回 HUD 认识的 `question` / `approval`（展示层词表没变）。 */
const ADAPTER_KIND_TO_HUD = { 'needs-input': 'question', 'needs-approval': 'approval' }
function adapterPartialKinds(now = Date.now()) {
  const kinds = new Set()
  for (const store of adapterStore.values()) {
    for (const event of store.values()) {
      if (!adapterEventFresh(event, now)) continue
      if (event.completeness !== 'partial') continue
      const hudKind = ADAPTER_KIND_TO_HUD[event.kind]
      if (hudKind !== undefined) kinds.add(hudKind)
    }
  }
  return [...kinds].sort()
}

/** 数据源条 / 排障用：不进 feed 的 adapter 也要能一眼看到「它为什么是空的」。 */
/**
 * 有效完整性：探测结论与「实际收到的数据」取更可信的那个。
 *
 * 为什么需要：claude 的 hooks 没配时会探成 unsupported，但用户手上可能已经有
 * 手动配置/别的入口送进来的事件。这时底条写「未装」却又能列出它的任务，自相矛盾；
 * 有数据就至少承认 partial，并在 note 里说清「通道未配置」。
 */
function effectiveCompleteness(id, completeness, note) {
  const descriptor = adapterRegistry.get(id)
  const declared = descriptor?.completeness ?? 'unknown'
  const store = adapterStore.get(id)
  const hasEvents = store !== undefined && store.size > 0
  if (hasEvents && (completeness === 'unsupported' || completeness === 'unknown')) {
    return { completeness: 'partial', note: note ?? '通道未配置，事件来自其它入口' }
  }
  if (hasEvents && completeness === 'partial') return { completeness, note: note ?? null }
  return { completeness: completeness ?? declared, note: note ?? null }
}

/** 统一作答入口（t39 P0-3 的 answer 生命周期）：没有实现 answer 的家一律 409，不伪装能答。 */
async function adapterAnswer(id, payload) {
  const descriptor = adapterRegistry.get(String(id))
  if (descriptor === undefined) return { ok: false, status: 404, error: 'unknown adapter' }
  if (typeof descriptor.answer !== 'function') {
    return { ok: false, status: 409, error: `adapter ${descriptor.id} does not support answer` }
  }
  try {
    const result = (await descriptor.answer(payload ?? {})) ?? { ok: false, status: 500, error: 'empty answer result' }
    return result
  } catch (error) {
    return { ok: false, status: 502, error: uslice(String(error && error.message ? error.message : error), 160) }
  }
}

/** 数据源条 / 排障面板的完整快照：能力声明、心跳、熔断、声明式装载统计都在这。 */
function adapterSnapshot() {
  const now = Date.now()
  return adapterList().map((descriptor) => {
    const health = adapterHealth.get(descriptor.id) ?? {}
    const store = adapterStore.get(descriptor.id) ?? new Map()
    // F7：单一投影。运行时观测结果（adapterLastStatus，由 observeAdapter 每轮写入）优先，
    // 没跑过观测时才回落到健康度/声明值；note 一律取运行时那条，
    // 否则会出现「hooks 已装却仍写未安装」这种和事实相反的文案。
    const last = adapterLastStatus.get(descriptor.id) ?? null
    const declared = descriptor.completeness
    const baseCompleteness = last?.completeness ?? health.completeness ?? declared
    // t43 / M4：note 必须是**运行时**事实。last 只在本轮观测跑过时才有值，
    // 首帧（观测还没跑）会退回到声明值，于是出现「hooks 已装却写未安装」。
    // 所以声明层提供 noteNow() 时优先用它——claude 用它现读 settings.json。
    const runtimeNote = typeof descriptor.noteNow === 'function' ? descriptor.noteNow() : null
    // t54：noteNow() 是「现算」的说明（例如 workbuddy 的未识别事件类型、claude 的 hooks 是否已装），
    // 比上一轮观测留下的快照更新。只有在**熔断/探测失败**时才让观测文案优先——
    // 那两种情况必须如实说「探测失败/已熔断」，不能被静态说明盖掉（t47 R4-L2 的契约）。
    const healthBroken = (health.breakerUntil ?? 0) > now || (health.error !== null && health.error !== undefined)
    const baseNote = healthBroken
      ? (last?.note ?? health.error ?? runtimeNote ?? descriptor.note ?? null)
      : (runtimeNote ?? last?.note ?? descriptor.note ?? null)
    const effective = effectiveCompleteness(descriptor.id, baseCompleteness, baseNote)
    const breakerUntil = health.breakerUntil ?? 0
    const lastOkAt = health.lastOkAt ?? 0
    // 快照也要反映熔断口径：否则「熔断已打开」的条目仍显示上一次的 completeness，自相矛盾。
    const completeness = breakerUntil > now
      ? (lastOkAt > 0 ? 'stale' : 'unknown')
      : effective.completeness
    return {
      id: descriptor.id,
      label: descriptor.label,
      channel: descriptor.channel,
      completeness,
      declared,
      // t52：声明式/日志型 adapter 可以暴露自己的取数统计（增量读了多少字节、耗时多少），
      // 供 `/x-radar/adapters` 与用例验证「不是每次重读全文件」。
      stats: typeof descriptor.stats === 'function' ? descriptor.stats() : undefined,
      toastOnly: descriptor.capabilities?.toastOnly === true,
      // 能力声明（P0-3）：UI 只承诺 answer:true 的家能就地处置。
      capabilities: descriptor.capabilities ?? { observe: true, answer: false, toastOnly: false },
      note: effective.note,
      // 运行时事实：UI 用它决定「未装/未运行」这类提示，不要另算一遍。
      installed: last?.installed ?? health.installed ?? null,
      running: last?.running ?? null,
      supported: last?.supported ?? true,
      itemCount: store.size,
      events: store.size,
      ok: health.ok ?? null,
      // t43 / M4：error 同理取运行时（本轮观测 > 历史 health）。
      error: last?.error ?? health.error ?? null,
      probeMs: health.probeMs ?? null,
      pollMs: health.pollMs ?? null,
      fault: adapterFault.get(descriptor.id) ?? null,
      // 心跳与熔断（P1）
      consecutiveFailures: health.consecutiveFailures ?? 0,
      breakerUntil,
      breakerOpen: breakerUntil > now,
      lastOkAt: lastOkAt === 0 ? null : lastOkAt,
      staleForMs: lastOkAt === 0 ? null : Math.max(0, now - lastOkAt),
    }
  })
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
      log(`stale approval dropped id=${uslice(String(approval.id), 12)} ` +
        `run=${uslice(String(approval.runId ?? '-'), 12)} agent=${approval.agent ?? '-'} reason=${staleReason}`)
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

  // 多 agent adapter 层（分支 feat/multi-agent-notify）：DSH 之外的四家在等你看一眼。
  // 这一层**只读**：不代点、不发送、不改别人的配置；每家独立探测、独立超时，
  // 一家挂了只写它自己的 health，其余照常（spec §4.6-a 的隔离要求）。
  const agentFeed = await adapterFeed(ctx)
  // t43 / M2：hide-session 原来只按 DSH 的 sessionId 过滤（sessionItems 里那段），
  // 于是「从雷达移除」对 adapter 行完全无效——下一轮 poll 又把它放回来。
  // 这里对 adapter 条目按三条键任一命中即隐藏：item.id / dedupKey / sessionRef。
  const hiddenKeys = readHiddenSessions()
  const hiddenRunsAdapter = readHiddenRuns()
  const seenForAdapter = readSeen()
  for (const item of agentFeed.items) {
    // t51 / CD-1：adapter 的完成行以前完全不看 seen —— clear-done 写进 seen.json 的
    // 置读记录对它们无效，于是 counts.doneUnread 永远回到原值（真机 25 条 codex/dumate 完成）。
    // 未读 ⟺ finishedAt > seenAt；等于或早于置读时间就算已读。
    if (item.status === 'done') {
      const finishedAt = Number(item.finishedAt ?? item.updatedAt ?? 0)
      if (finishedAt > 0 && seenAtOf(seenForAdapter, String(item.id ?? '')) >= finishedAt) continue
    }
    const hitId = String(item.id ?? '')
    const hit = hiddenKeys[hitId] !== undefined
      || (item.dedupKey !== undefined && hiddenKeys[String(item.dedupKey)] !== undefined)
      || (item.sessionRef !== undefined && hiddenKeys[String(item.sessionRef)] !== undefined)
      // t55：adapter 行也要能走 hidden-runs 账本（失败页「清掉这条」用它，
      // 与 seen 的「置读」分开：清掉是永不再出现，置读只是把未读计数清掉）。
      || hiddenRunsAdapter[hitId] !== undefined
      || (item.dedupKey !== undefined && hiddenRunsAdapter[String(item.dedupKey)] !== undefined)
    if (hit) {
      log(`adapter hidden id=${uslice(String(item.id ?? ''), 32)} key=${uslice(String(item.dedupKey ?? ''), 32)}`)
      continue
    }
    items.push(item)
  }

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
      log(`run superseded by retry id=${uslice(run.id, 8)}`)
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
        log(`radar run orphaned id=${uslice(run.id, 8)} from=needs-approval to=failed reason=no_live_waiter`)
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
        log(`process-exited run=${uslice(run.id, 8)} agent=${run.agent} pid=${run.pid} last=turn.end -> done`)
      } else {
        reason = 'process-exited'
        error = '进程已退出（process-exited）'
        log(`process-exited run=${uslice(run.id, 8)} agent=${run.agent} pid=${run.pid} last=${tail ?? 'none'} -> failed`)
      }
    } else if (stale !== null) {
      const tail = lastRunEventKind(run.id)
      status = tail === 'turn.end' ? 'done' : 'failed'
      reason = tail === 'turn.end' ? reason : 'stale-running'
      if (tail !== 'turn.end') error = '超过 10 分钟没有任何新事件（可能卡住了，stale-running）'
      log(`stale-running run=${uslice(run.id, 8)} agent=${run.agent} ageMin=${Math.round(stale.ageMs / 60000)} last=${tail ?? 'none'} -> ${status}`)
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
        log(`rework stale run=${uslice(run.id, 8)} ageMin=${Math.round(revisionAge / 60000)} -> hidden`)
        continue
      } else {
        // 降级成「已完成」，但诚实说明：验收没过，也没有自动返工。
        status = 'done'
        note = '验收未通过，未自动返工'
        log(`rework unbound run=${uslice(run.id, 8)} -> done (no live continuation)`)
      }
    } else if (status === 'verifying' || status === 'unverified') {
      if (revisionAge > REVISION_TTL_MS) {
        log(`${status} stale run=${uslice(run.id, 8)} ageMin=${Math.round(revisionAge / 60000)} -> hidden`)
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
        log(`blocked-no-action run=${uslice(run.id, 8)} -> failed`)
      } else {
        log(`blocked actionable run=${uslice(run.id, 8)} approvals=1`)
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
  const seenNow = readSeen()
  for (const session of sessions.items) {
    const id = session.id
    if (!id) continue
    if (session.title) track.titles[id] = session.title
    if (session.status === 'running') {
      // t51 / CD-1：这里以前会 `delete seen[id]`（想让又跑起来的会话重新算未读）。
      // 那是「按集合删除」，会连带抹掉用户刚置读的记录，也让 clear-done 的写入白做。
      // 现在改为时间戳比较（见 seenAtOf）：这一轮结束后 finishedAt 会变大，自然重新算未读。
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
    const finishedForSeen = Number(track.finishedAt[id] ?? at)
    if (nowMs - Number(at) > FINISHED_KEEP_MS || seenAtOf(seenNow, id) >= finishedForSeen) {
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
    // t22 / S-08：原子写 + 内容未变不写（2s 轮询 × 多客户端会把同一份账本反复覆盖）。
    writeJsonIfChanged(TRACK_FILE, track)
  } catch (error) {
    log(`track write failed ${String(error && error.message ? error.message : error)}`)
  }

  // 用户口径（2026-11-13）：胶囊数字 = 正在进行的顶层会话数；
  // 子智能体/子会话不计入，审批与完成未看只作为次要提示。
  // 完成未看的唯一键：run 用 id#run，session 用 id#<finishedAt 毫秒>（updatedAt 会随后续
  // 事件前移，同一轮会被误判成新事件）。HUD 的通知计数与点击清单一律用这批 id 派生，
  // 保证「标题 N = ids.size = counts.doneUnread」（t17 的 finding：三者曾各算各的）。
  // t22 / B-4：doneUnreadIds 必须与 feed 里真实存在的 done 行**集合相等**（原来从全量 items 里取，
  // 折叠与 slice(MAX_ITEMS) 之后会出现「ids 里有 40 个、列表里只有 2 个」的口径分裂）。
  // 所以这里先算 counts 的其它项，doneUnread 留到 fold + slice 之后再从最终列表里取。
  const counts = {
    running: items.filter((item) => item.kind === 'session' && item.status === 'running').length,
    // 审批与提问都算「等你处理」：胶囊红呼吸 + 告警横幅都看这个数。
    approvals: items.filter((item) => item.kind === 'approval' || item.kind === 'question').length,
    questions: items.filter((item) => item.kind === 'question').length,
    failed: items.filter((item) => item.kind === 'run' && item.status === 'failed').length,
    doneUnread: 0,
    // 九态里的三态（U-13）：verifying/rework/blocked 必须在胶囊、面板行、横幅都能看见，
    // 所以 counts 要给真实计数。老宿主没有这三个字段时 UI 按 0 处理、不推断（t4 §0.4）。
    verifying: items.filter((item) => item.status === 'verifying' || item.status === 'unverified').length,
    rework: items.filter((item) => item.status === 'rework').length,
    blocked: items.filter((item) => item.status === 'blocked').length,
  }
  // 会话内提问（DSH 自己的 ask_user_question）单独计数：排障时能区分「桥在等」与「会话在等」。
  counts.questionsDsh = items.filter((item) => item.kind === 'question' && item.source === SOURCE_DSH).length
  counts.pending = counts.running
  // 多 agent：降级口径要能被 UI 读到（胶囊 `等回答(2+)`、数据源条 `部分`），
  // rejected 暴露「有事件被规范化拒掉」，dropped 在截断后回填（见下方 return）。
  counts.partialKinds = agentFeed.partialKinds
  // rejected = poll 里规范化拒掉的条数 + 契约校验累计（按 reason 分类，排障能看出「为什么没进来」）。
  const rejectReasons = {}
  for (const [reason, times] of adapterRejectReasons) rejectReasons[reason] = times
  // 本轮被拒条数：normalize 每次拒都会 noteAdapterReject（累计值进 rejectedReasons 做排障），
  // 这里只报「这一轮」的条数，避免把历史累计当成当下的 rejected（t39 自检时曾出现 4 vs 2）。
  counts.rejected = adapterPassRejects
  counts.rejectedReasons = rejectReasons
  counts.dropped = 0

  // 办公产物：最近 6 小时内生成的 docx / xlsx / pptx / pdf，最多 3 条（点一下在 Finder 定位）。
  // 代确认次数（bridge 写 ~/.dsh/agent-bridge/workbuddy-confirms.json，一行一次）
  try {
    const confirmFile = join(BRIDGE_DIR, 'workbuddy-confirms.json')
    if (existsSync(confirmFile)) {
      const lines = readFileSync(confirmFile, 'utf8').split('\n').filter(Boolean)
      const today = new uslice(Date().toISOString(), 10)
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
  // t39 / P0-1：**每一条** item 都要有 dedupKey（HUD 用它去重提醒、也用来对齐 doneKey）。
  // done 类必须与 HUD 的 doneKey 同形：run = `<id>#run`，session = `<id>#<finishedAt 毫秒>`。
  // t39 / P0-5：出站前再过一遍脱敏——adapter 事件已在规范化层处理，这里兜住 DSH/桥的标题与错误。
  for (const item of items) {
    if (typeof item.title === 'string') item.title = redactSecrets(item.title)
    if (typeof item.detail === 'string') item.detail = redactSecrets(item.detail)
    if (typeof item.error === 'string') item.error = redactSecrets(item.error)
    if (typeof item.note === 'string') item.note = redactSecrets(item.note)
    if (typeof item.dedupKey === 'string' && item.dedupKey !== '') continue
    if (typeof item.id !== 'string' || item.id === '') continue
    if (item.status === 'done') {
      item.dedupKey = item.kind === 'run'
        ? `${item.id}#run`
        : `${item.id}#${Math.round(Number(item.finishedAt ?? item.updatedAt ?? 0))}`
    } else {
      item.dedupKey = `${item.id}#${item.status ?? 'unknown'}`
    }
  }

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
  // t39 / P0-6：规格口径 = 优先级 → ts **升序**（最早一条优先）→ dedupKey 字典序。
  // 旧版按 updatedAt 倒序，于是三条提问里最后发生的那条排第一，用户按顺序答会乱。
  items.sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority
    const leftTs = Number(left.updatedAt ?? 0)
    const rightTs = Number(right.updatedAt ?? 0)
    if (leftTs !== rightTs) return leftTs - rightTs
    return String(left.dedupKey ?? left.id ?? '').localeCompare(String(right.dedupKey ?? right.id ?? ''))
  })

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

  // t39 / P1-a + t43 / H1：会话桶折叠。折叠单位是**会话**不是 agent（spec §2.3 L2）：
  // 同一家 agent 的同一次会话里，多条事件只占一行，行上带 `count`（HUD 显示 `×N`）。
  // t43 / H1：待办类（needs-answer / needs-approval）**也折叠**——captain 口径：同会话 3 条
  // Elicitation 必须是 1 行 count=3（原来 3 行，等于把会话桶规则只落实了一半）。
  // 代表行保留它自己的回执字段，就地处置仍可用；其余条目的明细在详情页里（行上 count 指明还有几条）。
  // R3-H1：桶成员快照。HUD 用它把 ×N 展开成逐条可点的行——没有它，「同会话 3 条待回答 + 1 条失败」
  // 会压成 1 行、三条提问的正文与回执字段全部消失，等于把待办吞掉。
  const foldSnapshot = (item) => ({
    id: item.id,
    dedupKey: item.dedupKey,
    title: item.title,
    detail: item.detail,
    kind: item.kind,
    status: item.status,
    answerRequest: item.answerRequest,
    answerToken: item.answerToken,
    approvalId: item.approvalId,
    questions: item.questions,
    ts: Number(item.updatedAt ?? 0),
  })
  const bucketed = []
  const bucketIndex = new Map()
  const bucketRank = { failed: 5, 'needs-answer': 4, 'needs-approval': 3, running: 2, done: 1 }
  const foldableStatus = new Set(['done', 'failed', 'running', 'needs-answer', 'needs-approval'])
  for (const item of items) {
    const foldable = item.source !== undefined && item.source !== SOURCE_DSH
      && item.sessionRef !== undefined && item.sessionRef !== null && String(item.sessionRef) !== ''
      && foldableStatus.has(item.status)
    if (!foldable) {
      bucketed.push(item)
      continue
    }
    const key = `${item.agent ?? item.source}|${item.sessionRef}`
    const kept = bucketIndex.get(key)
    if (kept === undefined) {
      bucketIndex.set(key, item)
      bucketed.push(item)
      continue
    }
    // R3-H1：每个成员各留一份明细（代表行也在内），`count === folded.length`。
    if (kept.folded === undefined) kept.folded = [foldSnapshot(kept)]
    kept.folded.push(foldSnapshot(item))
    kept.count = kept.folded.length
    // 代表行取「更重要的状态」与「更新的时间」：一个会话里既有失败又有完成时，先说失败。
    const keptRank = bucketRank[kept.status] ?? 0
    const itemRank = bucketRank[item.status] ?? 0
    const keptTs = Number(kept.updatedAt ?? 0)
    const itemTs = Number(item.updatedAt ?? 0)
    if (itemRank > keptRank || (itemRank === keptRank && itemTs > keptTs)) {
      // R3-H2：代表行**整体**换成这条（id/kind/status/dedupKey 来自同一条事件）。
      // 之前只搬处置字段不搬 id，会出现 `id=…:needs-input:abc` 配 `kind=run` 的自相矛盾行。
      const folded = kept.folded
      const count = kept.count
      const priority = Math.min(Number(kept.priority ?? 9), Number(item.priority ?? 9))
      Object.assign(kept, item)
      kept.folded = folded
      kept.count = count
      kept.priority = priority
    }
    kept.updatedAt = Math.max(keptTs, itemTs)
  }
  const entryCount = items.length
  items.length = 0
  items.push(...bucketed)
  // R3-M3：counts 是**条目数**（折叠前），items/total 是**桶数**（折叠后）。
  // HUD 侧等式：questions == Σ(桶内 kind=question 的成员数)。
  counts.entries = entryCount
  counts.buckets = items.length

  // t22 / B-4：未读完成 id 只从**最终渲染的列表**里取，保证 len(doneUnreadIds) == done 行数。
  // t43 / H2：截断前按 kind 预留槽位。46 条截到 40 时，43 条批准会把 failed/done 整段顶掉，
  // 用户于是看不到失败与已完成——这是最坏的一种截断。规格口径（t34 L2）：failed / done
  // 各至少留 1 行在可见页里；counts 始终是全量，列表是分页。
  const isStatus = (item, status) => item.status === status
  const reserveStatuses = ['failed', 'done']
  const pickVisible = () => {
    // R3-M2：failed 永不丢弃。52 条（47 批准 + 2 failed）截 40 时，两条 failed 必须都在可见页，
    // 而且留**较新**的；failed 自己就超过上限时，可见页改成「只放 failed」并在 overflow 里说明。
    const failedAll = items
      .filter((item) => isStatus(item, 'failed'))
      .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))
    let kept = []
    if (failedAll.length >= MAX_ITEMS) {
      kept = failedAll.slice(0, MAX_ITEMS)
      log(`feed.reserve status=failed-only total=${failedAll.length} kept=${kept.length}`)
    } else {
      const taken = new Set(failedAll.map((item) => String(item.dedupKey ?? item.id)))
      kept = [...failedAll]
      for (const item of items) {
        if (kept.length >= MAX_ITEMS) break
        const key = String(item.dedupKey ?? item.id)
        if (taken.has(key)) continue
        kept.push(item)
        taken.add(key)
      }
      // done 至少留 1 行：否则「完成」整段会被一堆批准挤掉（t43/H2 的同一类问题）。
      if (!kept.some((item) => isStatus(item, 'done'))) {
        const donor = items.find((item) => isStatus(item, 'done'))
        if (donor !== undefined) {
          let victimIndex = -1
          for (let index = kept.length - 1; index >= 0; index -= 1) {
            const candidate = kept[index]
            if (reserveStatuses.some((other) => isStatus(candidate, other))) continue
            if (victimIndex === -1 || (candidate.priority ?? 9) >= (kept[victimIndex].priority ?? 9)) victimIndex = index
          }
          if (victimIndex !== -1) {
            const victim = kept[victimIndex]
            kept[victimIndex] = donor
            log(`feed.reserve status=done swapped=${victim.id ?? victim.dedupKey} in=${donor.id ?? donor.dedupKey}`)
          }
        }
      }
    }
    kept.sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority
      const leftTs = Number(left.updatedAt ?? 0)
      const rightTs = Number(right.updatedAt ?? 0)
      if (leftTs !== rightTs) return leftTs - rightTs
      return String(left.dedupKey ?? left.id ?? '').localeCompare(String(right.dedupKey ?? right.id ?? ''))
    })
    return kept
  }
  const visible = pickVisible()
  const doneUnreadIds = []
  const seenDone = new Set()
  for (const item of visible) {
    if (item.status !== 'done' || typeof item.id !== 'string') continue
    if (seenDone.has(item.id)) continue
    seenDone.add(item.id)
    doneUnreadIds.push(item.id)
  }
  counts.doneUnread = doneUnreadIds.length
  // 截断必须可观测（spec §2.6）：面板底部据此显示「还有 N 条未显示」。
  counts.dropped = Math.max(0, items.length - visible.length)
  if (counts.dropped > 0) log(`feed.truncated total=${items.length} kept=${visible.length} dropped=${counts.dropped}`)

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    counts,
    // 与 items 里的 done 行一一对应（t22 / B-4 口径一致）；折叠行只保留代表 id（行上有 count）。
    doneUnreadIds,
    items: visible,
    total: items.length,
    sources: { sessions: sessions.source, runs: runs.length, questions: dshQuestions.source, agents: agentFeed.adapters.length },
    // 数据源条：一家一行（id/label/completeness/channel/running/note/error），顺序由 ADAPTER_ORDER 固定。
    adapters: agentFeed.adapters,
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
// t43 / M5：快照版本号。SWR 让「写后第一帧是旧快照」成为设计的一部分，
// 但调用方（前端/CLI）需要能强制拿一帧新的：写路由回 `snapshotRev`，
// 下次读带 `?cb=<rev>` 就同步重建一次。rev 单调递增，只增不减。
let snapshotRev = 0

function refreshSnapshot(ctx) {
  if (snapshotInflight) return snapshotInflight
  const startedAt = Date.now()
  snapshotInflight = buildRadar(ctx)
    .then((body) => {
      snapshotAt = Date.now()
      snapshotRev += 1
      snapshotBody = body
      // 构建耗时是 F1 的核心指标（7 家全超时也必须落在预算内）：常态打一行即可，
      // 超过 800ms 预算时单独 warn，排障时不用再猜。
      const spent = snapshotAt - startedAt
      log(`radar build ms=${spent} adapters=${body.adapters?.length ?? 0} items=${body.items?.length ?? 0}`)
      if (spent > ADAPTER_FEED_BUDGET_MS) log(`radar build over budget ms=${spent} budget=${ADAPTER_FEED_BUDGET_MS}`)
      return body
    })
    .finally(() => { snapshotInflight = null })
  // 后台刷新的失败不能变成未捕获拒绝：留着旧快照，下次请求再试。
  snapshotInflight.catch(() => {})
  return snapshotInflight
}

// 让下一次 /radar 立刻重建：置已读、批/拒之后必须马上看到新状态，不能等 TTL。
/**
 * 写操作后让快照失效（t39 F1-②）。
 *
 * 关键：**不能**把 `snapshotBody` 清空——那会让下一次 `/x-radar/radar` 变成同步冷建
 * （一次 buildRadar 要串行探 7 家 adapter），用户点一下「批准」就要等一秒多。
 * 这里只把时间戳拨到 0（标记过期）并立即后台重建：下一次请求拿到的还是上一份快照，
 * 后台在几百毫秒内把它换掉（stale-while-revalidate）。
 */
function invalidateSnapshot(ctx) {
  snapshotAt = 0
  if (ctx !== undefined) refreshSnapshot(ctx)
}

// stale-while-revalidate：有快照就立刻返回（p50 从「每次等 list()」降到 1ms 级），
// 过期了在后台补一份；只有冷启动那一次要等 list()。
async function buildRadarCached(ctx, options) {
  // t43 / M5：`?cb=<rev>`（或内部 force）绕过缓存，同步重建一次。
  // 只给「刚写完、必须立刻看到」的调用方用，别放进轮询路径。
  if (options !== undefined && options !== null && options.force === true) {
    const body = await refreshSnapshot(ctx)
    return { body, cached: false, ageMs: 0 }
  }
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
    // 0.7.4：市场收录复核指出「webServer 路由没做浏览器来源拦截，0.2.2 及以下宿主里网页可直读」。
    // 为什么没直接调 ctx.connection.requestRejection()：它在 0.2.2-rc.5 里确实存在（asar 可查），
    // 但内部是 Host/Origin 围栏 **加** browserAuth 会话认证——命令行的 curl、HUD 的 URLSession
    // 没有浏览器 Cookie，会被判成 401，把胶囊和 CLI 一起打死。所以这里复刻围栏里与本插件相关的两条：
    //   1) Host 必须是回环地址（防 DNS rebinding：攻击者把自己的域名解析到 127.0.0.1 后，Host 会是 evil.com）；
    //   2) 浏览器带的 `Sec-Fetch-Site` 是 cross-site / same-site 一律拒。
    // 命令行与 HUD 不带 Sec-Fetch-*，Host 也是回环，行为不变。
    const hostHeader = String(request?.headers?.get?.('host') ?? '')
    const hostName = hostHeader.replace(/^\[/, '').split(']')[0].split(':')[0].toLowerCase()
    // 没有 Host 的请求只可能来自进程内调用（浏览器与 curl 必带 Host），放过；带了就必须是回环。
    if (hostHeader !== '' && !(hostName === '127.0.0.1' || hostName === 'localhost' || hostName === '::1')) {
      log(`route guard tail=${tail} host=${uslice(hostHeader, 40)} -> 403`)
      return new Response(JSON.stringify({ ok: false, error: 'cross_origin_rejected', code: 'cross_origin_rejected', detail: `Host 不是回环地址：${uslice(hostHeader, 60)}` }), {
        status: 403,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }
    const fetchSite = String(request?.headers?.get?.('sec-fetch-site') ?? '').toLowerCase()
    if (fetchSite === 'cross-site' || fetchSite === 'same-site') {
      log(`route guard tail=${tail} sec-fetch-site=${fetchSite} -> 403`)
      return new Response(JSON.stringify({ ok: false, error: 'cross_origin_rejected', code: 'cross_origin_rejected', detail: `Sec-Fetch-Site: ${fetchSite}` }), {
        status: 403,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }
    // t22 / X-01、X-02：状态变更一律 GET（其它方法 405），并且必须同源（403 cross_origin_rejected）。
    if (MUTATING_TAILS.has(tail)) {
      const method = String(request?.method ?? 'GET').toUpperCase()
      if (method !== 'GET') {
        log(`write guard method=${method} tail=${tail} -> 405`)
        return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }), {
          status: 405,
          headers: { 'content-type': 'application/json; charset=utf-8', allow: 'GET' },
        })
      }
      const reason = sameOriginReason(request)
      if (reason !== null) {
        log(`write guard tail=${tail} reason=${reason} -> 403`)
        return new Response(JSON.stringify({ ok: false, error: 'cross_origin_rejected', code: 'cross_origin_rejected', detail: reason }), {
          status: 403,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      }
    }
    if (tail === 'beacon') return beaconResponse(url)
    if (tail === 'radar') {
      let body
      let cached = false
      try {
        // t43 / M5：写路由会回 `snapshotRev`；调用方带 `?cb=<rev>` 表示「我的基线是这个版本，
        // 若要更新就重建」。带 cb 一律强制重建一次（值相同也重建——SWR 下内容是旧的，rev 才是新的）。
        const cbParam = url.searchParams.get('cb')
        const snapshot = await buildRadarCached(ctx, { force: cbParam !== null })
        // t43 / M5：读也回版本号，前端拿它做下一次 ?cb= 的基线。
        body = { ...snapshot.body, snapshotRev }
        cached = snapshot.cached
      } catch (error) {
        log(`radar error ${uslice(String(error && error.stack ? error.stack : error), 600)}`)
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
      log(`jump requested id=${record.id} session=${uslice(sessionId, 8)} client=${half.active ? 'active' : 'inactive'}`)
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
          log(`jump.degraded id=${record.id} session=${uslice(sessionId, 8)} client=inactive open=skipped reason=${record.degradeReason}`)
          try {
            unlinkSync(path)
          } catch {}
          return
        }
        try {
          execFile('/usr/bin/open', ['-a', 'DeepSeek Harness'], { timeout: 4000 }, (error) => {
            if (error) log(`jump.degraded id=${record.id} session=${uslice(sessionId, 8)} open=error ${error.message} reason=${record.degradeReason}`)
            else log(`jump.degraded id=${record.id} session=${uslice(sessionId, 8)} client=inactive open=ok reason=${record.degradeReason}`)
          })
        } catch (error) {
          log(`jump.degraded id=${record.id} session=${uslice(sessionId, 8)} open=throw ${error?.message ?? error}`)
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
        log(`question answer rejected request=${uslice(requestId, 12)} reason=not-pending`)
        return fail(410, 'request not pending')
      }
      if (token === '' || token !== held.token) {
        log(`question answer rejected request=${uslice(requestId, 12)} reason=bad-token`)
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
        log(`question answer rejected request=${uslice(requestId, 12)} reason=bad-shape`)
        return fail(400, 'answers must be [{id, selected:[label], custom?}]')
      }
      held.settle('answered', answers)
      invalidateSnapshot(ctx)
      return new Response(JSON.stringify({ ok: true, request: requestId, answered: answers.length, snapshotRev }), {
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
            question: uslice(String(question.question ?? ''), 120),
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
      let body = { sessionId: null, reload: CLIENT_BUILD !== '' && lastClientBuild !== '' && lastClientBuild !== CLIENT_BUILD }
      for (const path of jumpCandidatePaths()) {
        try {
          const raw = JSON.parse(readFileSync(path, 'utf8'))
          if (raw && typeof raw.sessionId === 'string' && Date.now() - Number(raw.at ?? 0) < 15000) {
            body = {
              sessionId: raw.sessionId,
              mailbox: path === jumpFile() ? 'host' : 'legacy',
              reload: CLIENT_BUILD !== '' && lastClientBuild !== '' && lastClientBuild !== CLIENT_BUILD,
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
        log(`jump acked id=${acked.id} session=${uslice(String(acked.sessionId), 8)} lag=${acked.ackedAt - acked.at}ms`)
      }
      for (const path of jumpCandidatePaths()) {
        try {
          unlinkSync(path)
        } catch {}
      }
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
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
      log(`approval decide id=${uslice(approvalId, 8)} decision=${decision} answers=${answersNote}${rawNote} ok=${result.ok === true} status=${result.status ?? '-'}${dismissedNote}`)
      // 桥回 404（审批不存在/已过期）和 403（token 不匹配）都要原样透出，
      // 不能一律 502 —— HUD 靠状态码区分「过时」和「桥挂了」。
      const passthrough = [400, 403, 404, 409]
      const status = result.ok ? 200 : passthrough.includes(result.status) ? result.status : 502
      // 批/拒成功或失败都动过审批队列，快照一律作废，避免 HUD 立刻刷新时看到旧的 pending。
      invalidateSnapshot(ctx)
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
        saveSeen(seen)
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
          writeJsonAtomic(file, saved)
        } catch (error) {
          log(`track clear failed ${String(error && error.message ? error.message : error)}`)
        }
      }
      if (persisted) log(`markSeen ok ids=${ids.length} track=${trackRemoved}`)
      if (missing.length > 0) log(`markSeen failed ids=${missing.length} missing=${uslice(missing, 3).join(',')}`)
      invalidateSnapshot(ctx)
      return new Response(JSON.stringify({
        ok: persisted && missing.length === 0,
        marked: ids.length,
        verified: missing.length === 0,
        missing,
        track: trackRemoved,
        snapshotRev,
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
          log(`retry failed run=${uslice(runId, 8)} status=${created.status} body=${uslice(JSON.stringify(body), 160)}`)
          return new Response(JSON.stringify({ ok: false, error: 'bridge rejected retry', status: created.status, body }), {
            status: 502,
            headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
          })
        }
        writeRetryOf(body.runId, runId)
        const seen = readSeen()
        seen[runId] = Date.now()
        try {
          saveSeen(seen)
        } catch {}
        invalidateSnapshot(ctx)
        log(`retry run=${uslice(runId, 8)} -> new=${uslice(body.runId, 8)} agent=${body.agent ?? '?'}`)
        return new Response(JSON.stringify({ ok: true, runId: body.runId, retryOf: runId, agent: body.agent ?? null, snapshotRev }), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      } catch (error) {
        log(`retry error run=${uslice(runId, 8)} ${String(error && error.message ? error.message : error)}`)
        return new Response(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }), {
          status: 502,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
    }
    if (tail === 'hide-run') {
      // t55：外部 agent 行的「清掉这条」。adapter 行没有 DSH run，也没有 session 生命周期，
      // 只能按行 id / dedupKey 记账；写 hidden-runs.json（永久过滤）+ hidden-sessions.json
      // （adapter 行的通用账本，t43/M2）+ seen（把未读一起清掉），磁盘上的原始日志一个字节都不动。
      const runIdParam = (url.searchParams.get('id') ?? '').trim()
      const runKeyParam = (url.searchParams.get('key') ?? '').trim()
      const target = runIdParam !== '' ? runIdParam : runKeyParam
      if (target === '') {
        return new Response(JSON.stringify({ ok: false, error: 'id is required' }), {
          status: 400,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      hideRun(target)
      if (runKeyParam !== '' && runKeyParam !== target) hideRun(runKeyParam)
      hideSession(target)
      if (runKeyParam !== '' && runKeyParam !== target) hideSession(runKeyParam)
      const seenRuns = readSeen()
      seenRuns[target] = Date.now()
      if (runKeyParam !== '' && runKeyParam !== target) seenRuns[runKeyParam] = Date.now()
      try {
        saveSeen(seenRuns)
      } catch {}
      invalidateSnapshot(ctx)
      log(`run hidden id=${uslice(target, 40)} key=${uslice(runKeyParam, 40)} by=${runIdParam !== '' ? 'id' : 'key'}`)
      return new Response(JSON.stringify({ ok: true, hidden: target, snapshotRev }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    if (tail === 'hide-session') {
      // 双击会话行选「仅从雷达移除」：写 hidden-sessions.json（永久过滤）+ seen。
      // 只动雷达自己的视图，不碰 DSH 的会话数据（删会话只能在 DSH 里做）。
      // t43 / M2：三个参数都收——session（DSH 会话 / adapter 的 sessionRef）、
      // key（adapter 的 dedupKey）、id（feed 行 id）。谁的账本命中谁就消失。
      const sessionId = (url.searchParams.get('session') ?? '').trim()
      const hideKey = (url.searchParams.get('key') ?? '').trim()
      const hideId = (url.searchParams.get('id') ?? '').trim()
      const target = sessionId !== '' ? sessionId : (hideKey !== '' ? hideKey : hideId)
      if (target === '') {
        return new Response(JSON.stringify({ ok: false, error: 'session or key is required' }), {
          status: 400,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      hideSession(target)
      const seen = readSeen()
      seen[target] = Date.now()
      try {
        saveSeen(seen)
      } catch {}
      invalidateSnapshot(ctx)
      log(`session hidden id=${uslice(target, 24)} by=${sessionId !== '' ? 'session' : hideKey !== '' ? 'key' : 'id'}`)
      return new Response(JSON.stringify({ ok: true, hidden: target, snapshotRev }), {
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
      invalidateSnapshot(ctx)
      log(`purge-tests matched=${hit.length} patterns=${patterns.join('|')}`)
      return new Response(JSON.stringify({ ok: true, hidden: hit.length, runs: hit, snapshotRev }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    if (tail === 'clear-done') {
      // 一次点击必须清干净。doneUnreadIds 只含「最终渲染列表」里的 id（折叠与 slice 之后），
      // 折叠行 "x2" 只贡献 1 个 id，所以单轮清理必然剩下一条 → 循环到没有新的可清条目为止。
      let cleared = 0
      let trackCleared = 0
      let passes = 0
      let stuck = false
      let previousKey = ''
      for (let pass = 0; pass < 6; pass += 1) {
        const fresh = await buildRadar(ctx)
        const ids = Array.isArray(fresh.doneUnreadIds) ? fresh.doneUnreadIds : []
        if (ids.length === 0) break
        // t51 / CD-1：如果这一轮的待清 id 跟上一轮**完全一样**，说明置读没生效
        //（以前正是这样静默循环 6 轮：cleared=150、doneUnread 不变）。
        // 记一行 `pass.ineffective` 并停手，别把「清不动」伪装成「清完了」。
        const key = ids.slice().sort().join('|')
        if (key === previousKey) {
          stuck = true
          log(`pass.ineffective pass=${pass + 1} n=${ids.length} sample=${uslice(String(ids[0] ?? ''), 48)}`)
          break
        }
        previousKey = key
        passes += 1
        const seen = readSeen()
        const now = Date.now()
        for (const id of ids) seen[id] = now
        try {
          saveSeen(seen)
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
        cleared += ids.length
        invalidateSnapshot(ctx)
      }
      // 2026-11-25 用户口径「codex 运行失败就一直显示、清除不了」：老实现只清完成行，
      // 失败行（adapter 的 settled/process-exited 等）根本没有批量出口，而完成按钮又只在
      // doneUnread>0 时才画 → 只剩失败行时按钮消失，用户无从下手。这里把 adapter 失败行
      // 一并写进 hidden-runs / hidden-sessions（与单行「清掉这条」同一账本，永久不再出现）。
      let failedCleared = 0
      try {
        const fresh = await buildRadar(ctx)
        const failedIds = (Array.isArray(fresh.items) ? fresh.items : [])
          .filter((item) => item.status === 'failed' && typeof item.id === 'string' && item.id.includes('#'))
          .map((item) => item.id)
        if (failedIds.length > 0) {
          const seenNow = readSeen()
          const nowMs = Date.now()
          for (const id of failedIds) {
            hideRun(id)
            hideSession(id)
            seenNow[id] = nowMs
            failedCleared += 1
          }
          try {
            saveSeen(seenNow)
          } catch {}
          invalidateSnapshot(ctx)
        }
      } catch (error) {
        log(`clear-done failed-clear error ${uslice(String(error && error.message ? error.message : error), 120)}`)
      }
      log(`panel clear-done cleared=${cleared} track=${trackCleared} failed=${failedCleared} passes=${passes} stuck=${stuck ? 1 : 0}`)
      return new Response(JSON.stringify({ ok: true, cleared, track: trackCleared, failed: failedCleared, passes, stuck, snapshotRev }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    if (tail === 'open-agent') {
      // t51 / JUMP-1：adapter 行（dumate / workbuddy / 豆包…）没有 DSH sessionId，
      // 走 `jump` 是死路：只写 jump.json，没有任何 client 消费方，用户点了完全没反应。
      // 这里退一步——**打开那家的 App**，并把「能不能开」明确回给 HUD，
      // 让点击永远有可见结果（HUD 失败时弹「该任务在 X 内，无法从雷达跳转」）。
      const agent = String(url.searchParams.get('agent') ?? '').trim().toLowerCase()
      const ref = uslice(String(url.searchParams.get('ref') ?? '').trim(), 200)
      // 只认这张白名单：绝不允许路由参数变成任意命令。
      const OPEN_AGENT_APPS = {
        dumate: ['DuMate'],
        workbuddy: ['WorkBuddy', 'Work Buddy'],
        doubao: ['Doubao', '豆包'],
        codex: [],
        comate: [],
      }
      const candidates = OPEN_AGENT_APPS[agent]
      if (candidates === undefined) {
        log(`row activate agent=${agent || '-'} result=unsupported reason=unknown-agent`)
        return new Response(JSON.stringify({ ok: false, opened: false, agent, ref, error: 'unsupported agent' }), {
          status: 400,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      // 测试钩子：`DSH_TASK_RADAR_NO_OPEN=1` 时不真的拉起 App（用例里不能开用户的 DuMate）。
      const dryRun = process.env.DSH_TASK_RADAR_NO_OPEN === '1'
      let opened = false
      let app = null
      // t52：DuMate 自带 URL scheme `dumate://`（Info.plist CFBundleURLSchemes=[dumate]）。
      // 先试深链（能把 DuMate 拉到前台、带上会话上下文），失败再退回 open -a。
      const OPEN_AGENT_DEEP_LINKS = {
        dumate: (value) => (value === '' ? 'dumate://' : `dumate://session/${encodeURIComponent(value)}`),
      }
      const deepLink = OPEN_AGENT_DEEP_LINKS[agent]
      if (!dryRun && deepLink !== undefined) {
        try {
          execFileSync('open', [deepLink(ref)], { timeout: 2000, stdio: 'ignore' })
          opened = true
          app = 'deep-link'
        } catch {}
      }
      for (const name of dryRun || opened ? [] : candidates) {
        try {
          execFileSync('open', ['-a', name], { timeout: 2000, stdio: 'ignore' })
          opened = true
          app = name
          break
        } catch {}
      }
      log(`row activate agent=${agent || '-'} ref=${uslice(ref, 32)} result=${opened ? 'ok' : 'unsupported'} app=${app ?? '-'}${dryRun ? ' reason=dry-run' : ''}`)
      return new Response(JSON.stringify({
        ok: opened, opened, agent, app, ref, dryRun,
        error: opened ? null : (dryRun ? 'dry-run' : 'no app to open'),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
    if (tail === 'claude-hook') {
      // Claude Code 的 hooks 落点（只读登记，不代答）。GET 是因为宿主 webserver 只放行 GET/HEAD。
      const result = claudeAccept(url)
      log(`claude hook ev=${uslice(url.searchParams.get('ev') ?? '-', 24)} accepted=${result?.accepted === true ? 1 : 0}`)
      return new Response(JSON.stringify({ ok: result?.ok === true, continue: true, accepted: result?.accepted === true, error: result?.error ?? null }), {
        status: result?.ok === true ? 200 : 400,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }

    if (tail === 'claude-hook-config') {
      // 只给引导，不代写用户的 ~/.claude/settings.json（spec 禁止项）。
      const config = claudeHookConfig(ctx)
      log(`claude hook config installed=${config.hooksInstalled === true ? 1 : 0}`)
      return new Response(JSON.stringify(config), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }

    if (tail === 'adapters') {
      // 排障：每家 adapter 的通道、完整性、能力、心跳/熔断与最近一次探测的耗时与错误。
      // 先重扫 adapters.d：新增一家 agent 只要丢一份 JSON 进来，下一次请求就能看到（t39 P0-3）。
      const declared = loadDeclaredAdapters()
      const health = adapterSnapshot()
      log(`adapters snapshot n=${health.length} degraded=${health.filter((item) => item.completeness !== 'full').length} declared=${declared.loaded}`)
      return new Response(JSON.stringify({
        ok: true,
        adapters: health,
        partialKinds: adapterPartialKinds(),
        // t53：运行中条目被终态兜底降级的累计条数（便于复盘「不再无限 running」）。
        settled: adapterSettled,
        declared,
        declaredDir: ADAPTER_DECL_DIR,
        kinds: [...ADAPTER_CANON_KINDS],
        rejectedReasons: Object.fromEntries(adapterRejectReasons),
      }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }

    if (tail === 'adapter-answer') {
      // 统一作答入口：?id=dsh&body=<JSON>（写路由，同样走同源校验）。
      const id = String(url.searchParams.get('id') ?? '')
      let body = {}
      try {
        body = JSON.parse(url.searchParams.get('body') ?? '{}')
      } catch {
        return new Response(JSON.stringify({ ok: false, error: 'body must be JSON' }), {
          status: 400,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      const result = await adapterAnswer(id, body)
      const status = result.ok === true ? 200 : (result.status ?? 400)
      log(`adapter answer id=${uslice(id, 24)} ok=${result.ok === true} status=${status}`)
      return new Response(JSON.stringify(result), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }

    if (tail === 'adapter-inject') {
    // F8：这是给故障隔离自检用的注入口，生产不该可达。默认 404，只有显式打开
    // DSH_TASK_RADAR_ADAPTER_INJECT=1 的自检进程才有这个路由。
    if (process.env.DSH_TASK_RADAR_ADAPTER_INJECT !== '1') {
      // t43 / L1：这里原来写 json(response, …)，但 Request handler 里没有 node 风格的 response
      // 对象，调用即 ReferenceError → 本该 404 却返回 500。改成直接构造 Response。
      return new Response(JSON.stringify({ ok: false, error: 'not found', path: tail }), {
        status: 404,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      })
    }
      // 故障隔离自测注入（写路由，走同源校验）：?id=claude&mode=throw|timeout|clear
      const id = String(url.searchParams.get('id') ?? '')
      const mode = String(url.searchParams.get('mode') ?? 'clear')
      if (!adapterRegistry.has(id)) {
        return new Response(JSON.stringify({ ok: false, error: 'unknown adapter', id }), {
          status: 404,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      if (mode === 'clear') adapterFault.delete(id)
      else adapterFault.set(id, mode === 'timeout' ? 'timeout' : 'throw')
      invalidateSnapshot(ctx)
      log(`adapter inject id=${id} mode=${mode} fault=${adapterFault.get(id) ?? 'none'}`)
      return new Response(JSON.stringify({ ok: true, id, mode, fault: adapterFault.get(id) ?? null, snapshotRev }), {
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
      log(`radar route error ${uslice(String(error && error.message ? error.message : error), 400)}`)
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
    return typeof parsed?.build === 'string' ? uslice(parsed.build, 16) : 'unknown'
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
  const build = uslice((url.searchParams.get('b') ?? ''), 32)
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
  // t22 / F-07：显式 charset（缺省时部分客户端按 latin-1 解，中文提示会变乱码）。
  const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  if (build && CLIENT_BUILD !== '' && build !== CLIENT_BUILD) headers['x-radar-reload'] = '1'
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

/** 解析任意 hud.pid 文件（hudPid 与「兄弟目录是否退役」共用同一套格式判断）。 */
function readPidFile(file) {
  let raw
  try {
    raw = String(readFileSync(file, 'utf8')).trim()
  } catch {
    return undefined
  }
  return parsePidText(raw)
}

function parsePidText(raw) {
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

function hudPid() {
  return readPidFile(hudPidFile())
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
  // 声明式 adapter（t39 P0-3）：启动时扫一次 ~/.dsh/agent-bridge/adapters.d/*.json，
  // 之后每次 GET /x-radar/adapters 会再扫一遍，所以新增一家不必重启宿主。
  try {
    const declared = loadDeclaredAdapters()
    if (declared.loaded > 0 || declared.failed > 0) {
      log(`adapter declare boot loaded=${declared.loaded} skipped=${declared.skipped} failed=${declared.failed}`)
    }
  } catch (error) {
    log(`adapter declare boot failed ${uslice(String(error && error.message ? error.message : error), 120)}`)
  }
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
          // t22 / S-01：有活跃 Web 客户端时**一律**不接管，桌面卡才是权威回执入口。
          log(`question delegate reason=${verdict}`)
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
