# 发布说明（v0.7）

交接物：DSH 桌面版的一组本地插件 + 一份一键验收脚本。**不修改 `app.asar`**，全部通过 profile 的 bundle 机制装载。

## 一、包含内容

| 包 | 版本 | 职责 | 依赖 |
| --- | --- | --- | --- |
| `@local/dsh-agent-bridge` | 0.6.1 | 把 Codex / Claude Code / WorkBuddy 作为外部 run 接进来；聚合 API 上行；`bin/dsh-bridge` CLI | `@openai/codex`（profile 自带）、`claude` 2.1.x、WorkBuddy.app |
| `@local/dsh-judge` | 0.1.3 | L1 验收判别层：任务契约 → 确定性检查 → LLM 裁决 → 通知门 → 返工 | 聚合 API（OpenAI 兼容） |
| `@local/dsh-task-radar` | 0.4.8 | 桌面悬浮胶囊（RadarHUD，Swift）+ `/x-radar/radar` 聚合口 | macOS arm64、Swift 编译器（构建用） |
| `@local/dsh-office-artifacts` | 0.1.1 | 办公产物扫描与定位 | 无 |

`dsh-project-journal` 0.1.0 是既有插件，本轮未改动，未纳入发布包。

## 二、安装

```bash
# 1) 装包（在 DSH 里）：
#    plugin_manager install_bundle <本目录>/dist/local-dsh-task-radar-0.4.8.tgz
#    其余三个同理；安装后必须「重启 App」让宿主侧插件加载新一代模块

# 2) 雷达原生二进制需在目标机自行构建（tarball 不内含二进制）：
cd plugins/dsh-task-radar/native && bash build.sh

# 3) 验收：
bash scripts/smoke.sh
```

`dsh-bridge` 可直接用：`plugins/dsh-agent-bridge/bin/dsh-bridge doctor|run|list|show|approve`。

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
