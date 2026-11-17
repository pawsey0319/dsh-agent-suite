# RadarHUD —— DSH 任务雷达原生悬浮窗

一个独立的 macOS 原生小工具（AppKit，无第三方依赖），把 DSH 的聚合任务雷达放在
**所有 Space、所有 App 之上**，常驻置顶。

它是 DSH 窗口内右上角 Web 小胶囊的「桌面级」替代/补充：

- **收起态**：一个 56 × 56 pt 的圆形徽标，圆内只有「运行中的会话数」和呼吸圆点；
- **展开态**：鼠标移入圆形徽标后，0.18s 动画展开为 320pt 宽的任务面板，列出正在
  运行的会话（agent 徽标 + 标题，最多 6 行）；鼠标离开 250ms 后收回；
- 只有**双击**才激活 DeepSeek Harness，单击不做事（避免误触）；
- 圆形徽标的位置就是面板的生长锚点：默认在右下角，向右/上避开屏幕边缘，展开时
  圆形本身不移动，只向屏幕内侧长。

- 进程模型：`NSApplication` + `.accessory`（不占 Dock、无菜单栏图标、不抢焦点）
- 窗口：无边框、透明、圆角 HUD 材质、常驻置顶、可拖动
- 数据：轮询 DSH 的 radar JSON；也支持纯本地 mock 文件自测
- 单实例、位置持久化、SIGTERM/SIGINT 清理 pid

对应需求：`docs/PRD.md` R3（任务雷达）的桌面悬浮形态扩展。本文档只覆盖
`plugins/dsh-task-radar/native/` 下的独立进程，不改动插件其它文件。

## 文件

| 文件 | 说明 |
|---|---|
| `RadarHUD.swift` | 全部实现，单文件，Swift 5 / AppKit + Foundation |
| `build.sh` | 可重复执行的构建脚本，输出裸可执行文件 `RadarHUD` |
| `README.md` | 本文档 |

## 构建

```bash
cd plugins/dsh-task-radar/native
bash build.sh
```

实际执行的命令：

```bash
swiftc -O -framework AppKit RadarHUD.swift -o RadarHUD
```

要求：macOS + Xcode Command Line Tools（`swiftc`）。产物是裸 Mach-O 可执行文件，
**不是** `.app` bundle；没有 Info.plist，ATS 对 127.0.0.1 的 HTTP 请求在命令行
工具里实测可用（见「已验证项」）。

## 运行

```bash
# 显式 URL（DSH 插件注入当前端口）
./RadarHUD --url http://127.0.0.1:64274/x-radar/radar

# 自动跟随 DSH 端口（DSH 重启换端口后无需重启 HUD）
./RadarHUD --url auto --interval 2

# 无服务自测：只读本地文件，不访问网络
./RadarHUD --mock /tmp/radar-mock.json

# 启动即强制展开（截图/验收用，鼠标离开也不收回）
./RadarHUD --mock /tmp/radar-mock.json --expand

# 查看帮助
./RadarHUD --help
```

| 参数 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `--url <http(s) URL \| auto>` | 否 | `auto` | 显式 URL 优先且忽略 URL 文件；`auto`（或不传）每轮轮询前重读 URL 文件 |
| `--interval <秒>` | 否 | `2` | 轮询间隔，限制在 0.2–3600 秒 |
| `--mock <file.json>` | 否 | — | 给了就只读本地文件（每轮重读，可热切换内容），不联网 |
| `--expand` | 否 | — | 启动即强制展开面板，且不因鼠标离开收回（仅测试/截图用） |
| `-h`, `--help` | 否 | — | 打印用法后退出（exit 0） |

`--mock` 优先级最高：同时给 `--url` 与 `--mock` 时只读本地文件。参数非法
（缺值、非 http(s) URL）时打印错误并以 exit 2 退出。

`--expand` 是**测试专用**：正常运行时不要传，否则鼠标离开不会收回，失去 hover
交互。

### `--url auto` 契约（DSH 侧约定）

HUD 每一轮轮询前读取：

```
~/.dsh/agent-bridge/radar-url.json
```

内容形如：

```json
{
  "url": "http://127.0.0.1:64274/x-radar/radar",
  "port": 64274,
  "updatedAt": 1794810835505
}
```

规则：

1. 文件存在、可解析、`url` 是 `http(s)` URL → 用该 URL，并记为 last-known。
2. 文件不存在 / 不可解析 / URL 非法 → 回退到**上一次使用的 URL**（last-known）。
3. 两者都没有 → 显示「离线」，继续按 interval 重试（文件出现后自动恢复）。
4. 显式传入 `--url http...` 时始终用显式 URL，不读文件。

这样 DSH 重启换了 Web 端口后，只要插件重写这个文件，HUD 下一轮就会跟着换端口。

## 数据格式

HUD 使用 `counts.running` 作为大数字，并解码 `items` 列表；列表只展示
`kind == "session" && status == "running"` 的项（`kind == "run"` 的子任务/子智能体
不进入会话列表，避免「一个顶层会话拆成很多条」）。

```json
{
  "ok": true,
  "generatedAt": "2026-11-16T06:40:00.000Z",
  "counts": { "running": 3, "approvals": 1, "doneUnread": 2, "pending": 5 },
  "items": [
    { "id": "s1", "kind": "session", "agent": "codex", "title": "整理周报数据",
      "status": "running", "updatedAt": 1794566583000 },
    { "id": "s2", "kind": "session", "agent": "claude", "title": "修复登录问题",
      "status": "running", "updatedAt": 1794566582000 },
    { "id": "s3", "kind": "session", "agent": "dsh", "title": "写周会 PPT",
      "status": "running", "updatedAt": 1794566581000 },
    { "id": "s4", "kind": "session", "agent": "codex", "title": "已完成的会话",
      "status": "done", "updatedAt": 1794566580000 },
    { "id": "r1", "kind": "run", "agent": "codex", "title": "子任务不列出",
      "status": "running", "updatedAt": 1794566579000 }
  ],
  "total": 5,
  "dsh": { "port": 64274, "url": "http://127.0.0.1:64274" }
}
```

容错细节：

- `counts` 缺失 → 全 0；单个字段缺失/为 `null` → 该字段 0。
- 数值同时接受 `Int`、`Double`、数字字符串；负数截断为 0。
- `items` 缺失 → 空列表；单条 item 解析失败 → 跳过该条，不影响其它行。
- `ok: false` → 按离线处理（保留上次数字，不显示服务端失败数据）。
- JSON 解析失败、HTTP 非 2xx、连接失败、5 秒超时 → 离线。
- 离线时保留最后一次成功取到的数字和列表，仅把数字/整体变暗并显示「离线」。

## 显示映射

### 收起态（56 × 56 圆形）

| 区域 | 规则 |
|---|---|
| 大数字 24pt Bold | `counts.running`（正在运行的顶层会话数） |
| 呼吸圆点 8pt | `approvals > 0` → 红色；否则 `pending > 0` → 橙色；否则灰色。非空闲时 opacity 1.0 ↔ 0.35，单程 0.6s，完整周期 1.2s；空闲时停止 |
| 空闲 | `running == 0 && approvals == 0`：数字 `0`，窗口整体 `alpha = 0.72`，圆点灰色 |
| 离线 | 圆内底部显示小字「离线」，数字保留上次值并变暗（数字 alpha 0.5），继续轮询 |

### 展开态（320pt 宽面板）

| 区域 | 规则 |
|---|---|
| 标题 | `运行中的会话`，右侧 `N 个`；离线时右侧变「离线」 |
| 列表 | `items` 中 `kind=session && status=running`，按数组顺序最多 6 行；每行：彩色 agent 徽标（首字母）+ 标题 + 小号 agent 名 |
| 超出 | 超过 6 行显示 `还有 N 条`（N = 总数 − 6） |
| 副行 | 面板底部/顶部带状区：`需批准 N`（红）> `完成未看 N`，取前两个非零；离线时变暗 |
| 空列表 | 显示 `暂无运行中的会话`，大数字 0，整体 alpha 0.72 |

面板高度随会话条数变化：`80 + 12 + 34 + 行数×42 + 溢出24 + 12` pt；
0 行时用 32pt 的空态行，总高 170pt。因此 3 条运行时展开为 320 × 264。

## 交互

| 操作 | 行为 |
|---|---|
| 鼠标移入圆形 | `NSTrackingArea` 触发，0.18s 动画展开面板；圆形屏幕位置不动 |
| 鼠标在圆形/面板内移动 | 面板本身也是 hover 区域，不会误收起 |
| 鼠标离开圆形/面板 | 启动 250ms 宽限计时；期间移回则取消，超时才动画收回 |
| 左键拖动背景 | 移动窗口（`window.performDrag(with:)` + `isMovableByWindowBackground = true`），展开/收起都支持 |
| **双击**（圆形、面板、列表行） | `/usr/bin/open -a "DeepSeek Harness"` 激活 DSH；不做任务深链 |
| **单击**（位移 < 2pt） | 什么都不做；只有发生实际位移才保存新位置 |
| 右键 | 菜单：`刷新` / `置顶开/关` / `隐藏 5 分钟` / `退出` |
| 置顶开关 | `.screenSaver`（开，level 1000）↔ `.normal`（关）；菜单项有勾选态 |
| 隐藏 5 分钟 | 先收回圆形再 `orderOut`，300 秒后自动 `orderFrontRegardless` |

圆形窗口的 hit area 也是圆的：`HUDRootView.hitTest` 在收起态只接受圆形内部的点，
56×56 方块的四个角落会穿透给下面的 App；展开态只接受圆角面板内部。

## 展开方向与多显示器

- 面板以**圆形原来的屏幕位置**为锚点，圆形本身不移动；
- 圆形在屏幕右半边 → 面板向左生长；在左半边 → 向右生长；
- 圆形在屏幕下半边 → 面板向上生长；在上半边 → 向下生长；
- 面板四周至少留 12pt 边距；如果首选方向空间不够，自动换到另一侧；
- 最后用 `NSScreen.visibleFrame` 做一次夹取（clamp），保证面板不会长出屏幕；
- 屏幕选择按圆形与各 `NSScreen` 的交集面积取最大者，多显示器安全。

默认位置：主屏右下角，圆形距右边 24pt、距底边 24pt（例如 1440×900 屏、
visibleFrame 高 870 时为 `{1360, 24}`）。

## 窗口层级与 Space 行为

```swift
window.level = .screenSaver   // 1000；比 .floating(3) 更可靠地压住全屏 App
window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
```

选 `.screenSaver` 而不是 `.floating`，是为了在别的 App 进入全屏 Space 时仍能盖在
其上（`.floating` + `fullScreenAuxiliary` 在部分全屏场景会被压住）。代价是它也在
菜单栏/Dock 之上，但窗口只有右下角 56×56（展开时 320×264），右键「置顶开/关」
可临时降回 `.normal`。

## 状态文件

| 路径 | 用途 |
|---|---|
| `~/.dsh/agent-bridge/hud.pid` | 单实例锁；启动时若 pid 存活且进程名是 `RadarHUD` 则 `exit 0`；正常退出删除 |
| `~/.dsh/agent-bridge/hud-window.json` | `{"x":1360,"y":24,"version":2}`，保存的是**收起态圆形的左下角**（AppKit 屏幕坐标） |
| `~/.dsh/agent-bridge/radar-url.json` | `--url auto` 每轮读取的 URL 文件（由 DSH 插件写入） |

- 位置在拖动结束、`SIGTERM`/`SIGINT` 退出时保存（原子写）。
- 启动恢复位置时用 `NSScreen.screens` 的 `visibleFrame` 做包含判断；坐标不在任何
  可见屏幕内则回退默认右下角。
- `version` 缺失或 `< 2` 的旧 `hud-window.json` 是旧 300×92 面板的坐标，语义不同，
  升级后第一次启动会忽略它并落到默认右下角；之后写入 `version: 2`。
- SIGKILL 不会清理 pid/位置；下次启动发现 pid 已死会自动接管并覆盖。

## 已验证项（macOS 26.6.2 arm64 / Swift 6.4，2026-11-16）

### 1. 编译

```text
$ cd plugins/dsh-task-radar/native && bash build.sh
==> swiftc -O -framework AppKit RadarHUD.swift -o RadarHUD
==> built: .../plugins/dsh-task-radar/native/RadarHUD
$ file RadarHUD
RadarHUD: Mach-O 64-bit executable arm64
```

`swiftc` 无 error（首轮编译有 3 处 `NSView` 动画 API 用法错误，改为
`circleView.animator().frame = ...` 后通过）；`file` 为 arm64 thin，307K，ad-hoc signed。
`build.sh` 可重复执行。

### 2. 收起态窗口几何（CGWindowList 外部观测）

```text
RadarHUD id=51200 layer=1000 alpha=1.0 onscreen=true name=DSH Task Radar
  bounds X=1360.0 Y=820.0 W=56.0 H=56.0
```

- 56 × 56 pt，符合 52–56pt 要求；`layer=1000`，普通窗口为 `layer=0`；
- 位置 `{1360, 24}` = 主屏 1440×900、visibleFrame 高 870 时右下角内缩 24pt；
- CG 坐标 `Y=820` 与 AppKit `y=24, height=56` 换算一致（900 − 24 − 56 = 820）。

### 3. 展开态几何与展开方向

鼠标移到圆形上（用 `CGWarpMouseCursorPosition` 合成 hover，测试后已把指针移回）：

```text
expand panel={{1108, 12}, {320, 264}} circle={{1360, 24}, {56, 56}}
       growLeft=true growUp=true sessions=3 screen=Built-in Retina Display
```

```text
RadarHUD id=51190 layer=1000 alpha=1.0 name=DSH Task Radar
  bounds X=1108.0 Y=624.0 W=320.0 H=264.0
```

- 面板右边 1428 = 1440 − 12，上边 276；完整留在屏幕内（12pt 边距）；
- 圆形左下角仍是 `{1360, 24}`，展开前后没有移动；
- 默认右下角 → `growLeft=true, growUp=true`，符合「向右/上避开边缘」。

鼠标移开后的日志：

```text
collapse panel={{1360, 24}, {56, 56}} circle={{1360, 24}, {56, 56}}
```

「圆 → 面板」宽限也做了实测：指针先进入圆形（触发 `expand`），再移到面板内部，
停留 0.7s 内没有出现 `collapse`，窗口保持 320×264；继续移出面板后才在约 250ms
宽限后出现 `collapse`，窗口回到 56×56。日志：

```text
expand panel={{1108, 12}, {320, 264}} circle={{1360, 24}, {56, 56}} sessions=3
# 移入面板内部，无 collapse
collapse panel={{1360, 24}, {56, 56}} circle={{1360, 24}, {56, 56}}
```

### 4. 截图与 OCR

> 说明：`screencapture -l <windowId>` 需要 Screen Recording 权限；本机已授权。
> 除文件大小外，还做了平均亮度统计与 Vision OCR。

收起态（3 条运行会话）：

```bash
screencapture -l51200 -o -x /tmp/hud-circle-collapsed.png
sips -g pixelWidth -g pixelHeight /tmp/hud-circle-collapsed.png
#   pixelWidth: 112 / pixelHeight: 112   （Retina 2x，对应 56×56 pt）
# 112px 的图直接 OCR 认不出数字，放大 4 倍后：
sips -z 448 448 /tmp/hud-circle-collapsed.png --out /tmp/hud-circle-collapsed-big.png
/tmp/ocr /tmp/hud-circle-collapsed-big.png
#   observations=1
#   1.00 | 3
```

展开态（3 条运行会话）：

```bash
screencapture -l51190 -o -x /tmp/hud-circle-expanded.png
sips -g pixelWidth -g pixelHeight /tmp/hud-circle-expanded.png
#   pixelWidth: 640 / pixelHeight: 528   （320×264 pt @2x）
/tmp/ocr /tmp/hud-circle-expanded.png
#   1.00 | 运行中的会话
#   1.00 | 整理周报数据
#   1.00 | CODEX
#   1.00 | 修复登录问题
#   1.00 | CLAUDE
#   1.00 | 写周会 PPT
#   1.00 | DSH
#   1.00 | 需批准1
#   0.50 | 完成未看 2
#   1.00 | 3个
#   1.00 | 3
```

亮度（非全黑弱证据的强化版）：展开态 `640x528 avgLum=129.88, nonBlack=99.71%`；
收起态 `112x112 avgLum=74.06, nonBlack=79.97%`。

空闲态（mock 切到全 0）：

```text
render pending=0 running=0 approvals=0 doneUnread=0 sessions=0
       mode=idle alpha=0.72 expanded=0 origin=mock

RadarHUD id=51200 layer=1000 alpha=0.7200000286102295
  bounds X=1360.0 Y=820.0 W=56.0 H=56.0
```

空闲截图 `/tmp/hud-circle-idle-collapsed.png` 仍为 112×112；平均亮度从活跃态
74.06 降到 54.31、avgAlpha 从 200.3 降到 144.5，与窗口 alpha 0.72 一致。
`0` 这个字形在 112px 下 OCR 识别不到（3 能识别），但日志/窗口 alpha 明确证明
进入空闲态，且数字绘制逻辑与 3 相同。

### 5. mock 数据 → 显示映射（实测日志）

`/tmp/radar-mock-three.json`：`running=3, approvals=1, doneUnread=2, pending=5`，
items 里 3 条 `session+running`、1 条 `session+done`、1 条 `run+running`。

```text
RadarHUD start pid=35569 source=mock=/tmp/radar-mock-three.json interval=2.0 expandFlag=true
window frame={{1360, 24}, {56, 56}} level=1000 collectionBehavior=337 screens=2
       savedOrigin=restored circleSize=56.0
force expand at startup
expand panel={{1108, 12}, {320, 170}} circle={{1360, 24}, {56, 56}} sessions=0
render pending=5 running=3 approvals=1 doneUnread=2 sessions=3
       mode=active alpha=1.00 expanded=1 origin=mock
expand-resize panel={{1108, 12}, {320, 264}} sessions=3
```

- 3 条运行会话 → 展开列表 3 行（OCR 同时识别到 `整理周报数据` / `修复登录问题` /
  `写周会 PPT`）；
- `done` 与 `run` 条目没有进入列表（OCR 未出现「已完成的会话」/「子任务不列出」）；
- 大数字为 `counts.running = 3`，不是 `pending = 5`。

热切换 mock 到全 0（不重启进程）：

```text
render pending=0 running=0 approvals=0 doneUnread=0 sessions=0
       mode=idle alpha=0.72 expanded=1 origin=mock
expand-resize panel={{1108, 12}, {320, 170}} sessions=0
```

### 6. `--url auto` 跟随真实 DSH

```text
RadarHUD start pid=35819 source=url=auto(/Users/pawsey/.dsh/agent-bridge/radar-url.json)
       interval=1.0 expandFlag=false
url resolved http://127.0.0.1:64274/x-radar/radar source=file reason=startup
render pending=1 running=1 approvals=0 doneUnread=2 sessions=1
       mode=active alpha=1.00 expanded=0 origin=remote
expand panel={{1108, 12}, {320, 180}} sessions=1
```

真实接口当时返回 `running=1`、`pending=1`，items 中恰好 1 条
`kind=session, status=running`（另 2 条是 `kind=run, status=done`）；HUD 只列出
1 行，面板高度 180。`sessions=1` 说明过滤逻辑在真实 feed 上生效。

### 7. 多显示器位置恢复与展开

手写 `hud-window.json` 为 `{"x":2000,"y":500,"version":2}`（副屏 HP E223，
frame 1920×1080 位于 x=1440）：

```text
window frame={{2000, 500}, {56, 56}} savedOrigin=restored
expand panel={{1988, 304}, {320, 264}} circle={{2000, 500}, {56, 56}}
       growLeft=false growUp=false screen=HP E223
CG bounds X=1988 Y=332 W=320 H=264
```

- 副屏内正确恢复；圆形在副屏左半边、上半边 → 面板向右、向下生长；
- 面板右 2308 < 副屏右 3360、下 304 > 副屏底 -180，未越界；
- 测试后已恢复测试前保存的位置。

### 8. 生命周期 / 单实例 / 信号

```text
shutdown: signal 15
pid file removed
# 进程退出，~/.dsh/agent-bridge/hud.pid 不存在

shutdown: signal 2        # SIGINT 同样正常退出
pid file removed

# 第二个实例（第一个仍在运行）
pid file points to live RadarHUD pid=36150
another RadarHUD instance is running, exit 0
# 第二次启动 exit 0，第一个实例不受影响
```

本轮所有测试实例都用 `kill -TERM` / `kill -INT` 结束，结束时
`pgrep -fl RadarHUD` 为空，`hud.pid` 不存在。

## 已知限制

1. **双击/右键/拖动未做自动化端到端测试**：合成点击需要辅助功能/输入监控权限，
   而本工具刻意不申请 AX。代码路径已实现：`handleMouseDown` 第一分支是
   `event.clickCount >= 2` → `open -a "DeepSeek Harness"`；单击只走
   `performDrag`，位移 < 2pt 时打印 `single click: no-op` 并结束。建议人工双击一遍。
2. **hover 测试使用了合成指针移动**（`CGWarpMouseCursorPosition`），已观察到
   `expand` / `collapse` 日志与窗口 56×56 ↔ 320×264 的切换；但「从圆移进面板
   不收起」的连续手势没有做逐帧自动化验证，逻辑由「整个根视图一个 tracking area
   + 250ms 延迟」保证。
3. **全屏 App 覆盖未在真实全屏 Space 中实测**：选 `.screenSaver(1000)` +
   `.fullScreenAuxiliary` 是按能压住全屏窗口的层级实现的；未用真实全屏应用做端到端
   验证（避免改动用户桌面）。
4. **截图/OCR 依赖 Screen Recording 权限**：无权限时 `screencapture` 会得到黑图；
   HUD 本身不申请该权限、不录屏。
5. **激活 DSH 写死 App 名** `DeepSeek Harness`（`open -a`）；若 App 改名需改
   `activateDSH()` 常量。
6. **只读展示**：HUD 不提供就地批准/跳转具体任务，双击只激活 DSH，不做任务深链。
7. **超大数字**：`counts.running` 到 3–4 位数时圆形内数字可能拥挤（真实场景很小）。
8. **auto 首次启动**：若 `radar-url.json` 不存在且没有显式 URL，会先显示「离线」，
   等文件出现后自动恢复（契约如此，不是 bug）。
9. **位置保存时机**：SIGKILL 会丢失最后一次拖动后的位置；pid 由下次启动自愈。
10. **窗口层级为 `.screenSaver` 时会盖住菜单栏区域**（仅右下角 56×56）；可用右键
    「置顶开/关」临时降级。
11. **`--expand` 仅测试用**：正常启动不要传，否则鼠标离开不收回。

## DSH 侧启动建议

```js
// 一行版：DSH 插件 spawn 独立 HUD，auto 跟随端口，detached 不阻塞宿主
spawn(RadarHUDPath, ['--url', 'auto', '--interval', '2'], { detached: true, stdio: 'ignore' }).unref()
```

`RadarHUDPath` 建议为 `<workspace>/plugins/dsh-task-radar/native/RadarHUD`；插件每次
apply 时同时写 `~/.dsh/agent-bridge/radar-url.json`（`url` + `port` + `updatedAt`），
HUD 会在下一轮自动切换端口。若插件更愿意传显式 URL，`--url http://127.0.0.1:<port>/x-radar/radar`
同样可用（端口变化时需重启 HUD）。
