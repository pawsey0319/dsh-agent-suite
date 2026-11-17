# DSH One-Console 研发文档（DEV）

> 版本 v0.1 ｜ 更新 2026-11-16 ｜ 对应 PRD v0.4.0 ｜ 维护：Lead
>
> 阅读顺序：**PRD（为什么做 / 做什么）→ docs/research/*（外部事实）→ 本文（怎么做的 / 怎么改 / 怎么验）**。
> PRD 是需求与验收依据；本文是实现细节与工程纪律，两者冲突以 PRD 为准。

---

## 0. 一分钟上手

```bash
# 1) 看当前是否在跑
lsof -nP -iTCP -sTCP:LISTEN | grep -i deepseek          # 找 DSH Web 端口（每次重启都变）
pgrep -fl RadarHUD                                      # 桌面雷达进程
tail -5 /tmp/dsh-task-radar/beacon.log                  # 插件侧事件流（唯一的无图排障通道）

# 2) 改完代码后重装插件（必须 remove → install，application:"applied" 才算生效）
#    用 plugin_manager 工具：remove_bundle "@local/dsh-task-radar"
#                          install_bundle "<工作区绝对路径>/plugins/dsh-task-radar"

# 3) 只改原生 HUD 时
cd plugins/dsh-task-radar/native && bash build.sh        # swiftc -O -framework AppKit
```

原生 HUD 是**独立进程**（不是 Electron 渲染层），改完二进制后必须让插件重启它：
`kill $(cat ~/.dsh/agent-bridge/hud.pid)` 然后 `remove_bundle` + `install_bundle`。

---

## 1. 分层与模块地图

```
┌──────────────────────────── DSH 桌面（Electron 壳 + Node 宿主进程）────────────────────────────┐
│  Node 宿主进程（@deepseek-ai/dsh-desktop-host）—— cordis 插件运行时                            │
│                                                                                                │
│  plugins/dsh-task-radar/index.js      ← 雷达聚合口（Host 半）                                  │
│    └ GET /x-radar/radar               聚合「DSH 会话运行态」+「Agent Bridge 外部 run」          │
│    └ GET /x-radar/seen?id=a,b         标记一条/多条已读（逗号分隔）                          │
│    └ 写 ~/.dsh/agent-bridge/radar-url.json   （端口跟随契约）                                  │
│    └ spawn native/RadarHUD --url auto --interval 2                                             │
│                                                                                                │
│  plugins/dsh-agent-bridge/index.js    ← 外部 agent 事件出口（Host 半，P1）                     │
│    └ POST /agent-bridge/runs          起一次 Codex run（app-server stdio）                     │
│    └ GET  /agent-bridge/runs/<id>/stream?since=  SSE 逐事件回流                                │
│    └ GET/POST /agent-bridge/approvals 审批队列（5 分钟无响应自动 decline）                      │
│    └ 落盘 ~/.dsh/agent-bridge/runs/<runId>/{events.jsonl,meta.json}                            │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
                     │ HTTP（127.0.0.1，端口每次重启变化）
                     ▼
        native/RadarHUD（Swift + AppKit，独立进程，56pt 圆形常驻窗口）
          收起 = 小圆圈；悬停 = 展开任务面板；双击 = 激活 DSH；拖拽 = 移动并记忆
```

三个硬约束（决定了一切实现形状）：

1. **插件里不能 `import('electron')`**——桌面宿主是独立 Node 进程，任何「窗口级」能力只能另起原生进程（本项目用 Swift/AppKit）。
2. **不能改 `app.asar`**——所有能力必须通过 profile 里的 bundle 插件 + 独立进程实现（可回滚、可热更）。
3. **数据必须落盘**——雷达是「会话层事件的项目」，面板与 HUD 都只是投影；`beacon.log` + `runs/*/events.jsonl` 是唯一可信证据链。

### 文件清单

| 路径 | 作用 | 何时改 |
|---|---|---|
| `plugins/dsh-task-radar/index.js` | Host 半：聚合口、端口跟随、HUD 生命周期 | 改计数口径 / 加数据源 |
| `plugins/dsh-task-radar/native/RadarHUD.swift` | 原生 HUD 全部实现（~1650 行） | 改外观 / 交互 / 几何 |
| `plugins/dsh-task-radar/native/build.sh` | `swiftc -O -framework AppKit RadarHUD.swift -o RadarHUD` | 几乎不用改 |
| `plugins/dsh-agent-bridge/index.js` | Codex app-server 客户端 + HTTP/SSE + 审批 | 接新 agent / 加事件类型 |
| `plugins/dsh-project-journal/index.js` | Host 半：项目/会话对账、增量总结、回填、迁移、分支路由（`/x-journal/*`） | 改数据面逻辑 |
| `plugins/dsh-project-journal/journal-store.js` | journal v3 纯函数：读写/迁移/摘要合并/分支工具 | 改数据模型 |
| `plugins/dsh-project-journal/client.js` | 客户端半：底部「进展」按钮 + 会话行「移入项目」+ 全屏面板（阶段链/分支页签/开分支弹层） | 改 UI |
| `plugins/*/locale/{zh,en}.json` | 显示名（`meta.title` / `description` / `detail`） | 加插件 / 改名字 |
| `docs/PRD.md` | 需求、验收、分期、变更记录 | **先改这里再写代码** |
| `docs/research/*.md` | 外部协议与真机实测（codex/claude、workbuddy、dsh 插件面） | 调研结论更新时 |

---

## 2. 数据契约

### 2.1 雷达 Feed `GET /x-radar/radar`

```jsonc
{
  "ok": true,
  "generatedAt": "2026-11-16T07:01:16.805Z",
  "counts": {
    "running": 1,        // 顶层运行中会话数（大数字口径；子会话不计）
    "approvals": 1,      // 需批准（含 bridge run 的 needs-approval）
    "doneUnread": 2,     // 已完成未看
    "pending": 1         // = running（兼容旧字段）
  },
  "items": [
    { "id": "...", "kind": "session", "status": "running", "title": "DSH 统一 Agent 调度平台设计", "agent": "DSH", "preset": "...", "updatedAt": 1794566631481 },
    { "id": "...", "kind": "run", "status": "needs-approval", "title": "删除临时导出目录", "agent": "codex", "finalAnswer": null }
  ],
  "sources": { "sessions": "sessionController", "runs": 3 },
  "dsh": { "port": 64274, "url": "http://127.0.0.1:64274" }
}
```

- 排序：`needs-approval` > `done` > `running`。
- HUD 每 2s 拉一次；`counts` 决定大数字与颜色，`items(limit 6)` 决定展开列表。
- 计数口径变更历史：v0.2.0 起「大数字 = 运行中的**顶层**会话数」，`parentSession`/`parentSessionId` 的子会话被 `childSessionIds()` 过滤（3 个子 agent 并发仍显示 1）。

### 2.2 DSH 会话数据形状（实测，写 UI 必看）

```jsonc
// sessionController.list(signal) → { items: [...] }   ← 注意是信封，不是数组
{
  "sessionId": "...", "updatedAt": 1794566631481, "running": true, "blank": false,
  "agentAvailable": true, "formatStatus": "...", "cwd": "/Users/...",
  "projections": {
    "kind": "sequenced", "asOfSeq": 123,
    "values": { "title": "DSH 统一 Agent 调度平台设计", "goal": "...", "agentPreset": "..." }
  }
}
```

- **标题只能取 `projections.values.title`**；回退到 `cwd` 基名会显示成 `default-workspace`。
- 客户端侧（已弃用的窗口内角标）形状不同：`sessions.list` 快照 = `{ids, byId, phase, projectionsBySession}`，行上 `running` 是扁平布尔，`displayTitle` 取标题。

### 2.3 端口与位置文件

| 文件 | 写入方 | 内容 | 用途 |
|---|---|---|---|
| `~/.dsh/agent-bridge/radar-url.json` | 插件 apply | `{url, port, updatedAt}` | HUD `--url auto` 每轮重读，解决端口漂移 |
| `~/.dsh/agent-bridge/hud-window.json` | HUD | `{x, y, version:2}`（**左下角圆心的屏幕坐标**） | 拖拽位置记忆；`version<2` 视为旧语义、回落默认右下 |
| `~/.dsh/agent-bridge/hud.pid` | HUD | pid | 单实例锁 + 插件退出清理 |
| `~/.dsh/agent-bridge/seen.json` | 插件 | `{runId: ts}` | 完成未看的已读标记 |
| `~/.dsh/agent-bridge/runs/<id>/{events.jsonl,meta.json}` | bridge | 逐事件 + 运行元数据 | 时间线 UI / 验收判别的原始证据 |

---

## 3. 插件宿主（Host 半）实现纪律

1. **所有副作用放 `ctx.effect`，并返回 disposer**。否则插件热替换时旧世代不释放，重装会报
   `dsh: warning: 1 entry did not activate` + `webserver: duplicate prefix route "/x-radar"`。
   正确形状：

   ```js
   ctx.effect(() => {
     const bound = ctx.webServer.register({ kind: 'prefix', path: '/x-radar', handler })
     startHud(port)
     return () => { bound.dispose(); killHud() }
   })
   ```

2. **路由 handler 签名是 `handler(req, res)`**（DSH webserver 内部 `await responder.handler(req, res)`）。
   曾因漏传 `res` 导致线上 500 `Cannot read properties of undefined (reading 'writeHead')`。
   另有 `route.resource` 形态走 `serveResource`（静态资源），不要混用。

3. **插件清单**：`dsh.manifestVersion: 1`、`dsh.bundle.patch`、`exports`；宿主专属插件不要写 `dsh.client`
   （写了就必须提供 `exports["./client"]`，否则 `client-modules` 直接抛错）。
   **窗口内角标已于 v0.2.0 移除**，现在只有桌面 HUD 一种形态。

4. **显示名来自 locale 的 `meta`**：`{"meta":{"title":"任务雷达","description":"...","detail":"docs/DETAIL.md"}}`，
   缺失才回退 `package.json` 的 name/description（会显示成裸包名 `@local/dsh-task-radar`）。

5. **安装/升级只有一条路**：`plugin_manager` 的 `remove_bundle` → `install_bundle`（target 用工作区绝对路径），
   以返回里的 `application: "applied"` 为生效判据；不要手写 profile 的 `package.json` / `cordis.patch.yml`。

6. **JS 与原生二进制解耦**：插件只负责 `spawn(HUD_BIN, ['--url','auto','--interval','2'])`（`detached + unref`）
   和退出时 `process.kill(hud.pid)`；HUD 缺失只记 `host.hud.missing` 并继续提供 Feed，不阻塞宿主。

---

## 4. 原生 HUD 实现

### 4.1 窗口

| 项 | 值 | 原因 |
|---|---|---|
| 尺寸 | 收起 56×56，展开 320×W（按行数 180–264） | 用户要求「小圆圈」；面板宽度固定便于扫读 |
| 样式 | `.borderless`、`isOpaque=false`、`backgroundColor=.clear`、`isMovableByWindowBackground=true` | 完全透明无白底（v0.2.4 修复：曾用 `NSVisualEffectView.hudWindow` + `behindWindow` 采样桌面，浅色壁纸下整块发白） |
| 层级 | `.screenSaver(1000)` + `[.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]` | 全屏 App 上也可见、所有 Space 跟随 |
| 命中 | 收起态圆形 hitTest（四角穿透）；展开态圆角矩形去四角 | 不挡下层 App |
| 默认位置 | **主显示器**（`NSScreen.screens.first`）右下角内缩 24pt | 曾用 `NSScreen.main`（跟随焦点窗口）导致默认跑到副屏 |

### 4.2 交互状态机

```
收起(56pt) ──悬停 0ms──▶ 展开(320pt) ──移出 250ms──▶ 收起
   │                        │
   └──拖拽(mouseDragged)────┴──mouseUp: 位移≥2pt 记忆位置，否则：
                                  ├ 点在「完成未看」行 → markSeen([runId])
                                  ├ 点在「完成未看 N」副行 → markSeen(全部)
                                  └ 其余位置 → no-op
   └──双击(clickCount≥2)──▶ activateDSH(): open -a "DeepSeek Harness"
```

- **拖动是手写的**（`mouseDown` 记起点 → `mouseDragged` 移动窗口 → `mouseUp` 记忆）：
  `window.performDrag(with:)` 在无边框 + 合成事件下不可靠，且它的模态循环会和「悬停收起」打架，
  旧实现表现为「拖完又弹回右下角」。
- **拖拽期间禁止收起**（`isDragging` 守卫）：否则窗口会在拖拽途中缩回旧坐标。
- 展开几何：以圆心为锚向屏幕内侧生长（`growLeft`/`growUp`），四周留 12pt，越界夹回并记
  `warn: 展开面板超出屏幕，已夹回可见区域`。

#### 4.2.1 「完成未看」行与置为已读

外部 agent（Agent Bridge run）完成后没有 DSH 会话可跳转，所以它的「完成」必须能在 HUD 里被消费掉，
否则计数会永远挂在副行上——旧版本就是这个死结（用户报「一直显示完成未看 2，点击没用」）。

- 判定：`RadarItem.isDoneUnreadRun` = `kind == "run" && status == "done" && !(seen ?? false)`。
- 列表口径：`panelRows = runningSessions + doneRuns`（完成的排在运行中之后，按 `updatedAt` 倒序），
  统一受 `maxRows(6)` 约束，`panelRowCount` 同时决定 `panelHeight()`。
- 行样式：徽标降为灰色（`0.58/0.55`）、标题 α0.74、副行文案「`<AGENT>` · 完成未看 · 点击标记已读」。
- 命中：绘制时把每个完成行的 `NSRect` 收进 `doneRowHits`（视图坐标），另把「完成未看 N」副行区域
  收进 `doneStatsRect`；`mouseUp` 且 `!dragMoved` 时用 `panelContent.convert(event.locationInWindow, from: nil)`
  换算坐标后命中。
- 写入：HUD 是只读轮询方，置读走一次 `GET /x-radar/seen?id=<a,b>`（后端 `seen` 路由按逗号拆分，
  批量写 `~/.dsh/agent-bridge/seen.json`），成功后立刻 `fetchNow(reason: "after-mark-seen")`
  重拉，因此计数与行数在同一帧内同步收缩。
- 端点推导：`seenEndpoint(ids:)` 取 `lastResolvedURLString` 里的 feed URL，`/radar` → `/seen`
  再挂 `id`，因此 DSH 换端口（`radar-url.json` 每轮重读）后仍然正确。
- 右键菜单同项：「完成未看全部置为已读」。

#### 4.2.2 详情视图（点完成行看结果）

置为已读只解决「计数消不掉」，用户真正要看的是「那次任务到底输出了什么」，所以点完成行会同时
**置读 + 打开详情**：

- 状态：控制器持有 `detail: RadarDetail?`（`title / agent / meta / body`），非 nil 即详情态；
  视图侧 `panelContent.detail` 同一份数据，`draw` 里在画完背景后分支到 `drawDetail`。
- 数据：`GET /agent-bridge/runs/<id>?limit=120` → `{run, events}`。正文优先 `run.finalAnswer`，
  为空时回退拼接 `events` 里 `kind == "text"` 的 `text` 字段（实测 codex 常把答案放在
  `item/agentMessage/delta` 的 text 事件里而 `turn.end.finalAnswer` 为 null）。
  meta 行用 `run.durationMs / run.usage.total.totalTokens / run.eventCount` 拼成
  「耗时 4.5s · 88936 tokens · 44 事件」。
- 布局：标题「任务结果」+ 右上 agent 徽标；下面标题行、meta 行、正文（`byWordWrapping`，
  按 `bodyLines = min(6, max(1, len/34+1))` 预留高度，超出即截断）；底部提示「点击任意处返回列表」。
- 高度：`panelHeight()` 在详情态返回
  `bandHeight + contentPadding*2 + headerHeight + 64 + bodyLines*15`，因此面板会随正文长短伸缩。
- 返回：详情态下 `handleMouseUp` 只判断点击是否落在面板内，落在面板内即 `closeDetail()`
  （清空 detail → `refreshExpandedGeometry(animated: true)`），不做行命中。
- 边界：详情态不吃 hover 收起逻辑（`isExpanded` 仍为真，鼠标移出仍会收起，符合桌面小部件直觉）。

#### 4.2.3 事件流二级视图（完整过程）

摘要只给最终回答，用户要看「那次运行到底怎么走的」时进事件流：

- 入口：摘要页底部右侧按钮「事件流 N 条 ›」（`DetailAction.showEvents`）。
- 数据：`RadarDetail.events`，由 `fetchRunDetail` 一次性拉 `GET /agent-bridge/runs/<id>?limit=1000`
  的 `events` 构造 `RadarEventLine{seq, kind, text}`。
  - **过滤** `kind == "event"`（原始 JSON-RPC 通知，如 `mcpServer/startupStatus/updated`、`remoteControl/*`），
    否则一屏 12 行会被噪声占满。
  - 摘要文案按 kind 生成：`text`→正文、`reasoning`→文本或「思考」、`item.*`→`title`/`itemType`、
    `turn.start`→「回合开始」、`turn.end`→`status`、`usage`→`N tokens`、`run.created`→prompt、
    `approval.*`→「请求批准 / 批准结果」。
- 布局：头部「事件流」+ 右侧 `当前-末/总数`；正文固定 12 行（`HUD.eventVisibleRows`）× 15pt，
  三列 = seq(30) / KIND(64) / text(剩余)；右侧 2pt 滚动条（轨道 + 滑块按比例）。
- 高度：`HUD.bandHeight + padding*2 + headerHeight + 12*15 + 22 = 340`。
- 翻页：`scrollWheel` 在 **根视图** 上转发（`PanelContentView` 继承 `PassthroughView`，`hitTest` 返回 nil，
  自己收不到滚轮！）→ `controller.handleScroll` → `panelContent.scrollEvents(by:)`；
  `step = Int(-deltaY/5)`，为 0 时按方向 ±1 行，范围 `0...(count-12)`。
- 返回：底部左按钮「‹ 返回结果」（`DetailAction.backToSummary`）；事件流页点空白**不**关闭。

#### 4.2.4 一次点击被投递两次（踩坑）

实测：点「完成未看」行会连续收到 **两次 `mouseUp`**（同一次点击，1ms 内），第一下打开详情、
第二下被详情分支当成「点空白 → 返回列表」，表现为「详情一打开就秒退」。

- 修法：`handleMouseUp` 顶部按事件时间戳去重（`event.timestamp - lastMouseUpTimestamp < 0.02` 直接返回）；
  另保留「打开详情后 250ms 内的点击忽略」作为二道保险（`detailOpenedAt`）。
- 影响：置读、整理、双击都只执行一次，日志里不再出现成对的 `mouseUp`。

#### 4.2.5 事件流实时跟随（直播）

运行中的任务不该只有「跑完再看」，点开就要能看着它跑。

- 触发：`openDetail` 时 `live = item.isRunningSession || item.isRunningRun`；`live` 为真才 `startLiveDetail()`。
- 增量：`liveDetailTimer` 每 **1.5s** 调 `fetchRunDetail(append: true)` → `GET /agent-bridge/runs/<id>?since=<detailLastSeq>&limit=500`，
  追加到 `RadarDetail.events` 并更新 `detailLastSeq = max(seq)`（后台解析、主线程合并）。
- 不抢滚动：只有 `panelContent.eventsAtBottom(detail)` 为真（用户就停在底部）才 `followEventsTail`；
  用户向上翻看时新事件只累积、不改变 `eventScrollRow`。
- 结束：`status` 不再属于 `{running, starting, queued}` → `stopLiveDetail()`，并延时 0.6s 调
  **`refreshRunSummary(id:)`**（`?limit=1`，只更新 `meta/body/runStatus`，**绝不动 events**）。
  实测教训：收尾时做一次全量拉取会把已累积的 2423 条事件截成 1000 条 —— 增量攒出来的列表不能被「刷新」吃掉。
- 视觉：事件流标题右侧绿点「● 直播中」（`0.45/0.92/0.62`），停止后消失。

#### 4.2.6 单条事件的原始 payload

事件行不再只是摘要，要能追到源头（不同 agent 的 payload 形状差异靠这一步兜底）。

- 命中：`drawEvents` 逐行记录 `eventRowHits`（`NSRect(x: 0, y: y - 2, w: bounds.width, h: rowHeight)`），
  `eventRowIndex(at:)` 反查；控制器在事件流里点空白不再关闭（避免误关），点行才 `openRaw(at:)`。
- 渲染：`drawRaw` 等宽 9pt、行高 13pt、一屏 12 行（`HUD.rawVisibleRows`），标题「原始事件」+ 右侧 `#seq KIND`；
  以 `"`/`{`/`}` 开头的行亮色（结构行），其余淡蓝（字符串内容）；`wrapRaw(width: 52)` 折行。
- 数据：`rawPayload(for:)` 优先用事件记录的 **`raw`** 字段（桥梁写入的原始通知 params），否则整条记录；
  头部拼 `#seq kind notification at`。
- 返回：底部 `‹ 返回事件流`（`.backToEvents`）或点空白 → `backToEvents()`；滚轮由 `scrollRaw` 处理。

#### 4.2.7 点会话行跳回 DSH（跨进程跳转）

原生 HUD 在另一个进程里，**它不能直接操作页面状态**，所以跳转走「信箱 + 轮询」：

1. HUD 点会话行 → `sessionRowHitId` → `jumpToSession(id)`：把 feed URL 的末段 `radar` 换成 `jump`，
   GET `/x-radar/jump?session=<id>`，随后 `activateDSH()` 把 DSH 拉到前台。
2. 宿主把请求写进 `~/.dsh/agent-bridge/jump.json`（`{sessionId, at}`）。
3. 页面侧 **client 半**（无 UI，申报 `dsh.client`、不注册任何 slot）每 **1.2s** 拉 `/x-radar/jump-pending`，
   有值就 `uiWorkspace.openSession(id)`（多级回退：服务本体 → `.actions` → `.controller` → `ctx.layout`），
   成功后 `/x-radar/jump-ack` 清空信箱。
4. **15 秒过期**：离开电脑回来时，旧请求不会突然把你弹到别的会话。

注意三点：
- client 半必须声明 `dsh.client.platform = "web"`，否则 `dsh-client-modules` 的 `parseDshClient` 直接丢弃该 entry。
- 该半没有可见 UI，所以加载确认只能靠 `apply` 里的一次性 beacon（`/x-radar/beacon?e=client.apply`）。
- 页面换 client bundle 需要**整页重载**（`__DSH_BOOT__` 在启动时注入）。

#### 4.2.8 面板内直接审批

审批的数据源头在 Agent Bridge（它才握着 JSON-RPC 的 pending request），雷达只做「合并 + 代理」：

1. `buildRadar` 里先取端口，`GET http://127.0.0.1:<port>/agent-bridge/approvals`（1.2s 超时，失败就当没有），
   把每条审批变成 `{kind:"approval", approvalId, agent:"codex", title:<命令或理由>, status:"needs-approval"}`。
2. 这些行排在列表**最前**（桥侧 5 分钟不处理会自动 decline，所以它有时限；`counts.approvals` 也只数 `kind==="approval"`）。
3. HUD 点击 → `.approval` 视图（标题「任务审批」+ agent 徽标 + 命令正文 + 「✕ 拒绝」「✓ 批准」）。
4. 按钮 → `GET /x-radar/approval-decide?id=<approvalId>&decision=accept|decline` → 雷达代理
   `POST /agent-bridge/approvals/<id> {"decision":...}` → 成功后关详情并刷新 feed。

坑：`bridge` 对未知 id 返回 `{"ok":false}`（HTTP 404 会被代理成 502），HUD 会把它打印成
`approval decide decline -> {"ok": false}` —— 这是正常失败，不要当成网络错误。

#### 4.2.9 父会话聚合 + 「只有 Agent Team 才展开成员」（2026-11-16 定稿）

两层规则，别混：

1. **行 = 父会话**。子会话（带 `parentSessionId`）永远不单独成行，也不单独计数。
2. **成员页只对 Agent Team 开放**。团队判定是**两个来源取或**（只认 `enabled` 会漏判，2026-11-16 踩过）：
   `projections.values.agentTeam.enabled === true` **或** `subagentCatalog` 里存在 `label` 以
   `agent-teams:` 开头的条目。普通会话调 subagent 只是内部动作，点父会话直接 `jumpToSession`，
   不展示成员。
3. **完成的成员 30 分钟后自动消失**：`FINISHED_TTL_MS = 30 * 60 * 1000`；成员若「任务状态含 已完成」
   或「空闲」且 `Date.now() - updatedAt > 30min`，从 `children` 与 `childCount` 里一并剔除
   （`childCount` 必须用过滤后的 `members.length`，否则会出现「显示 4 名成员但列表空」）。

```js
// 判断是不是团队会话
const team = values.agentTeam?.enabled === true
const catalog = values.subagentCatalog ?? []                // [{id, label, mode}]
const tasks = values.agentTeam?.tasks ?? []                  // [{id, subject, status, ownerId}]

// 成员 = 看板 owner ∪ catalog，按成员 id 去重
const byMember = new Map()
for (const t of tasks) if (t.ownerId) push(byMember, t.ownerId, { task: t })
for (const c of catalog) push(byMember, c.id, { catalog: c })

children = team ? [...byMember].map(([id, x]) => ({
  id,
  role: x.catalog?.label ?? '',
  title: x.task?.subject ?? x.catalog?.label ?? '',
  taskStatus: x.task ? zhTask(x.task.status) : null,   // 待处理/进行中/已完成
  status: childRow(id)?.running ? 'running' : 'idle',
  tokens: …, updatedAt: …,
})).sort(byRunningThenTaskThenUpdated) : []
```

HUD 侧（v0.3.12 起，按用户反馈「外环弧完全看不懂」重设计）：
- **圆内只保留大数字**（正在处理的父会话数），需批准时整圈变红 + 呼吸点；**禁止**外环分段弧、
  成员状态小点、圆内缩写——这些图形无法表意，用户明确说看不懂。
- 身份与进度全部放到**悬停即展开**的面板：表头右侧 `已完成/总数 完成`（如 `0/2 完成`）；
  每个团队行副标题 `2/5 完成 · 当前 editor`（`done = children.filter(任务状态含已完成)`，
  `current = children.first{ running }`，取 `role ?? displayTitle`）。
- 点行：`item.team == true && childCount > 0` → `openChildren(item)`；否则 `jumpToSession(item.id)`。

排障：`GET /x-radar/debug-sessions` 看 `projections.values.agentTeam` 是否 `enabled`。

**团队判定的两个来源**（2026-11-16 修过漏检）：

```js
team = values.agentTeam?.enabled === true
    || (values.subagentCatalog ?? []).some(e => e?.label?.startsWith('agent-teams:'))
```

只认 `agentTeam.enabled` 会漏掉「用 subagent 工具临时起一支 team」的会话（看板没开、成员确实在跑），
用户报的「智能硬件会话调了 agent team 但胶囊没显示」就是这个坑。

**56pt 圆里的进展表达**（尺寸不变，只增加信息密度）：

| 元素 | 含义 | 实现 |
|---|---|---|
| 圆内大数字 | 正在处理的父会话数 | `state.taskCount` |
| 外环分段弧 | 每个活跃任务一段（蓝运行/橙等批准/绿完成未看），最多 4 段 | `activeItems.prefix(4)` + `NSBezierPath.appendArc`，半径 `w/2-3.0`、线宽 2.0 |
| 内圈细弧 | 团队完成比例 = 已完成成员/成员总数 | `state.teamFraction`，半径 `w/2-6.6`、线宽 1.8 |
| 圆底小点 | 团队成员状态（绿进行/亮灰完成/暗灰待处理），≤6 个 | `state.teamDots`，尺寸 3.4、间距 5.2、y=5 |
| 圆上小点 | 有任务等批准时变红呼吸（已有） | `dotView` + `pulse` |


#### 4.2.10 历史 run 的事件回填（桥梁侧）

宿主重启后内存里的 `run.events` 是空的，老 run 会显示「没有事件」。

- `plugins/dsh-agent-bridge/index.js` 的 `RunStore.hydrate(run)`：`events.length === 0` 时从
  `~/.dsh/agent-bridge/runs/<id>/events.jsonl` 逐行解析回填（保留最后 4000 条），并把 `this.seq` 提到最大 seq。
- `GET /agent-bridge/runs/<id>` 与 `/stream` 两条路由拿到 run 后都先 `hydrate`，所以历史 run 与直播 run 走同一套前端。

### 4.3 绘制

- 根视图已改为普通 `NSView`（透明）；**圆与面板各自画背景**：圆深色 `0.06/0.42` + 边框；面板 `0.08/0.90` + 1px 描边。
- 数字：`numberFontSize 24`，必须显式 `NSMutableParagraphStyle(.center)`（默认左对齐会挤成一条竖条）。
- 呼吸圆点：`CABasicAnimation(opacity 1→0.35, 0.6s, autoreverse, infinity)`。
- **待批准红色脉冲**（v0.2.4）：`approvals > 0` 时整个圆压一层红（α 0.16–0.26）+ 描边 2.2–3.2pt
  （α 0.80–1.0）+ 圆点转红呼吸；脉冲由 20fps `pulseTimer` 驱动 `pulse ∈ [0,1)`，周期 1.4s。
  **只在 `approvals > 0` 时创建定时器**，其余时间零额外开销。
- 空闲（无运行/无待批）整体 `alpha 0.72`，避免抢注意力。

### 4.4 进程与生命周期

- 单实例：读 `hud.pid` 判断；抢占失败 `exit 0`。
- `--url auto`：每轮重读 `radar-url.json`（DSH 端口每次重启都变）；读不到回落上次成功的 URL；连续失败进 `mode=offline`（保留数字 + 显示「离线」小字）。
- 退出：SIGTERM/SIGINT 时保存位置、删 pid 文件、`NSApp.terminate`，兜底 `exit(0)`。
- 调试开关：`--mock <json>`（离线回放）、`--expand`（强制展开便于截图）、`--interval`。

---

### 4.3 Claude Code 适配（`plugins/dsh-agent-bridge`）

Codex 走常驻 `app-server`；Claude 是**一个 run 一个子进程**：`claude -p <prompt> --output-format stream-json
--verbose --include-partial-messages --settings <run>/claude-settings.json --permission-mode default`。

**为什么用 `-p` + `--settings`**
- `-p` 的 stream-json 是行 JSON，和 Codex 一样好解析；`--settings` 能让 CLI 读我们写的 hooks，
  **注意**：`HOME` 里的 `~/.claude/settings.json` 也会生效，所以 hooks 只在每 run 的 settings 里加，
  不污染用户全局配置。
- 事件形状（2.1.312 实测）：`system{init|status|commands_changed}`、`stream_event{content_block_delta}`
  （`text_delta` / `thinking_delta`）、`assistant`（完整 message，含 `tool_use` 块）、`user`（`tool_result`）、
  `result`（`result`/`session_id`/`usage`/`duration_ms`/`num_turns`/`total_cost_usd`/`permission_denials`）。

**事件归一化**（`claudeRows()`，与 `normalize()` 共用 `kind` 词汇）
| stream-json | 我们的 kind | 备注 |
| --- | --- | --- |
| `system/init` | `status` | 带 `sessionId`/`model`/`toolCount` |
| `stream_event.text_delta` | `text` | 增量；`sawText` 置真 |
| `stream_event.thinking_delta` | `reasoning` | |
| `assistant.tool_use` | `item.start` | `title=工具名`，`detail=命令/路径` |
| `user.tool_result` | `item.end` | `ok=!is_error`，`detail=输出前 160 字` |
| `result` | `turn.end` | `finalAnswer=result`、`usage` 换算成 `{total:{totalTokens,...}}` |

**审批闸门（关键坑）**
- `PermissionRequest` hook 在 `-p` 模式下**不会触发**（实测两次，工具直接执行）→ 不能用它做审批。
- 真正可用的是 **`PreToolUse`**：payload `{session_id, tool_name, tool_input, permission_mode, ...}`，
  我们在 `/agent-bridge/claude-hook?run=<id>` 里判断：
  - 工具在 `CLAUDE_AUTO_ALLOW`（只读类）→ 立刻 `{"continue": true}`；
  - 否则登记 approval（`{id:'claude-N', agent:'claude', params:{tool,input}}`）→ **把 HTTP 响应挂住**
    等 HUD 决定（25s 超时自动 `deny`）→ 回
    `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"|"deny"}}`。
- 二级细节：`settleApproval()` 现在两种审批并存——Codex 用 `host.respond(id,{decision})`，
  Claude 用 approval 上的 `resolve` 回调（Promise），别把两者写串。

**验收脚本**（在宿主端口上）
```bash
PORT=51997
RID=$(curl -s -X POST "http://127.0.0.1:$PORT/agent-bridge/runs" -H 'content-type: application/json' \
  -d '{"agent":"claude","prompt":"只回答两个字：可以"}' | python3 -c 'import json,sys;print(json.load(sys.stdin)["runId"])')
curl -s "http://127.0.0.1:$PORT/agent-bridge/runs/$RID?limit=200" | python3 -m json.tool
# 需要审批的任务：
curl -s -X POST "http://127.0.0.1:$PORT/agent-bridge/runs" -H 'content-type: application/json' \
  -d '{"agent":"claude","prompt":"用 Bash 执行 echo hi"}'
curl -s "http://127.0.0.1:$PORT/agent-bridge/approvals"      # 应出现 claude-N
curl -s -X POST "http://127.0.0.1:$PORT/agent-bridge/approvals/claude-1" -H 'content-type: application/json' -d '{"decision":"accept"}'
```

## 5. 开发与验收流程

### 5.1 改 JS（插件）

```bash
# 1) 编辑 plugins/dsh-task-radar/index.js 或 dsh-agent-bridge/index.js
# 2) 语法自检
node --check plugins/dsh-task-radar/index.js
# 3) remove_bundle → install_bundle（plugin_manager 工具，target 用绝对路径）
# 4) 验证
tail -20 /tmp/dsh-task-radar/beacon.log
curl -s "http://127.0.0.1:$(python3 -c "import json;print(json.load(open('$HOME/.dsh/agent-bridge/radar-url.json'))['port'])")/x-radar/radar" | python3 -m json.tool | head -30
```

### 5.2 改原生 HUD

```bash
cd plugins/dsh-task-radar/native
bash build.sh                       # 产出 RadarHUD（arm64 Mach-O）
kill $(cat ~/.dsh/agent-bridge/hud.pid) 2>/dev/null; rm -f ~/.dsh/agent-bridge/hud.pid
# 再 remove_bundle + install_bundle 让插件重新拉起
```

### 5.3 验证工具箱（都在 /tmp，模型无法看图时的替代手段）

| 工具 | 作用 |
|---|---|
| `/tmp/wininfo` | 用 `CGWindowList` 打印所有窗口 `id/layer/alpha/onscreen/bounds`，验证层级与几何 |
| `/tmp/ocr` | macOS Vision OCR，读出面板/圆内文字 |
| `/tmp/drag <x1> <y1> <x2> <y2>` | CGEvent 合成拖拽，验证拖动与位置持久化（会短暂接管鼠标） |
| `/tmp/click <x> <y>` | CGEvent 合成单击 |
| `/tmp/radar-smoke.mjs` | stub 环境执行客户端渲染逻辑（历史遗留，窗口内角标已移除） |
| `/tmp/radar-mock-approval.json` | 含 `approvals:1` 的 mock feed，测红色脉冲 |
| `screencapture -l <winId> -o x.png` | 抓单窗口（保留 alpha）：四角 `(0,0,0,0)` 证明无白底 |

验收模板（每次改 HUD 必做）：

```bash
ID=$(/tmp/wininfo | grep -o "RadarHUD id=[0-9]*" | head -1 | cut -d= -f2)
/tmp/wininfo | grep -A6 "DSH Task Radar"          # 收起 56×56 / 展开 320×H
screencapture -l "$ID" -o /tmp/hud.png            # 透明角 + 数字
/tmp/ocr <(python3 -c "from PIL import Image;im=Image.open('/tmp/hud.png');im.resize((im.width*6,im.height*6)).convert('RGB').save('/tmp/big.png')"; echo) /tmp/big.png
```

### 5.4 提交前 checklist

- [ ] PRD 已先更新（需求/验收/变更记录）
- [ ] `node --check` 通过；`bash build.sh` 无警告
- [ ] `remove_bundle → install_bundle` 返回 `application:"applied"`
- [ ] `beacon.log` 出现预期事件（无 `error.stack`）
- [ ] 几何/OCR/透明度三项证据齐全（贴到 PRD §7.1）
- [ ] 旧行为未被破坏（悬停展开、双击跳转、拖动记忆、单实例、离线降级）

---

## 6. 已知坑（都踩过，别再踩）

1. `sessionController.list()` 返回 `{items:[...]}` 信封 → `Array.isArray` 判断必错，会静默回退到 `sessions` 源。
2. 标题必须取 `projections.values.title`，否则显示 cwd 基名。
3. `webServer.register` / `slots.register` 不放 `ctx.effect` → 热替换后 `duplicate prefix route` 安装失败。
4. webserver handler 必须接 `(req, res)`，漏 `res` 会在运行时 500。
5. `NSVisualEffectView` + `.hudWindow` + `behindWindow` 在浅色桌面下渲染成白方块。
6. `window.performDrag` 与悬停收起互相打架 → 手写拖动 + `isDragging` 守卫。
7. 56pt 圆内的文字默认左对齐 → 必须显式段落居中。
8. `NSScreen.main` 跟随焦点窗口 → 默认位置改用 `NSScreen.screens.first`（主显示器）。
9. 原生窗口在 `.screenSaver` 层级会截获其覆盖区域内的所有鼠标事件（曾把 DSH 右上角胶囊压死，表现为「点击没反应」）。
10. DSH Web 端口每次重启都变 → 任何硬编码端口都会在某次重启后失效，必须走 `radar-url.json`。

---

## 7. 路线图（近期）

| 阶段 | 内容 | 状态 |
|---|---|---|
| P1-b | 时间线 UI：`/agent-bridge/runs/<id>/stream` 的 SSE 原样渲染（来源徽标 + 原始 payload 可展开） | 出口已完成，UI 未做 |
| P2 | Claude Code 接入（Agent SDK `canUseTool` + PermissionRequest HTTP hook；CLI 直驱不冒泡审批） | 待做 |
| P3 | WorkBuddy 桌面端 CDP 驱动（DSH 负责启动；单实例锁 → 先让用户退出或托管启动） | 实测完成，集成待做 |
| P4 | 内嵌原生视图 + 接管（`sidebar.right.pane.tab` + 独立 PTY） | 待做 |
| P2.5 | R8 验收门（L1 判别 + 通知门），待确认判别模型族 / 默认自主度 / DoD 生成方式 | 设计完成 |
| P6 | 稳定性收口：N1（版本钉住/故障隔离/幂等落盘/降级徽标/零回归/可运维） | 持续 |

---

## 8. 变更记录

| 日期 | 版本 | 内容 |
|---|---|---|
| 2026-11-17 | v0.17 | 修 `syncSessions`：读 `storageDomain.get('workspace')` 的 `global.archivedSessionIds`，归档会话跳过建记录、且 prune 时视为不存在（否则归档会话会被 listSessions 反复同步回未归属）；`buildState` 的 sessions 增 `cwd`，未归属项目在客户端按目录分组展示。 |
| 2026-11-17 | v0.16 | 新增路由：`/api/phase/restore-revision`（按 `at` 回到某一版，写入新修订含 `restoredFrom`）、`/api/branch/diff`（分支 vs 主线：`branchPhases`/`mainAfterFork`/`openProblems`）、`/api/trash`（占用量统计）与 `/api/trash/empty?confirm=1`（清空后 `trashedArtifacts` 置空并记 `trashedArtifactsPurgedAt`）、`/api/consistency/fix`（清残留指针，回 `removedFromPhase/removedFromRecord`）、`/api/phase/rescan`（按 `phase.startedAt` 扫描补 artifacts）；`attachSessionToBranch(...,allowMove)` 跨项目时先 `migrateSession`；`mergeBranch` 返回 `conflicts`（标题归一化后与主线分叉后阶段同名）。客户端：修订历史列表、BranchDiff 弹窗、回收站占用/清空、一致性自动修正、重扫产物、筛选条（status + 只看未解决）、跨项目挂会话。测试：`npm test` 跑 `test/journal-store.test.mjs`（HOME 指向临时目录后动态 import，避免污染真实 journal）。 |
| 2026-11-17 | v0.15 | §4.6 增「删除阶段 = 裁剪上下文」：`trashPhaseArtifacts` 用 `renameSync` 把阶段产物移到 `TRASH_DIR`（按 `<projectId>/<phaseId>/<相对路径>` 保结构），`restorePhaseArtifacts` 原路移回；会话记录打 `hidden/hiddenBy` 标记，`buildState` 的 sessions、`runReproject` 的 ids、`summarizeSession` 都要过滤；`/api/artifact/open` 自然失效（文件已不在项目内）。维护路由 `workspace-create/workspace-delete/session-create` 必须 `confirm=1`，`session-create` 支持 `cwd` 或 `workspaceId`（只能二选一，走 `sessionController.create`）。对应 PRD v0.11.8 |
| 2026-11-17 | v0.14 | §4.6 增：进展记录是派生视图——编辑会通过 `phaseContext`/`branchContext`/`buildSeed` 影响后续归纳与开分支，因此必须保留 `phase.revisions`（手改快照，最多 20 条，`phaseBrief` 输出 `revisionCount`）；删除默认软删除 `deletedAt`（`branchPhases`/`resequence`/`phaseContext` 都要过滤，且 `resequence` 末尾要保回软删除阶段，否则会被静默丢弃——这是实测踩到的 bug）；永久删除走 `hard=1`；`buildState` 输出 `trash` 与 `consistency`（会话指已删阶段 / 阶段列不存在或跨项目会话）。客户端打点 `client-v12`。对应 PRD v0.11.7 |
| 2026-11-17 | v0.13 | §4.6 增：客户端编辑态放 store（`editingPhaseId`）而不是组件内联 state——宿主 5s 轮询/重渲染会让内联展开看起来「点了没反应」；弹窗必须作为元素渲染 `h(ConfirmModal)`，**不能** `ConfirmModal()` 直接调用（hooks 顺序随弹窗开关变化，React 会报错且面板白屏）；删除阶段只删 journal 记录并清理 `state.sessions[*].phaseIds` 里的成员引用。客户端打点升 `client-v10`。对应 PRD v0.11.6 |
| 2026-11-17 | v0.12 | §4.6 增：未归属会话归纳（locked 提示词分支、`rebuild=1` 重置游标——增量 0 会让「重新归纳」变成空操作）、产物打开路由（`/api/artifact/open`：相对路径 join 项目目录 + `inside()` 校验，`open` 前必须挡目录穿越）、`/api/branch/unmerge`（按 `mergedPhases` 回退并恢复会话 `branchId`）、**客户端不要用 `window.prompt`**（Electron 渲染层无实现，点击无反应，改用内嵌输入组件）；客户端版本打点升至 `client-v9`。对应 PRD v0.11.5 |
| 2026-11-17 | v0.11 | §4.6 增：面板顶部跨项目检索（纯客户端过滤阶段/问题/下一步/分支名，点结果切换 projectId+branchOf）、`GET /api/export?projectId=` 输出 Markdown（`new Response` + text/markdown，未走 json 包装）、「导出 MD」下载并尝试 `navigator.clipboard`、底部角标改「未解决问题数」；客户端版本打点升至 `client-v8`。对应 PRD v0.11.4 |
| 2026-11-17 | v0.10 | §4.6 增：阶段 `nextSteps` 数据模型与合并/兜底规则（硬约束 12）、会话目录体检与 prune 的验证陷阱（硬约束 13）；面板新增「接下来」汇总条、项目行「下一步 N」角标、阶段卡 `+ 下一步`/× 移除、PhaseEditor 多行编辑；`buildState` 输出 `suggestions`（cwd 属于别的项目）+ 一键迁移条；修「重做 · 重做」双前缀。对应 PRD v0.11.3 |
| 2026-11-16 | v0.9 | §4.6 补：面板阶段卡「会话」chip 点击经 `ctx.get('uiWorkspace').openSession(id)` 直达会话（客户端 `inject` 只有 `slots`，服务用 `ctx.get` 取，启动时打 `ui-workspace:ready|missing` beacon）；分支条新增「重命名」（`/api/branch/status?action=rename&title=`）与「打开分支会话」；主线 prefix 阶段也能「从主线此阶段开分支」（只读不等于不能分叉）；开分支成功用 `notice` 绿条回报继承事件数；新增维护路由 `/api/session-prompt?sessionId=&text=`（走 `sessionController.prompt` + 30s signal，仅调试用）与 `/api/model-probe`（强制重解析模型，返回 `{model,error}`）；boot 时预热 `resolveModel()` 并打「模型就绪」beacon（否则 `state.model.ready` 常态 false，看着像坏了）；删除分支按钮改为「分支已放弃即可点」，服务端仍以 `branch-not-empty` 守门 |
| 2026-11-16 | v0.8 | §4.6 硬约束 11 补「atSeq 必须是 completed-turn 边界」的 snap+重试链、`fork-failed` 面板可见、分支会话数双过滤；ForkDialog 的承接默认值改为「会话可用即勾选」，`confirm` 在 context 缺失时重取 `/api/branch/seed` 再决定 fork/blank |
| 2026-11-16 | v0.7 | §4.6 分支会话改为 `sessionController.fork` 承接上下文：新增硬约束 11（atSeq 含端、cursorSeq=atSeq、切点回退规则）、`mode=fork|blank`、ForkDialog 承接勾选。对应 PRD v0.9.0 |
| 2026-11-16 | v0.6 | §4.6 补会话记录 prune 规则与两个维护路由（session-archive / session-record） |
| 2026-11-16 | v0.4 | 补 §4.6 一条：空分支导致面板无按钮的修法（activeBranchId 归一 + 客户端兜底） |
| 2026-11-16 | v0.3 | 增 §4.6 `dsh-project-journal`：journal v3 数据模型（项目/阶段/问题/分支/会话游标）、10 条硬约束（GET-only 路由、0 基 seq、async listSessions、prompt 必传 signal、storageDomain 改归属、阶段随会话迁移、标题兜底、客户端 name=槽位名 + inject:['slots']、llm.stream 形状）、增量与回填、R10 分支重做与种子会话、验证路径。对应 PRD v0.8.0 |
| 2026-11-16 | v0.2 | 增 §4.2.5 事件流实时跟随（1.5s 增量 / 不抢滚动 / 收尾只刷新摘要不覆盖事件）、§4.2.6 单条事件原始 payload（`eventRowHits` / `drawRaw` / `wrapRaw`）、§4.2.7 历史 run 事件回填（`RunStore.hydrate`）。对应 PRD v0.4.4 |
| 2026-11-16 | v0.1 | 首版：分层地图、数据契约（feed / session 形状 / 状态文件）、Host 与 HUD 实现纪律、验证工具箱、10 条已知坑、路线图。对应 PRD v0.4.0（HUD 红色脉冲 / 去掉白底 / 拖动位置记忆） |

## 4.4 dsh-judge：L1 验收判别层

**为什么**：worker 说「我做完了」不等于做完。判别层把「完成」变成一个**有证据的裁决**，并决定要不要发通知。

**四步流水线**
1. `POST /dsh-judge/contract {runId, originalAsk, checks[], expectations[]}` → 落 `verify/<runId>/contract.json`；**重复签发 409**（扩范围请新建任务）。
2. **确定性检查先跑**：`file-exists`（可带 `minBytes`）、`command`（`argv` 数组，禁止 shell 字符串）、`min-lines`。任一失败 → `needs_revision`，`reason: deterministic_failed`，**不调用判别模型**（省钱且快）。
3. 通过后再让 LLM 只读裁决：OpenAI `/v1/chat/completions` 或 Anthropic `/v1/messages`，prompt 明确「worker 自述不算证据」「输出单个 JSON」。解析失败 → `judge_unparsable`，按未验证处理，绝不放行。
4. `needs_revision` 且 `autonomy ∈ {L2,L3}` 且 `round < maxRounds` → 自动 `POST /agent-bridge/runs` 返工，prompt 只带 `required_fixes` + `missing`，并写 `rounds.json`。

**三个「不许」**：无契约不许 verified（→ `blocked / no_contract`）；无判别模型不许 verified（→ `unverified`）；达到 `maxRounds` 不许继续打回（→ `max_rounds`，升给人）。

**通知门在雷达侧**（`plugins/dsh-task-radar/index.js` 的 `gateStatus()`）：`verified→done`、`needs_revision→rework`、`blocked→blocked`、其余→`verifying`；`done` 且无契约 → `unverified`。HUD 行副标题据此显示「待验收 / 返工中 N/2 / 需你决定 / 未验证完成」。

**配置**：`~/.dsh/agent-bridge/judge.json` → `{autonomy, maxRounds, judge:{protocol, baseUrl, model, apiKeyEnv, timeoutMs}}`。`judge` 为 `null` 时所有任务停在「未验证完成」——这是刻意的失败安全姿态，不是 bug。

**审计**：`verify/<runId>/history.jsonl` 每行一次裁决（含 `required_fixes`），`rounds.json` 记录轮次与返工 runId。

## 4.5 Agent Bridge 客户端半（时间线内嵌，0.1.6）

**为什么有这一层**：宿主半（`index.js`）只有 HTTP；要在 DSH 里看见外部 run，必须有 `dsh.client` 半注册 UI 座位。

- 客户端 bundle **不转译**：`client.js` 不能写 JSX，只能 `React.createElement`；也只能 `require` seed 模块（本插件只用 `react`）。
- 两个座位：`shell.overlay`（`agent-bridge-timeline`，全屏浮层）与 `sidebar.footer.action`（`agent-bridge-entry`，侧边栏底部「⇄ 外部任务」，带活跃数角标）。
- 打开方式：footer 按钮 `window.dispatchEvent(new CustomEvent('dsh-agent-bridge:open'))`，浮层监听该事件。
- 数据：`GET /agent-bridge/runs`（2s/5s 轮询）、`GET /agent-bridge/runs/<id>?since=<seq>&limit=500`（运行中 1.5s）、`GET /agent-bridge/approvals`、`POST /agent-bridge/approvals/<id> {decision:'accept'|'decline'}`。
- 打点：`GET /agent-bridge/beacon?e=&d=` → `/tmp/dsh-agent-bridge-client.log`；该文件为空即「客户端半没跑起来」。
- 坑：改完 `package.json` 必须 `plugin_manager remove_bundle` + `install_bundle`（绝对路径）；客户端半要整页重载才生效。

## 4.6 dsh-project-journal：项目进展（R9）+ 分支重做（R10）

**要解决的问题**：同时开四五个会话时，人记不住别的会话做到哪一步；隔几个月回来更记不住「当时为什么这么做」。所以把「项目阶段链」做成可看、可回溯、可纠错的记忆层。

### 数据模型（`~/.dsh/project-journal/journal.json`，version 3）

- `projects[id] = { id, title, locked, activeBranchId, branches[], phases[], createdAt, updatedAt }`
- `branches[] = { id, title, fromPhaseId, fromSeq, status: active|merged|abandoned, seedSessionId, createdAt }`；`main` 是内建主线，不可删不可改状态。
- `phases[] = { id, seq, title, summary, nextSteps[], artifacts[], problems[], branchId, redoOf, manual, startedAt, ... }`；`nextSteps` 是「接下来还需要做什么」（≤6 条、每条 ≤120 字，手改后整组保护）；`seq` 是**分支内**序号。
- `problems[] = { id, statement, quote, resolution, status: open|solved, manual }`；`quote` 必须是该会话用户原话的连续子串，否则丢弃。
- `sessions[id] = { sessionId, projectId, phaseIds[], cursorSeq, branchId, title, state: pending|done|failed, lastError }`；`cursorSeq` 是**已消费到的 0 基 seq**，新记录从 `-1` 起。
- `unassigned`（locked）桶：不在任何 workspace 的会话（如 `~/.dsh-im`）；不能作为迁移目标，也不会自动建阶段。

### 硬约束（踩过才知道）

1. **webserver prefix 路由只服务 GET/HEAD**（`RESOURCE_METHODS = "GET, HEAD"`）→ 所有写操作走 GET + query（`/api/branch?...`、`/api/migrate?...`），POST 会在匹配前就 405。
2. **会话 seq 是 0 基**（`sessionQuery` 里 `loaded.events[seq]` 直接当下标）→ cursor 初值必须 `-1`，否则第一轮 delta 为空、记录被误标 done。
3. **`sessionQuery.listSessions()` 是 async**；漏 `await` 会拿到 Promise 当空数组（表现为「5 个项目但 0 会话」）。
4. **`sessionController.prompt(request, signal)` 第二参必传 AbortSignal**，否则网关里 `signal.throwIfAborted()` 抛 `Cannot read properties of undefined`；用 `AbortSignal.timeout(30000)`。
5. **`sessionController.create({workspaceId|cwd})` 二者不能同给**；给 `workspaceId` 时会 `workspace.attachSession`，会话直接进对应项目。
6. **迁移不直接改 `workspace.json`**：用 `ctx.get('storageDomain').get('workspace').table('workspaces').update(id, fn)`；live domain 内存值会覆盖外部改文件。写前先备份到 `~/.dsh/project-journal/backups/`。
7. **阶段随会话迁移**：迁移时把该会话的阶段带过去（源项目释放；共享阶段在目标项目克隆并换 id），不再新建「迁入 · 会话名」占位阶段（旧做法往返迁移会重复且丢明细）。
8. **标题**：`sessionQuery.readTitle()` 常为 `undefined`（很多会话没有 titler）→ 兜底取首条 `user/message` 文本前 42 字。
9. **客户端插件契约**：`factory` 返回 `{name, inject:['slots'], apply(ctx)}`；`slots.register` 的 `name` **必须等于槽位名**（自定义 id 放 `id`）；注册都放 `ctx.effect`。
9.1 **空分支会让面板「看起来点不动」**：若 `activeBranchId` 指向已放弃/零阶段分支，面板默认打开该分支 → 0 张阶段卡 → 「改阶段/重做」根本没有按钮。修法：`setBranchStatus` 在 abandoned/merged 时把 `activeBranchId` 归 `main`，`migrateJournal` 加载时把非 active 的 `activeBranchId` 归 `main`，客户端 `branchSelected` 只在分支 `status==='active'` 或 `phaseCount>0` 时才自动选中。
10. **模型调用**：`ctx.llm.stream({provider, model, messages:[{role:'user',content:[{type:'text',text}]}], temperature:0.2, maxTokens:2400, purpose:'project-journal'})`；provider/model 从 `listProviders()/listModels()` 解析，默认 `deepseek` + 名字含 chat/flash 的模型。
11. **承接上下文靠 `sessionController.fork({sessionId, atSeq})`**：`atSeq` 是**含端**事件序号 ✓，返回 `{sessionId}`；fork 出的会话继承该前缀的全部事件，故 journal 记录的 `cursorSeq` 必须直接设成 `atSeq`（否则会把继承来的历史再总结一遍）。阶段来源切点优先用 `phase.sourceSessionId/sourceSeq`；老阶段没有 `sourceSeq` 时用「同分支下一阶段 `startedAt`」回退（事件 `time` 可能是 number 或 ISO，要两者都试），再退会话末尾。
   **`atSeq` 必须落在 completed-turn 边界**：`readSession` 里 643 个事件里 `seq=642` 只是最后一个事件，fork 会以 `atSeq must be a completed-turn boundary` 拒绝（本轮真实踩坑）。做法：`snapToTurnEnd(sessionId, seq)` 找 `type==='turn/end'` 且 `seq<=atSeq` 的最后一个；按 `[snapped, atSeq, undefined]` 依次重试 `fork`（`undefined` 即「最近一个完成轮次」），全部失败才退回 `create`+种子，并把 `warning:'fork-failed'` 写进分支记录与面板 error。
   **分支会话数按项目+分支双过滤**：`buildState` 里 `sessionCount` 必须 `record.projectId === project.id && record.branchId === branch.id`，否则每个项目的主线都会显示全部会话数（32）。

12. **`nextSteps` 的合并规则**：`applySummary` 只在模型给出非空数组时整体替换（空数组不清空，避免模型偷懒把已有清单抹掉）；`phase.manual === true` 跳过；`status === 'active'` 且仍为空时，用该阶段 `open` 问题兜底生成 `处理：<陈述>`（≤3 条）。注意兜底必须放在 problems 合并**之后**，否则用的是上一轮的旧问题集。
13. **`window.prompt` 在 DSH 渲染层是空操作**：点了既不弹窗也不报错，表现为「按钮没反应」；任何需要输入的交互都要用内嵌 input/textarea 组件（`StepForm`、`BranchRename` 即此教训）。
14. **会话目录体检的 prune 陷阱**：`buildState` 的 `suggestions` 依赖 `record.cwd`（`syncSessions` 每轮从 `header.cwd` 刷新）。`syncSessions` 会删除「不在 `listSessions` 且未被阶段引用」的记录，所以**不能靠往 journal 里手塞假会话来验证**——下一轮就被 prune 掉；要验证就用真实会话 + `workingDirectory` 改动，或直接单测纯函数。

### 增量与回填

- 触发：全局事件 `api-session/status(sessionId, running)` + `api-session/activity`（**不要**用 `agent/status`，那是 agent 作用域、根监听拿不到 sessionId），按会话防抖 1.5s。
- 回填：`/api/backfill?action=start|pause|reset`，串行 worker、每会话一次 `llm.stream`、节流 1.5s；`total` 为所有项目的历史会话数。
- 对账与清理：`syncSessions()` 每轮只补不删；新增的 prune 只在「本轮拿到非空会话列表」且「记录未被任何阶段引用」时，删除 DSH 已不存在（删除/归档）的会话记录，避免项目会话数虚高。会话被归档后不再出现在 `listSessions`，记录会被自动清掉。
- 合并：`applySummary` 用 `id` 或标题归一化命中既有阶段则更新（`manual` 字段跳过），否则新建并把上一个 active 置 done；`problems` 按归一化 statement 去重。

### 分支（R10，「从阶段 K 重做」）

- 语义：**只分流对话起点与进展链，不动工作目录文件**；现有进度不删除；代码级替换需用户显式确认。
- API：`/api/branch/seed`（预演分支名、种子 prompt 与 `context:{sessionId,seq,total}`）、`/api/branch`（建分支；`withSession=1&mode=fork` 默认分叉该阶段所在会话承接上下文，`mode=blank` 退回空白会话+种子）、`/api/branch/status`（merged|abandoned|active）、`/api/branch/delete`（只能删未动过的分支；删除时把该分支会话改回 main）。
- 视图：`BranchTabs` 只在 >1 分支时出现；分叉点之前的阶段作 `prefix` 灰显只读；分支首节点带 `↺ 重做` chip；分支工具条可标已合并/放弃/恢复/删除。
- 分支会话：默认 `sessionController.fork({sessionId, atSeq})` 继承阶段 K 结束前的对话历史（实测一次 fork 拿到 12357 条事件 / 115 turn），`prompt` 只在用户显式填写时才发；fork 失败才降级 `create({workspaceId}) + prompt` 种子，warning 记 `fork-failed` / `session-create-failed` / `seed-prompt-failed`。
- 弹层：`ForkDialog` 有「承接该阶段的上下文」勾选（有 `context` 时默认勾选，并显示将继承的事件数与切点）；种子文本留空即不发消息，等用户直接续写。

### 验证路径

```bash
B=http://127.0.0.1:<当前端口>            # 端口每次重启变，查 GUI URL
curl -s $B/x-journal/api/health          # ok / version:3 / sessionController:true
curl -s $B/x-journal/api/state           # projects[].branches[]/phases[]/sessions[] + beacons
curl -s "$B/x-journal/api/branch/seed?projectId=..&phaseId=.."   # 只读预演
curl -s "$B/x-journal/api/session-debug?sessionId=.."            # events/firstUser：验证种子是否落地
curl -s "$B/x-journal/api/session-archive?sessionId=.."          # 归档一个会话（可逆，面板/侧边栏都不再显示）
curl -s "$B/x-journal/api/session-record?sessionId=..&action=delete"  # 仅删 journal 记录（维护用）
```

客户端半是否加载：`/api/state` 的 `beacons` 出现 `client:client-v7`、`client:slot-ok:*` 即成功；出现 `client:render-error:*` 说明某个组件渲染抛错（已被 guard 兜住，不会白屏）。client.js 改动由 HMR 自动重载；index.js 改动用 `plugin_manager set_plugin target="include:dsh-project-journal" disabled→enabled`。


## 4.6 接管外部 agent 的原生 TUI（PTY + xterm）

目标：在 DSH 内直接操作 Codex / Claude Code 的真实终端界面，而不是只看事件流。

### 4.6.1 三层通道

| 层级 | 实现 | 适用 |
| --- | --- | --- |
| 结构化 | `POST /agent-bridge/runs`（app-server / `-p`） | 只关心结果与事件，不需要 TUI |
| OS 级 | `POST /agent-bridge/takeover` → `osascript` 开 Terminal.app | 想用真实终端、但可以离开 DSH |
| 内嵌 | `POST /agent-bridge/pty` + xterm 渲染 | 想留在 DSH 里打字 |

### 4.6.2 四个必须知道的坑

1. **`script(1)` 拿不到 tty**：macOS 用管道 stdio 调 `script -q /dev/null <bin>` 会报 `script: tcgetattr/ioctl: Operation not supported on socket`。必须用 `python3 pty_helper.py`（`pty.fork()`）给子进程分配真 tty。
2. **TUI 必须用终端模拟器渲染**：Codex 的输出是 `ESC7/ESC8` 光标定位 + 逐字符重绘，剥掉 ANSI 后得到的是散字（Claude 略好，仍有大量重绘）。所以前端必须加载 xterm（`GET /agent-bridge/assets/xterm.js`，宿主自己播，因为 `/plugins/<pkg>/assets/*` 对非 client 插件返回 404）。
3. **TUI 会查询终端能力**：启动时发 `ESC]10;?` / `ESC]11;?` / `ESC[c` / `ESC[>7u` 问前景色、背景色、设备属性、键盘协议；不应答会卡在 487B 左右不动。宿主侧 `answerTerminalQueries()` 回 `rgb:ffff/ffff/ffff`、`rgb:0000/0000/0000`、`ESC[?62;22c`、`ESC[?0u`。
4. **回调里不要用未定义的函数**：`index.js` 早期没有 `log`，我在子进程 `exit` 回调里调它，异常冒到宿主 → `dsh: fatal uncaught exception: ReferenceError: log is not defined`，整个应用退出。子进程回调必须自带 try/catch 或调用已定义的模块级函数。

### 4.6.3 尺寸自适应契约

- 宿主：`POST /agent-bridge/pty` 接受 `cols` / `rows`（夹紧 20–400 / 5–200，默认 80×24），写入 `~/.dsh/agent-bridge/pty-<id>.size`；
- 前端：`ResizeObserver` 监听 xterm 容器，按 `floor((w-8)/6.6)` 与 `floor((h-8)/15)` 估算列行，先 `term.resize` 再 `POST /agent-bridge/pty/<id>/resize {cols,rows}`；
- 宿主：写 size 文件并给 helper 发 `SIGUSR1`，helper 重读尺寸 → `TIOCSWINSZ` → 给子进程发 `SIGWINCH`，TUI 自己重排。

### 4.6.4 已知限制

- 一个 pty 会话只对应一个二进制实例，关闭面板不会杀进程（`POST /pty/<id>/close` 才杀），避免误关正在跑的任务。
- 没有做滚轮回看历史（`scrollback: 2000` 只在 xterm 内存里），刷新页面会丢屏幕内容，但 `stream?since=0` 可回放最近 20 万字符。
- 中文输入依赖 xterm 的 IME 支持，暂未在面板内验证。

## 4.7 dsh-bridge CLI：把外部 agent 结果送回对话

定位：**主路径**。DSH 会话里说一句「让 codex 做 X」，由 Agent 调 `plugins/dsh-agent-bridge/bin/dsh-bridge`，最终答案作为工具输出直接回到该会话的消息流；进度、审批、验收由 HUD 负责。

### 4.7.1 命令

| 命令 | 行为 |
| --- | --- |
| `run --agent codex\|claude --prompt "…" [--cwd DIR] [--model M] [--timeout 180]` | 建 run → 轮询到 `done/failed/cancelled` → stdout 打最终答案，stderr 打状态行 |
| `list [--limit N]` | 最近的外部任务 |
| `show <runId>` | 最终答案 + 全部事件 |
| `approve <approvalId> accept\|decline` | 处理挂起审批 |

### 4.7.2 端口发现

宿主 `apply()` 时写 `~/.dsh/agent-bridge/bridge-url.json`（`{url, port, updatedAt}`），CLI 每次调用重读；也可用环境变量 `DSH_BRIDGE_URL` 覆盖。DSH 的 Web 端口每次重启都会变，**不要把它硬编码**。

### 4.7.3 答案提取规则

`turn.end.finalAnswer` 优先；为空时按序拼接所有 `kind === "text"` 的 `text`。实测 Codex 的 `turn.end` 常常 `finalAnswer: null`，正文只在增量 `text` 事件里，所以两者都要处理。

### 4.7.4 与终端面板的分工

- 对话内调用（本 CLI）：默认形态，结果入对话，人不需要盯着。
- 内嵌 PTY 面板：可选形态，需要手动接管（敲 `/` 命令、切模型、看权限弹窗）时才打开。

## 4.8 办公产物：从工作区到 HUD 再到对话

三层职责严格分开，避免「又造一个面板」：

| 层 | 谁做 | 产物去向 |
| --- | --- | --- |
| 扫描 | `plugins/dsh-office-artifacts`（宿主半） | `GET /office-artifacts/list` → `~/.dsh/agent-bridge/artifacts.json` |
| 呈现 | `plugins/dsh-task-radar` 的 HUD | feed 里多一类 `kind: "artifact"`，最多 3 条，排在完成项之后 |
| 交付 | Agent 在任务收尾时 `present` | DSH 原生文件卡进对话（不复刻预览器） |

### 4.8.1 HUD 侧的 artifact 行

- 宿主 `artifactItems()` 读 `artifacts.json`，只保留 `updatedAt` 在 6 小时内（`ARTIFACT_KEEP_MS`）的条目，取前 3 条；
- 行结构 `{kind:'artifact', id:'artifact:<path>', agent:<doc|sheet|slide|pdf>, title:<文件名>, path, updatedAt}`；
- `RenderState.artifactItems` 参与 `rowCount` 与 `panelRows`（顺序：审批 → 运行中会话 → 运行中外部任务 → 待验收 → 完成未看 → 产物）；
- 点击：`PanelContentView.artifactRowPath(at:)` 命中 → `openArtifact(path)` → `GET /office-artifacts/open?path=` → Finder `open -R`。**不在这里预览内容**。

### 4.8.2 对话侧约定（不是插件能力）

插件无法往会话里塞消息，所以「产物卡入对话」是 Agent 的行为约定：

1. 任务涉及办公文件时，收尾前调一次 `/office-artifacts/list` 确认产物清单；
2. 用 `present` 把 1–4 个关键文件挂出来（路径必须是绝对路径）；
3. 对话里用一句话说明每个文件是什么，而不是罗列目录树。

### 4.8.3 实测证据

```
GET /x-radar/radar → counts {running:2, approvals:0, doneUnread:2, pending:2, artifacts:3}
 - artifact 演示.pptx   /tmp/office-demo/演示.pptx
 - artifact 阶段表.xlsx /tmp/office-demo/阶段表.xlsx
 - artifact 验证稿.docx /tmp/office-demo/验证稿.docx
HUD: expand panel={{1108,444},{320,414}} sessions=2   # 414pt = 5 行（2 会话 + 2 完成未看 + 1 产物占位）
```

## 4.9 WorkBuddy 桌面端接入（bridge 0.4.2）

**为什么是「重启 + CDP」**：WorkBuddy 是 Electron 应用且有**单实例锁**——已在运行时再带 `--remote-debugging-port` 启动不会开端口。所以 DSH 必须先 `osascript tell application "WorkBuddy" to quit`，再用 `open -na /Applications/WorkBuddy.app --args --remote-debugging-port=9333` 拉起，**并删掉子进程环境里的 `ELECTRON_RUN_AS_NODE`**（否则 App 报 `bad option`）。

路由（`plugins/dsh-agent-bridge/workbuddy.js`）：

| 路由 | 作用 | 实测 |
| --- | --- | --- |
| `GET /agent-bridge/workbuddy/state` | 探活 `127.0.0.1:18488/workbuddy/probe` + 查 CDP 页签，返回 `needsRelaunch` | `{running:true, version:"5.11.3", cdpReady:false, needsRelaunch:true}` |
| `POST /agent-bridge/workbuddy/launch` | 需要时退出重开并等 CDP 就绪 | `{ok:true, relaunched:true, waitedMs:1576, cdpReady:true}` |
| `POST /agent-bridge/workbuddy/send` | `Runtime.evaluate` 聚焦输入框 → `Input.insertText` → `Input.dispatchKeyEvent Enter` | `{ok:true, tag:"DIV"}`，消息真的发出 |
| `GET /agent-bridge/workbuddy/last` | 读 `[class*="markdown"]` 最后一屏，排除「模型名+时间」元信息行 | `{count:1, last:"收到"}` |

**已验证**：首轮 `只回复两个字：收到` → 回复正文 `收到`（模型 `DeepSeek-V4.1-Flash`）被正确读出。
**第二轮失败的真因（已定位）**：会话里挂着一张 `cb-agent-card`「回复确认消息」——WorkBuddy 在等用户确认，此时插入文本 + 回车不会提交。send 已改为（0.4.3）：
1. 先等空闲（`/准备中|生成中|思考中|执行中/` 消失）；
2. 检测到 `[class*="cb-agent-card"]` 就**拒绝发送**并返回 `{ok:false, needsUser:true, reason:"pending_confirmation", card:"回复确认消息"}`，不再静默失败；
3. 提交顺序 `Enter`（带 `text:"\r"`）→ `Cmd+Enter` → 找 `发送|提交|Send` 按钮，任一让输入框清空即算成功，返回实际命中的 `via`。

**待决策**：WorkBuddy 的确认卡（权限/继续执行一类）要不要由 DSH 自动点「确认」？默认**不自动点**——它可能是权限授予或不可逆动作，属于该问人的事。

## 4.10 办公产物卡与打回（office-artifacts 0.2.0）

**为什么要产物卡**：R5 原先只有「扫描 + HUD 一行」，用户看到产物却没法立即判定「收 / 退」，打回意见也无法回到干活的那个 agent——闭环断在最后一步。现在补成：侧栏「📎产物」→ 全屏面板 → 每条产物可 打开位置 / 接受 / 打回重做。

| 路由（GET） | 作用 |
| --- | --- |
| `/office-artifacts/list?hours=&cwd=` | 扫描工作区产物（省略 `cwd` 时取最近会话的 cwd，避免落到 profile 目录） |
| `/office-artifacts/state` | 已接受/已打回记录 + 最近 beacons |
| `/office-artifacts/review?path=&action=accept` | 标接受 |
| `/office-artifacts/review?path=&action=reject&feedback=&send=1` | 标打回；`send=1` 时把「产物被退回了…修改意见…」prompt 到同 cwd 最近活跃会话，返回 `sent:<sessionId>` |
| `/office-artifacts/beacon?e=` | 客户端打点（新客户端是否加载，看 `beacons` 里有没有 `client-boot`） |

**关键约束**：`review` 的 sendback 用 `AbortSignal.timeout(30000)`；找不到会话时只落盘不发送（返回 `sent:null`），面板提示「没找到可发送的会话」。打回记录写 `~/.dsh/agent-bridge/artifacts-state.json`。

**产物进阶段链**：`dsh-project-journal` 在会话总结后扫描项目目录，把落在「该会话开始时间之后」的 docx/xlsx/pptx/pdf/md 补进本次触及阶段的 `artifacts`（每阶段最多 8 条），阶段卡直接能看到「这一阶段产出了什么」。

**HUD 集成现状（明确不做的是什么）**：HUD 的产物行仍由 agent-bridge 的 6 小时扫描提供；本次没有改 HUD 的 Swift 代码——把产物卡塞进常驻圆窗需要改 `native/RadarHUD.swift` 并重建，属于独立风险，留在 P2 处理，先用侧栏面板闭环。

## 4.11 P6 稳定性：诊断面与已知崩溃点

`dsh-project-journal` 新增 `GET /x-journal/api/diagnostics`，一次拿到：`uptimeSec / fileBytes / backups / projects / phases / problems / sessions / sessionStates / failures(最近 10 条 error|skipped) / queue / timers / workerRunning / backfill / reproject / model / workspaceSource / beacons`。排障顺序：先看 `diagnostics.failures` 的 `lastError`，再看 `beacons` 最后 8 条，最后才翻日志。

已踩过的崩溃点（都是「未捕获异常 → 整个宿主 exit」）：
1. `agent-bridge` 接管回调里 `log is not defined`（已还原为上游写法，别在那里加未定义函数）。
2. `sessionController.prompt(request)` 少传第二个 `signal` → `throwIfAborted` on undefined。
3. 路由里 `await` 未包 try/catch → 前缀资源 reject 后宿主直接退出；本仓库所有 handler 都是「大 try/catch + json 500」。

原则：**插件不注册 process 级钩子**（会和其他插件抢）；错误在本插件的 handler/worker 内消化，错误写 `note()` + `lastError`，把可观测性做在 `/api/diagnostics`，而不是靠重启示。

## 4.12 审批聚合与会话恢复（agent-bridge，P2）

新增四类 GET 路由（老 `POST /agent-bridge/approvals/:id` 仍保留，但侧栏已改用 GET）：

| 路由 | 作用 |
| --- | --- |
| `GET /agent-bridge/pending` | 待审批队列 `{ok,count,pending[]}`；宿主重载遗留条目带 `stale:true` |
| `GET /agent-bridge/approve?id=&decision=allow\|deny&note=` | 决策并回传子进程（Claude hook 已 e2e；`delivered:false,stale:true` 表示条目已失效） |
| `GET /agent-bridge/pending/clear?mode=stale\|all` | 清理；`all` 会先 deny 活 waiter 再清 |
| `GET /agent-bridge/resume?runId=` | `fork` 到最后一个 `turn/end` → `prompt` 续跑；失败退 `create({cwd})` + 原任务摘要；返回 `{sessionId,mode:'fork'\|'new',prompted}` |

**坑**：① 队列持久化文件必须能容忍坏 JSON（读失败按 `[]`）；② `snapshotPending` 要剥掉 `timer/resolve` 等运行时句柄再落盘；③ `runId` 必须正则白名单（`^[A-Za-z0-9._-]{1,128}$`）并拒绝 `.`/`..`，否则 `/resume` 会变成路径穿越；④ 只有 `POST /runs` 调用方显式传 `sessionId` 的 run 才有 `dshSessionId`，历史 run 只能 `?sessionId=` 手动指定。

## 4.13 WorkBuddy 驱动（workbuddy-driver 0.1.0，P3）

七条 GET 路由：`/workbuddy/{health,launch,windows,focus,idle,send,screenshot}`。`send` 的编排是：`bridge.state` → 等 idle（`/last` 签名连续两次不变）→ 记 baseline → 调 agent-bridge 的 `/workbuddy/send` → 校验（`input-cleared` 或 `/last` 变化）→ 失败且无待确认卡时用原生 Cmd+Enter 兜底，再补普通 Return → 仍无变化返回 `submit-unverified`（不改动会话）。

**不要做的事**：不要把用户文本拼进 AppleScript（只走 bridge 的 `Input.insertText`）；不要在未运行时「顺手启动」——`focus` 返回 `need-launch`，由用户显式点启动。真机冒烟只读：`running:true, version 5.11.3, cdp.ready:true`；`/workbuddy/send` 与 `/launch` 未跑（会改动用户 App 状态）。

### 4.13.1 会话输入区被折叠时怎么发（2026-11-17 修复）

WorkBuddy 5.11.3 的会话页里 `[data-testid="conversation-input"]` 在任务完成态会变成一个 **0 高、没有子节点** 的 div（`data-pane-input-ready` 仍在），真正可写的是 home 页的 Slate 编辑器 `._editable_*`（≈439×78）。三处口径必须一致：

1. **选编辑器**：优先 `[data-testid="conversation-input"] [contenteditable="true"]`，否则任一「可见且高 ≥40、宽 ≥200」的 `[contenteditable="true"]`。只按 `class*="editable"` 或 `contenteditable="true"` 会误命中 135×28 的消息气泡（`contenteditable="false"` 的气泡也可能被父节点匹配）。
2. **清空**：Slate 编辑器**不能** `textContent=''`——DOM 被改而内部文档状态不变，后续 `Input.insertText` 会失效。改成聚焦后 `Cmd+A` → `Backspace`（`Input.dispatchKeyEvent`，`modifiers:4`）。
3. **探测失败**：返回 `{ok:false, needsUser:true, reason:'input_unavailable'}`，不要盲目 insert。

配套：`/workbuddy/send?...&new=1` 会先点「新建任务」回到 home composer 再发；不带 `new=1` 时若遇到 `input_unavailable`/`insert_failed`，driver 自动用新任务路径重试一次并回传 `switchedNewTask:true`。`needsUser` 的 `reason` 必须翻译成 error 码（`input-unavailable`/`pending-confirmation`/`needs-user`），否则面板只能显示「未知错误」。实测：`你好` 与 `你好呀` 均已真实发出并收到回复。

## 4.14 PTY 接管与通知（pty-takeover 0.1.0，P4）

`/x-pty-takeover/{health,pty/start,pty/status,pty/write,pty/read,pty/clear,pty/stop,notify}`。设计要点：单子进程 + 200KB 环形缓冲 + `since` 游标增量读（游标越界自动钳到窗口并置 `truncated`，多字节字符从中间开始则丢弃续字节）；`/pty/write` 只接受 UTF-8 文本，**必须带 `%0A`** 才会执行（客户端发 `text+"\n"`）；控制类路由对 `Sec-Fetch-Site: cross-site` / 异源 `Origin` 返回 403（纯 GET 接口不加这个会被任意网页 CSRF）；`/notify` 追加 `~/.dsh/agent-bridge/im-outbox.jsonl` 并可选 POST webhook（5s 超时、失败只记日志）。

**限制要写清**：不是真 TTY（`isatty()` false、行缓冲、无 ANSI 光标/清屏、`vim`/`top` 会异常）；全局单会话，换目录要先 `stop` 再 `start`。

### 4.9.1 WorkBuddy 需要人确认时，把它推到胶囊里（bridge 0.4.6 + 雷达 0.4.4）

自动确认只对「能点掉」的卡片有效。遇到需要实质选择、或输入框被锁成不可写的确认，`send` 返回 `needsUser:true` 并写 `~/.dsh/agent-bridge/workbuddy-pending.json`（一行一次、末行生效）。

**复用审批通道，不新造 UI**：
- 宿主 `GET /agent-bridge/approvals` 在有 pending 时**前置一条合成审批** `{id:"workbuddy", agent:"workbuddy", method:"workbuddy/confirm", title:<卡片原文>}`；
- 雷达 `pendingApprovals()` 照常拉，于是它自动变成红色脉冲 + 一行 `待批准`；
- 点行 → `openApproval` → 点「✓ 批准」→ `POST /agent-bridge/approvals/workbuddy` → `open -a WorkBuddy` 把窗口拉到前台 + 清掉 pending；
- 雷达 `describeApproval()` 现在优先取 `approval.title`，所以行标题是**卡片原文**（`回复确认消息`）而不是 `workbuddy/confirm`。

**实测**：
```
send → {"ok":false,"needsUser":true,"reason":"insert_failed"}
GET /agent-bridge/approvals → [{"id":"workbuddy","title":"回复确认消息\n10分钟前"}]
feed  → counts.approvals=1，item: approval needs-approval | "回复确认消息"
POST /agent-bridge/approvals/workbuddy {"decision":"accept"} → {"ok":true,"decision":"activate"}
之后 approvals 归零，圆停止红色脉冲
```
**语义**：这里「批准」不等于替用户做决定，只是把 WorkBuddy 窗口推到前台让他自己点——所以不违反「授权类必须问人」。


### 4.9.2 PTY 内嵌终端已彻底移除（bridge 0.4.7）

用户 2026-11-16 决定：右下角那个 PTY 终端**直接删掉**，不保留。已删除：
- `index.js` 里 `POST /pty`、`GET /pty/<id>/stream`、`POST /pty/<id>/{input,resize,close}` 共 5 条路由与 `ptys` Map（89 行）；
- `GET /assets/xterm.js|css` 静态路由与 `assets/` 目录；
- `pty_helper.py`、退役的 `client.js`。

验证：`/agent-bridge/pty` → **404**、`/assets/xterm.js` → **404**、`/health` → 200、`/workbuddy/state` → 200（其余能力未受影响）。残留 `pty_helper` / `pty.spawn` 进程已清理（计数 0）。

**如果屏幕上还看到那个终端**：那是旧页面里缓存的 client bundle 在跑，按一次 `Cmd+R` 整页重载即消失（插件已不再声明 `dsh.client`）。

## 4.15 回归记录：宿主重启后的 53301 端口实测（2026-11-16 20:28）

宿主重启后 GUI 端口从 49392 换成 53301，以下为**真实调用**结果（不是代码推断）：

| 能力 | 调用 | 结果 |
| --- | --- | --- |
| journal | `GET /x-journal/api/health` | `{ok:true, version:3}` |
| journal 客户端半 | `beacons` | `client-boot:visible` + `client-v4` + 三个 `slot-ok:*` |
| 客户端面板注册 | `cordis_inspect_query Slots listSubTree(shell.overlay)` | `project-journal-panel` / `office-artifacts-panel` / `workbuddy-panel` / `pty-takeover-panel` 全部 active |
| 侧栏 footer 按钮 | 同上（`sidebar.footer.action`） | `office-artifacts-entry`(24)、`project-journal-entry`(25) 在 Settings 旁 |
| 产物卡 | `accept` / `reject(send=0)` / `state` | 接受进 accepted、驳回进 rejected 并清 accepted |
| 产物列表 | `list?cwd=…` | 只回 `.docx/.xlsx/.pptx/.pdf/.csv/…`；**`.md` 已从集合剔除** |
| 审批聚合 | `POST /agent-bridge/claude-hook` + `pending` + `approve?decision=allow` | hook 拿到 `permissionDecision:"allow"` |
| 审批拒绝 | 同上 `decision=deny` | hook 拿到 `"deny"`，队列归零 |
| 队列清理 | `pending/clear?mode=stale` | `{cleared:0, denied:0}` |
| PTY | `pty/start` → `write?text=echo%20PTY2_OK%0A` → `read?since=0` | 回 `PTY2_OK` |
| PTY 通知 | `notify?text=…&channel=im` | `{queued:true}`，`im-outbox.jsonl` 落盘 |
| WorkBuddy | `windows` / `idle` / `screenshot` / `focus` | 1 窗口 801×870、`idle:true preview:"收到"`、截图 2.3MB、`focused:true` |
| judge | `GET /dsh-judge/health` | `{ok:true, autonomy:"L2", model:"DeepSeek-V4.1-Flash"}` |
| radar | `GET /x-radar/radar` | `counts:{running:1,doneUnread:3,pending:1,artifacts:1}` |
| HUD 审批行 | 造一条 pending 后拉 feed | `kind:"approval"` + `title:"echo radar"`；决策后 `approvals:0` |
| 审批队列持久化 | 造 pending → 关/开 `include:dsh-agent-bridge` → `pending` | 条目仍在且 `stale:true`；`approve` 返回 `delivered:false, stale:true` |
| 迁移预演 | `migrate?sessionId=…&targetProjectId=…&dryRun=1` | `from/to/targetExists/journalFrom` 正确，未写盘 |
| 阶段 CRUD | `phase/create?…&title=…` → `phase?action=delete` | 建出 `seq:1`，删后项目回到 0 阶段 |

**坑**：`/workbuddy/focus` 会把 WorkBuddy 窗口拉到前台（会打断当前前台 App），回归时最后再调；`/office-artifacts/list` 默认按最近会话 cwd 取目录，不带 `cwd` 时结果取决于「最近活跃会话」，不是当前工作区。

**回归中修的两处**：① `/office-artifacts/list` 的扩展名集合去掉 `.md`（笔记不算办公产物，否则面板里一屏全是 PRD）；② `重新归纳本项目` 跑完若项目仍 0 阶段（模型对非项目型会话常返回空），`reproject.error` 写「模型未产出可归纳的阶段，可用『新建阶段』手动补一条」，面板在按钮旁显示 `pj-note`，不再静默无变化。

## 4.10 聚合 API 上行（R2）：子 agent 与 DSH 用同一条 API

**唯一事实来源**：`~/.dsh/profiles/desktop/cordis.patch.yml` 里 `llm-pi-ai → providers` 的第一个 provider（本机是 `company`）。插件不维护第二份配置，`models.yaml` 不做。

**解析**（`plugins/dsh-agent-bridge/index.js` 的 `readUpstream()`）：provider 名、`api`、`baseURL`、`apiKeyEnv`、`models[]`（正则抓 `- id:`），结果落 `~/.dsh/agent-bridge/upstream.json`。

**密钥**（`resolveApiKey()`）：先 `process.env[apiKeyEnv]`，再回落 `~/.dsh/.credentials.yaml` 的 `refs:` 段——与 DSH 自身取凭据同一链路。

**注入**（`applyUpstream(env, kind)`，在两处 spawn 调用）：
| agent | 注入 | 备注 |
| --- | --- | --- |
| codex | `OPENAI_BASE_URL` / `OPENAI_API_BASE` / `OPENAI_API_KEY` | 走 `codex app-server` |
| claude | `ANTHROPIC_BASE_URL`（去尾 `/v1`）/ `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000` | 网关未登记模型窗口，不显式给会被按 200k 保守处理 |
| workbuddy | 不注入 | 桌面 App 无法注入 env，结果仍回落同一 bridge |

**自检**：`GET /agent-bridge/upstream`（`?probe=1` 真发一次 8 token 请求）、`dsh-bridge doctor`（打印 provider/baseURL/apiKeyEnv/models/probe，失败退出码非 0）。

**实测（2026-11-17，company 网关）**：
```
provider   company  (openai-completions)
baseURL    https://oneapi-comate.baidu-int.com/v1
apiKeyEnv  COMPANY_API_KEY
models     gpt-6.1-sol, Opus 5.5, Kimi K3, DeepSeek-V4.1-Flash, GLM-5.3-Flash,
           Gemini 4 Argon, Grok-4.7, Claude Sonnet 5.5, gpt-6-astra
probe      OK 2199ms model=gpt-6.1-sol
```
- claude 直连网关（`--model "Claude Sonnet 5.5"`）→ `可以`（stderr 有一条 `unrecognized_model`，属预期，已用 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 补窗口）
- codex 直连网关 → `可以`，输出带 `tokens used 8,328`（走网关计费特征）

**两个坑**：
1. `bridge-url.json` 里存的是**无路径前缀**的 `http://127.0.0.1:<port>`，CLI 各命令自己拼 `/agent-bridge/...`；`doctor` 起初漏了前缀，一直 404。
2. Node 侧插件改代码后必须**重启 App** 才加载新一代模块（`application: applied` 不等于已生效）；客户端 bundle 才用 `Cmd+R`。
