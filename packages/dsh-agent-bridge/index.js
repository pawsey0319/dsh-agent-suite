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
  }

  onNotification(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start() {
    if (this.child && this.ready) return
    const binary = codexBinary()
    if (!binary) throw new Error('codex binary not found (set DSH_AGENT_BRIDGE_CODEX)')
    this.child = spawn(process.execPath, [binary, 'app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: applyUpstream({ ...process.env }, 'codex'),
    })
    this.child.stderr.on('data', (chunk) => {
      this.lastError = chunk.toString().slice(0, 400)
    })
    this.child.on('exit', () => {
      this.ready = false
      this.child = null
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
      store.setStatus(run, turn.status === 'completed' ? 'done' : 'failed', {
        finalAnswer: final?.text ?? null,
        durationMs: turn.durationMs ?? null,
        error: turn.error ?? null,
      })
    }
  })

  const handleServerRequest = (event) => {
    const run = runsByThread.get(event.params?.threadId) ?? null
    const approval = {
      id: String(event.id),
      runId: run?.id ?? null,
      agent: run?.agent ?? 'codex',
      method: event.method,
      params: event.params ?? null,
      at: new Date().toISOString(),
      timer: setTimeout(() => settleApproval(approval.id, 'decline', 'timeout'), APPROVAL_TIMEOUT_MS),
    }
    approvals.set(approval.id, approval)
    pendingApprovals.upsert({
      id: approval.id,
      runId: approval.runId,
      agent: approval.agent,
      method: approval.method,
      params: approval.params,
      at: approval.at,
    })
    if (run) {
      store.append(run, { kind: 'approval.request', notification: event.method, raw: event.params })
      store.setStatus(run, 'needs-approval')
    }
  }

  const settleApproval = (id, decision, reason) => {
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
        // TODO(protocol): Codex app-server 的审批应答枚举无法从已编译二进制里确认，
        // 这里按既有约定回 {decision:'accept'|'decline'}；若上游实际用
        // acceptForSession / cancel，需要在 handleServerRequest 里按 method 分流。
        host.respond(Number(id), { decision })
      } catch {}
    }
    const run = approval.runId ? store.runs.get(approval.runId) : null
    if (run) {
      store.append(run, { kind: 'approval.decision', decision, reason: reason ?? null })
      store.setStatus(run, 'running')
    }
    return true
  }

  /**
   * 外部（HUD / 面板）唯一决策入口：`allow|deny` 在这里换成子进程协议词。
   * 返回 false 表示没有活 waiter（调用方可回 404 或按 stale 条目处理）。
   */
  const decide = (id, decision, note) => settleApproval(String(id), internalDecision(decision), note)

  const startRun = async (body) => {
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) throw new Error('prompt is required')
    const agent = body.agent === 'claude' ? 'claude' : 'codex'
    const fallbackCwd = process.env.DSH_AGENT_BRIDGE_CWD ?? process.env.DSH_WORKSPACE ?? process.cwd()
    const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : fallbackCwd
    // 发起 run 的 DSH 会话 id（可选）；/resume 会优先 fork 它回到最后一个 completed-turn。
    const dshSessionId = typeof body.sessionId === 'string' ? body.sessionId : typeof body.dshSessionId === 'string' ? body.dshSessionId : null
    if (agent === 'claude') {
      const run = store.create({ agent: 'claude', prompt, cwd, model: body.model ?? null, dshSessionId })
      store.append(run, { kind: 'run.created', prompt })
      const child = spawnClaude(run, { prompt, cwd, model: body.model ?? null, port: ctx.webServer.port })
      store.setStatus(run, 'running')
      return { runId: run.id, agent: 'claude', pid: child.pid ?? null, model: run.model, cwd }
    }
    await host.start()
    const run = store.create({ agent: 'codex', prompt, cwd, model: body.model ?? null, dshSessionId })
    store.append(run, { kind: 'run.created', prompt })
    const thread = await host.request('thread/start', { cwd, ...(body.model ? { model: body.model } : {}) })
    run.threadId = thread.thread.id
    run.model = thread.model ?? run.model
    runsByThread.set(run.threadId, run)
    store.persist(run)
    const turn = await host.request('turn/start', {
      threadId: run.threadId,
      input: [{ type: 'text', text: prompt }],
    })
    run.turnId = turn.turn?.id ?? null
    store.setStatus(run, 'running')
    return { runId: run.id, threadId: run.threadId, turnId: run.turnId, model: run.model, cwd }
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
      store.setStatus(run, 'failed', { error: String(error && error.message) })
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
      return json(response, 200, {
        ok: true,
        codex: { running: Boolean(host.ready), userAgent: host.userAgent ?? null, codexHome: host.codexHome ?? null, lastError: host.lastError },
        claude: { binary: claudeBinary() ?? null, running: claudeChildren.size },
        runs: store.runs.size,
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
        return json(response, 200, await startRun(await readBody(request)))
      } catch (error) {
        return json(response, 500, { error: String(error && error.message) })
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
          params: { tool: toolName, input: body.tool_input ?? null, sessionId: body.session_id ?? null },
          at: new Date().toISOString(),
          resolve,
          timer: setTimeout(() => settleApproval(id, 'decline', 'timeout'), 25000),
        }
        approvals.set(id, approval)
        pendingApprovals.upsert({
          id,
          runId: approval.runId,
          agent: approval.agent,
          method: approval.method,
          params: approval.params,
          at: approval.at,
        })
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
      const pending = wbPending()
      if (pending && !pending.cleared) {
        return json(response, 200, {
          approvals: [
            { id: 'workbuddy', agent: 'workbuddy', method: 'workbuddy/confirm', title: pending.card || 'WorkBuddy 等你确认', createdAt: pending.at },
            ...pendingApprovals.list(),
          ],
        })
      }
      return json(response, 200, {
        approvals: [...approvals.values()].map(({ timer, ...rest }) => rest),
      })
    }
    if (method === 'POST' && parts[0] === 'approvals' && parts.length === 2 && parts[1] === 'workbuddy') {
      await new Promise((resolve) => {
        execFile('/usr/bin/open', ['-a', 'WorkBuddy'], () => resolve())
      })
      wbClearPending()
      log('approval workbuddy -> activate')
      return json(response, 200, { ok: true, decision: 'activate', agent: 'workbuddy' })
    }
    if (method === 'POST' && parts[0] === 'approvals' && parts.length === 2) {
      const body = await readBody(request)
      const decision = normalizeDecision(body.decision)
      if (decision === null) return json(response, 400, { ok: false, error: 'decision must be allow|deny' })
      const ok = decide(parts[1], decision, typeof body.note === 'string' ? body.note.slice(0, 500) : null)
      return json(response, ok ? 200 : 404, { ok, decision })
    }
    // ── P2 审批聚合：HUD / 面板用 GET + query（prefix 资源只服务 GET/HEAD） ──
    if (method === 'GET' && parts[0] === 'pending' && parts.length === 1) {
      try {
        const pending = pendingApprovals.list()
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
        if (decide(id, decision, note)) {
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
        let cleared = 0
        let denied = 0
        for (const entry of pendingApprovals.list()) {
          if (mode !== 'all' && entry.stale !== true) continue
          // 活 waiter 会先被 decide() 结掉（它自己会从队列移除），所以两种都要计数。
          const decided = mode === 'all' ? decide(entry.id, 'deny', 'cleared') : false
          if (decided) denied += 1
          if (pendingApprovals.remove(entry.id) || decided) cleared += 1
        }
        if (cleared > 0) log(`pending approvals cleared mode=${mode} cleared=${cleared} denied=${denied}`)
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
    return json(response, 404, { error: 'not found', path })
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
              try {
                json(response, 500, { error: String(error && error.message) })
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
