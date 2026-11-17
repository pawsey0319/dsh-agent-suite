#!/usr/bin/env bash
# 一键验收：雷达 / 桥 / 判断层 / 产物面
set -u
WS="$(cd "$(dirname "$0")/.." && pwd)"
BRIDGE="$WS/plugins/dsh-agent-bridge/bin/dsh-bridge"
fail=0
step() { printf '\n== %s ==\n' "$1"; }
ok()   { printf '  ✅ %s\n' "$1"; }
bad()  { printf '  ❌ %s\n' "$1"; fail=$((fail+1)); }

step "1/5 雷达 feed"
RADAR_URL_FILE="$HOME/.dsh/agent-bridge/radar-url.json"
PORT=$(python3 -c "import json;print(json.load(open('$RADAR_URL_FILE'))['port'])" 2>/dev/null)
if [ -n "${PORT:-}" ] && curl -sf "http://127.0.0.1:$PORT/x-radar/radar" -o /tmp/smoke-radar.json; then
  python3 - <<'PY' && ok "radar feed counts 正常" || bad "radar feed 异常"
import json
d=json.load(open('/tmp/smoke-radar.json'))
assert d.get('ok') is not False
print('   counts', d.get('counts'), 'items', len(d.get('items') or []))
PY
else
  bad "雷达 feed 不可达（DSH 是否在运行？）"
fi

step "2/5 桥 / 聚合 API"
if "$BRIDGE" doctor | tee /tmp/smoke-doctor.txt | grep -q "probe      OK"; then
  ok "doctor probe OK"
else
  bad "doctor 失败：$(grep -c . /tmp/smoke-doctor.txt 2>/dev/null || echo 0) 行输出"
fi

step "3/5 codex 一句话"
"$BRIDGE" run --agent codex --prompt "只回答两个字：可以" --timeout 90 >/tmp/smoke-codex.out 2>/tmp/smoke-codex.err
if grep -q "可以" /tmp/smoke-codex.out; then
  ok "codex 应答：$(tr -d '\n' < /tmp/smoke-codex.out | head -c 40)"
else
  bad "codex 失败：$(tail -2 /tmp/smoke-codex.err 2>/dev/null | tr '\n' ' ')"
fi

step "4/5 claude 一句话"
"$BRIDGE" run --agent claude --prompt "只回答两个字：可以" --cwd "$WS" --timeout 150 >/tmp/smoke-claude.out 2>/tmp/smoke-claude.err
if grep -q "可以" /tmp/smoke-claude.out; then
  ok "claude 应答：$(tr -d '\n' < /tmp/smoke-claude.out | head -c 40)"
else
  bad "claude 失败：$(tail -2 /tmp/smoke-claude.err 2>/dev/null | tr '\n' ' ')"
fi

step "5/5 产物面"
if [ -n "${PORT:-}" ] && curl -sf "http://127.0.0.1:$PORT/office-artifacts/list?cwd=$WS&hours=720" -o /tmp/smoke-artifacts.json; then
  N=$(python3 -c "import json;print(json.load(open('/tmp/smoke-artifacts.json')).get('count'))")
  ok "office-artifacts 可达（该目录最近 30 天产物 $N 个）"
else
  bad "office-artifacts 不可达"
fi

printf '\n结果：%s\n' "$([ $fail -eq 0 ] && echo '全部通过 ✅' || echo "$fail 项失败 ❌")"
exit $fail
