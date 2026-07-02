#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p build
clang -fobjc-arc -framework AppKit -framework Foundation scripts/make-icon.m -o build/make-icon
./build/make-icon
mkdir -p build/icon.iconset
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" build/icon-1024.png --out "build/icon.iconset/icon_${s}x${s}.png" >/dev/null
  sips -z "$((s * 2))" "$((s * 2))" build/icon-1024.png --out "build/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns build/icon.iconset -o build/icon.icns
rm -rf build/icon.iconset build/make-icon
echo "built build/icon.icns"
