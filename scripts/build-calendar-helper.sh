#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p resources
clang -fobjc-arc -O2 \
  -framework Foundation -framework EventKit \
  native/calendar-helper/main.m \
  -o resources/calendar-helper
echo "built resources/calendar-helper"
