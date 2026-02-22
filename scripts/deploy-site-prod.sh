#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

EXPECTED_PROJECT="${EXPECTED_VERCEL_PROJECT:-claude-on-discord}"
CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=1
fi

if ! command -v vercel >/dev/null 2>&1; then
  echo "Error: vercel CLI is not installed or not in PATH." >&2
  exit 1
fi

if [[ ! -f ".vercel/project.json" ]]; then
  echo "Error: .vercel/project.json is missing. Run 'vercel link' from repo root first." >&2
  exit 1
fi

PROJECT_NAME="$(
  bun -e 'import { readFileSync } from "node:fs";
const project = JSON.parse(readFileSync(".vercel/project.json", "utf8"));
process.stdout.write(String(project.projectName ?? ""));'
)"

if [[ "$PROJECT_NAME" != "$EXPECTED_PROJECT" ]]; then
  echo "Error: linked Vercel project is '$PROJECT_NAME', expected '$EXPECTED_PROJECT'." >&2
  echo "Fix: run from repo root -> vercel link (select $EXPECTED_PROJECT)." >&2
  exit 1
fi

if [[ -d "site/.vercel" ]]; then
  echo "Error: found site/.vercel. This can redirect deploys to the wrong project." >&2
  echo "Fix: remove it with 'rm -rf site/.vercel' and retry." >&2
  exit 1
fi

echo "Vercel target check passed: $PROJECT_NAME"

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  exit 0
fi

echo "Deploying production build to '$PROJECT_NAME'..."
vercel deploy --prod --yes
