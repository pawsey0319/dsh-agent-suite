/**
 * Host half of the Agent Bridge (DSH one-console P1).
 *
 * It runs the real Codex binary as an `app-server` child process (JSONL
 * JSON-RPC over stdio), starts one thread per DSH run, and keeps every
 * notification verbatim:
 *
 *   ~/.dsh/agent-bridge/runs/<runId>/events.jsonl   raw notification per line
 *   ~/.dsh/agent-bridge/runs/<runId>/meta.json      run metadata
 *
 * The events are then exposed over HTTP + SSE so the DSH client half (and any
 * other console) can render the timeline without re-parsing provider output.
 * Server-initiated approval requests become a queue answered over HTTP; while
 * one waits, the run is marked `needs-approval`.
 *
 * Design notes that cost us a debug round already:
 * - register HTML routes inside `ctx.effect` and dispose them, otherwise a
 *   replaced plugin generation leaves `duplicate prefix route` behind;
 * - the Codex binary ships inside the DSH profile, so resolve it there first.
 *
 * P2 additions (GET only — prefix resources answer POST with 405):
 *   GET /pending                    审批队列快照（含宿主重载后遗留的 stale 条目）
 *   GET /approve?id&decision&note   下决策，真正回传给 Codex app-server / Claude hook
 *   GET /pending/clear?mode=        清理队列（stale 默认 / all 连带 deny 掉活 waiter）
 *   GET /resume?runId=              优先 fork 原 DSH 会话到最后一个 turn/end，
 *                                   失败退回 create({cwd}) + 原任务摘要
 * 队列持久化在 ~/.dsh/agent-bridge/pending-approvals.json，只存可序列化字段。
 */
import { execFile, spawn } from 'node:child_process'
import { autoConfirm as wbAutoConfirm, clearPending as wbClearPending, confirmAudit as wbAudit, pendingInfo as wbPending, launch as wbLaunch, readLast as wbReadLast, send as wbSend, state as wbState } from './workbuddy.js'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-agent-bridge'
// sessionController / sessionQuery 是可选的：用 ctx.get() 拿并逐项降级，
// 不写进 inject，免得服务缺席时整个插件起不来。
export const inject = ['webServer']

const ROOT = join(process.env.HOME ?? '/tmp', '.dsh', 'agent-bridge')
const RUNS = join(ROOT, 'runs')
const BRIDGE_LOG = join(BRIDGE_ROOT_FOR_LOG(), 'bridge.log')
function BRIDGE_ROOT_FOR_LOG() {
  return process.env.DSH_AGENT_BRIDGE_ROOT || join(process.env.HOME || '/tmp', '.dsh', 'agent-bridge')
}
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`
  try {
    mkdirSync(BRIDGE_ROOT_FOR_LOG(), { recursive: true })
    appendFileSync(BRIDGE_LOG, line)
  } catch {
    // 日志失败不能影响请求处理。
  }
  try { process.stderr.write(line) } catch {}
}

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

// ─────────────────────────────────────────────────────────────────────────────
// P2：审批聚合 + 会话恢复。
// 这里只放纯函数 / 无副作用的类，apply() 之外也能被 `node -e` 直接单测
// （用临时 HOME 目录即可，ROOT / PENDING_FILE 都从 process.env.HOME 派生）。
// ─────────────────────────────────────────────────────────────────────────────

/** 待审批队列的持久化快照；宿主重载后 HUD 仍能读到未处理条目。 */
const PENDING_FILE = join(ROOT, 'pending-approvals.json')
const PENDING_LIMIT = 200

/**
 * 把 HUD / 面板传来的决策词归一成 `allow` | `deny`。
 * 无法识别时返回 null（由调用方回 400），绝不猜测用户意图。
 */
function normalizeDecision(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (['allow', 'accept', 'approve', 'approved', 'yes', 'y', '1', 'true'].includes(text)) return 'allow'
  if (['deny', 'decline', 'reject', 'rejected', 'no', 'n', '0', 'false', 'cancel'].includes(text)) return 'deny'
  return null
}

/** 归一决策 → 现有 Codex / Claude hook 协议里的词（accept / decline）。 */
function internalDecision(decision) {
  return decision === 'allow' ? 'accept' : 'decline'
}

/** 生成待审批 id：进程内单调，重启后也不会和旧条目撞车。 */
/**
 * 审批凭据：只有拿到「看到这条审批的人」手上的 token 才能下决策。
 * 桥和 HUD 同机，本来靠 127.0.0.1 兜底，但任何本机进程都能 POST 一个 id
 * 放行别人的审批（F-02），所以队列里的每一项都配一个一次性 token。
 */
function makeApprovalToken() {
  return randomUUID().replace(/-/g, '').slice(0, 24)
}

/** 常量时间比较，避免 token 通过计时差异泄漏。 */
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * N-03：`GET /approvals` 默认不回一次性 token —— 面板只需要展示，真正下决定时
 * 由雷达带同一 token 转发。需要原样的调用方（同机雷达）显式带 `?include_token=1`。
 */
function redactToken(token) {
  if (typeof token !== 'string' || token.length === 0) return undefined
  return `${token.slice(0, 4)}…${token.slice(-2)}`
}

/**
 * N-03：清理队列的运维凭据。
 *
 * 一次性 approval token 只存在于活 waiter 上（`snapshotPending` 故意不落盘），
 * 宿主重启后遗留的 stale 条目没有任何 token 可以核对 —— 所以给「清理」单独一把
 * 落盘凭据：文件 0600，只有本机同用户可读。HTTP 层因此仍要求 token，拿到 403 的
 * 匿名进程无法凭一个 GET 就把别人的审批队列清空。
 */
const CLEAR_TOKEN_FILE = join(ROOT, 'clear.token')
let clearTokenCache

function clearToken() {
  if (typeof clearTokenCache === 'string' && clearTokenCache.length > 0) return clearTokenCache
  try {
    if (existsSync(CLEAR_TOKEN_FILE)) {
      const saved = readFileSync(CLEAR_TOKEN_FILE, 'utf8').trim()
      if (saved.length >= 16) {
        clearTokenCache = saved
        return clearTokenCache
      }
    }
  } catch { /* 读不到就重新生成 */ }
  clearTokenCache = randomUUID().replace(/-/g, '')
  try {
    mkdirSync(ROOT, { recursive: true })
    writeFileSync(CLEAR_TOKEN_FILE, `${clearTokenCache}\n`, { mode: 0o600 })
  } catch (error) {
    log(`clear token write failed: ${String(error && error.message ? error.message : error)}`)
  }
  return clearTokenCache
}

/**
 * 按 token 过滤待处理队列：返回调用方有权处置的条目。
 * - 带 id：必须是该条目的 token，否则不匹配；
 * - 不带 id：只返回 token 与调用方一致的那些条目。
 */
function entriesOwnedByToken(list, token, id) {
  if (typeof token !== 'string' || token.length === 0) return []
  return list.filter((entry) => {
    if (id !== undefined && entry.id !== id) return false
    return sameToken(entry.token, token)
  })
}

function makeApprovalId(prefix, seq, now = Date.now()) {
  const base = String(prefix ?? 'approval').replace(/[^a-zA-Z0-9_-]/g, '') || 'approval'
  const n = Math.max(1, Math.floor(Number(seq) || 1))
  return `${base}-${Number(now).toString(36)}-${n}`
}

/** run 事件里最后一条 `turn/end`（completed turn 边界）的 seq；没有则返回 null。 */
function lastCompletedTurnSeq(events) {
  let best = null
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'turn/end') continue
    const seq = Number(event?.seq)
    if (!Number.isSafeInteger(seq) || seq < 0) continue
    if (best === null || seq > best) best = seq
  }
  return best
}

/** 恢复会话时发给新会话的续跑提示。fork 自带上下文，new 需要带上原任务摘要。 */
function resumePrompt({ mode, prompt, agent, cwd }) {
  const task = String(prompt ?? '').trim()
  const short = task.length > 500 ? `${task.slice(0, 500)}…` : task
  if (mode === 'fork') {
    return `继续上一次未完成的工作：从断点接着做，不要从头重来。${short === '' ? '' : `\n\n原任务：${short}`}`
  }
  return `继续之前中断的任务（agent=${agent ?? 'unknown'}，cwd=${cwd ?? 'unknown'}）。原任务：\n\n${short === '' ? '(原任务内容未记录)' : short}\n\n请先确认当前仓库状态，再从断点继续。`
}

/** 落盘形态：只保留可序列化字段，timer / resolve 这类句柄永不写盘。 */
function snapshotPending(entry) {
  return {
    id: entry.id,
    runId: entry.runId ?? null,
    agent: entry.agent ?? null,
    method: entry.method ?? null,
    params: entry.params ?? null,
    at: entry.at ?? null,
    note: entry.note ?? null,
    stale: entry.stale === true,
  }
}

/** 读盘形态 → 内存条目；缺 id 的脏数据直接丢弃。 */
function sanitizePending(row) {
  if (row === null || typeof row !== 'object') return null
  if (typeof row.id !== 'string' || row.id === '') return null
  return snapshotPending(row)
}

/**
 * 待审批队列。
 *
 * `approvals`（apply 内）持有实时 waiter，是决策回传的唯一通道；这个类只负责
 * 给 HUD/面板读的快照 + 持久化。两者用同一个 id 关联。
 */
class PendingApprovalStore {
  constructor(file) {
    this.file = file
    this.items = new Map()
  }

  /** 读盘；任何损坏都退化成空队列，绝不让插件加载失败。 */
  load() {
    try {
      if (!existsSync(this.file)) return []
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.pending) ? parsed.pending : []
      this.items = new Map()
      for (const row of rows) {
        const entry = sanitizePending(row)
        if (entry !== null) this.items.set(entry.id, entry)
      }
    } catch {
      this.items = new Map()
    }
    return this.list()
  }

  save() {
    try {
      mkdirSync(ROOT, { recursive: true })
      writeFileSync(this.file, `${JSON.stringify([...this.items.values()].map(snapshotPending), null, 2)}\n`)
    } catch {
      // 持久化失败不能影响审批回传。
    }
  }

  list() {
    return [...this.items.values()].map((entry) => ({ ...entry }))
  }

  get(id) {
    return this.items.get(String(id)) ?? null
  }

  upsert(entry) {
    const clean = sanitizePending(entry)
    if (clean === null) return null
    this.items.set(clean.id, { ...clean, stale: false })
    while (this.items.size > PENDING_LIMIT) {
      const oldest = this.items.keys().next().value
      if (oldest === undefined) break
      this.items.delete(oldest)
    }
    this.save()
    return this.get(clean.id)
  }

  /** 宿主重载后，磁盘里剩下的条目都没有活 waiter 了。 */
  markAllStale() {
    let changed = 0
    for (const entry of this.items.values()) {
      if (entry.stale !== true) {
        entry.stale = true
        changed += 1
      }
    }
    if (changed > 0) this.save()
    return changed
  }

  remove(id) {
    const key = String(id)
    if (!this.items.has(key)) return false
    this.items.delete(key)
    this.save()
    return true
  }

  clear() {
    const count = this.items.size
    this.items.clear()
    this.save()
    return count
  }
}

// 插件目录本体（随包分发的资源用这个定位，不能用 cwd 推断）
const PLUGIN_ROOT = fileURLToPath(new URL('.', import.meta.url))

/** 把任意输入夹到 [min, max]，非法时回退 fallback。 */
function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function codexBinary() {
  if (process.env.DSH_AGENT_BRIDGE_CODEX) return process.env.DSH_AGENT_BRIDGE_CODEX
  const candidates = [
    join(process.env.HOME ?? '', '.dsh/profiles/desktop/node_modules/@openai/codex/bin/codex.js'),
    join(process.env.HOME ?? '', '.dsh/profiles/desktop/node_modules/@openai/codex/bin/codex'),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return undefined
}

function claudeBinary() {
  if (process.env.DSH_AGENT_BRIDGE_CLAUDE) return process.env.DSH_AGENT_BRIDGE_CLAUDE
  const home = process.env.HOME ?? ''
  const candidates = [
    join(home, '.local/bin/claude'),
    join(home, '.claude/local/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = join(dir, 'claude')
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Tools Claude may run without asking the human (read-only / no side effects). */
const CLAUDE_AUTO_ALLOW = new Set(['Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'NotebookRead', 'BashOutput', 'KillBash', 'WebFetch', 'WebSearch'])

function summarizeToolInput(input) {
  if (input === null || typeof input !== 'object') return null
  const command = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? null
  if (typeof command === 'string') return command.length > 160 ? `${command.slice(0, 160)}…` : command
  try {
    return JSON.stringify(input).slice(0, 160)
  } catch {
    return null
  }
}

function claudeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const input = Number(usage.input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0)
  const output = Number(usage.output_tokens ?? 0)
  const total = { totalTokens: input + output, inputTokens: input, cachedInputTokens: Number(usage.cache_read_input_tokens ?? 0), outputTokens: output }
  return { total, last: total }
}

/**
 * Normalize one `claude -p --output-format stream-json` line into zero or more
 * timeline rows using the same `kind` vocabulary as the Codex side, so the HUD
 * renders both agents with one code path.
 */
function claudeRows(event, state) {
  const type = event?.type
  if (type === 'system') {
    if (event.subtype === 'init') {
      state.sessionId = event.session_id ?? state.sessionId
      state.model = event.model ?? state.model
      return [{ kind: 'status', status: 'init', sessionId: event.session_id ?? null, model: event.model ?? null, toolCount: Array.isArray(event.tools) ? event.tools.length : null }]
    }
    if (event.subtype === 'status') return [{ kind: 'status', status: event.status ?? null }]
    return [{ kind: 'status', status: event.subtype ?? null }]
  }
  if (type === 'stream_event') {
    const inner = event.event ?? {}
    if (inner.type === 'content_block_delta') {
      const delta = inner.delta ?? {}
      if (delta.type === 'text_delta') {
        state.sawText = true
        return [{ kind: 'text', text: delta.text ?? '' }]
      }
      if (delta.type === 'thinking_delta') return [{ kind: 'reasoning', text: delta.thinking ?? '' }]
    }
    return []
  }
  if (type === 'assistant') {
    const content = Array.isArray(event.message?.content) ? event.message.content : []
    const rows = []
    for (const block of content) {
      if (block?.type === 'tool_use') {
        rows.push({ kind: 'item.start', itemType: 'tool', toolUseId: block.id ?? null, title: `${block.name ?? 'tool'}`, detail: summarizeToolInput(block.input) })
      } else if (block?.type === 'text' && !state.sawText && (block.text ?? '') !== '') {
        rows.push({ kind: 'text', text: block.text })
      } else if (block?.type === 'thinking' && (block.thinking ?? '') !== '') {
        rows.push({ kind: 'reasoning', text: block.thinking })
      }
    }
    return rows
  }
  if (type === 'user') {
    const content = Array.isArray(event.message?.content) ? event.message.content : []
    const rows = []
    for (const block of content) {
      if (block?.type === 'tool_result') {
        rows.push({ kind: 'item.end', itemType: 'tool_result', toolUseId: block.tool_use_id ?? null, ok: block.is_error !== true, title: 'tool_result', detail: typeof block.content === 'string' ? block.content.slice(0, 160) : null })
      }
    }
    return rows
  }
  if (type === 'result') {
    return [{
      kind: 'turn.end',
      status: event.is_error === true ? 'failed' : 'completed',
      finalAnswer: typeof event.result === 'string' ? event.result : null,
      durationMs: Number(event.duration_ms ?? 0) || null,
      numTurns: Number(event.num_turns ?? 0) || null,
      costUsd: Number(event.total_cost_usd ?? 0) || null,
      denials: Array.isArray(event.permission_denials) ? event.permission_denials.length : 0,
      usage: claudeUsage(event.usage),
    }]
  }
  return []
}

/** One `codex app-server` child process, shared by every run. */
/** 提问类 serverRequest：与审批分流（kind=question）。 */
const isQuestionMethod = (method) =>
  typeof method === 'string' && /requestUserInput|request_user_input|AskUserQuestion|ask_user|question/i.test(method)
const approvalKind = (method) => (isQuestionMethod(method) ? 'question' : 'approval')

/**
 * 提问回执的线形状由 codex 的 ToolRequestUserInputResponse 固定：
 * `{ answers: { <questionId>: { answers: ["<label>"] } } }`（值是对象，内层
 * answers 数组必填）。调用方（HUD/面板/curl）习惯发裸 label，裸字符串透传会
 * 让 codex 收到「empty answers」并丢掉用户的选择，所以在桥这一层统一收敛。
 */
const normalizeAnswers = (answers) => {
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

class CodexHost {
  constructor() {
    this.child = null
    this.buffer = ''
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    this.startedAt = null
    this.ready = false
    this.lastError = null
    /** 单飞：并发的两次 POST /runs 必须共用同一次启动，否则会 spawn 两个
     *  app-server，后启动的覆盖 this.child，先启动的成为没人回收的孤儿（F-01）。 */
    this.starting = null
  }

  onNotification(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start() {
    if (this.child && this.ready) return
    if (this.starting) return this.starting
    this.starting = this.startOnce().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async startOnce() {
    const binary = codexBinary()
    if (!binary) throw new Error('codex binary not found (set DSH_AGENT_BRIDGE_CODEX)')
    this.child = spawn(process.execPath, [binary, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: applyUpstream({ ...process.env }, 'codex'),
    })
    this.child.stderr.on('data', (chunk) => {
      this.lastError = chunk.toString().slice(0, 400)
    })
    this.child.on('error', (error) => {
      this.lastError = String(error && error.message ? error.message : error).slice(0, 400)
      this.ready = false
    })
    this.child.on('exit', (code, signal) => {
      this.ready = false
      this.child = null
      this.lastError = this.lastError ?? `app-server exited code=${code ?? 'null'} signal=${signal ?? 'null'}`
      for (const [, waiter] of this.pending) waiter.reject(new Error('codex app-server exited'))
      this.pending.clear()
      this.emit({ type: 'host/exit' })
    })
    this.child.stdout.on('data', (chunk) => this.consume(chunk))
    const init = await this.request('initialize', {
      clientInfo: { name: 'dsh-agent-bridge', title: 'DeepSeek Harness Agent Bridge', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    this.startedAt = Date.now()
    this.ready = true
    this.userAgent = init?.userAgent
    this.codexHome = init?.codexHome
    return init
  }

  consume(chunk) {
    this.buffer += chunk.toString()
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      this.dispatch(message)
    }
  }

  dispatch(message) {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const waiter = this.pending.get(message.id)
      this.pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
      else waiter.resolve(message.result)
      return
    }
    if (message.method) {
      this.emit({ type: 'notification', method: message.method, params: message.params })
      if (message.id !== undefined) this.emit({ type: 'serverRequest', id: message.id, method: message.method, params: message.params })
      return
    }
    if (message.id !== undefined) this.emit({ type: 'serverResponse', id: message.id, result: message.result, error: message.error })
  }

  emit(event) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {}
    }
  }

  write(payload) {
    if (!this.child) throw new Error('codex app-server is not running')
    this.child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  request(method, params, timeoutMs = 120000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`codex ${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write({ id, method, params })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  respond(id, result) {
    this.write({ id, result })
  }

  /** codex 的 server→client 请求按方法分流：审批回 {decision}，
   * 提问回 {answers}。旧实现一律回 {decision}，提问类请求必然被对方判为无效（R-05）。 */
  respondApproval(id, decision, method = '', answers = null) {
    if (isQuestionMethod(method)) {
      // 提问不是审批：回执必须是 {answers: {<questionId>: <option>}}，
      // 回 {decision} 会让上游把它当成批准结果，追问永远看不到（2.20）。
      const out = answers && typeof answers === 'object' && !Array.isArray(answers) ? answers : {}
      this.write({ id, result: { answers: out, declined: decision !== 'accept' } })
      return
    }
    this.write({ id, result: { decision: decision === 'accept' ? 'accept' : 'decline' } })
  }
}

/** Runs: metadata + append-only raw event log + in-memory ring for SSE. */
class RunStore {
  constructor() {
    this.runs = new Map()
    this.seq = 0
    mkdirSync(RUNS, { recursive: true })
  }

  create({ agent, prompt, cwd, model, dshSessionId }) {
    const id = randomUUID()
    const dir = join(RUNS, id)
    mkdirSync(dir, { recursive: true })
    const run = {
      id,
      agent,
      prompt,
      cwd,
      model,
      // 发起该 run 的 DSH 会话（可选）；恢复时优先 fork 它。
      dshSessionId: typeof dshSessionId === 'string' && dshSessionId !== '' ? dshSessionId : null,
      status: 'starting',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      threadId: null,
      turnId: null,
      eventCount: 0,
      usage: null,
      error: null,
      dir,
      events: [],
      clients: new Set(),
    }
    this.runs.set(id, run)
    this.persist(run)
    return run
  }

  /** 从磁盘回填事件：宿主重启后内存里的 run 是空的，但详情页仍要能读历史。 */
  hydrate(run) {
    if (!run || run.events.length > 0) return run
    try {
      const file = join(run.dir, 'events.jsonl')
      if (!existsSync(file)) return run
      const events = []
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { events.push(JSON.parse(line)) } catch {}
      }
      run.events = events.slice(-4000)
      const last = run.events[run.events.length - 1]
      if (last && typeof last.seq === 'number' && last.seq > this.seq) this.seq = last.seq
    } catch {}
    return run
  }

  persist(run) {
    const meta = {
      id: run.id,
      agent: run.agent,
      prompt: run.prompt,
      cwd: run.cwd,
      model: run.model,
      // dshSessionId = DSH 会话；sessionId = agent 原生会话（Claude 的 session_id）。
      dshSessionId: run.dshSessionId ?? null,
      sessionId: run.sessionId ?? null,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      threadId: run.threadId,
      turnId: run.turnId,
      eventCount: run.eventCount,
      usage: run.usage,
      finalAnswer: run.finalAnswer ?? null,
      durationMs: run.durationMs ?? null,
      error: run.error,
    }
    try {
      writeFileSync(join(run.dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
    } catch {}
  }

  append(run, event) {
    const record = { seq: ++this.seq, at: new Date().toISOString(), ...event }
    run.eventCount += 1
    run.updatedAt = record.at
    run.events.push(record)
    if (run.events.length > 4000) run.events.splice(0, run.events.length - 4000)
    try {
      appendFileSync(join(run.dir, 'events.jsonl'), `${JSON.stringify(record)}\n`)
    } catch {}
    for (const res of run.clients) {
      try {
        res.write(`id: ${record.seq}\ndata: ${JSON.stringify(record)}\n\n`)
      } catch {}
    }
    return record
  }

  setStatus(run, status, extra) {
    run.status = status
    if (extra) Object.assign(run, extra)
    run.updatedAt = new Date().toISOString()
    this.persist(run)
    for (const res of run.clients) {
      try {
        res.write(`event: status\ndata: ${JSON.stringify({ status: run.status, ...(extra ?? {}) })}\n\n`)
      } catch {}
    }
  }

  list() {
    return [...this.runs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((run) => ({
        id: run.id,
        agent: run.agent,
        prompt: run.prompt.slice(0, 160),
        status: run.status,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        threadId: run.threadId,
        eventCount: run.eventCount,
        finalAnswer: run.finalAnswer ?? null,
      }))
  }

  /**
   * 按 id 从磁盘补一个 run（宿主重启后内存里只有最近 50 个）。
   * 路径做白名单校验：runId 来自 query，不能变成目录穿越。
   */
  readFromDisk(id) {
    if (this.runs.has(id)) return this.runs.get(id)
    if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(id) || id === '.' || id === '..') return null
    try {
      const meta = JSON.parse(readFileSync(join(RUNS, id, 'meta.json'), 'utf8'))
      const run = { ...meta, dir: join(RUNS, id), events: [], clients: new Set() }
      this.runs.set(id, run)
      return run
    } catch {
      return null
    }
  }

  loadFromDisk(limit = 50) {
    let dirs = []
    try {
      dirs = readdirSync(RUNS).slice(-limit)
    } catch {
      return
    }
    for (const id of dirs) {
      if (this.runs.has(id)) continue
      try {
        const meta = JSON.parse(readFileSync(join(RUNS, id, 'meta.json'), 'utf8'))
        this.runs.set(id, { ...meta, dir: join(RUNS, id), events: [], clients: new Set() })
      } catch {}
    }
  }
}

/** Normalize a Codex notification into a compact timeline row (raw kept). */
function normalize(notification) {
  const { method, params } = notification
  const item = params?.item
  if (method === 'item/agentMessage/delta') return { kind: 'text', text: params?.delta ?? '' }
  if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
    return { kind: 'reasoning', text: params?.delta ?? '' }
  }
  if (method === 'item/commandExecution/outputDelta') return { kind: 'output', text: params?.delta ?? '' }
  if (method === 'item/plan/delta') return { kind: 'plan', text: params?.delta ?? '' }
  if (method === 'item/started' || method === 'item/completed') {
    return {
      kind: method === 'item/started' ? 'item.start' : 'item.end',
      itemType: item?.type ?? null,
      itemId: item?.id ?? null,
      title: item?.command ?? item?.title ?? item?.type ?? null,
    }
  }
  if (method === 'turn/completed') {
    const items = Array.isArray(params?.turn?.items) ? params.turn.items : []
    const final = items.find((entry) => entry?.type === 'agentMessage' && entry?.phase === 'final_answer') ?? null
    return {
      kind: 'turn.end',
      status: params?.turn?.status ?? null,
      durationMs: params?.turn?.durationMs ?? null,
      finalAnswer: final?.text ?? null,
      itemCount: items.length,
    }
  }
  if (method === 'thread/tokenUsage/updated') return { kind: 'usage', usage: params?.tokenUsage ?? null }
  if (method === 'turn/started') return { kind: 'turn.start' }
  if (method === 'thread/status/changed') return { kind: 'status', threadStatus: params?.status ?? null }
  if (method?.endsWith('/requestApproval')) return { kind: 'approval.request', approval: params ?? null }
  return { kind: 'event' }
}


/**
 * TUI 启动时会向终端查询颜色/键盘能力（OSC 10/11、DA1、kitty keyboard）。
 * 管道里如果没有终端，这些查询永远没人回，TUI 就卡在首屏。这里给最小应答。
 */
function answerTerminalQueries(session, text) {
  const reply = (data) => {
    try { session.child.stdin.write(data) } catch {}
  }
  if (text.includes('\u001b]10;?')) reply('\u001b]10;rgb:ffff/ffff/ffff\u001b\\')
  if (text.includes('\u001b]11;?')) reply('\u001b]11;rgb:1616/1818/1c1c\u001b\\')
  if (text.includes('\u001b[c') || text.includes('\u001b[0c')) reply('\u001b[?62;22c')
  if (text.includes('\u001b[>7u') || text.includes('\u001b[>4;')) reply('\u001b[?0u')
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead?.(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end?.(text)
}

function badRequest(code, message) {
  const error = new Error(message)
  error.status = 400
  error.code = code
  return error
}

/**
 * 严格版 readBody：body 不是合法 JSON 时抛 400，而不是静默变成 {}。
 * 旧实现让「JSON 写错」表现为 prompt is required，排查时完全看不出真因。
 */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let data = ''
    request.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) request.destroy()
    })
    request.on('end', () => {
      if (!data.trim()) return resolve({})
      try {
        resolve(JSON.parse(data))
      } catch (error) {
        reject(badRequest('invalid_json', `invalid JSON body: ${error.message}`))
      }
    })
    request.on('error', (error) => reject(badRequest('read_failed', `failed to read body: ${error.message}`)))
  })
}

function readBody(request) {
  return new Promise((resolve) => {
    let data = ''
    request.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) request.destroy()
    })
    request.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch {
        resolve({})
      }
    })
    request.on('error', () => resolve({}))
  })
}

function wbPort(url) {
  const value = Number(url.searchParams.get('port'))
  return Number.isFinite(value) && value > 1024 ? value : 9333
}

const DSH_PATCH = join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
const UPSTREAM_FILE = join(ROOT, 'upstream.json')

/**
 * 本项目的「聚合 API」= DSH 自己正在用的那一个。
 * 唯一事实来源是 profile 的 cordis.patch.yml（llm-pi-ai 的 providers），
 * 这里只做只读解析，不维护第二份配置。
 */
function readUpstream() {
  try {
    const text = readFileSync(DSH_PATCH, 'utf8')
    const providerName = (text.match(/providers:\s*\n\s+([A-Za-z0-9_.-]+):/) || [])[1]
    if (!providerName) return { ok: false, reason: 'no_provider' }
    const start = text.indexOf(`providers:`)
    const block = text.slice(start)
    const apiKeyEnv = (block.match(/apiKeyEnv:\s*([A-Za-z0-9_]+)/) || [])[1] || 'COMPANY_API_KEY'
    const baseURL = (block.match(/baseURL:\s*(\S+)/) || [])[1] || ''
    const api = (block.match(/\n\s+api:\s*([A-Za-z0-9_-]+)/) || [])[1] || 'openai-completions'
    const models = []
    for (const match of block.matchAll(/^\s{8,}-\s+id:\s*(.+)$/gm)) {
      const id = match[1].trim()
      if (id && !models.includes(id)) models.push(id)
    }
    return { ok: Boolean(baseURL), provider: providerName, api, baseURL, apiKeyEnv, models }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

async function probeUpstream(upstream) {
  if (!upstream?.ok) return { ok: false, reason: 'upstream_unavailable' }
  const key = resolveApiKey(upstream.apiKeyEnv)
  if (!key) return { ok: false, reason: 'api_key_missing', apiKeyEnv: upstream.apiKeyEnv }
  const model = upstream.models[0]
  if (!model) return { ok: false, reason: 'no_models' }
  const root = /\/v1$/.test(upstream.baseURL) ? upstream.baseURL : `${upstream.baseURL.replace(/\/$/, '')}/v1`
  const startedAt = Date.now()
  try {
    const response = await fetch(`${root}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false }),
      signal: AbortSignal.timeout(30000),
    })
    const body = await response.text()
    return { ok: response.ok, status: response.status, model, ms: Date.now() - startedAt, sample: body.slice(0, 200) }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error), model }
  }
}

function resolveApiKey(envName) {
  if (!envName) return ''
  if (process.env[envName]) return process.env[envName]
  try {
    const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
    const match = text.match(new RegExp(`^\\s*${envName}\\s*:\\s*(\\S+)\\s*$`, 'm'))
    return match ? match[1] : ''
  } catch {
    return ''
  }
}

/** 把子进程切到 DSH 自己那条聚合 API（单一事实来源：profile 的 cordis.patch.yml）。 */
function applyUpstream(env, kind) {
  const upstream = readUpstream()
  if (!upstream.ok || !upstream.baseURL) return env
  const key = resolveApiKey(upstream.apiKeyEnv)
  if (!key) return env
  const root = /\/v1$/.test(upstream.baseURL) ? upstream.baseURL : `${upstream.baseURL.replace(/\/$/, '')}/v1`
  if (kind === 'codex') {
    env.OPENAI_BASE_URL = root
    env.OPENAI_API_KEY = key
    env.OPENAI_API_BASE = root
  } else {
    env.ANTHROPIC_BASE_URL = upstream.baseURL.replace(/\/v1$/, '')
    env.ANTHROPIC_AUTH_TOKEN = key
    env.ANTHROPIC_API_KEY = key
    // 网关没有登记这个模型的窗口，Claude Code 会按 200k 保守处理，这里显式给 1M。
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '1000000'
  }
  return env
}

export function apply(ctx) {
  // 写一份自描述文件，供 CLI / MCP 桥接进程发现当前宿主端口（端口每次重启都变）。
  try {
    const port = ctx.webServer?.port
    if (port) {
      // 新 profile 首次运行时 ROOT 还不存在：不 mkdir 会静默丢文件（F-12）。
      mkdirSync(ROOT, { recursive: true })
      writeFileSync(join(ROOT, 'bridge-url.json'), `${JSON.stringify({ url: `http://127.0.0.1:${port}`, port, updatedAt: Date.now() }, null, 2)}\n`)
    }
  } catch (error) {
    log(`bridge-url write failed: ${error?.message ?? error}`)
  }

  const store = new RunStore()
  store.loadFromDisk()
  const host = new CodexHost()
  const runsByThread = new Map()
  const approvals = new Map()

  // 审批聚合：approvals 是活句柄（唯一能把决策送回子进程的通道），
  // pendingApprovals 是 HUD / 面板读的快照，落到 ~/.dsh/agent-bridge/pending-approvals.json。
  const pendingApprovals = new PendingApprovalStore(PENDING_FILE)
  try {
    pendingApprovals.load()
    const stale = pendingApprovals.markAllStale()
    if (stale > 0) log(`pending approvals: ${stale} stale entr${stale === 1 ? 'y' : 'ies'} recovered from disk`)
  } catch (error) {
    log(`pending approvals load failed: ${String(error?.message ?? error)}`)
  }

  host.onNotification((event) => {
    if (event.type === 'host/exit') {
      for (const run of store.runs.values()) if (run.status === 'running') store.setStatus(run, 'failed', { error: 'codex app-server exited' })
      return
    }
    if (event.type !== 'notification') {
      if (event.type === 'serverRequest') handleServerRequest(event)
      return
    }
    const run = runsByThread.get(event.params?.threadId) ?? null
    if (!run) return
    const row = normalize(event)
    if (run.status === 'starting') store.setStatus(run, 'running')
    store.append(run, { notification: event.method, ...row, raw: event.params })
    if (row.kind === 'usage') {
      run.usage = row.usage
      store.persist(run)
    }
    if (event.method === 'turn/completed') {
      const turn = event.params?.turn ?? {}
      const items = Array.isArray(turn.items) ? turn.items : []
      const final = items.find((entry) => entry?.type === 'agentMessage' && entry?.phase === 'final_answer') ?? null
      const status = turn.status === 'completed' ? 'done' : 'failed'
      store.setStatus(run, status, {
        finalAnswer: final?.text ?? null,
        durationMs: turn.durationMs ?? null,
        error: turn.error ?? null,
      })
      // bridge.log 要能回答「这个 run 什么时候结束、成没成」（F-10）。
      log(`run ${status} id=${run.id.slice(0, 8)} agent=codex duration=${turn.durationMs ?? '-'} error=${turn.error ? String(turn.error).slice(0, 120) : '-'}`)
    }
  })

  const handleServerRequest = (event) => {
    const run = runsByThread.get(event.params?.threadId) ?? null
    const approval = {
      id: String(event.id),
      runId: run?.id ?? null,
      agent: run?.agent ?? 'codex',
      method: event.method,
      kind: approvalKind(event.method),
      params: event.params ?? null,
      at: new Date().toISOString(),
      token: makeApprovalToken(),
      timer: setTimeout(() => settleApproval(approval.id, 'decline', 'timeout'), APPROVAL_TIMEOUT_MS),
    }
    approvals.set(approval.id, approval)
    pendingApprovals.upsert({
      id: approval.id,
      runId: approval.runId,
      agent: approval.agent,
      method: approval.method,
      kind: approval.kind,
      params: approval.params,
      at: approval.at,
      token: approval.token,
    })
    log(`approval request id=${approval.id.slice(0, 8)} run=${(approval.runId ?? '-').slice(0, 8)} agent=${approval.agent} method=${approval.method}`)
    if (run) {
      store.append(run, { kind: 'approval.request', notification: event.method, raw: event.params })
      store.setStatus(run, 'needs-approval')
    }
  }

  /**
   * 把 {questionId: optionId|label} 还原成人能看懂的「问题 → 选项」，仅用于日志与事件，
   * 保证 HUD/查日志能确认「选了哪一问的哪个选项」（PRD 2.20 的可审计要求）。
   */
  const describeAnswer = (approval, answers) => {
    const list = []
    const questions = approval?.params?.questions ?? approval?.params?.input?.questions
    const entries = answers && typeof answers === 'object' ? Object.entries(answers) : []
    for (const [questionId, value] of entries) {
      // 线形状是 {answers:[label]}；这里拆出可读值再和选项标签比对。
      const rawValue = value && typeof value === 'object' && Array.isArray(value.answers) ? value.answers.join(' / ') : value
      const question = Array.isArray(questions) ? questions.find((q) => String(q?.id) === String(questionId)) : null
      const options = Array.isArray(question?.options) ? question.options : []
      const picked = options.find((o) => String(o?.id ?? o?.label ?? o) === String(rawValue))
      const label = picked ? String(picked.label ?? picked.id ?? picked) : String(rawValue)
      const text = String(question?.question ?? question?.text ?? '').replace(/\s+/g, ' ').slice(0, 60)
      list.push(`${questionId}=${label}${text ? ` («${text}»)` : ''}`)
    }
    return list.length ? list.join(', ') : '-'
  }

  const settleApproval = (id, decision, reason, answers = null) => {
    const approval = approvals.get(id)
    if (!approval) return false
    approvals.delete(id)
    clearTimeout(approval.timer)
    pendingApprovals.remove(id)
    if (typeof approval.resolve === 'function') {
      try {
        approval.resolve(decision)
      } catch {}
    } else {
      try {
        // Codex 的审批与提问是两种 serverRequest：审批回 {decision}，提问回
        // {answers}。按 method 分流，否则提问类请求会被上游判为无效（R-05）。
        host.respondApproval(Number(id), decision, approval.method, answers)
      } catch (error) {
        log(`approval respond failed id=${id.slice(0, 8)} ${String(error && error.message ? error.message : error)}`)
      }
    }
    if (/timeout/.test(String(reason ?? ''))) {
      // 超时必须是拒绝：旧行为等于静默放行，审计已实测到 hook 被自动 allow。
      log(`approval timeout -> deny id=${id.slice(0, 8)} method=${approval.method} reason=${reason}`)
    }
    log(`approval settle id=${id.slice(0, 8)} decision=${decision} reason=${reason ?? '-'} run=${(approval.runId ?? '-').slice(0, 8)}`)
    // 用审批自带的 kind（claude 的 AskUserQuestion 在创建时已按工具名分类），
    // 仅看 method 会把它当成普通审批，question answered 日志就永远不出现。
    const approvalIsQuestion = (approval.kind ?? approvalKind(approval.method)) === 'question'
    if (approvalIsQuestion) {
      // 提问通道单独一条可 grep 的日志：question answered … option=…
      log(`question answered id=${id.slice(0, 8)} run=${(approval.runId ?? '-').slice(0, 8)} decision=${decision} option=${describeAnswer(approval, answers)}`)
    }
    const run = approval.runId ? store.runs.get(approval.runId) : null
    if (run) {
      const isQuestion = approvalIsQuestion
      store.append(run, isQuestion
        ? { kind: 'question.answer', decision, reason: reason ?? null, answers: answers ?? null, picked: describeAnswer(approval, answers) }
        : { kind: 'approval.decision', decision, reason: reason ?? null, answers: answers ?? null })
      store.setStatus(run, 'running')
    }
    return true
  }

  /**
   * 外部（HUD / 面板）唯一决策入口：`allow|deny` 在这里换成子进程协议词。
   * 返回 false 表示没有活 waiter（调用方可回 404 或按 stale 条目处理）。
   */
  const decide = (id, decision, note, token, answers = null) => {
    const approval = approvals.get(String(id))
    if (!approval) return false
    if (typeof approval.token === 'string' && !sameToken(token, approval.token)) {
      log(`approval rejected id=${String(id).slice(0, 8)} reason=bad_token`)
      return 'forbidden'
    }
    // 提问的回答也走这里：带 answers 就等价于「已采纳」，decision 记为 accept。
    const wireAnswers = normalizeAnswers(answers)
    const answersProvided = wireAnswers !== null
    return settleApproval(String(id), answersProvided ? 'accept' : internalDecision(decision), note, wireAnswers)
  }

  const startRun = async (body) => {
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) {
      // 客户端错误不能算 500：给 400 + code，调用方和日志都能分清是谁的问题（F-13）。
      const error = new Error('prompt is required')
      error.status = 400
      error.code = 'prompt_required'
      throw error
    }
    const agent = body.agent === 'claude' ? 'claude' : 'codex'
    const fallbackCwd = process.env.DSH_AGENT_BRIDGE_CWD ?? process.env.DSH_WORKSPACE ?? process.cwd()
    const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : fallbackCwd
    // 发起 run 的 DSH 会话 id（可选）；/resume 会优先 fork 它回到最后一个 completed-turn。
    const dshSessionId = typeof body.sessionId === 'string' ? body.sessionId : typeof body.dshSessionId === 'string' ? body.dshSessionId : null
    if (agent === 'claude') {
      // 先确认二进制存在再建 run：旧实现先 create 再 throw，用户拿到一个
      // 永远停在 starting 的 run，也没有任何可诊断的错误（F-06）。
      if (!claudeBinary()) {
        const error = new Error('claude binary not found (set DSH_AGENT_BRIDGE_CLAUDE)')
        error.status = 503
        error.code = 'claude_binary_missing'
        throw error
      }
      const run = store.create({ agent: 'claude', prompt, cwd, model: body.model ?? null, dshSessionId })
      store.append(run, { kind: 'run.created', prompt })
      try {
        const child = spawnClaude(run, { prompt, cwd, model: body.model ?? null, port: ctx.webServer.port })
        store.setStatus(run, 'running')
        log(`run start id=${run.id.slice(0, 8)} agent=claude pid=${child.pid ?? 'unknown'} cwd=${cwd}`)
        return { runId: run.id, agent: 'claude', pid: child.pid ?? null, model: run.model, cwd }
      } catch (error) {
        store.setStatus(run, 'failed', { error: String(error && error.message ? error.message : error) })
        log(`run failed id=${run.id.slice(0, 8)} agent=claude reason=${String(error && error.message ? error.message : error)}`)
        error.status = 500
        error.runId = run.id
        throw error
      }
    }
    await host.start()
    const run = store.create({ agent: 'codex', prompt, cwd, model: body.model ?? null, dshSessionId })
    store.append(run, { kind: 'run.created', prompt })
    log(`run start id=${run.id.slice(0, 8)} agent=codex cwd=${cwd}`)
    const thread = await host.request('thread/start', { cwd, ...(body.model ? { model: body.model } : {}) })
    run.threadId = thread.thread.id
    run.model = thread.model ?? run.model
    runsByThread.set(run.threadId, run)
    store.persist(run)
    const turn = await host.request('turn/start', {
      threadId: run.threadId,
      input: [{ type: 'text', text: prompt }],
      // 直问通道（PRD 2.20）：codex 的 `request_user_input` 只在 plan 协作模式下暴露，
      // 默认模式调用会被系统拒绝（实测「request_user_input 在当前 Default 模式下不可用」）。
      // 需要 agent 向人提问时传 plan:true 即可走 plan 模式，从而真实触发
      // `item/tool/requestUserInput`，由 kind=question 通道收集 {answers}。
      ...(body.plan === true
        ? { collaborationMode: { mode: 'plan', settings: { model: run.model ?? 'DeepSeek-V4.1-Flash' } } }
        : {}),
    })
    run.turnId = turn.turn?.id ?? null
    store.setStatus(run, 'running')
    if (body.plan === true) log(`run plan-mode id=${run.id.slice(0, 8)} model=${run.model ?? '-'} (request_user_input enabled)`)
    return { runId: run.id, threadId: run.threadId, turnId: run.turnId, model: run.model, cwd, plan: body.plan === true }
  }

  /** Claude Code runs: one `claude -p` child per run, stream-json in, our rows out. */
  const claudeChildren = new Map()
  let claudeApprovalSeq = 0

  const emitClaudeRows = (run, rows, raw) => {
    for (const row of rows) {
      if (!row) continue
      store.append(run, { ...row, raw })
      if (row.kind === 'usage' && row.usage) {
        run.usage = row.usage
        store.persist(run)
      }
    }
  }

  const spawnClaude = (run, { prompt, cwd, model, port }) => {
    const binary = claudeBinary()
    if (!binary) throw new Error('claude binary not found (set DSH_AGENT_BRIDGE_CLAUDE)')
    const settingsPath = join(run.dir, 'claude-settings.json')
    const hookUrl = `http://127.0.0.1:${port}/agent-bridge/claude-hook?run=${run.id}`
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [{ hooks: [{ type: 'http', url: hookUrl, timeout: 25 }] }],
          },
        },
        null,
        2,
      ),
    )
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--settings', settingsPath, '--permission-mode', 'default']
    if (model) args.push('--model', model)
    const env = applyUpstream({ ...process.env }, 'claude')
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    claudeChildren.set(run.id, child)
    run.binary = binary
    run.settingsPath = settingsPath
    store.persist(run)

    const state = { sessionId: null, model: run.model, sawText: false }
    let buffer = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (!line) continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (run.status === 'starting') store.setStatus(run, 'running')
        emitClaudeRows(run, claudeRows(event, state), event)
        if (event.type === 'result') {
          store.setStatus(run, event.is_error === true ? 'failed' : 'done', {
            finalAnswer: typeof event.result === 'string' ? event.result : null,
            durationMs: Number(event.duration_ms ?? 0) || null,
            sessionId: event.session_id ?? state.sessionId,
          })
          if (event.usage) {
            run.usage = claudeUsage(event.usage)
            store.persist(run)
          }
        }
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000)
    })
    child.on('error', (error) => {
      // 子进程根本没起来也必须从 claudeChildren 里摘掉，否则 /health 的
      // running 计数会一直显示一个已经死掉的进程（F-11）。
      claudeChildren.delete(run.id)
      store.setStatus(run, 'failed', { error: String(error && error.message) })
      log(`claude spawn error run=${run.id.slice(0, 8)} ${String(error && error.message)}`)
    })
    child.on('exit', (code, signal) => {
      claudeChildren.delete(run.id)
      if (run.status === 'running' || run.status === 'starting' || run.status === 'needs-approval') {
        store.setStatus(run, code === 0 ? 'done' : 'failed', { error: code === 0 ? null : `${signal ?? code}: ${stderr.slice(-400)}` })
      }
    })
    return child
  }

  // ── 会话恢复（GET /resume?runId=...） ─────────────────────────────────────
  // 顺序：fork 原 DSH 会话到最后一个 completed-turn → create({cwd}) + 原任务摘要。
  // 两个入口都只能改元数据（events.jsonl / meta.json），不会重跑失败的子进程。

  /** 内存优先，其次从 runs/<id>/meta.json 补；非法 id 返回 null（禁止目录穿越）。 */
  const resolveRun = (runId) => {
    if (typeof runId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(runId) || runId === '.' || runId === '..') return null
    return store.runs.get(runId) ?? store.readFromDisk(runId)
  }

  /** 从 query / run 元数据 / 事件里收集候选 DSH 会话 id（按可信度排序）。 */
  const resumeCandidates = (run, explicit) => {
    const seen = new Set()
    const ids = []
    const push = (value) => {
      if (typeof value !== 'string' || value === '' || seen.has(value)) return
      seen.add(value)
      ids.push(value)
    }
    push(explicit)
    push(run?.dshSessionId)
    // run.sessionId 平时是 Claude 的原生 session_id；只有 DSH 铸造的 `session-*` 才当成候选，
    // 真正的有效性由 sessionQuery.readSession 判定（失败就继续下一个）。
    if (typeof run?.sessionId === 'string' && run.sessionId.startsWith('session-')) push(run.sessionId)
    for (const event of Array.isArray(run?.events) ? run.events : []) {
      for (const value of [event?.sessionId, event?.data?.sessionId]) {
        if (typeof value === 'string' && value.startsWith('session-')) push(value)
      }
    }
    return ids
  }

  /** 读会话事件，返回可以 fork 的 turn/end seq；读不到/不可用时 ok:false。 */
  const findForkPoint = async (sessionId) => {
    let query
    try {
      query = ctx.get('sessionQuery')
    } catch (error) {
      return { ok: false, error: `sessionQuery lookup failed: ${String(error?.message ?? error)}` }
    }
    if (!query || typeof query.readSession !== 'function') return { ok: false, error: 'sessionQuery service unavailable' }
    try {
      const snapshot = await query.readSession(sessionId)
      return { ok: true, seq: lastCompletedTurnSeq(snapshot?.events ?? []) }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  const resumeSignal = () => {
    try {
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(30000)
    } catch {}
    return new AbortController().signal
  }

  const resumeRun = async (runId, url) => {
    // 先校验 runId（含目录穿越检查），再谈服务；这样未知 run 永远回 400 而不是 500。
    const run = resolveRun(runId)
    if (!run) return { ok: false, error: `run not found: ${runId}` }
    let controller
    try {
      controller = ctx.get('sessionController')
    } catch (error) {
      return { ok: false, error: `sessionController lookup failed: ${String(error?.message ?? error)}` }
    }
    if (!controller || typeof controller.fork !== 'function' || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
      return { ok: false, error: 'sessionController service unavailable' }
    }
    store.hydrate(run)
    const cwd = (typeof run.cwd === 'string' && run.cwd) || process.env.DSH_AGENT_BRIDGE_CWD || process.env.DSH_WORKSPACE || process.cwd()
    const prompt = typeof run.prompt === 'string' ? run.prompt : ''
    const warnings = []
    const candidates = resumeCandidates(run, url.searchParams.get('sessionId'))
    let source = null
    let atSeq = null
    for (const candidate of candidates) {
      const probe = await findForkPoint(candidate)
      if (probe.ok === true) {
        source = candidate
        atSeq = probe.seq
        break
      }
      warnings.push(`${candidate}: ${probe.error}`)
    }
    if (source !== null) {
      // 先按 turn/end 精确切；失败再让 fork 自己挑 latest completed prefix。
      const cuts = []
      if (atSeq !== null) cuts.push(atSeq)
      cuts.push(undefined)
      for (const cut of cuts) {
        try {
          const request = { sessionId: source }
          if (cut !== undefined) request.atSeq = cut
          const forked = await controller.fork(request)
          const sessionId = forked?.sessionId
          if (typeof sessionId !== 'string' || sessionId === '') throw new Error('fork returned no sessionId')
          let prompted = false
          let promptError = null
          try {
            await controller.prompt(
              { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: resumePrompt({ mode: 'fork', prompt, agent: run.agent, cwd }) }] },
              resumeSignal(),
            )
            prompted = true
          } catch (error) {
            promptError = String(error?.message ?? error)
            log(`resume: forked ${sessionId} but prompt failed: ${promptError}`)
          }
          try {
            store.append(run, { kind: 'resume', mode: 'fork', sessionId, source, atSeq: cut ?? null, prompted })
            store.persist(run)
          } catch {}
          return {
            ok: true,
            sessionId,
            mode: 'fork',
            source,
            atSeq: cut ?? null,
            prompted,
            ...(promptError === null ? {} : { promptError }),
            ...(warnings.length === 0 ? {} : { warnings }),
          }
        } catch (error) {
          warnings.push(`fork atSeq=${cut ?? 'latest'}: ${String(error?.message ?? error)}`)
        }
      }
    }
    // 退路：新会话 + 原任务摘要。create 只给 cwd（workspaceId 与 cwd 不能同时给）。
    let created
    try {
      created = await controller.create({ cwd })
    } catch (error) {
      return { ok: false, error: `create failed: ${String(error?.message ?? error)}`, warnings }
    }
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: 'create returned no sessionId', warnings }
    let prompted = false
    let promptError = null
    try {
      await controller.prompt(
        { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: resumePrompt({ mode: 'new', prompt, agent: run.agent, cwd }) }] },
        resumeSignal(),
      )
      prompted = true
    } catch (error) {
      promptError = String(error?.message ?? error)
      log(`resume: created ${sessionId} but prompt failed: ${promptError}`)
    }
    try {
      store.append(run, { kind: 'resume', mode: 'new', sessionId, source: null, prompted })
      store.persist(run)
    } catch {}
    return {
      ok: true,
      sessionId,
      mode: 'new',
      source: null,
      atSeq: null,
      prompted,
      ...(promptError === null ? {} : { promptError }),
      ...(warnings.length === 0 ? {} : { warnings }),
    }
  }

  const handler = async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const path = url.pathname.replace(/^\/agent-bridge\/?/, '')
    const parts = path.split('/').filter(Boolean)
    const method = request.method ?? 'GET'

    if (method === 'GET' && (path === '' || path === 'health')) {
      // ok 不再恒为 true：app-server 起不来 / 子进程死光时要说实话，
      // 否则 doctor 和 smoke 永远绿（F-11）。
      const claudeBinaryPath = claudeBinary() ?? null
      const codexBinaryPath = codexBinary() ?? null
      const problems = []
      if (!codexBinaryPath) problems.push('codex binary not found')
      if (!claudeBinaryPath) problems.push('claude binary not found')
      if (host.lastError && host.ready === false) problems.push(`codex: ${host.lastError}`)
      const failedRuns = [...store.runs.values()].filter((run) => run.status === 'failed').length
      return json(response, problems.length === 0 ? 200 : 503, {
        ok: problems.length === 0,
        problems,
        codex: {
          running: Boolean(host.ready),
          starting: Boolean(host.starting),
          binary: codexBinaryPath,
          version: host.userAgent ?? null,
          codexHome: host.codexHome ?? null,
          lastError: host.lastError ?? null,
        },
        claude: { binary: claudeBinaryPath, running: claudeChildren.size },
        runs: store.runs.size,
        failedRuns,
        pendingApprovals: pendingApprovals.list().length,
        approvals: approvals.size,
        root: ROOT,
      })
    }
    if (method === 'GET' && parts[0] === 'beacon') {
      try {
        const name = url.searchParams.get('e') ?? 'event'
        const detail = (url.searchParams.get('d') ?? '').slice(0, 1500)
        const line = `${new Date().toISOString().slice(11, 23)} ${name} ${detail}\n`
        appendFileSync('/tmp/dsh-agent-bridge-client.log', line)
      } catch {}
      return json(response, 200, { ok: true })
    }
    if (parts[0] === 'workbuddy' && method === 'POST' && parts[1] === 'activate') {
      await new Promise((resolve) => {
        execFile('/usr/bin/open', ['-a', 'WorkBuddy'], () => resolve())
      })
      wbClearPending()
      log('workbuddy activate')
      return json(response, 200, { ok: true, activated: true })
    }
    if (parts[0] === 'workbuddy' && method === 'GET' && parts[1] === 'pending') {
      return json(response, 200, { pending: wbPending() })
    }
    if (parts[0] === 'workbuddy' && method === 'POST' && parts[1] === 'confirm') {
      const result = await wbAutoConfirm(wbPort(url)).catch((error) => ({ ok: false, error: String(error.message || error) }))
      log(`workbuddy confirm ok=${result.ok}`)
      return json(response, result.ok ? 200 : 500, result)
    }
    if (parts[0] === 'workbuddy' && method === 'GET' && parts[1] === 'confirms') {
      return json(response, 200, wbAudit(Number(url.searchParams.get('limit')) || 200))
    }
    if (parts[0] === 'workbuddy' && method === 'GET' && parts[1] === 'state') {
      const info = await wbState(wbPort(url))
      log(`workbuddy state running=${info.running} cdp=${info.cdpReady}`)
      return json(response, 200, info)
    }
    if (parts[0] === 'workbuddy' && method === 'POST' && parts[1] === 'launch') {
      const info = await wbLaunch(wbPort(url))
      log(`workbuddy launch ok=${info.ok} relaunched=${info.relaunched ?? ''}`)
      return json(response, info.ok ? 200 : 504, info)
    }
    if (parts[0] === 'workbuddy' && method === 'POST' && parts[1] === 'send') {
      const body = await readBody(request)
      const result = await wbSend(String(body.text ?? ''), wbPort(url), { newTask: body.newTask === true }).catch((error) => ({ ok: false, error: String(error.message || error) }))
      log(`workbuddy send ok=${result.ok}`)
      return json(response, result.ok ? 200 : 500, result)
    }
    if (parts[0] === 'workbuddy' && method === 'GET' && parts[1] === 'last') {
      const result = await wbReadLast(wbPort(url)).catch((error) => ({ ok: false, error: String(error.message || error) }))
      return json(response, result.ok ? 200 : 500, result)
    }
    if (method === 'GET' && parts[0] === 'upstream') {
      const upstream = readUpstream()
      const probe = String(url.searchParams.get('probe') ?? '') === '1' ? await probeUpstream(upstream) : undefined
      if (upstream.ok) {
        try {
          writeFileSync(UPSTREAM_FILE, `${JSON.stringify({ ...upstream, updatedAt: Date.now() }, null, 2)}\n`)
        } catch {}
      }
      log(`upstream provider=${upstream.provider ?? '-'} base=${upstream.baseURL ?? '-'} models=${upstream.models?.length ?? 0} probe=${probe ? probe.ok : '-'}`)
      json(response, 200, { ok: Boolean(upstream.ok), upstream, probe })
      return
    }

    if (method === 'GET' && parts[0] === 'runs' && parts.length === 1) {
      return json(response, 200, { runs: store.list() })
    }
    if (method === 'POST' && parts[0] === 'runs' && parts.length === 1) {
      try {
        return json(response, 200, await startRun((await readJsonBody(request)) ?? {}))
      } catch (error) {
        // 结构化 4xx/5xx：带 code/runId，日志里有同一条记录，客户端能据此诊断（F-06/F-13）。
        const status = Number.isFinite(error?.status) ? error.status : 500
        const payload = { ok: false, error: String(error && error.message ? error.message : error) }
        if (typeof error?.code === 'string') payload.code = error.code
        if (typeof error?.runId === 'string') payload.runId = error.runId
        log(`run start failed status=${status} ${payload.error}`)
        return json(response, status, payload)
      }
    }
    if (method === 'GET' && parts[0] === 'runs' && parts[2] === 'stream') {
      const run = store.runs.get(parts[1])
      if (!run) return json(response, 404, { error: 'run not found' })
      store.hydrate(run)
      const since = Number(url.searchParams.get('since') ?? '0')
      const res = response
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(`event: status\ndata: ${JSON.stringify({ status: run.status })}\n\n`)
      for (const record of run.events) if (record.seq > since) res.write(`id: ${record.seq}\ndata: ${JSON.stringify(record)}\n\n`)
      run.clients.add(res)
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {}
      }, 15000)
      const cleanup = () => {
        clearInterval(ping)
        run.clients.delete(res)
      }
      request.on('close', cleanup)
      request.on('error', cleanup)
      return
    }
    if (method === 'GET' && parts[0] === 'runs' && parts.length === 2) {
      const run = store.runs.get(parts[1])
      if (!run) return json(response, 404, { error: 'run not found' })
      store.hydrate(run)
      const since = Number(url.searchParams.get('since') ?? '0')
      const limit = Math.min(Number(url.searchParams.get('limit') ?? '500'), 2000)
      const events = run.events.filter((record) => record.seq > since).slice(-limit)
      return json(response, 200, {
        run: {
          id: run.id,
          agent: run.agent,
          prompt: run.prompt,
          status: run.status,
          threadId: run.threadId,
          turnId: run.turnId,
          model: run.model,
          cwd: run.cwd,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          eventCount: run.eventCount,
          usage: run.usage,
          finalAnswer: run.finalAnswer ?? null,
          durationMs: run.durationMs ?? null,
          error: run.error,
        },
        events,
      })
    }
    if (method === 'POST' && parts[0] === 'claude-hook') {
      const body = await readBody(request)
      const runId = url.searchParams.get('run')
      const run = runId ? store.runs.get(runId) ?? null : null
      const toolName = typeof body.tool_name === 'string' ? body.tool_name : 'tool'
      if (CLAUDE_AUTO_ALLOW.has(toolName)) return json(response, 200, { continue: true })
      const id = makeApprovalId('claude', ++claudeApprovalSeq)
      const decision = await new Promise((resolve) => {
        const approval = {
          id,
          runId: run?.id ?? null,
          agent: run?.agent ?? 'claude',
          method: 'claude/PreToolUse',
          // 工具名也要参与分类：claude 的 AskUserQuestion 走同一个 PreToolUse hook，
          // 只看 method 会把它降级成普通审批，提问回执与日志都会走错分支。
          kind: approvalKind(`claude/PreToolUse ${toolName}`),
          params: { tool: toolName, input: body.tool_input ?? null, sessionId: body.session_id ?? null },
          at: new Date().toISOString(),
          token: makeApprovalToken(),
          resolve,
          // 钩子客户端 25s 就会放弃等待：服务端必须更早自己收口（20s），
          // 否则「用户点批准」和「钩子超时」会互相覆盖（F-09）。
          timer: setTimeout(() => settleApproval(id, 'decline', 'hook-timeout'), 20000),
        }
        approvals.set(id, approval)
        pendingApprovals.upsert({
          id,
          runId: approval.runId,
          agent: approval.agent,
          method: approval.method,
          kind: approval.kind,
          params: approval.params,
          at: approval.at,
          token: approval.token,
        })
        log(`approval request id=${id.slice(0, 8)} run=${(approval.runId ?? '-').slice(0, 8)} agent=claude method=PreToolUse tool=${toolName}`)
        if (run) {
          store.append(run, { kind: 'approval.request', notification: 'claude/PreToolUse', raw: { tool: toolName, input: body.tool_input ?? null } })
          store.setStatus(run, 'needs-approval')
        }
      })
      return json(response, 200, {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision === 'accept' ? 'allow' : 'deny' },
      })
    }
    if (method === 'POST' && parts[0] === 'takeover') {
      // 接管：在用户自己的 Terminal 里起原生 TUI（真实 PTY），DSH 只负责把它拉起来。
      const body = await readBody(request)
      const agent = body?.agent === 'claude' ? 'claude' : 'codex'
      const cwd = typeof body?.cwd === 'string' && body.cwd ? body.cwd : process.env.HOME || '/'
      const bin = agent === 'claude' ? claudeBinary() : codexBinary()
      if (!bin) return json(response, 503, { ok: false, error: `${agent} binary not found` })
      const cmd = `cd ${JSON.stringify(cwd)} && ${JSON.stringify(bin)}`
      const script = `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(cmd)}\nend tell`
      const child = spawn('/usr/bin/osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
      let err = ''
      child.stderr.on('data', (chunk) => { err += String(chunk) })
      child.on('close', (code) => {
        if (code !== 0) log(`[agent-bridge] takeover ${agent} code=${code} ${err.slice(0, 200)}`)
      })
      return json(response, 200, { ok: true, agent, cwd, binary: bin })
    }
    if (method === 'GET' && parts[0] === 'approvals' && parts.length === 1) {
      // 活的 waiter 必须在列表里（旧实现只要 WorkBuddy 有待确认卡，就只回
      // WorkBuddy + 持久化条目，codex/claude 的实时审批整批消失）。
      // N-03：默认脱敏 token；只有显式 ?include_token=1 的同机调用方（雷达/HUD 代理）
      // 才拿到原值，避免任何本机进程从列表里捡走凭据。
      const includeToken = url.searchParams.get('include_token') === '1'
      const expose = (entry) => {
        const withKind = { ...entry, kind: entry.kind ?? approvalKind(entry.method) }
        if (includeToken) return withKind
        const { token, ...rest } = withKind
        return { ...rest, tokenRedacted: redactToken(token), hasToken: typeof token === 'string' && token.length > 0 }
      }
      const live = [...approvals.values()].map(({ timer, ...rest }) => expose(rest))
      const liveIds = new Set(live.map((entry) => entry.id))
      const stale = pendingApprovals
        .list()
        .filter((entry) => !liveIds.has(entry.id))
        .map((entry) => expose(entry))
      const list = [...live, ...stale]
      const pending = wbPending()
      if (pending && !pending.cleared) {
        list.unshift({
          id: 'workbuddy',
          agent: 'workbuddy',
          method: 'workbuddy/confirm',
          title: pending.card || 'WorkBuddy 等你确认',
          at: pending.at,
          createdAt: pending.at,
        })
      }
      return json(response, 200, { approvals: list })
    }
    if (method === 'POST' && parts[0] === 'approvals' && parts.length === 2 && parts[1] === 'workbuddy') {
      // WorkBuddy 的确认卡不是「命令批准」：accept = 激活应用让人去点确认；
      // decline = 只清掉这条待确认，绝不擅自打开 WorkBuddy（R-04）。
      const body = (await readJsonBody(request)) ?? {}
      const decision = normalizeDecision(body.decision)
      if (decision === null) return json(response, 400, { ok: false, error: 'decision must be allow|deny' })
      if (decision === 'deny') {
        wbClearPending()
        log('approval workbuddy -> declined (app not opened)')
        return json(response, 200, { ok: true, decision: 'deny', agent: 'workbuddy' })
      }
      await new Promise((resolve) => {
        execFile('/usr/bin/open', ['-a', 'WorkBuddy'], () => resolve())
      })
      wbClearPending()
      log('approval workbuddy -> activate')
      return json(response, 200, { ok: true, decision: 'allow', action: 'activate', agent: 'workbuddy' })
    }
    if (method === 'POST' && parts[0] === 'approvals' && parts.length === 2) {
      const body = (await readJsonBody(request)) ?? {}
      const answers = body.answers && typeof body.answers === 'object' ? body.answers : null
      // 提问回执没有 allow/deny：带 answers 即视为已采纳，decision 只为兼容旧客户端。
      const decision = answers ? 'allow' : normalizeDecision(body.decision)
      if (decision === null) return json(response, 400, { ok: false, error: 'decision must be allow|deny (or pass answers)', code: 'bad_decision' })
      const result = decide(parts[1], decision, typeof body.note === 'string' ? body.note.slice(0, 500) : null, body.token, answers)
      if (result === 'forbidden') return json(response, 403, { ok: false, error: 'approval token mismatch', id: parts[1] })
      // N-04：404 不能再回 decision:"allow" —— 只看 body 的调用方会把「未兑现」当「已批准」。
      if (!result) return json(response, 404, { ok: false, decision: null, reason: 'not_found', id: parts[1] })
      return json(response, 200, { ok: true, decision, answers: answers ?? null, id: parts[1] })
    }
    // ── P2 审批聚合：HUD / 面板用 GET + query（prefix 资源只服务 GET/HEAD） ──
    if (method === 'GET' && parts[0] === 'pending' && parts.length === 1) {
      try {
        const pending = pendingApprovals.list().map(({ token, ...rest }) => rest)
        return json(response, 200, { ok: true, count: pending.length, pending })
      } catch (error) {
        return json(response, 500, { ok: false, error: String(error?.message ?? error) })
      }
    }
    if (method === 'GET' && parts[0] === 'approve' && parts.length === 1) {
      try {
        const id = (url.searchParams.get('id') ?? '').trim()
        const decision = normalizeDecision(url.searchParams.get('decision'))
        const note = (url.searchParams.get('note') ?? '').slice(0, 500)
        if (id === '') return json(response, 400, { ok: false, error: 'id is required' })
        if (decision === null) return json(response, 400, { ok: false, error: 'decision must be allow|deny' })
        const token = url.searchParams.get('token') ?? ''
        const applied = decide(id, decision, note, token)
        if (applied === 'forbidden') {
          log(`approval ${id} rejected: token mismatch`)
          return json(response, 403, { ok: false, error: 'approval token mismatch', id })
        }
        if (applied) {
          log(`approval ${id} ${decision}${note === '' ? '' : ` note=${note.slice(0, 80)}`}`)
          return json(response, 200, { ok: true, id, decision, delivered: true })
        }
        // 没有活 waiter：多半是宿主重载后遗留的条目，丢掉并如实告诉调用方。
        if (pendingApprovals.get(id) !== null) {
          pendingApprovals.remove(id)
          return json(response, 200, { ok: true, id, decision, delivered: false, stale: true, note: 'no live waiter; queue entry dropped' })
        }
        return json(response, 404, { ok: false, error: 'approval not found', id })
      } catch (error) {
        return json(response, 500, { ok: false, error: String(error?.message ?? error) })
      }
    }
    if (method === 'GET' && parts[0] === 'pending' && parts[1] === 'clear' && parts.length === 2) {
      try {
        // mode=stale（默认）只清重载遗留；mode=all 会把活 waiter 一律按 deny 结掉，
        // 避免子进程一直挂着等审批。
        const mode = url.searchParams.get('mode') === 'all' ? 'all' : 'stale'
        // N-03：清理是破坏性动作（mode=all 会真的 deny 掉别人的 waiter），必须持 token。
        const token = url.searchParams.get('token') ?? ''
        const onlyId = (url.searchParams.get('id') ?? '').trim()
        // 两把钥匙：条目自己的活 token（HUD 代理用），或 ~/.dsh/agent-bridge/clear.token（运维清理）。
        // 活 waiter 的 token 只在 approvals Map 里（快照故意不落盘），所以候选集合要合并两边。
        const liveEntries = [...approvals.values()].map(({ timer, ...rest }) => ({ ...rest, kind: rest.kind ?? approvalKind(rest.method) }))
        const liveIds = new Set(liveEntries.map((entry) => entry.id))
        const candidates = [...liveEntries, ...pendingApprovals.list().filter((entry) => !liveIds.has(entry.id))]
        const operator = sameToken(token, clearToken())
        const owned = operator
          ? candidates.filter((entry) => onlyId === '' || entry.id === onlyId)
          : entriesOwnedByToken(candidates, token, onlyId === '' ? undefined : onlyId)
        if (owned.length === 0) {
          log(`pending clear rejected: token missing or not owned (mode=${mode} id=${onlyId === '' ? '-' : onlyId})`)
          return json(response, 403, { ok: false, error: 'approval token required and must match a queued approval or the operator clear token', code: 'approval_token_mismatch' })
        }
        const ownedIds = new Set(owned.map((entry) => entry.id))
        let cleared = 0
        let denied = 0
        for (const entry of candidates) {
          if (!ownedIds.has(entry.id)) continue
          if (mode !== 'all' && entry.stale !== true) continue
          // 活 waiter 会先被 decide() 结掉（它自己会从队列移除），所以两种都要计数。
          // 内部维护路径：不经过 token 校验（它本来就是桥自己的清理动作）。
          const decided = mode === 'all' ? settleApproval(entry.id, 'decline', 'cleared') : false
          if (decided) denied += 1
          if (pendingApprovals.remove(entry.id) || decided) cleared += 1
        }
        if (cleared > 0) log(`pending approvals cleared mode=${mode} cleared=${cleared} denied=${denied} by=${operator ? 'operator-token' : 'entry-token'}`)
        return json(response, 200, { ok: true, mode, cleared, denied })
      } catch (error) {
        return json(response, 500, { ok: false, error: String(error?.message ?? error) })
      }
    }
    if (method === 'GET' && parts[0] === 'resume' && parts.length === 1) {
      try {
        const runId = (url.searchParams.get('runId') ?? '').trim()
        if (runId === '') return json(response, 400, { ok: false, error: 'runId is required' })
        const result = await resumeRun(runId, url)
        log(`resume run=${runId} ok=${result.ok} mode=${result.mode ?? '-'} session=${result.sessionId ?? '-'}`)
        return json(response, result.ok === true ? 200 : 400, result)
      } catch (error) {
        log(`resume failed: ${String(error?.message ?? error)}`)
        return json(response, 500, { ok: false, error: String(error?.message ?? error) })
      }
    }
    return json(response, 404, { ok: false, error: 'not found', path })
  }

  ctx.effect(() => {
    const paths = ['/agent-bridge', '/agent-bridge-b', '/agent-bridge-c']
    let bound = null
    for (const path of paths) {
      let dispose
      try {
        dispose = ctx.webServer.register({
          kind: 'prefix',
          path,
          handler: async (request, response) => {
            try {
              await handler(request, response)
            } catch (error) {
              // 任何路由级异常都要留下结构化响应 + 一条日志（F-03/F-10）。
              const status = Number.isFinite(error?.status) ? error.status : 500
              const payload = { ok: false, error: String(error && error.message ? error.message : error) }
              if (typeof error?.code === 'string') payload.code = error.code
              log(`route error status=${status} ${String(error && error.stack ? error.stack.split('\n')[0] : error)}`)
              try {
                json(response, status, payload)
              } catch {}
            }
          },
        })
      } catch {
        continue
      }
      bound = { path, dispose }
      break
    }
    return () => {
      if (bound) bound.dispose()
      for (const child of claudeChildren.values()) {
        try {
          child.kill()
        } catch {}
      }
      for (const run of store.runs.values()) for (const res of run.clients) try { res.end() } catch {}
      try {
        host.child?.kill()
      } catch {}
    }
  }, 'agent-bridge: http routes')

  ctx.effect(() => () => {
    try {
      host.child?.kill()
    } catch {}
  }, 'agent-bridge: codex child')
}

/**
 * 仅供 `node -e` 单测使用（纯函数 + 队列）。宿主只读取 name / inject / apply，
 * 多余的具名导出不参与插件生命周期。
 */
export const __test = {
  normalizeDecision,
  internalDecision,
  makeApprovalId,
  lastCompletedTurnSeq,
  resumePrompt,
  snapshotPending,
  sanitizePending,
  PendingApprovalStore,
  PENDING_FILE,
}
