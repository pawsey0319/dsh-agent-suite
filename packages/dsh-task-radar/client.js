/**
 * Client half of the task radar bundle — **headless**.
 *
 * The visible radar is the native floating HUD (AppKit), so this half renders
 * nothing and registers no slot. Its only job is to consume the jump mailbox:
 * the HUD writes `~/.dsh/agent-bridge/jump.json` through `/x-radar/jump`, and
 * this half polls `/x-radar/jump-pending` to open that session in the UI, then
 * acknowledges with `/x-radar/jump-ack`.
 *
 * Keep it dependency-free beyond the seeded `react` module: the client bundle
 * is loaded through `window.__ModuleLoader__` and shares the page's runtime.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-task-radar',
  factory(require) {
    const POLL_MS = 1200

    const resolveWorkspace = (ctx) => {
      for (const key of ['uiWorkspace', 'workspace']) {
        try {
          const service = ctx.get(key)
          if (service) return service
        } catch {}
      }
      return null
    }

    const openSession = (ctx, id) => {
      const service = resolveWorkspace(ctx)
      if (!service) return false
      const candidates = [service, service.actions, service.controller]
      for (const candidate of candidates) {
        if (candidate && typeof candidate.openSession === 'function') {
          try {
            candidate.openSession(id)
            return true
          } catch {}
        }
      }
      try {
        if (ctx.layout && typeof ctx.layout.openSession === 'function') {
          ctx.layout.openSession(id)
          return true
        }
      } catch {}
      return false
    }

    /** 一次性打点：确认 client 半真的加载了（窗口内没有可见 UI，只能靠日志确认）。 */
    const beacon = (event) => {
      fetch(`/x-radar/beacon?e=${event}`, { cache: 'no-store' }).catch(() => {})
    }

    const apply = (ctx) => {
      beacon('client.apply')
      let disposed = false
      let busy = false

      const tick = async () => {
        if (disposed || busy) return
        busy = true
        try {
          const response = await fetch('/x-radar/jump-pending', { cache: 'no-store' })
          if (!response.ok) return
          const body = await response.json().catch(() => null)
          const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : ''
          if (!sessionId) return
          const opened = openSession(ctx, sessionId)
          console.log('[task-radar] jump', sessionId, opened ? 'opened' : 'no-workspace')
          if (opened) await fetch('/x-radar/jump-ack', { cache: 'no-store' }).catch(() => {})
        } catch {
          // 宿主重启期间轮询失败是正常的，下一轮再试。
        } finally {
          busy = false
        }
      }

      ctx.effect(() => {
        const timer = setInterval(tick, POLL_MS)
        return () => {
          disposed = true
          clearInterval(timer)
        }
      })
    }

    return { name: 'dsh-task-radar-client', inject: [], apply }
  },
})
