/**
 * dsh-agent-suite —— 四件套整合包（radar / bridge / judge / office）。
 *
 * 旧实现（0.8.0）的 try/catch 是死代码：`ctx.plugin(mod)` 同步返回的是
 * cordis 的 fiber，成员 apply 里的异常被 fiber 吞掉，于是「mounted judge」
 * 照打，路由却一条都没挂上，也没有任何地方能看出谁失败了（F-03）。
 *
 * 现在每个成员都包一层：apply 里 await 真成员的 apply，成功/失败都写进
 * 共享的挂载状态，失败成员的 label 会进日志（console + 宿主日志）并通过
 * GET /agent-suite/health 暴露出来。每个成员仍是独立 fiber，一个成员挂掉
 * 不会影响其余成员。
 */
import * as bridge from './lib/bridge/index.js'
import * as judge from './lib/judge/index.js'
import * as office from './lib/office/index.js'
import * as radar from './lib/radar/index.js'

export const name = 'dsh-agent-suite'
export const inject = ['webServer']

export const PREFIXES = ['/agent-suite', '/agent-suite-b', '/agent-suite-c']

const MEMBERS = [
  ['bridge', bridge],
  ['judge', judge],
  ['office', office],
  ['radar', radar],
]

/** 挂载状态：health 路由和日志都读这一份。 */
function createStatus() {
  const status = {
    startedAt: new Date().toISOString(),
    members: new Map(),
    lastError: null,
  }
  status.mark = (label, state, extra = {}) => {
    const previous = status.members.get(label) ?? {}
    status.members.set(label, { label, ...previous, state, ...extra, at: new Date().toISOString() })
    if (state === 'failed') status.lastError = `${label}: ${extra.error ?? 'unknown error'}`
  }
  status.snapshot = () => ({
    ok: [...status.members.values()].every((member) => member.state === 'mounted'),
    startedAt: status.startedAt,
    lastError: status.lastError,
    members: [...status.members.values()],
  })
  return status
}

/**
 * 把成员包成一个可观测的插件：先标 mounting，apply 抛错就标 failed 并
 * 记下名字/消息，然后再抛给 cordis（让这条 fiber 在宿主里也是红的）。
 */
function observe(label, mod, status) {
  return {
    name: `${mod.name ?? `dsh-agent-suite-${label}`}`,
    inject: mod.inject ?? [],
    apply: async (ctx) => {
      status.mark(label, 'mounting')
      try {
        const result = await mod.apply(ctx)
        status.mark(label, 'mounted')
        console.log(`[agent-suite] mounted ${label}`)
        return result
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        status.mark(label, 'failed', { error: message })
        console.error(`[agent-suite] mount failed: ${label}: ${message}`)
        throw error
      }
    },
  }
}

export function apply(ctx) {
  const status = createStatus()
  // 供同进程的其他代码（以及测试）查询挂载状态。
  globalThis.__dshAgentSuiteStatus = status

  for (const [label, mod] of MEMBERS) {
    try {
      ctx.plugin(observe(label, mod, status))
    } catch (error) {
      // ctx.plugin 本身失败（配置/注册阶段）也不能静默。
      const message = String(error && error.message ? error.message : error)
      status.mark(label, 'failed', { error: message })
      console.error(`[agent-suite] mount failed: ${label}: ${message}`)
    }
  }

  ctx.effect(() => {
    const handler = async (request, response) => {
      try {
        const snapshot = status.snapshot()
        const body = JSON.stringify(snapshot)
        response.writeHead(snapshot.ok ? 200 : 503, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        response.end(body)
      } catch (error) {
        try {
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ ok: false, error: String(error && error.message ? error.message : error) }))
        } catch {}
      }
    }
    for (const path of PREFIXES) {
      let dispose
      try {
        dispose = ctx.webServer.register({ kind: 'prefix', path, handler })
      } catch {
        continue
      }
      if (dispose) {
        console.log(`[agent-suite] health at ${path}`)
        return () => dispose()
      }
    }
    console.error('[agent-suite] could not register health route')
    return () => {}
  })
}
