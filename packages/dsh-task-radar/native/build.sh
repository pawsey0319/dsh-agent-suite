#!/usr/bin/env bash
# RadarHUD 构建脚本（可重复执行）
#
#   bash build.sh
#
# 依赖：macOS 自带 Swift 工具链（Xcode Command Line Tools 即可）。
# 输出：同目录下的 RadarHUD（裸 Mach-O 可执行文件，不是 .app bundle）。
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "error: 找不到 swiftc；请先安装 Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
fi

echo "==> swiftc -O -framework AppKit RadarHUD.swift -o RadarHUD"
swiftc -O -framework AppKit RadarHUD.swift -o RadarHUD

echo "==> built: $(pwd)/RadarHUD"
file RadarHUD
