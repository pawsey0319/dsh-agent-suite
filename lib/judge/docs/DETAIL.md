# 验收判别（L1）

R8 的 L1 判别层最小实现：`contract.json` → 确定性检查 → LLM 裁决 → 通知门。

## 数据面

- `~/.dsh/agent-bridge/verify/<runId>/contract.json`（签发后不可改）
- `verdict.json` / `history.jsonl` / `rounds.json`
- 配置 `~/.dsh/agent-bridge/judge.json`：`{autonomy, maxRounds, judge:{protocol,baseUrl,model,apiKeyEnv}}`

## HTTP

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-judge/health` | 当前自主度与被判模型 |
| POST | `/dsh-judge/contract` | 签发契约（重复签发回 409） |
| GET | `/dsh-judge/contract?run=` | 读契约 |
| POST | `/dsh-judge/verify` | 跑一次判别（可带 rework:false 只判不改） |
| GET | `/dsh-judge/verdict?run=` | 读最近裁决 |
| GET | `/dsh-judge/list` | 所有 run 的裁决与轮次 |
