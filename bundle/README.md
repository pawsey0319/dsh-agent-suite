# DSH Agent Suite

One install, four plugins for DeepSeek Harness (desktop, macOS arm64):

| 插件 | 作用 | 入口 |
| --- | --- | --- |
| task-radar | 桌面右上角悬浮胶囊：运行中/待批准/完成提醒 + 悬停任务列表 | 原生 HUD 窗口 |
| agent-bridge | 在 DSH 里调用 Codex / Claude Code / WorkBuddy，结果回到对话 | `bin/dsh-bridge`、HTTP |
| judge | L1 验收判别层：契约 + 确定性检查 + LLM 裁决 + 通知门 | `/dsh-judge/*` |
| office-artifacts | 扫描工作区办公产物（docx/xlsx/pptx/pdf） | `/office-artifacts/*` |

## 安装

DSH → 插件管理 → 安装 bundle → 粘贴（或本地 `plugin_manager install_bundle <tgz 绝对路径>`）：

```
https://github.com/pawsey0319/dsh-agent-suite/releases/download/v0.8.1/pawsey0319-dsh-agent-suite-0.8.1.tgz
```

装完重启 DSH App 生效（Node 侧插件不支持热替换）。

装完自检：

```bash
curl -s localhost:<web 端口>/agent-suite/health   # 四个成员 state=mounted
bash scripts/smoke.sh                              # 五项全 ✅
```

包内结构：`index.js`（成员挂载 + `/agent-suite/health`）、`client.js`（Web 前端半边）、`members.json`（成员清单）、`lib/{bridge,judge,office,radar}/**`、`lib/radar/native/RadarHUD`（已编译，含 `build.sh` 与 `RadarHUD.swift` 便于重编）。
