#!/usr/bin/env bash
# One-command ship: build everything, swap the app into /Applications, relaunch.
# Skips the DMG (--dir) — a disk image only matters for distributing to others.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run helper:build
npx electron-vite build
npm run build:mcp
npx electron-builder --mac --dir

# Re-sign the whole bundle (electron-builder's ad-hoc sign sometimes leaves
# the resource seal broken — "may be damaged or incomplete"). Prefer the
# self-signed "Kairos Dev" identity from scripts/make-signing-cert.sh: its
# designated requirement is stable across rebuilds, so TCC grants (Screen &
# System Audio Recording, Microphone) survive a ship. Ad-hoc is the fallback,
# and mints a new cdhash every time — see the TCC reset below.
identity="${KAIROS_SIGN_IDENTITY:-Kairos Dev}"
if security find-identity -v -p codesigning | grep -q "\"$identity\""; then
  # --timestamp=none: Apple's timestamp server rejects non-Apple identities
  # and an offline ship would otherwise fail; a local build gains nothing
  # from a timestamp anyway
  codesign --force --deep --timestamp=none --sign "$identity" dist/mac-arm64/Kairos.app
else
  echo "warning: no \"$identity\" identity — signing ad-hoc, so the Screen Recording grant" \
       "will not survive this ship (run scripts/make-signing-cert.sh once to fix)" >&2
  codesign --force --deep --sign - dist/mac-arm64/Kairos.app
fi

requirement() { codesign -d -r- "$1" 2>&1 | sed -n 's/^# designated => //p'; }
old_req=$(requirement /Applications/Kairos.app 2>/dev/null || true)
new_req=$(requirement dist/mac-arm64/Kairos.app)
# appId from electron-builder.yml, read back from the bundle we just built
bundle_id=$(defaults read "$PWD/dist/mac-arm64/Kairos.app/Contents/Info.plist" CFBundleIdentifier)

# quit the running app gracefully so it releases the single-instance lock
osascript -e 'quit app "Kairos"' 2>/dev/null || true
for _ in $(seq 1 20); do
  pgrep -xq Kairos || break
  sleep 0.5
done

# TCC pins each grant to the app's designated requirement. When it changes
# (every ad-hoc ship; once when switching to the certificate) the stored
# Screen Recording row goes stale: System Settings still shows Kairos ON,
# the OS reports it denied, and toggling never rewrites the row. Dropping
# the row is the only way out — the prompt on the next Record writes a
# fresh, matching one. Microphone self-heals (its prompt has Allow).
# Runs before the swap: tccutil resolves the bundle id through Launch
# Services, and right after rm -rf + ditto the re-registration can lag.
if [ "$old_req" != "$new_req" ]; then
  if tccutil reset ScreenCapture "$bundle_id" >/dev/null 2>&1; then
    echo "signature changed → Screen Recording grant reset; first Record re-prompts:" \
         "Open System Settings → toggle Kairos on → relaunch"
  else
    echo "warning: signature changed but \`tccutil reset ScreenCapture $bundle_id\` failed —" \
         "run it by hand, then Record → Open System Settings → toggle Kairos on → relaunch" >&2
  fi
fi

rm -rf /Applications/Kairos.app
ditto dist/mac-arm64/Kairos.app /Applications/Kairos.app

open /Applications/Kairos.app

version=$(defaults read /Applications/Kairos.app/Contents/Info.plist CFBundleShortVersionString 2>/dev/null || echo '?')
echo "shipped Kairos ${version} → /Applications"
