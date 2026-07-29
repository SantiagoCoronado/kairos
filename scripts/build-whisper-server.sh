#!/usr/bin/env bash
# Build whisper.cpp's whisper-server for the meeting-transcription sidecar
# and stage it at resources/whisper/whisper-server (git-ignored, bundled by
# electron-builder as an extraResource — whisper.cpp publishes no official
# macOS arm64 server binaries). Same pattern as build-calendar-helper.sh.
set -euo pipefail

# pin: whisper.cpp release used by Kairos — bump deliberately, then re-verify
WHISPER_TAG="v1.8.3"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CACHE="${WHISPER_BUILD_DIR:-$HOME/.cache/kairos-whisper-build}"
DEST="$ROOT/resources/whisper"

mkdir -p "$CACHE"
if [ ! -d "$CACHE/whisper.cpp" ]; then
  git clone --depth 1 --branch "$WHISPER_TAG" \
    https://github.com/ggml-org/whisper.cpp "$CACHE/whisper.cpp"
else
  echo "[whisper] reusing checkout at $CACHE/whisper.cpp"
fi

cd "$CACHE/whisper.cpp"
# Metal is on by default on Apple Silicon; the metal shader is embedded in
# the binary. Build only the server target's dependencies.
cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON > /dev/null
cmake --build build --config Release -j --target whisper-server > /dev/null

mkdir -p "$DEST"
cp "build/bin/whisper-server" "$DEST/whisper-server"
codesign --force --sign - "$DEST/whisper-server" 2>/dev/null || true
echo "[whisper] staged $DEST/whisper-server ($(du -h "$DEST/whisper-server" | cut -f1 | tr -d ' '))"
"$DEST/whisper-server" --help > /dev/null 2>&1 && echo "[whisper] binary runs OK" || true
