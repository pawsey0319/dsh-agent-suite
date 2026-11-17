/**
 * dsh-office-artifacts —— 办公产物清单
 *
 * 只做一件事：把工作区里「最近生成」的办公文档找出来，给 HUD 与对话一个可引用的清单。
 * 不预览、不转码、不打开（预览交给系统 Quick Look，`GET /office-artifacts/open?path=`）。
 */
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const NAME = 'dsh-office-artifacts'
export const name = NAME
export const inject = ['webServer', 'sessionQuery', 'sessionController']

const BRIDGE_DIR = join(homedir(), '.dsh', 'agent-bridge')
const LIST_FILE = join(BRIDGE_DIR, 'artifacts.json')
const LOG_FILE = join(BRIDGE_DIR, 'artifacts.log')
const STATE_FILE = join(BRIDGE_DIR, 'artifacts-state.json')

const OFFICE_EXT = new Set(['.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.pdf', '.csv', '.pages', '.numbers', '.key'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'build', 'out', '.next', 'Library', '.Trash', '.npm', '.pnpm-store'])
const MAX_FILES = 400
const MAX_DEPTH = 4

function log(message) {
  try {
    mkdirSync(BRIDGE_DIR, { recursive: true })
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${message}\n`)
  } catch {}
}

function kindOf(ext) {
  if (ext === '.docx' || ext === '.doc' || ext === '.pages') return 'doc'
  if (ext === '.xlsx' || ext === '.xls' || ext === '.csv' || ext === '.numbers') return 'sheet'
  if (ext === '.pptx' || ext === '.ppt' || ext === '.key') return 'slide'
  if (ext === '.pdf') return 'pdf'
  return 'other'
}

async function walk(root, depth, out) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      await walk(full, depth + 1, out)
      continue
    }
    if (!entry.isFile()) continue
    if (entry.name.startsWith('~$')) continue // Office 锁文件
    const ext = extname(entry.name).toLowerCase()
    if (!OFFICE_EXT.has(ext)) continue
    try {
      const info = statSync(full)
      out.push({
        path: full,
        name: entry.name,
        ext,
        kind: kindOf(ext),
        size: info.size,
        mtime: info.mtimeMs,
      })
    } catch {}
  }
}

function workspaceOf(url) {
  const raw = url.searchParams.get('cwd')
  const fallback = process.env.DSH_WORKSPACE || process.cwd()
  return resolve(raw && raw.startsWith('/') ? raw : fallback)
}

async function recentCwd() {
  try {
    const sessions = await ctxRef.get('sessionQuery').listSessions()
    const rows = (Array.isArray(sessions) ? sessions : [])
      .map((item) => item?.header ?? item)
      .filter((header) => typeof header?.cwd === 'string' && header.cwd !== '' && header.origin !== 'subagent')
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    return rows[0]?.cwd ?? null
  } catch {
    return null
  }
}

function recentFirst(a, b) {
  return b.mtime - a.mtime
}

function readState() {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return { accepted: Array.isArray(raw.accepted) ? raw.accepted : [], rejected: Array.isArray(raw.rejected) ? raw.rejected : [] }
  } catch {
    return { accepted: [], rejected: [] }
  }
}

function writeState(next) {
  try {
    mkdirSync(BRIDGE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`)
  } catch {}
}

function readSaved() {
  try {
    return JSON.parse(readFileSync(LIST_FILE, 'utf8'))
  } catch {
    return null
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`${JSON.stringify(body)}\n`)
}

let ctxRef = null
const beacons = []

export function apply(ctx) {
  ctxRef = ctx
  ctx.effect(() => {
    const disposers = []
    const prefixes = ['/office-artifacts', '/office-artifacts-b', '/office-artifacts-c']
    for (const prefix of prefixes) {
      disposers.push(ctx.webServer.register({
        kind: 'prefix',
        path: prefix,
        handler: async (request, response) => {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1')
          const tail = url.pathname.replace(/^\/office-artifacts(-[a-z])?\/?/, '')
          try {
            if (tail === 'beacon') {
              beacons.push({ e: url.searchParams.get('e') ?? '', at: Date.now() })
              while (beacons.length > 100) beacons.shift()
              return json(response, 200, { ok: true })
            }
            if (tail === 'health') {
              return json(response, 200, { ok: true, name: NAME, saved: Boolean(readSaved()) })
            }
            if (tail === 'list') {
              let cwd = workspaceOf(url)
              if (!url.searchParams.get('cwd')) {
                const detected = await recentCwd()
                if (detected !== null) cwd = detected
              }
              const sinceHours = Number(url.searchParams.get('hours') ?? 72)
              const files = []
              await walk(cwd, 0, files)
              const since = Date.now() - Math.max(1, sinceHours) * 3600 * 1000
              const items = files
                .filter((file) => file.mtime >= since)
                .sort(recentFirst)
                .slice(0, 60)
                .map((file) => ({
                  ...file,
                  relative: file.path.slice(cwd.length + 1),
                  updatedAt: Math.round(file.mtime),
                }))
              const payload = { ok: true, cwd, sinceHours, count: items.length, items, generatedAt: Date.now() }
              try {
                mkdirSync(BRIDGE_DIR, { recursive: true })
                writeFileSync(LIST_FILE, `${JSON.stringify(payload, null, 2)}\n`)
              } catch {}
              log(`list cwd=${cwd} hours=${sinceHours} count=${items.length}`)
              return json(response, 200, payload)
            }
            if (tail === 'saved') {
              const saved = readSaved()
              return json(response, saved ? 200 : 404, saved ?? { ok: false, error: 'no saved list yet' })
            }
            if (tail === 'state') {
              const state = readState()
              return json(response, 200, { ok: true, ...state, beacons, saved: readSaved() })
            }
            if (tail === 'review') {
              const target = url.searchParams.get('path') ?? ''
              const action = url.searchParams.get('action') ?? ''
              const feedback = (url.searchParams.get('feedback') ?? '').slice(0, 600)
              if (!target || !existsSync(target)) return json(response, 404, { ok: false, error: 'file not found' })
              if (action !== 'accept' && action !== 'reject') return json(response, 400, { ok: false, error: 'action must be accept|reject' })
              const state = readState()
              if (action === 'accept') {
                if (!state.accepted.includes(target)) state.accepted.push(target)
                state.rejected = state.rejected.filter((item) => item.path !== target)
                writeState(state)
                return json(response, 200, { ok: true, action, path: target })
              }
              state.rejected = [...state.rejected.filter((item) => item.path !== target), { path: target, feedback, at: new Date().toISOString() }]
              state.accepted = state.accepted.filter((item) => item !== target)
              writeState(state)
              let sent = null
              if (url.searchParams.get('send') === '1' && feedback !== '') {
                const cwd = url.searchParams.get('cwd') ?? ''
                try {
                  const sessions = await ctx.get('sessionQuery').listSessions()
                  const rows = (Array.isArray(sessions) ? sessions : [])
                    .map((item) => item?.header ?? item)
                    .filter((header) => header?.id && header?.origin !== 'subagent')
                    .filter((header) => cwd === '' || header.cwd === cwd)
                    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
                  const targetSession = rows[0]
                  if (targetSession !== undefined) {
                    const controller = ctx.get('sessionController')
                    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(30000) : new AbortController().signal
                    const text = `产物被退回了：${target}\n\n修改意见：${feedback}\n\n请按这个意见改，改完告诉我。`
                    await controller.prompt({ requestId: (globalThis.crypto?.randomUUID?.() ?? String(Date.now())), sessionId: targetSession.id, mode: 'queue', content: [{ type: 'text', text }] }, signal)
                    sent = targetSession.id
                  }
                } catch (error) {
                  log(`sendback failed ${error?.message ?? error}`)
                }
              }
              return json(response, 200, { ok: true, action, path: target, sent })
            }
            if (tail === 'open') {
              const target = url.searchParams.get('path') ?? ''
              if (!target || !existsSync(target)) return json(response, 404, { ok: false, error: 'file not found' })
              execFile('/usr/bin/open', ['-R', target], () => {})
              log(`open -R ${target}`)
              return json(response, 200, { ok: true })
            }
            return json(response, 404, { ok: false, error: `unknown route ${tail}` })
          } catch (error) {
            log(`error ${error?.message ?? error}`)
            return json(response, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      }))
    }
    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch {}
      }
    }
  })
}
