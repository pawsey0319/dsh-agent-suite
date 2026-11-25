# 变更记录（CHANGELOG）

整合包 `@pawsey0319/dsh-agent-suite`。逐条对应可验证的行为与证据位置，不写「优化体验」这类无法核对的话。

## 0.9.17 — 2026-11-25

**成员版本**：`dsh-task-radar` 0.7.4、`dsh-agent-bridge` 0.5.2。

### 安全加固补完：Host 围栏（防 DNS rebinding）

0.9.16 只拦了 `Sec-Fetch-Site`。但 DNS rebinding 场景下浏览器会把攻击者域名解析到 127.0.0.1，此时 `Sec-Fetch-Site` 是 `same-origin`、挡不住（请求的 Host 是 `evil.com`）。

- 两个插件在路由入口加 Host 围栏：**带了 Host 就必须是回环地址**（`127.0.0.1` / `localhost` / `::1`），否则 403 `cross_origin_rejected`；没有 Host 的请求只可能来自进程内调用（浏览器和 curl 必带 Host），放过。
- 为什么不直接调 `ctx.connection.requestRejection()`：它在 0.2.2-rc.5 里**是存在的**（asar 里 16 处、含 TS 声明），但内部是「Host/Origin 围栏 + browserAuth 会话认证」，CLI 的 curl 与 HUD 的 URLSession 没有浏览器 Cookie，会被判 401，把胶囊和 CLI 一起打死；所以这里只复刻围栏两条判定（Host 回环 + `Sec-Fetch-Site`），认证层留给宿主。

**自检**：83 → 84 条（新增 SEC-3）。

## 0.9.16 — 2026-11-25

**成员版本**：`dsh-task-radar` 0.7.3、`dsh-agent-bridge` 0.5.1。

### 安全加固（市场收录复核意见）

awesome-dsh-plugin 维护者合并时按 main 上的实际代码补了一句：`webServer.register` 注册的路由没调用 `ctx.connection.requestRejection(req)`，也没用 `engines.dsh >= 0.2.3` 限定在默认鉴权的宿主上，所以 0.2.2 及以下宿主的浏览器页面能直接访问。

- 本机宿主是 **0.2.2-rc.5**，没有 `ctx.connection.requestRejection`，也不能加 `engines.dsh >= 0.2.3`（会把自己挡在门外），所以两个插件都在路由入口自己拦：只认浏览器必带的 `Sec-Fetch-Site`，`cross-site` / `same-site` 一律 403 `cross_origin_rejected`。
- 读接口也拦（会话标题、run 结果和写入一样敏感）；命令行、CLI、HUD 的 URLSession 不带该头，行为不变。
- 实测：无头 `GET /x-radar/radar` → 200；带 `Sec-Fetch-Site: cross-site` → 403，日志 `route guard tail=radar sec-fetch-site=cross-site -> 403`。

**自检**：81 → 83 条（新增 SEC-1/2 两条静态守卫）。

## 0.9.15 — 2026-11-25

**成员版本**：`dsh-task-radar` 0.7.2（其余成员随包不变）。

### 胶囊（dsh-task-radar 0.7.2）

- **codex「失败清不掉」的根因修复**：`normalizeAdapterEvent()` 入库前会削掉 `codex:` 前缀（store 键是 `<thread>:running`），而 codex 的 retract 一直写 `codex:<thread>:running` → `store.delete()` 永远 false 且**失败不打日志**；「先 poll 到 task_started、后 poll 到 task_complete」的时序（几乎必然）就留下幽灵 running，10 分钟后被 settle 改写成 `failed(stale-no-progress)`。现在 retract 消费端按同一套前缀规则归一化，未命中也会打 `adapter retract miss`。
- **settle 兜底**：改写 failed 之前先看同会话是否已有 `ts >= running.ts` 的 done/failed，有就静默收回（`reason=superseded`）；带时间比较，所以 DuMate 同会话开新一轮的 running 不会被误删。

**自检**：`node docs/verify/t43-repro/t43-checks.mjs` → 81/81（新增 RET-1/2/3 三条静态守卫）。

## 0.9.14 — 2026-11-25

**成员版本**：`dsh-task-radar` 0.7.1（其余成员随包不变）。

### 胶囊（dsh-task-radar 0.7.1）

- **只剩失败行时也能清**：清除按钮以前只在 `doneUnread > 0` 时出现，用户看到「codex 运行失败一直挂着」却没有入口；现在 `doneUnread > 0 || failed > 0` 都画按钮，文案按内容切换（`panel.clearDone` / `panel.clearFailed` / `panel.clearEnded`，zh/en 两份 locale 同步）。
- **`GET /x-radar/clear-done` 顺带清失败行**：把 adapter 失败行写进 `hidden-runs.json` + `hidden-sessions.json`（与单行「清掉这条」同一账本），响应新增 `failed=N`，日志 `panel clear-done … failed=N` 可复核；实测老实现对该场景返回 `cleared=0` 且行不消失。

**自检**：`node docs/verify/t43-repro/t43-checks.mjs` → 78/78；`bash native/build.sh` 重建 HUD（`e9317c7212e5`）。

## 0.9.0 — 2026-11-19

**成员版本**：`dsh-task-radar` 0.6.13、`dsh-agent-bridge` 0.6.2、`dsh-judge` / `dsh-office-artifacts` 随整合包发布。

### 胶囊（dsh-task-radar 0.6.13）

- **等回答/待批准/在跑三态可辨**：静态环形态表达状态（缺口=等你回答、双环=待批准、实心环=有新完成、中性细环=在跑），
  `sessionController.list()` 之外的信号（`typertGateway.getPendingRemoteEvents()`）产生 `kind=question` 条目；等回答的会话不再计入「进行中」。
- **宽胶囊**：待回答 / 待批准 / 失败时收起态是 44 高、178–234 宽（上限 240）的胶囊，直接写 `等回答：<问题首句>…`；
  锚点跟随圆盘位置，宽窄同一 NSWindow（不新建窗口）。
- **就地处置（选项类）**：HUD 存活且无活 Web 客户端时接管会话内提问，面板内点选项即提交，多选提交行；20s 未答 / HUD 退出 /
  插件卸载立刻 `next()` 让渡回桌面提问卡；回执形状 `{answers:[{id,selected,custom}]}`。
- **横幅**：点完成横幅一键跳会话（先标已读再跳）、`run` 打开详情、审批/提问打开处置页；条目被消费后横幅下一轮自动消失
  （`banner dismiss reason=item-consumed`），取数失败不吞提醒（`banner keep reason=feed-error`）。
- **未读口径**：以 DSH 可证事实清账（行消失 `dsh-gone`、会话又跑 `dsh-running`、完成后仍有输入 `dsh-prompt`），
  其余才回退雷达自己的 60 分钟保留。
- **僵尸 run**：桥把子进程 pid 落进 `runs/<id>/meta.json`，进程消失即写回 `failed + reason=process-exited`；
  雷达读侧两级判定（`pidAlive:false` 立即落终态，10 分钟只留给「活着但卡住」）。
- **性能与门禁**：呼吸改 Core Animation、feed stale-while-revalidate（p50 57.7ms → 0.3ms）、日志 10MB×3 轮转、
  胶囊窗口复用（不再 1→0 抖动）、`release-gate.sh --phase pre` 落升级前快照、`--bench` 输出真实 `cpu_pct`/`rss_kb`。

### 已知限制

- M9（10 万事件详情渲染）按用户 2026-11-18 裁定记 `KNOWN-DEFERRED`，阈值未改（50ms），由 F-04 追踪。
- 客户端半边的指纹自愈（R-03/U-04）本轮**未启用**：任何 `client.js` 改写都会 bump 客户端 bundle rev，
  运行期安装会导致页面按新 rev 拉 combo 404 → web-boot 失败，因此 `client.js` 与上一版字节一致，门禁记 `KNOWN-DEFERRED`。

## 0.8.2 — 2026-11-18

- 低危清理 N-18…N-21（SSE 终态结束、历史 `finalAnswer` 回填、空队列 clear 返回 200、clientHalf 心跳）。
- 雷达 0.6.7：`--bench` JSON Lines、日志轮转、重复实例不删存活 `hud.pid`。

## 0.8.1 / 0.8.0

- 首个可安装整合包：四个成员 + 原生胶囊二进制，`plugins == bundle == tarball` 三方哈希一致。
