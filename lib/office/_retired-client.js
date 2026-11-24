/**
 * dsh-office-artifacts —— 客户端半（产物卡）
 *
 * 侧边栏「产物」按钮 → 全屏浮层：最近生成的 docx/xlsx/pptx/pdf 清单，
 * 支持「打开位置 / 接受 / 打回重做（把意见发回最近活跃会话）」。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-office-artifacts',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect } = React

    const ROUTES = ['/office-artifacts', '/office-artifacts-b', '/office-artifacts-c']
    let base = null
    let ctxRef = null

    function beacon(message) {
      fetch(`${base ?? ROUTES[0]}/beacon?e=${encodeURIComponent(message)}`).catch(() => {})
    }

    async function ensureBase() {
      if (base !== null) return base
      for (const route of ROUTES) {
        try {
          const response = await fetch(`${route}/health`)
          if (response.ok) {
            base = route
            return route
          }
        } catch {}
      }
      throw new Error('office-artifacts host unavailable')
    }

    async function api(path, params) {
      const route = await ensureBase()
      const query = new URLSearchParams()
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value === undefined || value === null) continue
        query.set(key, String(value))
      }
      const suffix = query.toString() === '' ? '' : `?${query.toString()}`
      const response = await fetch(`${route}${path}${suffix}`)
      const data = await response.json().catch(() => null)
      if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`)
      return data
    }

    const store = {
      open: false,
      items: [],
      accepted: new Set(),
      rejected: new Map(),
      loading: false,
      error: null,
      notice: null,
      rejectPath: null,
      feedback: '',
      busy: false,
    }
    const subscribers = new Set()
    const emit = () => { for (const fn of subscribers) fn() }
    const setState = (patch) => { Object.assign(store, patch); emit() }
    function useStore() {
      const [, force] = useState(0)
      useEffect(() => {
        const off = (() => { subscribers.add(() => force((v) => v + 1)); return () => subscribers.delete(() => {}) })()
        return () => { subscribers.delete(off) }
      }, [])
    }

    async function refresh() {
      setState({ loading: true, error: null })
      try {
        const [list, state] = await Promise.all([api('/list', { hours: 240 }), api('/state')])
        setState({
          items: Array.isArray(list?.items) ? list.items : [],
          accepted: new Set(state?.accepted ?? []),
          rejected: new Map((state?.rejected ?? []).map((item) => [item.path, item.feedback])),
          loading: false,
        })
      } catch (error) {
        setState({ loading: false, error: String(error?.message ?? error) })
      }
    }

    async function review(path, action, feedback) {
      setState({ busy: true })
      try {
        const result = await api('/review', { path, action, feedback: feedback ?? '', send: action === 'reject' ? 1 : 0 })
        setState({
          busy: false,
          rejectPath: null,
          feedback: '',
          notice: action === 'accept'
            ? '已接受这个产物'
            : result?.sent
              ? '已打回，意见已发回最近活跃的会话'
              : '已打回并记录意见（没找到可发送的会话）',
        })
        await refresh()
      } catch (error) {
        setState({ busy: false, error: String(error?.message ?? error) })
      }
    }

    function iconFor(kind) {
      if (kind === 'doc') return '📄'
      if (kind === 'sheet') return '📊'
      if (kind === 'slide') return '📽'
      if (kind === 'pdf') return '📕'
      return '📎'
    }

    function sizeText(size) {
      if (!Number.isFinite(size)) return ''
      if (size > 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)}MB`
      return `${Math.max(1, Math.round(size / 1024))}KB`
    }

    function FooterButton(props) {
      useStore()
      const wide = props?.wide === true
      const count = store.items.length
      return h(
        'button',
        {
          className: 'oaf-foot',
          type: 'button',
          title: '办公产物',
          onClick: () => {
            setState({ open: true })
            beacon('panel-open')
            void refresh()
          },
        },
        h('span', { style: { fontSize: 13 } }, '📎'),
        wide ? h('span', { style: { marginLeft: 6 } }, '产物') : null,
        count > 0 ? h('span', { className: 'oaf-badge' }, String(count)) : null,
      )
    }

    function Panel() {
      useStore()
      useEffect(() => {
        if (store.open !== true) return undefined
        const timer = setInterval(() => { void refresh() }, 8000)
        return () => clearInterval(timer)
      }, [store.open])
      if (store.open !== true) return null
      const close = () => { beacon('panel-close'); setState({ open: false, rejectPath: null }) }
      return h(
        'div',
        { className: 'oaf-root', onMouseDown: (event) => { if (event.target === event.currentTarget) close() } },
        h(
          'div',
          { className: 'oaf-panel' },
          h(
            'div',
            { className: 'oaf-head' },
            h('span', { style: { fontSize: 16 } }, '📎'),
            h('strong', { style: { fontSize: 14 } }, '办公产物'),
            h('span', { className: 'oaf-sub' }, `${store.items.length} 个 · 最近 10 天`),
            h('span', { style: { flex: 1 } }),
            h('button', { className: 'oaf-btn', type: 'button', onClick: () => { void refresh() } }, '刷新'),
            h('button', { className: 'oaf-btn', type: 'button', onClick: close }, '关闭'),
          ),
          store.notice ? h('div', { className: 'oaf-notice' }, store.notice) : null,
          store.error ? h('div', { className: 'oaf-error' }, store.error) : null,
          h(
            'div',
            { className: 'oaf-body' },
            store.loading && store.items.length === 0
              ? h('div', { className: 'oaf-empty' }, '扫描中…')
              : store.items.length === 0
                ? h('div', { className: 'oaf-empty' }, '最近 10 天没有发现 docx / xlsx / pptx / pdf 产物。')
                : store.items.map((item) =>
                    h(
                      'div',
                      { className: 'oaf-card', key: item.path },
                      h('div', { className: 'oaf-card-main' },
                        h('span', { className: 'oaf-icon' }, iconFor(item.kind)),
                        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
                          h('div', { className: 'oaf-name', title: item.path }, item.name),
                          h('div', { className: 'oaf-sub' }, `${item.relative ?? item.path} · ${sizeText(item.size)} · ${new Date(item.mtime).toLocaleString()}`),
                        ),
                        h('span', { style: { flex: 1 } }),
                        store.accepted.has(item.path) ? h('span', { className: 'oaf-chip ok' }, '已接受') : null,
                        store.rejected.has(item.path) ? h('span', { className: 'oaf-chip bad' }, '已打回') : null,
                      ),
                      h('div', { className: 'oaf-actions' },
                        h('button', { className: 'oaf-btn', type: 'button', onClick: async () => { try { await api('/open', { path: item.path }) } catch {} } }, '打开位置'),
                        h('button', { className: 'oaf-btn', type: 'button', disabled: store.busy, onClick: () => review(item.path, 'accept') }, '接受'),
                        h('button', { className: 'oaf-btn ghost', type: 'button', disabled: store.busy, onClick: () => setState({ rejectPath: item.path, feedback: store.rejected.get(item.path) ?? '' }) }, '打回重做'),
                      ),
                      store.rejectPath === item.path
                        ? h('div', { className: 'oaf-reject' },
                            h('div', { className: 'oaf-sub' }, '打回意见会发给该项目最近活跃的会话；留空则只记录，不发送。'),
                            h('textarea', { className: 'oaf-area', value: store.feedback, onChange: (event) => setState({ feedback: event.target.value }) }),
                            h('div', { className: 'oaf-actions' },
                              h('button', { className: 'oaf-btn primary', type: 'button', disabled: store.busy, onClick: () => review(item.path, 'reject', store.feedback) }, '确认打回'),
                              h('button', { className: 'oaf-btn ghost', type: 'button', onClick: () => setState({ rejectPath: null, feedback: '' }) }, '取消'),
                            ),
                          )
                        : null,
                    ),
                  ),
          ),
        ),
      )
    }

    function ensureStyle() {
      if (document.getElementById('oaf-style') !== null) return
      const style = document.createElement('style')
      style.id = 'oaf-style'
      style.textContent = `
.oaf-foot{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border-radius:8px;background:transparent;border:1px solid transparent;color:var(--dsw-alias-label-secondary,#c9c9c9);cursor:pointer;font-size:12px}
.oaf-foot:hover{background:var(--dsw-alias-bg-l2,#242424);border-color:var(--dsw-alias-border-l,#333)}
.oaf-badge{min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-brand-primary,#7aa2ff);color:#0d0d0d;font-size:10px;line-height:16px;text-align:center}
.oaf-root{position:fixed;inset:0;z-index:90;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;pointer-events:auto}
.oaf-panel{width:min(760px,92vw);max-height:82vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#1c1c1c);border:1px solid var(--dsw-alias-border-l,#3a3a3a);border-radius:14px;box-shadow:0 24px 80px rgba(0,0,0,.6);overflow:hidden}
.oaf-head{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l,#2c2c2c)}
.oaf-sub{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.oaf-body{overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.oaf-card{border:1px solid var(--dsw-alias-border-l,#2c2c2c);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}
.oaf-card-main{display:flex;align-items:center;gap:10px}
.oaf-icon{font-size:18px}
.oaf-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:420px}
.oaf-actions{display:flex;gap:8px}
.oaf-btn{height:26px;padding:0 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l,#3a3a3a);background:var(--dsw-alias-bg-l1,#232323);color:var(--dsw-alias-label-primary,#f2f2f2);font-size:12px;cursor:pointer}
.oaf-btn.ghost{background:transparent}
.oaf-btn.primary{background:var(--dsw-alias-brand-primary,#7aa2ff);border-color:transparent;color:#0d0d0d;font-weight:600}
.oaf-btn:disabled{opacity:.5;cursor:default}
.oaf-chip{font-size:10.5px;padding:1px 7px;border-radius:99px;border:1px solid var(--dsw-alias-border-l,#444)}
.oaf-chip.ok{color:#7ee0b0;border-color:rgba(126,224,176,.5)}
.oaf-chip.bad{color:#ff9d9d;border-color:rgba(255,157,157,.5)}
.oaf-reject{background:rgba(255,255,255,.03);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px}
.oaf-area{min-height:70px;resize:vertical;background:var(--dsw-alias-bg-l1,#232323);color:var(--dsw-alias-label-primary,#f2f2f2);border:1px solid var(--dsw-alias-border-l,#3a3a3a);border-radius:8px;padding:8px;font-size:12.5px}
.oaf-notice{padding:8px 18px;background:rgba(57,185,128,.14);color:#7ee0b0;font-size:12px}
.oaf-error{padding:8px 18px;background:rgba(255,107,107,.12);color:#ff9d9d;font-size:12px}
.oaf-empty{padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a8a8a);font-size:12.5px}
`
      document.head.appendChild(style)
    }

    function apply(ctx) {
      ctxRef = ctx
      ensureStyle()
      const mount = (slot, def, Component) => {
        try {
          ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id: def.id, order: def.order, inject: def.inject }, Component))
          beacon(`slot-ok:${slot}`)
        } catch (error) {
          beacon(`slot-fail:${slot}:${String(error?.message ?? error).slice(0, 80)}`)
        }
      }
      mount('sidebar.footer.action', { id: 'office-artifacts-entry', order: 24, inject: (props) => ({ wide: props?.wide === true }) }, FooterButton)
      mount('shell.overlay', { id: 'office-artifacts-panel' }, Panel)
      beacon('client-boot')
    }

    return { name: 'dsh-office-artifacts-client', inject: ['slots'], apply }
  },
})
