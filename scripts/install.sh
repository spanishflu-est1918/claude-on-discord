#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${CLAUDE_ON_DISCORD_REPO_URL:-https://github.com/spanishflu-est1918/claude-on-discord.git}"
TARGET_DIR="${1:-$HOME/claude-on-discord}"

echo "==> claude-on-discord installer"
echo "Repo:   $REPO_URL"
echo "Target: $TARGET_DIR"

if ! command -v git >/dev/null 2>&1; then
  echo "error: git is required but not installed." >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  if ! command -v curl >/dev/null 2>&1; then
    echo "error: bun is missing and curl is not available for auto-install." >&2
    echo "Install bun first: https://bun.sh" >&2
    exit 1
  fi

  echo "==> bun not found; installing bun..."
  curl -fsSL https://bun.sh/install | bash

  BUN_INSTALL_DIR="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL_DIR/bin:$PATH"

  if ! command -v bun >/dev/null 2>&1; then
    echo "error: bun install completed but bun is still not on PATH." >&2
    echo "Add this to your shell profile and retry:" >&2
    echo "  export BUN_INSTALL=\"$BUN_INSTALL_DIR\"" >&2
    echo "  export PATH=\"\$BUN_INSTALL/bin:\$PATH\"" >&2
    exit 1
  fi
fi

if [ -d "$TARGET_DIR/.git" ]; then
  echo "==> existing repo found; pulling latest..."
  git -C "$TARGET_DIR" pull --ff-only
else
  echo "==> cloning repo..."
  git clone "$REPO_URL" "$TARGET_DIR"
fi

cd "$TARGET_DIR"

echo "==> installing dependencies..."
bun install

if [ ! -f ".env" ] && [ -f ".env.example" ]; then
  echo "==> creating .env from .env.example"
  cp .env.example .env
fi

cat <<EOF

Install complete.

Next:
  cd "$TARGET_DIR"
  bun run setup   # interactive Discord + env setup
  bun start

EOF
