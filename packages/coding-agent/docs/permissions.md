# Permissions

Pit gates tool calls and bash commands through a permission system with three
modes and a deny/allow/ask rule set. Permissions are enforced regardless of
which provider or model you use; the rules live in your settings and the
checker runs before every tool execution.

## Modes

| Mode | Behavior |
|------|----------|
| `default` | Allow by default. Built-in sensitive defaults (`.env`, `~/.ssh/**`, `rm -rf /`, …) deny. `askPaths`/`askCommands` prompt the user via the interactive UI; in non-interactive modes "ask" falls back to **deny** (fail-closed). |
| `auto` | Skip every prompt. Deny rules still apply. Use in CI / agentic loops where you trust the agent's tool catalog. |
| `plan` | Read-only mode. Any tool that mutates the filesystem or runs a shell (`bash`, `edit`, `write`) is blocked. Useful for exploration / planning passes. |

Override the configured mode for a single run with `--permission-mode <mode>`.
Switch mid-session with the `/permission-mode <mode>` slash command.

## Configuration

`settings.json` (project or global):

```json
{
  "permissions": {
    "mode": "default",
    "allowPaths": [
      { "glob": "src/**", "reason": "trusted source tree" }
    ],
    "denyPaths": [
      { "glob": "**/.env*" },
      { "glob": "node_modules/**", "tools": ["write", "edit"] }
    ],
    "askPaths": [
      { "glob": "**/build/**", "reason": "generated artifacts — confirm before editing" }
    ],
    "denyCommands": [
      { "pattern": "git\\s+push\\s+--force", "reason": "no force push" }
    ],
    "askCommands": [
      { "pattern": "git\\s+push", "reason": "confirm before pushing" }
    ],
    "allowTools": ["read"],
    "denyTools": [],
    "disableBuiltinDefaults": false
  }
}
```

### Path rules

- `glob` uses `*` (single segment), `**` (any path including separators), `?`
  (single character). Patterns are case-insensitive on Windows.
- Tool inputs are resolved to absolute paths before matching, so
  `**/.env*` matches both `./project/.env` and `/etc/.env.prod`.
- `tools` (optional) restricts the rule to specific tool names.
- `reason` is shown in deny errors and ask dialogs.

### Command rules

- `pattern` is a regular expression source string. Default flags are `i`
  (case-insensitive). Override per-rule with `flags`.
- Patterns are tested against the raw bash command line.
- Invalid patterns are silently ignored — the rule just never fires.

### Precedence

Within a single check the order is:

1. `denyTools[name]` → **deny**
2. `allowTools[name]` → **allow**
3. Plan mode block on write/exec → **deny**
4. `denyPaths` / `denyCommands` (incl. built-in defaults) → **deny**
5. `allowPaths` → **allow**
6. `askPaths` / `askCommands` (default mode only) → **ask**
7. Otherwise → **allow**

### Built-in defaults

Unless `disableBuiltinDefaults: true`, Pit adds:

- Deny paths: `**/.env`, `**/.env.*`, `**/.git/config`, `**/.ssh/**`,
  `**/.aws/credentials`, `**/.npmrc`, `**/id_rsa`, `**/id_ed25519`.
- Deny commands: recursive `rm -rf /` and `rm -rf ~`, classic fork-bomb,
  `mkfs` / `dd if=… of=/dev/`, `chmod -R 777 /`.

Disable when you're testing the system itself or when your project's checked-in
fixtures intentionally include `.env.example` files you need to write.

## Audit

Permissions emit a decision per tool call. To stream them, register an
extension and pass an `onPermissionDecision` callback when bundling built-ins
through the SDK (see `core/built-ins/permissions-extension.ts`).
