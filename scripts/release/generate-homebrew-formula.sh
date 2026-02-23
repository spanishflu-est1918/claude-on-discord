#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") [--version x.y.z] [--output path]

Options:
  --version  Package version to use (defaults to package.json version)
  --output   Output formula path (default: ./dist/homebrew/claude-on-discord.rb)
USAGE
}

VERSION=""
OUTPUT="dist/homebrew/claude-on-discord.rb"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      VERSION="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required" >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi
if ! command -v shasum >/dev/null 2>&1; then
  echo "shasum is required" >&2
  exit 1
fi

PKG_NAME="$(node -p "require('./package.json').name")"
PKG_VERSION="${VERSION:-$(node -p "require('./package.json').version")}"

if [ -z "$PKG_NAME" ] || [ -z "$PKG_VERSION" ]; then
  echo "package name/version missing" >&2
  exit 1
fi

TARBALL_URL="$(npm view "${PKG_NAME}@${PKG_VERSION}" dist.tarball --json | node -pe "JSON.parse(require('fs').readFileSync(0, 'utf8'))")"
if [ -z "$TARBALL_URL" ] || [ "$TARBALL_URL" = "null" ]; then
  echo "could not resolve npm tarball for ${PKG_NAME}@${PKG_VERSION}. Publish first." >&2
  exit 1
fi

SHA256="$(curl -fsSL "$TARBALL_URL" | shasum -a 256 | awk '{print $1}')"
CLASS_NAME="$(echo "$PKG_NAME" | awk -F- '{for (i=1;i<=NF;i++) printf toupper(substr($i,1,1)) substr($i,2)}')"
mkdir -p "$(dirname "$OUTPUT")"

cat > "$OUTPUT" <<FORMULA
class ${CLASS_NAME} < Formula
  desc "Claude Code in Discord channels and threads"
  homepage "https://github.com/spanishflu-est1918/claude-on-discord"
  url "${TARBALL_URL}"
  sha256 "${SHA256}"

  depends_on "bun"
  depends_on "node"

  def install
    system "npm", "install", *std_npm_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    output = shell_output("#{bin}/claude-on-discord --help")
    assert_match "Usage:", output
  end
end
FORMULA

echo "Formula written: $OUTPUT"
echo "Version: $PKG_VERSION"
echo "Tarball: $TARBALL_URL"
echo "SHA256:  $SHA256"
