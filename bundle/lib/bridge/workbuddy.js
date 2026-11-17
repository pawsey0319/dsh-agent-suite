// WorkBuddy(腾讯办公 Agent) 桌面端驱动：DSH 负责启动 + CDP 输入/读取。
// 关键事实：WorkBuddy 有单实例锁，正常启动不开调试端口；必须 quit 后用
// `open -na ... --args --remote-debugging-port=<p>` 并在子进程环境去掉 ELECTRON_RUN_AS_NODE。
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const WORKBUDDY_APP = '/Applications/WorkBuddy.app'
const AUDIT_FILE = join(homedir(), '.dsh', 'agent-bridge', 'workbuddy-confirms.json')
const PENDING_FILE = join(homedir(), '.dsh', 'agent-bridge', 'workbuddy-pending.json')

export function markPending(info) {
  try {
    mkdirSync(dirname(PENDING_FILE), { recursive: true })
    appendFileSync(PENDING_FILE, `${JSON.stringify({ at: new Date().toISOString(), ...info })}\n`)
  } catch {}
}

export function pendingInfo() {
  try {
    if (!existsSync(PENDING_FILE)) return null
    const lines = readFileSync(PENDING_FILE, 'utf8').split('\n').filter(Boolean)
    if (!lines.length) return null
    return JSON.parse(lines[lines.length - 1])
  } catch {
    return null
  }
}

export function clearPending() {
  try {
    mkdirSync(dirname(PENDING_FILE), { recursive: true })
    appendFileSync(PENDING_FILE, `${JSON.stringify({ at: new Date().toISOString(), cleared: true })}\n`)
  } catch {}
}

function audit(entry) {
  try {
    mkdirSync(dirname(AUDIT_FILE), { recursive: true })
    appendFileSync(AUDIT_FILE, `${JSON.stringify(entry)}\n`)
  } catch {}
}

export function confirmAudit(limit = 200) {
  try {
    if (!existsSync(AUDIT_FILE)) return { count: 0, today: 0, items: [] }
    const items = readFileSync(AUDIT_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
    const todayKey = new Date().toISOString().slice(0, 10)
    return {
      count: items.length,
      today: items.filter((item) => String(item.at || '').startsWith(todayKey)).length,
      items: items.slice(-limit),
    }
  } catch {
    return { count: 0, today: 0, items: [] }
  }
}
export const PROBE = 'http://127.0.0.1:18488/workbuddy/probe'
const DEFAULT_CDP = 9333

async function httpGet(url, timeoutMs = 1500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    return { status: response.status, text: await response.text() }
  } catch (error) {
    return { status: 0, text: String(error && error.message ? error.message : error) }
  } finally {
    clearTimeout(timer)
  }
}

export async function probe() {
  const result = await httpGet(PROBE, 1200)
  if (result.status !== 200) return { running: false, raw: result.text }
  try {
    return { running: true, ...JSON.parse(result.text) }
  } catch {
    return { running: true, raw: result.text }
  }
}

async function pages(port) {
  const result = await httpGet(`http://127.0.0.1:${port}/json/list`, 1200)
  if (result.status !== 200) return []
  try {
    const list = JSON.parse(result.text)
    return list.filter((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
  } catch {
    return []
  }
}

export async function state(port = DEFAULT_CDP) {
  const info = await probe()
  const list = await pages(port)
  return {
    installed: true,
    running: info.running,
    version: info.version ?? null,
    platform: info.platform ?? null,
    cdpPort: port,
    cdpReady: list.length > 0,
    targets: list.map((page) => ({ title: page.title, url: page.url })),
    // 单实例锁：已经在跑但没开调试端口时，只能重启才能接入。
    needsRelaunch: info.running && list.length === 0,
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function launch(port = DEFAULT_CDP, timeoutMs = 25000) {
  const before = await state(port)
  if (before.cdpReady) return { ok: true, relaunched: false, ...before }

  if (before.running) {
    await run('osascript', ['-e', 'tell application "WorkBuddy" to quit']).catch(() => {})
    for (let i = 0; i < 40; i += 1) {
      await sleep(250)
      if (!(await probe()).running) break
    }
    await run('pkill', ['-f', `${WORKBUDDY_APP}/Contents/MacOS/Electron`]).catch(() => {})
    await sleep(500)
  }

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = execFile('open', ['-na', WORKBUDDY_APP, '--args', `--remote-debugging-port=${port}`], { env }, () => {})
  child.unref?.()

  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const list = await pages(port)
    if (list.length > 0) return { ok: true, relaunched: before.running, waitedMs: Date.now() - started, ...(await state(port)) }
    await sleep(400)
  }
  return { ok: false, error: 'cdp_timeout', waitedMs: Date.now() - started, ...(await state(port)) }
}

async function withSocket(port, fn) {
  const list = await pages(port)
  if (!list.length) throw new Error('cdp_not_ready')
  const target = list[0]
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : '')
    } catch {
      return
    }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message || 'cdp_error'))
      else resolve(message.result)
    }
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cdp_open_timeout')), 5000)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('cdp_open_error'))
    })
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = (nextId += 1)
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`cdp_timeout:${method}`))
        }
      }, 15000)
    })
  try {
    await send('Runtime.enable')
    return await fn({ send, target })
  } finally {
    try {
      socket.close()
    } catch {}
  }
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'eval_failed')
  return result.result?.value
}

const READ_LAST = `(() => {
  // 回复正文在 markdown 块里；「模型名 + 时间」的元信息行要排除。
  const META = /^[A-Za-z0-9._\\-]+\\n\\d{1,2}:\\d{2}$/;
  const blocks = Array.from(document.querySelectorAll('[class*="markdown"]'))
    .map((node) => (node.innerText || '').trim())
    .filter((text) => text.length > 0 && !META.test(text));
  const body = blocks.length ? blocks[blocks.length - 1] : null;
  return { ok: true, count: blocks.length, all: blocks.slice(-3), last: body, title: document.title };
})()`

export async function readLast(port = DEFAULT_CDP) {
  return withSocket(port, async ({ send }) => {
    return evaluate(send, READ_LAST)
  })
}

const CONFIRM_SCRIPT = `(() => {
  // WorkBuddy 等确认时挂 cb-agent-card；点开卡片后可能还有一个「确认/允许」按钮。
  const card = Array.from(document.querySelectorAll('[class*="cb-agent-card"]')).find((n) => /回复确认消息|确认/.test(n.innerText || ''));
  if (!card) return { ok: false, reason: 'no_card' };
  const label = (card.innerText || '').trim().slice(0, 120);
  card.click();
  return { ok: true, clicked: 'card', label };
})()`

const CONFIRM_DIALOG = `(() => {
  const target = Array.from(document.querySelectorAll('button,[role="button"]')).find((b) => /^(确认|确定|同意|允许|继续|是)$/.test((b.innerText || '').trim()));
  if (!target) return { ok: false, reason: 'no_dialog' };
  const label = (target.innerText || '').trim();
  target.click();
  return { ok: true, clicked: 'dialog', label };
})()`

export async function autoConfirm(port = DEFAULT_CDP) {
  return withSocket(port, async ({ send: cdp }) => {
    const first = await evaluate(cdp, CONFIRM_SCRIPT)
    if (!first || first.ok !== true) return { ok: false, ...(first || {}) }
    await sleep(700)
    const second = await evaluate(cdp, CONFIRM_DIALOG)
    const entry = {
      at: new Date().toISOString(),
      card: String(first.label || '').slice(0, 120),
      dialog: second && second.ok ? String(second.label || '') : null,
      mode: 'auto',
    }
    audit(entry)
    return { ok: true, ...entry }
  })
}

const EDITOR_SELECTOR = '[data-testid="conversation-input"] [contenteditable="true"], [contenteditable="true"], [class*="editable"][contenteditable="true"]'

const INPUT_STATE = `(() => {
  const box = document.querySelector('[data-testid="conversation-input"] [contenteditable="true"]') || Array.from(document.querySelectorAll('[contenteditable="true"]')).find((n) => { const r = n.getBoundingClientRect(); return r.height > 0 && r.width > 0 }) || null;
  const card = Array.from(document.querySelectorAll('[class*="cb-agent-card"]')).map((n) => (n.innerText || '').trim()).filter(Boolean)[0] || null;
  const busy = /准备中|生成中|思考中|执行中/.test(document.body.innerText || '');
  return {
    box: !!box,
    text: box ? (box.innerText || '').trim() : '',
    busy,
    footer: !!document.querySelector('[data-testid="conversation-finished-footer"]'),
    pendingCard: card,
  };
})()`

async function settle(send_, ms = 900) {
  await sleep(ms)
  return evaluate(send_, INPUT_STATE)
}

export async function send(text, port = DEFAULT_CDP, options = {}) {
  return withSocket(port, async ({ send: cdp }) => {
    // 0) 显式新建任务：会话页输入区在 5.11.3 可能被折叠成空 div，
    //    home composer 才是可靠的可写编辑器，先点「新建任务」回到 home。
    if (options.newTask === true) {
      const opened = await evaluate(
        cdp,
        `(() => {
          const candidates = Array.from(document.querySelectorAll('button,[role="button"]')).filter((b) => /新建任务/.test((b.innerText || '').trim()));
          const btn = candidates.find((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 });
          if (!btn) return { ok: false, why: 'no-new-task-button' };
          btn.click();
          return { ok: true, label: (btn.innerText || '').trim().slice(0, 20) };
        })()`,
      )
      await sleep(900)
      if (!opened || opened.ok !== true) return { ok: false, needsUser: true, reason: 'new_task_unavailable', detail: opened ?? null }
    }
    // 1) 等空闲：上一轮还在生成，或需要先回答一张确认卡时，不要盲目发。
    let state = await settle(cdp, 300)
    for (let i = 0; i < 30 && state && state.busy; i += 1) state = await settle(cdp, 700)
    let autoConfirmed = null
    if (state && state.pendingCard) {
      // 用户 2026-11-16 决定：这类「回复确认消息」卡片自动点确认，并写审计（可在胶囊里看次数）。
      const confirmed = await evaluate(cdp, CONFIRM_SCRIPT)
      if (confirmed && confirmed.ok) {
        await sleep(700)
        const dialog = await evaluate(cdp, CONFIRM_DIALOG)
        autoConfirmed = {
          at: new Date().toISOString(),
          card: String(confirmed.label || '').slice(0, 120),
          dialog: dialog && dialog.ok ? String(dialog.label || '') : null,
          mode: 'auto',
        }
        audit(autoConfirmed)
        await sleep(900)
      } else {
        markPending({ card: state.pendingCard.slice(0, 160), reason: 'pending_confirmation' })
        return { ok: false, needsUser: true, reason: 'pending_confirmation', card: state.pendingCard.slice(0, 160) }
      }
    }

    const probe = `(() => {
        const box = document.querySelector('[data-testid="conversation-input"] [contenteditable="true"]') || Array.from(document.querySelectorAll('[contenteditable="true"]')).find((n) => { const r = n.getBoundingClientRect(); return r.height > 0 && r.width > 0 }) || null;
        if (!box) return { ok: false, why: 'missing' };
        const rect = box.getBoundingClientRect();
        if (rect.height <= 40 || rect.width <= 200) return { ok: true, ready: false, why: 'too-small', h: Math.round(rect.height), w: Math.round(rect.width), tag: box.tagName };
        return { ok: true, ready: true, editable: box.isContentEditable === true, tag: box.tagName, h: Math.round(rect.height) };
      })()`
    let focused = await evaluate(cdp, probe)
    if (focused && focused.ok === true && focused.ready !== true) {
      // 输入区被折叠（停在「任务完成」页或渲染异常）：先点一下输入区附近把它唤起来。
      const area = await evaluate(
        cdp,
        `(() => {
          const node = document.querySelector('[data-testid="conversation-input-area"]') || document.querySelector('[data-testid="conversation-input"]');
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        })()`,
      )
      if (area) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await cdp('Input.dispatchMouseEvent', { type, x: area.x, y: area.y, button: 'left', clickCount: 1 })
        }
        await settle(cdp, 500)
      }
      focused = await evaluate(cdp, probe)
    }
    if (!focused || focused.ok !== true || focused.ready !== true) {
      markPending({ card: '输入框不可写', reason: 'insert_failed' })
      return { ok: false, needsUser: true, reason: 'input_unavailable', detail: focused ?? null }
    }
    const focusBox = await evaluate(
      cdp,
      `(() => {
        const box = document.querySelector('[data-testid="conversation-input"] [contenteditable="true"]') || Array.from(document.querySelectorAll('[contenteditable="true"]')).find((n) => { const r = n.getBoundingClientRect(); return r.height > 40 && r.width > 200 }) || null;
        if (!box) return null;
        box.focus();
        const r = box.getBoundingClientRect();
        return { x: Math.round(r.x + Math.min(80, r.width / 2)), y: Math.round(r.y + r.height / 2), text: (box.innerText || '').trim().slice(0, 40) };
      })()`,
    )
    if (!focusBox) return { ok: false, needsUser: true, reason: 'input_unavailable', detail: 'no-editor' }
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp('Input.dispatchMouseEvent', { type, x: focusBox.x, y: focusBox.y, button: 'left', clickCount: 1 })
    }
    await settle(cdp, 200)
    // Slate/ProseMirror 编辑器不能直接改 textContent：用全选+退格清空，否则内部文档状态与 DOM 不一致。
    for (const type of ['keyDown', 'keyUp']) {
      await cdp('Input.dispatchKeyEvent', { type, key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 })
    }
    for (const type of ['keyDown', 'keyUp']) {
      await cdp('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
    }
    await settle(cdp, 250)
    await cdp('Input.insertText', { text })
    state = await settle(cdp, 400)
    if (!state || !state.text) {
      // 自动确认后输入区可能被重建：先按坐标点一下再插一次。
      const box = await evaluate(
        cdp,
        `(() => {
          const node = document.querySelector('[data-testid="conversation-input"] [contenteditable="true"]') || Array.from(document.querySelectorAll('[contenteditable="true"]')).find((n) => { const r = n.getBoundingClientRect(); return r.height > 0 }) || document.querySelector('[data-testid="conversation-input"]');
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          return { x: Math.round(rect.x + Math.min(60, rect.width / 2)), y: Math.round(rect.y + rect.height / 2) };
        })()`,
      )
      if (box) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await cdp('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 })
        }
        await settle(cdp, 300)
        await cdp('Input.insertText', { text })
        state = await settle(cdp, 400)
      }
      if (!state || !state.text) {
        markPending({ card: state && state.pendingCard ? String(state.pendingCard).slice(0, 160) : '输入框不可写入', reason: 'insert_failed' })
        return { ok: false, needsUser: true, reason: 'insert_failed', autoConfirmed }
      }
    }

    const attempts = []
    const submitted = async () => {
      const after = await settle(cdp, 1200)
      if (after && after.text === '') return true
      if (after && after.busy) return true
      return false
    }

    // 2) 依次尝试 Enter / Cmd+Enter / 找发送按钮，任何一种把输入框清空即算提交成功。
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 })
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    attempts.push({ via: 'enter', ok: await submitted() })

    if (!attempts[0].ok) {
      for (const type of ['keyDown', 'keyUp']) {
        await cdp('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', text: '\r', modifiers: 4, windowsVirtualKeyCode: 13 })
      }
      attempts.push({ via: 'cmd+enter', ok: await submitted() })
    }

    if (!attempts.some((a) => a.ok)) {
      const clicked = await evaluate(
        cdp,
        `(() => {
          const btn = Array.from(document.querySelectorAll('button,[role="button"]')).find((b) => /发送|提交|Send/i.test((b.getAttribute('aria-label') || '') + (b.innerText || '') + (b.className || '')));
          if (!btn) return { ok: false };
          btn.click();
          return { ok: true };
        })()`,
      )
      attempts.push({ via: 'button', ok: clicked && clicked.ok ? await submitted() : false })
    }

    const best = attempts.find((a) => a.ok) || null
    return { ok: Boolean(best), via: best ? best.via : null, attempts, autoConfirmed, sent: text.slice(0, 120), tag: focused.tag }
  })
}
