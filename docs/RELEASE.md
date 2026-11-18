# 发布说明（v0.8.1）

交接物：**一个整合包 = 四个插件 + 原生胶囊二进制**。只改 profile 的 bundle，不修改 `app.asar`。

## 一、包含内容

发布物只有一个 tarball：`pawsey0319-dsh-agent-suite-0.8.1.tgz`（约 350 KB）。解包后：

| 路径 | 说明 |
| --- | --- |
| `index.js` | 成员挂载 + 健康面 `GET /agent-suite/health`（成员状态、失败成员名、lastError） |
| `client.js` | Web 前端半边（点击胶囊行跳转会话），通过 `dsh.client` 声明 |
| `members.json` | 成员清单：label / name / version / entry / routes / native |
| `lib/agent-bridge/**` | 外部 run 桥（Codex / Claude Code / WorkBuddy）+ `bin/dsh-bridge` CLI |
| `lib/judge/**` | L1 验收判别层（契约 → 确定性检查 → LLM 裁决 → 通知门 → 返工） |
| `lib/office/**` | 办公产物扫描与 Finder 定位 |
| `lib/radar/**` | 桌面胶囊宿主侧 + `native/RadarHUD`（**已编译的 macOS arm64 二进制**，另附 `RadarHUD.swift` 与 `build.sh` 便于重编） |

版本：agent-bridge 0.6.1 / judge 0.1.3 / office-artifacts 0.1.1 / task-radar 0.5.0 / suite 0.8.1。

**唯一发布源**是仓库里的 `release/agent-suite/bundle/`；`/tmp` 只放构建产物，不承担安装来源。
构建：`bash scripts/build-tarball.sh`（产物在 `dist/`，`dist/` 不入库）。


> 历史说明：`.github/workflows/publish-npm.yml` 是 0.7 时代「四个包分别发 npm」的遗留流程。
> 现在四个成员以 `private` 打捆进整合包，发版只产出本 tarball 与 GitHub Release，
> 因此该 workflow 在 tag 上会以 `EPRIVATE` 失败，属预期，不影响发布物。

## 二、安装

### 0. 硬前提：换包后必须重启 DSH 宿主

宿主侧插件（bridge / judge / office / radar）是 Node 侧模块，**不支持热替换**。把 profile 里的来源从一个包换成另一个包（例如 `link:` → `file:` tarball、或换版本）后，只重启前端没用：

- 失败表现：`GET /agent-suite/health`、`/x-radar/radar`、`/agent-bridge/health` **全部 404**，且 `pgrep -f native/RadarHUD` 无进程；
- 正确处置：退出 DSH App 再打开（或重启承载它的宿主进程），然后复查上面的路由。

### 1. 装包

```bash
# 本地 tarball（路径用绝对路径）
plugin_manager install_bundle /绝对路径/pawsey0319-dsh-agent-suite-0.8.1.tgz

# 或 GitHub Release 直链
plugin_manager install_bundle https://github.com/pawsey0319/dsh-agent-suite/releases/download/v0.8.1/pawsey0319-dsh-agent-suite-0.8.1.tgz
```

`application=applied` 只代表 profile 的依赖与 bundle 列表已写好；宿主是否真的挂上，用第 3 步的健康面判断。

### 2. 重启 DSH 宿主（见上面第 0 条）

### 3. 验收

```bash
curl -s localhost:<web 端口>/agent-suite/health   # ok=true 且四成员 state=mounted
bash scripts/smoke.sh                              # 五项全 ✅
```

`dsh-bridge` 可直接用：`bundle/lib/agent-bridge/bin/dsh-bridge doctor|run|list|show|approve`。

## 三、卸载

```
plugin_manager remove_bundle @local/dsh-task-radar   # 其余三个同理
```
残留状态目录：`~/.dsh/agent-bridge/`（runs / verify / seen.json / radar-sessions.json 等），可整体删除，不影响 DSH。

## 四、验收标准（`scripts/smoke.sh` 五项）

1. 雷达 feed 可达且 `counts` 正常；
2. `doctor` → `probe OK`（走 DSH 同一条 `company` 网关）；
3. `codex` 一句话应答；
4. `claude` 一句话应答（1M 窗口已声明）；
5. `office-artifacts` 可达。

## 五、已知限制

- **仅 macOS arm64**（RadarHUD 用 AppKit 写的原生窗口）；Linux/Windows 无胶囊，只能走 HTTP 与 CLI。
- 聚合 API 依赖 `~/.dsh/profiles/desktop/cordis.patch.yml` 里 `llm-pi-ai` 的第一个 provider；换网关只改那一处，插件不另存配置。
- WorkBuddy 驱动需要重启它的实例（单实例锁），会提示你确认；「需要人确认」会自动推到胶囊。
- 阶段/进度只对声明了阶段计划的任务有意义；普通会话在 DSH 里没有结构化阶段字段。
- R4 的「内嵌原生视图」已按用户裁定退役，只保留 OS 级 takeover 与 CLI。

## 五之二、多宿主并存（同机跑两个 DSH）

同一台机器同时跑两个 DSH 宿主（例如 desktop 与 `--profile web`）时，两个宿主都会启用这个整合包。
0.8.1（t18 起）把**运行时状态按端口隔离**，不再互相踩：

| 文件 | 位置 | 说明 |
| --- | --- | --- |
| `bridge-url.json` | `~/.dsh/agent-bridge/hosts/<port>/` | 权威文件；根目录同名文件仅作兼容镜像（只在不存在/指向自己/过期 >10min 时刷新） |
| `radar-url.json` | `~/.dsh/agent-bridge/hosts/<port>/` | HUD 用 `--state-dir` 读写自己那一份 |
| `hud.pid` | `~/.dsh/agent-bridge/hosts/<port>/` | 内容 `{pid, ownerPort, dir}`；supervisor 只 kill `ownerPort` 等于自己的 HUD |
| `seen.json` / `jump.json` / `radar-sessions.json` | `~/.dsh/agent-bridge/hosts/<port>/` | 旧根目录文件在首次启动时一次性迁移，并记 `state.migrate` 日志 |

CLI 端口发现顺序：`DSH_BRIDGE_URL` → `hosts/<port>/bridge-url.json` 中 TCP 仍在监听的那个（多个活宿主取 `updatedAt` 最新的）→ 根目录兼容镜像。都找不到时输出「找不到活着的 DSH 宿主」并列出试过的端口与提示，不再是一句 `fetch failed`。

**仍然是共享的**（设计如此，两个宿主看到同一批 run/审批）：`runs/`、`pending-approvals.json`、`clear.token`、`verify/`、`artifacts.json`。共享的代价：A 宿主留下的孤儿审批会被 B 宿主也看到，但 B 能按 t15 的语义丢弃它（`{dismissed:true}`），不会误放行。

清理：直接删 `~/.dsh/agent-bridge/hosts/<port>/` 里已退出宿主的目录即可，运行中的宿主不受影响（下次启动会重建自己的目录）。

## 六、0.8.1 验收记录（2026-11-17）

- 发布源：`release/agent-suite/bundle/`（git `3eff69b` + tag `v0.8.1`）；`/tmp/release` 已改成纯构建产物目录。
- tarball：`dist/pawsey0319-dsh-agent-suite-0.8.1.tgz`，355298 字节 / 41 个文件，
  sha256 `8ef67db28987a857a5091ba8ad1bb4923da9db6835c8a595c95f48c58b76c1bb`；
  含 `client.js`、`members.json`、`cordis.patch.yml`、`lib/{bridge,judge,office,radar}/**`、
  `lib/radar/native/{RadarHUD(已编译),RadarHUD.swift,build.sh}`、`lib/bridge/bin/dsh-bridge`（0755）。
- Release：<https://github.com/pawsey0319/dsh-agent-suite/releases/tag/v0.8.1>；
  `curl -I` 附件直链 → `HTTP/2 200`、`content-length: 355298`，下载件 sha256 与本地一致。
- 两条安装路径（`/tmp/release` 已改名移走，全程不依赖 /tmp）：
  1. `file:` 本地 tarball → 装进隔离 profile 后启动宿主：`/agent-suite/health` **200**、`ok:true`、四成员 `mounted`；
  2. GitHub Release 直链 URL → 同上 **200**、四成员 `mounted`。
- 换包（`link:` → `file:`、或换版本）**必须重启宿主**：否则 `/agent-suite`、`/x-radar`、`/agent-bridge` 全部 404 且无 `native/RadarHUD` 进程（见第二节第 0 条）。

## 七、多宿主隔离验收记录（2026-11-17，t18）

同机并存三个宿主实测：desktop `49409`（旧字节，仍在跑）、web `51651`、web `51652`（新字节）。

```
~/.dsh/agent-bridge/hosts/51651/bridge-url.json  {"url":"http://127.0.0.1:51651","port":51651,"host":"51651"}
~/.dsh/agent-bridge/hosts/51651/radar-url.json   {"url":"http://127.0.0.1:51651/x-radar/radar","port":51651,...}
~/.dsh/agent-bridge/hosts/51651/hud.pid          {"pid":10726,"ownerPort":51651,"dir":".../hosts/51651",...}
~/.dsh/agent-bridge/hosts/51652/bridge-url.json  {"url":"http://127.0.0.1:51652","port":51652,"host":"51652"}
~/.dsh/agent-bridge/hosts/51652/radar-url.json   {"url":"http://127.0.0.1:51652/x-radar/radar","port":51652,...}
~/.dsh/agent-bridge/hosts/51652/hud.pid          {"pid":9261,"ownerPort":51652,...}
根目录 bridge-url.json 仍指向 49409（另一宿主在线时不覆盖）
```

- HUD 进程各自带 `--state-dir`：`RadarHUD --url auto --interval 2 --state-dir .../hosts/51651`、`.../hosts/51652`；互不读取对方文件。
- 归属校验实测：把 `hosts/51651/hud.pid` 人为改成 `{"pid":9858,"ownerPort":49409}`（desktop 的 HUD）→ `host.hud.foreign pid=9858 owner=49409 self=51651 (不是本宿主的 HUD，不动)`，9858 存活；51651 只重启自己的 HUD。
- 单点崩溃只复活自己：kill 掉 51652 的 HUD 后 26s，51652 复活出新 HUD，51651 / 49409 的 HUD pid 不变。
- CLI 端口发现：`[dsh-bridge] base=http://127.0.0.1:51652`（两宿主都活，取 `updatedAt` 最新）→ 停掉 51652 后自动 `base=http://127.0.0.1:49409`；`HOME=/tmp/t18-nohost`（只有死端口）输出：
  `找不到活着的 DSH 宿主：找过这些端口但都没在监听：59999(...)；提示：…或显式指定 DSH_BRIDGE_URL=http://127.0.0.1:<port>`；
  `DSH_BRIDGE_URL=http://127.0.0.1:51651` 时优先走显式地址。
- 迁移：首次启动记 `state.migrate seen.json legacy=.../.dsh/agent-bridge/seen.json host=.../hosts/<port>/seen.json`、`state.host port=<port> dir=...`；删除 `hosts/51651`、`hosts/51652`（宿主退出后）与伪造的 `hosts/99999`，desktop 的 health/radar 仍 200。
- 三类事件在隔离后的宿主上正常：codex 完成（doneUnread 18→19）、claude 审批（counts.approvals 1→0，run finalAnswer 含 `t18-approval-ok`）、claude-hook 提问（counts.questions 1→0，回执 `{"pace":{"answers":["立刻发布"]}}`）。
- `bash scripts/smoke.sh` → 8/8、`SMOKE_EXIT=0`（第 6/7/8 步的隔离 HOME 里也能看到 `bridge-url host=.../hosts/<port>`）。
- sha256（前 12 位，plugins 与 bundle 逐字节一致）：bridge `883f1cb61457`、bin/dsh-bridge `11670dff4934`、radar `d223d23bb75a`、RadarHUD.swift `e368b0fac559`、RadarHUD `1fa6045c3c56`。

## 八、client 半边自检 / 跳转降级 / 通知 30s（2026-11-17，t18 第二批）

新增行为（均可用环境变量调，生产默认值在括号里）：

| 能力 | 行为 | 默认 |
| --- | --- | --- |
| client 半边自检 | 宿主起来 30s 还没收到 `client.apply` beacon → `/agent-suite/health` 与 `/x-radar/radar` 多出 `clientHalf{active:false,lastBeacon,hint}`，HUD 一次性横幅「跳转需重载页面」 | 30s（`DSH_TASK_RADAR_CLIENT_STALE_MS`） |
| 跳转降级 | HUD 点会话/完成行 → `GET /x-radar/jump?session=…` 写信箱；8s 内没有 `jump-ack` → 服务端 `open -a "DeepSeek Harness"` 并记 `jump.degraded … open=ok`，HUD 横幅「已打开 DSH，但没定位到会话」 | 8s（`DSH_TASK_RADAR_JUMP_ACK_MS`；`DSH_TASK_RADAR_JUMP_OPEN=0` 只记日志不开 App，测试用） |
| markSeen 顺序 | HUD 轮询 `/x-radar/jump-status?id=…`：`acked` → 标已读（`seen=yes`）；`degraded` / `unknown` / 超时 → 不标已读 + 失败横幅（`seen=no`） | 1s × 12 次 |
| 通知自动消失 | 可点的横幅（完成/审批/提问/失败）30s 未被点击 → `banner dismiss reason=expired`，队列自动上移 | 30s（PRD 2.24） |

实测（host `51651`，新字节）：

```
[11:39:16.889Z] banner client-half inactive lastBeacon=never
[11:39:58.417Z] banner dismiss reason=expired remaining=0 title=25 个任务完成
[11:40:28.596Z] banner dismiss reason=expired remaining=0 title=23 个任务完成
[11:41:27.518Z] jump requested id=jump-mwkmgg9q-vy4f7 session=session- client=inactive
[11:41:35.597Z] jump.degraded id=jump-mwkmgg9q-vy4f7 session=session- client=inactive open=ok
jump-status: 1s -> {"state":"pending","ageMs":1049}; 9s -> {"state":"degraded","ageMs":9074}
seen.json 未新增 session-t18-offline（降级不清未读）
```

```
GET /agent-suite/health → "clientHalf":{"active":false,"lastBeacon":null,"sinceBootMs":9545,"staleAfterMs":3000,"hint":"跳转需重载页面（client 半边没在轮询）"}
GET /x-radar/health      → {"ok":true,"clientHalf":{…},"host":{"port":51651,"dir":"/Users/pawsey/.dsh/agent-bridge/hosts/51651"}}
```

`bash scripts/smoke.sh` → 9/9、`SMOKE_EXIT=0`；第 9 步 `client-half-harness` 覆盖：boot 宽限内 active=true、beacon 后 lastBeacon 有值、jump pending→（压缩后的 600ms）degraded 且日志 `jump.degraded … open=skipped`、ack 后 `jump acked id=… lag=…ms`、未知 id → `unknown`。

已知限制：`/x-radar/jump-status` 只保留最近 60s 的记录；HUD 轮询上限 12s，比服务端 8s 窗口多一次容错。降级路径会真的把 DSH App 端到前台（找不到具体会话），这是 PRD 2.23 的预期行为。

## 九、0.8.1 重新打包与安装复验（2026-11-17，t21）

按 §二 流程用 `release/agent-suite/scripts/build-tarball.sh` 重建（唯一发布源 `release/agent-suite/bundle`）：

- `dist/pawsey0319-dsh-agent-suite-0.8.1.tgz`：**386782 B / 41 文件**，sha256 `55812849485d…`（shasum `5361d0029d7f66e4…`）。
- 包内哈希（sha256 前 16 位，与工作区 `plugins/**` 逐字节相同）：

| 文件 | sha256 前 16 位 | 备注 |
| --- | --- | --- |
| `lib/bridge/index.js` | `9a376fbc9ec7b1ae` | 与 t20 review 期望值一致 |
| `lib/radar/index.js` | `7fecde71fa20f461` | t21 修了 jump 信箱路径/降级判定 |
| `lib/radar/native/RadarHUD.swift` | `33469f384abf35d9` | t21 统一了面板/横幅选屏链 |
| `lib/radar/native/RadarHUD`（预编译） | `0b0f11fcb6d89124` | **673240 B** = 672840 + 400（新增 `panel screen` 日志与选屏辅助） |

安装（plugin_manager，desktop profile，依赖仍指向本 tarball）：

- `remove_bundle @pawsey0319/dsh-agent-suite` → `application:"applied"`
- `install_bundle …/dist/pawsey0319-dsh-agent-suite-0.8.1.tgz` → `application:"applied"`、`version:"0.8.1"`
- 重载后 `GET http://127.0.0.1:49409/agent-suite/health` → **200**、`ok:true`、四成员 mounted（`startedAt 2026-11-17T12:14:33.918Z`）；`/x-radar/radar` 带 `doneUnreadIds`；`/agent-bridge/runs/0033c3ed-…`（内存窗口外最老的 run）→ 200。

> 换包后宿主是否自动加载新字节，取决于插件是否被重新挂载：本轮 remove+install 触发了重挂，node_modules 已是新文件，因此 49409 未重启 App 即生效。若只替换文件不做 remove/install，仍需按 §二.0 重启宿主。
