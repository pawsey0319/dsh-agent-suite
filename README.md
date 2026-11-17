# DSH Agent Suite

让 **DeepSeek Harness（DSH）** 成为一个入口：在对话里调用 Codex / Claude Code / WorkBuddy，任务完成与待批准事件出现在桌面胶囊上，办公产物一键回看。

> 只改 profile 的 bundle，不修改 `app.asar`。全部为本地插件。

## 包含什么

| 包 | 作用 |
| --- | --- |
| [`@pawsey0319/dsh-agent-bridge`](packages/dsh-agent-bridge) | 把 Codex / Claude Code / WorkBuddy 接成「外部 run」，逐事件记录、审批回传、聚合 API 上行；带 `dsh-bridge` 命令行 |
| [`@pawsey0319/dsh-judge`](packages/dsh-judge) | L1 验收判别层：任务契约 → 确定性检查 → LLM 裁决 → 通知门 → 返工 |
| [`@pawsey0319/dsh-task-radar`](packages/dsh-task-radar) | 桌面悬浮胶囊（原生 AppKit）：运行中 / 待批准 / 完成未看 / 办公产物 |
| [`@pawsey0319/dsh-office-artifacts`](packages/dsh-office-artifacts) | 扫描工作区里的 docx/xlsx/pptx/pdf，并在 Finder 中定位 |

## 安装（macOS arm64）

**一次装一个包**：整合包内含四个成员与原生胶囊二进制，不再需要逐个安装、也不需要本机编译 Swift。

1. 从 [Releases](https://github.com/pawsey0319/dsh-agent-suite/releases) 下载 `pawsey0319-dsh-agent-suite-<版本>.tgz`，
   或本机构建：`bash scripts/build-tarball.sh`（产物在 `dist/`）。
2. 在 DSH 里安装（插件管理 → 安装 bundle → 粘贴本地绝对路径或 Release 直链）：
   ```
   plugin_manager install_bundle /绝对路径/pawsey0319-dsh-agent-suite-0.8.1.tgz
   # 或直链
   plugin_manager install_bundle https://github.com/pawsey0319/dsh-agent-suite/releases/download/v0.8.1/pawsey0319-dsh-agent-suite-0.8.1.tgz
   ```
3. **重启 DSH**（宿主侧插件要换新一代模块；前端只要 Cmd+R）。
4. 验收：

```bash
bash scripts/smoke.sh
```

期望五项全 ✅：雷达 feed / `doctor` probe / codex 一句话 / claude 一句话 / 办公产物。

装完可用 `curl -s localhost:<端口>/agent-suite/health` 看四个成员是否都 `mounted`。

### 从源码更新整合包

`bundle/` 是唯一发布源，`bundle/lib/*` 由 `packages/*` 同步而来。改完成员源码后：

```bash
bash ../scripts/sync-suite-bundle.sh   # 在 DSH 工作区根执行：packages → bundle/lib + members.json
bash scripts/build-tarball.sh          # 重新打包
```

## 胶囊怎么用

- **悬停**展开任务列表，**双击**回到 DSH；
- 圆球颜色：**红** = 有任务等你批准，**绿** = 有任务完成未看；
- 点 **待批准** 行 → 直接批准/拒绝；
- 点 **完成** 行 → 跳回那段对话；
- 点 **进行中** 行 → 看当前进度（已运行时长、最近活动、下一步）；
- 点 **产物** 行 → Finder 定位文件。

## 前置条件

- macOS **arm64**（胶囊是原生 AppKit 二进制，已随包分发）
- DSH 桌面版
- 可选：Codex（随 DSH 自带）、Claude Code CLI、WorkBuddy.app
- 聚合 API：读 `~/.dsh/profiles/desktop/cordis.patch.yml` 里 `llm-pi-ai` 的第一个 provider，插件不另存配置

## 文档

- [发布说明](docs/RELEASE.md)：包清单、安装/卸载、验收标准、已知限制
- [开发笔记](docs/DEV.md)：宿主插件纪律、数据契约、踩过的坑

## License

MIT
