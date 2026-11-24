# Agent Bridge（P1）

把 Codex 作为**外部 run** 接进 DSH：DSH 负责发起与展示，Codex 在自己进程里跑，
每一个 app-server 通知都**原样落盘**后再投影成时间线。

## 数据面
- 子进程：`codex app-server --listen stdio://`（二进制随 DSH profile 分发，见 `codexBinary()`）。
- 每 run 一个 thread：`thread/start` → `turn/start`；事件来自 `item/*`、`turn/*` 通知。
- 落盘：`~/.dsh/agent-bridge/runs/<runId>/events.jsonl`（每行一条原始通知 + 归一化字段），`meta.json` 存元数据。
- 审批：`item/*/requestApproval` 进审批队列，run 标 `needs-approval`；5 分钟无人应答自动 `decline`。

## HTTP（同源，前缀 `/agent-bridge`）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | codex 子进程状态、run 数、待批数 |
| POST | `/runs` | `{prompt, cwd?, model?}` → `{runId, threadId, turnId}` |
| GET | `/runs` | run 列表 |
| GET | `/runs/<id>?since=&limit=` | 元数据 + 事件窗口 |
| GET | `/runs/<id>/stream?since=` | SSE 实时事件 |
| GET | `/approvals` | 待批列表 |
| POST | `/approvals/<id>` | `{decision:"accept"|"acceptForSession"|"decline"|"cancel"}` |

## 设计约束（踩过）
- 路由与子进程都在 `ctx.effect` 内注册并返回 disposer，否则热替换后 `duplicate prefix route`。
- 原始通知是唯一真源，投影只做读；`seq` 单调递增，SSE 断线用 `since` 续传。
- 目前只接 Codex；Claude Code（P2）与 WorkBuddy（P3）复用同一 `CodexHost`/`RunStore` 形状。
