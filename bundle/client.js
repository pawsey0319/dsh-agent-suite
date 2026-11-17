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
  id: '@pawsey0319/dsh-agent-suite',
  factory(require) {
    const POLL_MS = 1200

    const resolveWorkspace = (ctx) => {
      const services = []
      // 不同版本的 DSH 把「打开会话」放在不同服务上：按可用性依次尝试，
      // 不再只认 uiWorkspace 一个（否则 HUD 点了行会静默 no-workspace）。
      for (const key of ['uiWorkspace', 'workspace', 'sessionActions', 'uiSession']) {
        try {
          const service = ctx.get(key)
          if (service) services.push(service)
        } catch {}
      }
      try {
        if (ctx.layout) services.push(ctx.layout)
      } catch {}
      return services
    }

    const openSession = (ctx, id) => {
      const services = resolveWorkspace(ctx)
      if (!services.length) return false
      for (const service of services) {
        const candidates = [service, service.actions, service.controller, service.sessions]
        for (const candidate of candidates) {
          if (!candidate) continue
          for (const name of ['openSession', 'selectSession', 'open']) {
            if (typeof candidate[name] !== 'function') continue
            try {
              candidate[name](id)
              return true
            } catch {}
          }
        }
      }
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
      const attempts = new Map()

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
          const tries = (attempts.get(sessionId) ?? 0) + 1
          attempts.set(sessionId, tries)
          console.log('[task-radar] jump', sessionId, opened ? 'opened' : `no-workspace(${tries})`)
          if (opened) {
            beacon(`client.jump.ok&d=${encodeURIComponent(sessionId)}`)
            attempts.delete(sessionId)
            await fetch('/x-radar/jump-ack', { cache: 'no-store' }).catch(() => {})
          } else if (tries >= 5) {
            // 5 次都打不开：把失败说清楚（谁在等信息、为什么），然后 ack 掉，
            // 免得一条坏 session id 让信封永远重试。
            beacon(`client.jump.failed&d=${encodeURIComponent(sessionId)}`)
            attempts.delete(sessionId)
            await fetch('/x-radar/jump-ack', { cache: 'no-store' }).catch(() => {})
          }
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
