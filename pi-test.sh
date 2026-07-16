#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/scripts/clear-test-env.sh"

# Check for --no-env flag
NO_ENV=false
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--no-env" ]]; then
    NO_ENV=true
  else
    ARGS+=("$arg")
  fi
done

if [[ "$NO_ENV" == "true" ]]; then
  # Unset API keys (see scripts/clear-test-env.sh for the canonical list)
  clear_test_env
  echo "Running without API keys..."
fi

# Load the tsx loader in-process (`node --import`): full tsx pipeline (plain
# node type-stripping chokes on parts of the graph plain --version never hits)
# without the tsx wrapper-process overhead. file:///C:/... form for Windows Node.
TSX_LOADER="$SCRIPT_DIR/node_modules/tsx/dist/loader.mjs"
if [[ ! -f "$TSX_LOADER" ]]; then
  echo "pi-test: tsx not found at $TSX_LOADER. Run npm install from the repo root first." >&2
  exit 1
fi
if command -v cygpath >/dev/null 2>&1; then
  TSX_LOADER_URL="file:///$(cygpath -m "$TSX_LOADER")"
else
  TSX_LOADER_URL="file://$TSX_LOADER"
fi

node --import "$TSX_LOADER_URL" "$SCRIPT_DIR/packages/coding-agent/src/cli.ts" ${ARGS[@]+"${ARGS[@]}"}
