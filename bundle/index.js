import * as bridge from './lib/bridge/index.js'
import * as judge from './lib/judge/index.js'
import * as office from './lib/office/index.js'
import * as radar from './lib/radar/index.js'

export const name = 'dsh-agent-suite'
export const inject = ['webServer']

const MEMBERS = [['bridge', bridge], ['judge', judge], ['office', office], ['radar', radar]]

export function apply(ctx) {
  for (const [label, mod] of MEMBERS) {
    try {
      ctx.plugin(mod)
      console.log(`[agent-suite] mounted ${label}`)
    } catch (error) {
      console.error(`[agent-suite] mount failed: ${label}`, error)
    }
  }
}
