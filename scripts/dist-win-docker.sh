#!/usr/bin/env bash
# Build the Windows installers on Linux/macOS using electron-builder's Docker image,
# which has Wine (NSIS needs it). Reuses this checkout's node_modules and the host's
# download caches, and runs as the current user so no root-owned files appear.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p "$HOME/.cache/electron" "$HOME/.cache/electron-builder"
exec docker run --rm \
  -u "$(id -u):$(id -g)" \
  -e HOME=/tmp/home \
  -e ELECTRON_CACHE=/cache/electron \
  -e ELECTRON_BUILDER_CACHE=/cache/electron-builder \
  -v "$PWD:/project" \
  -v "$HOME/.cache/electron:/cache/electron" \
  -v "$HOME/.cache/electron-builder:/cache/electron-builder" \
  -w /project \
  electronuserland/builder:wine \
  /bin/bash -c 'mkdir -p "$HOME" && npm run dist:win'
