#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/scripts/clear-test-env.sh"

AUTH_FILE="$HOME/.pit/agent/auth.json"
AUTH_BACKUP="$HOME/.pit/agent/auth.json.bak"

# Restore auth.json on exit (success or failure)
cleanup() {
    if [[ -f "$AUTH_BACKUP" ]]; then
        mv "$AUTH_BACKUP" "$AUTH_FILE"
        echo "Restored auth.json"
    fi
}
trap cleanup EXIT

# Move auth.json out of the way
if [[ -f "$AUTH_FILE" ]]; then
    mv "$AUTH_FILE" "$AUTH_BACKUP"
    echo "Moved auth.json to backup"
fi

# Skip local LLM tests (ollama, lmstudio)
export PIT_NO_LOCAL_LLM=1

# Unset API keys (see scripts/clear-test-env.sh for the canonical list)
clear_test_env

echo "Running tests without API keys..."
npm test
