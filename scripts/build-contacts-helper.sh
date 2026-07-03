#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p resources
clang -fobjc-arc -O2 \
  -framework Foundation -framework Contacts \
  native/contacts-helper/main.m \
  -o resources/contacts-helper
echo "built resources/contacts-helper"
