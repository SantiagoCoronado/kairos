#!/usr/bin/env bash
# One-command ship: build everything, swap the app into /Applications, relaunch.
# Skips the DMG (--dir) — a disk image only matters for distributing to others.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run helper:build
npx electron-vite build
npm run build:mcp
npx electron-builder --mac --dir

# electron-builder's ad-hoc sign sometimes leaves the resource seal broken,
# which makes macOS refuse to open the app ("may be damaged or incomplete")
codesign --force --deep --sign - dist/mac-arm64/Kairos.app

# quit the running app gracefully so it releases the single-instance lock
osascript -e 'quit app "Kairos"' 2>/dev/null || true
for _ in $(seq 1 20); do
  pgrep -xq Kairos || break
  sleep 0.5
done

rm -rf /Applications/Kairos.app
ditto dist/mac-arm64/Kairos.app /Applications/Kairos.app
open /Applications/Kairos.app

version=$(defaults read /Applications/Kairos.app/Contents/Info.plist CFBundleShortVersionString 2>/dev/null || echo '?')
echo "shipped Kairos ${version} → /Applications"
