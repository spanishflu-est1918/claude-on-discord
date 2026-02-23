#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "[dist:check] $1" >&2
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  fail "node is required"
fi

if ! command -v npm >/dev/null 2>&1; then
  fail "npm is required"
fi

PKG_NAME="$(node -p "require('./package.json').name")"
PKG_VERSION="$(node -p "require('./package.json').version")"
PKG_BIN="$(node -p "Object.values(require('./package.json').bin || {})[0] || ''")"
PKG_PRIVATE="$(node -p "String(Boolean(require('./package.json').private))")"

[ -n "$PKG_NAME" ] || fail "package name is missing"
[ -n "$PKG_VERSION" ] || fail "package version is missing"
[ "$PKG_PRIVATE" = "false" ] || fail "package.json is still private=true"
[ -n "$PKG_BIN" ] || fail "package.json bin entry is missing"
[ -f "$PKG_BIN" ] || fail "bin file not found: $PKG_BIN"
[ -x "$PKG_BIN" ] || fail "bin file is not executable: $PKG_BIN"
[ -f "scripts/install.sh" ] || fail "scripts/install.sh missing"

echo "[dist:check] npm pack dry-run"
npm pack --dry-run >/dev/null

echo "[dist:check] cli help"
node "$PKG_BIN" --help >/dev/null

echo "[dist:check] OK - $PKG_NAME@$PKG_VERSION is publish-ready"
