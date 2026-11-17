# 办公产物（Office artifacts）

## 它解决什么

用 DSH 做办公任务时，产物（docx / xlsx / pptx / pdf）散落在工作区各层目录里，任务结束后很难一眼找全。
本插件把「最近 N 小时内在工作区生成的办公文档」汇总成一份清单，供 HUD 与对话引用。

## HTTP

| 路由 | 作用 |
| --- | --- |
| `GET /office-artifacts/health` | 存活检查 |
| `GET /office-artifacts/list?cwd=&hours=72` | 扫描并返回清单（同时落盘 `~/.dsh/agent-bridge/artifacts.json`） |
| `GET /office-artifacts/saved` | 读取上次落盘结果（宿主重启后仍可查） |
| `GET /office-artifacts/open?path=` | 在 Finder 中定位该文件（`open -R`） |

`list` 返回 `{ok, cwd, sinceHours, count, items[{path, relative, name, ext, kind, size, updatedAt}], generatedAt}`，
`kind ∈ doc | sheet | slide | pdf | other`。

## 边界

- 只读扫描，最多 400 个文件、4 层目录；跳过 `node_modules`、`.git`、`dist` 等目录与 Office 临时锁文件 `~$*`。
- 不渲染、不转换、不自动打开；预览交给系统 Quick Look（`open` 打开所在文件夹）。
- 判断「新生成」用的是 mtime，不是创建时间（复制/编辑都会刷新 mtime）。
