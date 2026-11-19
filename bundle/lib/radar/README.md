# dsh-task-radar（胶囊 / 桌面任务雷达）

DSH 桌面右上角的常驻胶囊：把「DSH 会话在跑什么」和「Agent Bridge 的外部 run（codex / claude）」合成一份 feed，
用原生 AppKit 窗口画成一个可拖动的小圆点，悬停展开面板，双击跳回会话。

产品需求见 `docs/PRD.md`（R3 浮动任务雷达、R17 等回答可见）；实现与验证流程见 `docs/DEV.md`。

## 形态与语义（v0.6.2）

收起态有两种形状：**宽胶囊**（要你动手时）与 **56pt 圆**（其余状态）。两者都不在圆内写汉字（用户 2026-11-18 否掉了单字角标），
状态靠「形状 + 颜色」双通道表达，色盲用户也能分辨。

| 状态 | 收起态 | 可辨特征 | 数据来源 |
| --- | --- | --- | --- |
| 会话在等你回答 | **宽胶囊** | `等回答：<问题首句>…` + 琥珀点 + 琥珀描边 + `?` | 宿主 `user-questions/request`（旁听/接管）+ `typertGateway` 未决事件 |
| 等你批准 | **宽胶囊** | `要批准：<标题>…` + 红点 + 红描边 + `✓` | `/agent-bridge/approvals` |
| 最近有失败 | **宽胶囊** | `失败：<错误首行>…` + 橙点 + 橙描边 + `×` | run 的 `error` 字段 |
| 有完成未看 | 56 圆 | 绿色**实心环**（lineWidth 3.4）+ 呼吸圆点 | `counts.doneUnread` |
| 只是在进行中 | 56 圆 | 中性细环（白 0.22）+ 呼吸圆点 | `counts.running` |
| 连不上宿主 | 56 圆 | 「离线」小字 | HUD 自身 |

圆内大数字始终是**进行中会话数**（PRD 2.19：圆内只放一个大数字，不堆颜色和图形）。
「在等你回答」的会话不再计入进行中——否则胶囊只会说「在忙」，用户分不清 AI 在跑还是在等他（R17 规则 1）。

## 自检开关（零 TCC，压测/排障用）

所有自检**一律带 `--hidden`**（窗口 `alpha=0`、不吃鼠标事件），否则测试窗口会留在用户桌面上被当成 bug：

| 开关 | 作用 | 期望日志 |
| --- | --- | --- |
| `--mock <feed.json>` | 用离线 feed 渲染 | `render pending=… questions=… mode=…` |
| `--hidden` | 隐藏窗口、只跑逻辑 | `hidden mode: alpha=0 ignoresMouseEvents=1` |
| `--mock-pointer x,y` | 仅 `--mock`：把「指针位置」换成 x,y | 用于确定性地验悬停判据 |
| `--hover-probe near\|leave\|far` | 悬停判据三态 | `keep expand reason=cursor-inside` / `collapse reason=cursor-outside`（≤400ms） |
| `--click-probe x,y` | 把窗口内坐标当一次点击走完整路径 | `hit row=… id=… kind=…` |
| `--scroll-probe dy` | 造一次滚轮事件 | `scroll probe dy=… row=a->b` |
| `--answer-probe request,token,qid=label` | 走真实回执写回请求（须 `--url` 模式） | `[answer] submit ok` / `submitted failed body=…` |
| `--click-delay ms` | `--click-probe` 的触发延迟（默认 350；测「点击→面板」用 1500） | 配合 `--click-probe` |
| `--route-probe <name>` | 用 feed 基址请求 `/<name>` 后自退（验地址前缀） | `route probe name=… url=… status=… bytes=… body=…` |
| `--grace-probe recent\|stale` | 验「点击后 800ms 内不收起」的宽限判据 | `collapse deferred reason=recent-click` / `collapse reason=cursor-outside` |

## 失败之后能做什么（v0.6.9）

- 失败行的详情页直接给动作：**重试**（同 prompt/agent 重发）、**复制错误**（完整错误进剪贴板）、**清掉这条**（只标已读，不删磁盘）、**看事件流**。
- 重试产生的新 run 会在 `hosts/<port>/retries.json` 记 `retryOf=<旧 runId>`（桥的 meta 不认这个字段，属于雷达自己的账本）；旧行随后不再出现。
- 僵尸 `running`（进程已退出、10 分钟无事件）会被读侧兜底成 `failed`（`reason=stale-running`）或按 `turn.end` 判成 `done`，日志 `grep stale-running` 可查对证。

## 会话行双击：要处理这个会话吗？（v0.6.9）

- `仅从雷达移除（推荐）`：写 `hidden-sessions.json`，feed 永久过滤，**DSH 里的会话数据一点不动**。
- `跳到 DSH 里删除`：只跳转，删不删由 DSH 本体决定。
- `取消`：关掉确认卡。单击语义不变（进会话详情）。


### 横幅点击（0.6.13）

完成横幅会记住「是哪一条」：点它就一键到那条结果所在的地方。

| 横幅 kind | 点击行为 |
| --- | --- |
| `session`（已完成） | 先标已读，再直接跳到该会话窗口；条目随即从胶囊消失 |
| `run`（外部 codex/claude/workbuddy） | 打开该 run 的详情页 |
| `approval` / `question` | 打开对应处置页（不跳转） |

一次点击只消费一条，队列里剩下的会上移。日志契约：`banner click kind=… id=…` → 动作行（`banner done jump kind=session` / `open detail`）→ `markSeen ok` / `jump sent`。零 TCC 自检：`--banner-probe 0`（0 = 队首）。

### 自检开关补遗（0.6.13）

- `--banner-probe <index>`：按下标模拟点一条横幅，打印 `banner probe …` 与真实点击同款日志后自退。
- `--bench <path>` 里的 `cpu_pct` 现在是真值（`proc_pid_rusage` 增量），可连续采 30 分钟看 M1/M3/M10。
- `/x-radar/health` 增 `clientLive`：为 false 表示当前没有活着的 DSH Web 页面，`clientHalf` 相关判据此时不成立（门禁记 KNOWN-DEFERRED）。

### 横幅与未读的收场规则（0.6.13）

- **条目被消费，横幅立刻消失**：每轮 feed 之后比对 `items[].id` 与 `doneUnreadIds`，不在集合里的横幅
  立即收掉并打 `banner dismiss reason=item-consumed`（在 DSH 里读完某个会话、或在雷达里置读之后，下一轮 2s 内生效）。
- **超时**：可点横幅 30s（`reason=expired`）、纯提示 6s（`reason=timeout`）；点击是 `reason=clicked`；队列超 3 条挤掉最旧是 `reason=evict`。
- **取数失败不吞提醒**：feed 500/断网时保留已有横幅，打 `banner keep reason=feed-error n=…`；自检 `--feed-fail`（第一次成功让横幅出来，之后必失败）。
- **已完成未读以 DSH 事实为准**：宿主 `list()` 没有未读字段（只有 `running/blank/updatedAt/formatStatus/sessionListMetadata.lastPromptAt` 等），
  所以只认三种硬事实清账 —— 行消失 → `session unread clear id=… source=dsh-gone`；会话又跑起来 → `source=dsh-running`；
  完成之后还有人类输入（`lastPromptAt > finishedAt`）→ `source=dsh-prompt`。都不命中才回退雷达自己的 60 分钟保留与 `seen.json`。

## 已知限制（2026-11-18）

1. **就地处置只做了选项类**：HUD 活着且没有 Web 客户端时，雷达会接管会话内提问，面板里点选项即提交
   （单选题点一次就发；多选题点选项切换、再点「✓ 提交已选」）。**自由文本不做**（不新增键盘输入、不抢焦点）——
   这类题面板只写「回 DSH 里答」。接管后 20s 没人答、或 HUD 进程消失、或插件卸载，都会立刻 `next()` 让渡回桌面提问卡。
   没接管时只旁听并立即 `next()`，面板如实写「回 DSH 里答」。
   协议与排障见 `docs/DEV.md` §2.1.1；产品口径见 `docs/PRD.md` 5.19。
2. **宽胶囊只覆盖三种状态**：待回答 / 待批准 / 失败时收起态是 44 高、宽 178–234（硬上限 240）的胶囊，
   直接显示 `等回答：<问题首句>…`；其余状态（含「有新完成」）仍是 56pt 圆 + 静态环形态（缺口=待回答、
   双环=待批准、实心环=有新完成、中性细环=进行中）。宽窄切换**没有** 180ms 插值（t4 §1.7-a 动效待做），
   且胶囊文本是首句截断，完整问题仍需展开面板或回 DSH 看。
3. **旁听有窗口期**：提问必须发生在插件装载之后才会被记录到文本；装载前已悬着的提问只能靠 `typertGateway`
   看到「有个会话在等回答」，看不到问题原文（排障路由 `/x-radar/questions` 会显示 `taps: []`）。
4. **批准通道在本机是死的**：本 profile 的审批策略是 `never`，`approval/request` 从不派发，所以双环（待批准）态
   实际只对桥 run 的审批队列有意义。
5. **没有免打扰**：任何待回答/待批准都会呼吸+横幅，没有静音或时段设置（t1 §C2 未实现）。
6. **性能**：呼吸已改由 Core Animation 驱动（常驻 CPU 0.0–0.5%，门 1.0%）；feed 走
   stale-while-revalidate 快照（实测 p50 57.7ms → 0.3ms，HUD 的 2s 节奏下 0.3–1.3ms），
   代价是最多 ~1s 的数据陈旧。仍未做：详情 10 万事件主线程 317ms（需后台分块+虚拟化）、
   日志轮转、`--hidden` / `--bench`——见 `docs/specs/radar-perf-budget.md` 的 F-04…F-07。
7. **单实例假设**：同时开两个 DSH 宿主会出现两只胶囊；`DSH_TASK_RADAR_HUD=0` 可关掉 HUD 只留 HTTP 接口。
   按 state-dir 的进程级加锁**未做**（t5 的 F-08），`--hidden`/`--bench` 自退也还没实现。
8. **面板点选项的端到端点击没有自动验收**：协议层有一条脚本化验收（假 ctx + 假 HUD pid，15 条断言），
   但本机没有辅助功能权限、也无法用桌面自动化点 HUD 面板，点选链路需人工在真机走一遍（t9 现场验收项）。

8. **面板点击/滚动没有自动化端到端验收**：本机零 TCC 权限，合成点击不可用（`desktop_control` 在 macOS 上不可用、
   `osascript click at` 报「不允许辅助访问」）。面板的**绘制**可以用 `screencapture -R` + 像素/OCR 复验（缺口角度、
   双环带、清除已完成按钮、`N–M/总数 · 滚轮翻页` 指示都已这样验过），但「点下去是否命中」只能由有输入权限的人真机点。

## 排障

```bash
PORT=$(python3 -c "import json;print(json.load(open('$HOME/.dsh/agent-bridge/radar-url.json'))['port'])")
curl -s "http://127.0.0.1:$PORT/x-radar/radar" | python3 -m json.tool | head -30   # feed
curl -s "http://127.0.0.1:$PORT/x-radar/questions"                                  # 提问旁听 + 接管表（holds）
# 接管/让渡的证据链（beacon.log）：
#   question tap listening        插件装载，listener 已 prepend 注册
#   question hold request=…       已接管，20s 倒计时开始
#   question answered request=…   面板提交成功，waterfall 拿到数组答案
#   question yield <why>          让渡（timeout / hud-dead / dispose），桌面卡接手
tail -f /tmp/dsh-task-radar/beacon.log                                              # 宿主侧日志
tail -f /tmp/dsh-task-radar/hud.log                                                 # HUD 侧日志（pulse state / banner show）
```

## 僵尸 running 的两级判定（v0.6.9）

- run 自称 `running|starting|queued` 但 `pidAlive=false`（子进程已退出）→ **立刻** 落终态：最后一条事件是 `turn.end` 就判 `done`，否则 `failed` + `reason=process-exited`（文案「进程已退出」）。
- 只有「pid 还活着但 10 分钟没有新事件」才算 `stale-running`（文案「可能卡住了」）。
- feed 每条 run 带 `pidAlive: true|false|null`；`pidAlive:false` 的 run 不会留在「进行中」分组。
- 已知限制：判定是**读侧**兜底，不写回桥的 `meta.json`（桥不在雷达 scope）；要根治请在桥里落终态。
