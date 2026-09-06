#!/usr/bin/env bash
# Idempotent dev-environment bootstrap for feishu-agent.
# Ensures a Node runtime that satisfies package.json engines (>= 22.19.0),
# installs pinned dependencies, and compiles TypeScript to dist/.
set -euo pipefail

cd "$(dirname "$0")/.."

# The project requires Node >= 22.19. Prefer nvm (present on the Cursor base
# image) to select an LTS 22 that satisfies the engine; fall back to whatever
# `node` is already on PATH when nvm is unavailable.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install 22 >/dev/null
  nvm use 22 >/dev/null
  nvm alias default 22 >/dev/null
fi

echo "Using Node $(node --version) / npm $(npm --version)"

# Reproducible install from the committed lockfile.
npm ci

# tsc -> dist/, then restore the CLI executable bit.
npm run build

echo "feishu-agent environment ready."
