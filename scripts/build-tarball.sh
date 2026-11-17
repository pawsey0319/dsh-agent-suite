#!/usr/bin/env bash
# 打出可安装的整合包 tarball（bundle/ 是唯一发布源）。
# 用法：bash scripts/build-tarball.sh [输出目录]（默认 ./dist）
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/dist}"
mkdir -p "$OUT"
cd "$ROOT/bundle"

# 发布前自检：语法 + 成员清单存在
node --check index.js
for f in lib/*/index.js; do node --check "$f"; done
test -f members.json || { echo "members.json missing; run the sync step first" >&2; exit 1; }
test -x lib/radar/native/RadarHUD || { echo "native RadarHUD missing/not executable" >&2; exit 1; }

npm pack --pack-destination "$OUT" >/dev/null
ls -l "$OUT"/pawsey0319-dsh-agent-suite-*.tgz | tail -1
