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

    /** 打点：确认 client 半真的加载了（窗口内没有可见 UI，只能靠日志确认）。 */
    // 构建指纹：sync 脚本会把占位符替换成 client.js 的 sha16，宿主据此判断「页面加载的是不是
    // 当前 bundle」；同时占位符存在与否决定 sync 是否走「改写 id + 指纹」分支（见 scripts/sync-suite-bundle.sh）。
    const CLIENT_BUILD = '__RADAR_CLIENT_BUILD__'
    const postBeacon = async (event) => {
      try {
        const response = await fetch(`/x-radar/beacon?e=${event}&b=${encodeURIComponent(CLIENT_BUILD)}`, { cache: 'no-store' })
        return response.ok
      } catch {
        return false
      }
    }
    // 尽力而为：失败也重试，但不阻塞调用方
    const beacon = (event) => {
      postBeacon(event).then((ok) => {
        if (!ok) retryBeacon(event)
      })
    }
    const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000]
    const retryBeacon = (event) => {
      let index = 0
      const attempt = () => {
        const delay = RETRY_DELAYS[Math.min(index, RETRY_DELAYS.length - 1)]
        index += 1
        setTimeout(async () => {
          if (await postBeacon(event)) return
          attempt()
        }, delay)
      }
      attempt()
    }
    /**
     * 心跳：页面若在宿主就绪前加载，apply 时那一次打点会落空且再无补打（R-03/U-04）。
     * 这里每 20s 补一次 client.alive，宿主据此把 clientHalf.active 判活。
     */
    const HEARTBEAT_MS = 20000
    const startHeartbeat = (isDisposed) => {
      let timer = null
      const beat = async () => {
        if (isDisposed()) return
        const ok = await postBeacon('client.alive')
        if (!ok && timer !== null) {
          // 失败就退化成密集重试，直到成功一次再回到 20s 节奏
          setTimeout(beat, 3000)
        }
      }
      const loop = () => {
        if (isDisposed()) return
        beat()
        timer = setTimeout(loop, HEARTBEAT_MS)
      }
      loop()
      return () => clearTimeout(timer)
    }

    const apply = (ctx) => {
      let disposed = false
      const isDisposed = () => disposed
      beacon('client.apply')
      const stopHeartbeat = startHeartbeat(isDisposed)
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
          stopHeartbeat()
        }
      })
    }

    return { name: 'dsh-task-radar-client', inject: [], apply }
  },
})
