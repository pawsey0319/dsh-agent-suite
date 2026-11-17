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
