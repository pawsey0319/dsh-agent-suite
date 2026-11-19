# 变更记录（CHANGELOG）

整合包 `@pawsey0319/dsh-agent-suite`。逐条对应可验证的行为与证据位置，不写「优化体验」这类无法核对的话。

## 0.9.0 — 2026-11-19

**成员版本**：`dsh-task-radar` 0.6.13、`dsh-agent-bridge` 0.6.2、`dsh-judge` / `dsh-office-artifacts` 随整合包发布。

### 胶囊（dsh-task-radar 0.6.13）

- **等回答/待批准/在跑三态可辨**：静态环形态表达状态（缺口=等你回答、双环=待批准、实心环=有新完成、中性细环=在跑），
  `sessionController.list()` 之外的信号（`typertGateway.getPendingRemoteEvents()`）产生 `kind=question` 条目；等回答的会话不再计入「进行中」。
- **宽胶囊**：待回答 / 待批准 / 失败时收起态是 44 高、178–234 宽（上限 240）的胶囊，直接写 `等回答：<问题首句>…`；
  锚点跟随圆盘位置，宽窄同一 NSWindow（不新建窗口）。
- **就地处置（选项类）**：HUD 存活且无活 Web 客户端时接管会话内提问，面板内点选项即提交，多选提交行；20s 未答 / HUD 退出 /
  插件卸载立刻 `next()` 让渡回桌面提问卡；回执形状 `{answers:[{id,selected,custom}]}`。
- **横幅**：点完成横幅一键跳会话（先标已读再跳）、`run` 打开详情、审批/提问打开处置页；条目被消费后横幅下一轮自动消失
  （`banner dismiss reason=item-consumed`），取数失败不吞提醒（`banner keep reason=feed-error`）。
- **未读口径**：以 DSH 可证事实清账（行消失 `dsh-gone`、会话又跑 `dsh-running`、完成后仍有输入 `dsh-prompt`），
  其余才回退雷达自己的 60 分钟保留。
- **僵尸 run**：桥把子进程 pid 落进 `runs/<id>/meta.json`，进程消失即写回 `failed + reason=process-exited`；
  雷达读侧两级判定（`pidAlive:false` 立即落终态，10 分钟只留给「活着但卡住」）。
- **性能与门禁**：呼吸改 Core Animation、feed stale-while-revalidate（p50 57.7ms → 0.3ms）、日志 10MB×3 轮转、
  胶囊窗口复用（不再 1→0 抖动）、`release-gate.sh --phase pre` 落升级前快照、`--bench` 输出真实 `cpu_pct`/`rss_kb`。

### 已知限制

- M9（10 万事件详情渲染）按用户 2026-11-18 裁定记 `KNOWN-DEFERRED`，阈值未改（50ms），由 F-04 追踪。
- 客户端半边的指纹自愈（R-03/U-04）本轮**未启用**：任何 `client.js` 改写都会 bump 客户端 bundle rev，
  运行期安装会导致页面按新 rev 拉 combo 404 → web-boot 失败，因此 `client.js` 与上一版字节一致，门禁记 `KNOWN-DEFERRED`。

## 0.8.2 — 2026-11-18

- 低危清理 N-18…N-21（SSE 终态结束、历史 `finalAnswer` 回填、空队列 clear 返回 200、clientHalf 心跳）。
- 雷达 0.6.7：`--bench` JSON Lines、日志轮转、重复实例不删存活 `hud.pid`。

## 0.8.1 / 0.8.0

- 首个可安装整合包：四个成员 + 原生胶囊二进制，`plugins == bundle == tarball` 三方哈希一致。
