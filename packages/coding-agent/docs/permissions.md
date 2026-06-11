# Permissions

Pit gates every tool call and bash command through a permission system with
two modes on a single axis of permissiveness, plus a deny/allow rule set.
Permissions are enforced regardless of which provider or model you use; the
rules live in your settings and the checker runs before every tool execution.

## Modes

| Mode | Behavior |
|------|----------|
| `plan` | Read-only. Any tool that mutates the filesystem or runs a shell (`bash`, `edit`, `write`) is blocked. Reads still honor deny rules. Useful for exploration / planning passes. |
| `auto` | **Default.** Writes and commands run without prompts, but the built-in deny floor is enforced as **hard blocks**: sensitive paths (`.env`, `~/.ssh/**`, …) and dangerous commands (`rm -rf /`, fork bomb, …) are denied. A *guarded* default. |

The built-in floor can still be dropped per-session by setting
`disableBuiltinDefaults: true` (see below) — a **no-rails** state surfaced
loudly in the footer. **User-authored** `denyPaths`/`denyCommands`/`denyTools`
still apply. For authorized targets only.

Override the configured mode for a single run with `--permission-mode <mode>`.
Switch mid-session with the `/permission-mode <mode>` slash command.

## Configuration

`settings.json` (project or global):

```json
{
  "permissions": {
    "mode": "auto",
    "allowPaths": [
      { "glob": "src/**", "reason": "trusted source tree" }
    ],
    "denyPaths": [
      { "glob": "**/.env*" },
      { "glob": "node_modules/**", "tools": ["write", "edit"] }
    ],
    "denyCommands": [
      { "pattern": "git\\s+push\\s+--force", "reason": "no force push" }
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
- `reason` is shown in deny errors.

### Command rules

- `pattern` is a regular expression source string. Default flags are `i`
  (case-insensitive). Override per-rule with `flags`.
- Patterns are tested against the raw bash command line.
- Invalid patterns are silently ignored — the rule just never fires.

### Precedence

Within a single check the order is:

1. `denyTools[name]` → **deny** (every mode)
2. **plan** only: write / exec / mutating tool → **deny** (read-only)
3. `allowTools[name]` → **allow** (skips remaining checks)
4. `denyPaths` (reads in `plan`; reads + writes in `auto`) and
   `denyCommands` (exec in `auto`), including the built-in defaults
   unless the floor is off → **deny**
5. `allowPaths` → **allow**
6. Otherwise → **allow**

The built-in floor (the defaults in step 4) is active in `plan`/`auto` and off
in any mode with `disableBuiltinDefaults: true`.

### Built-in defaults

Unless `disableBuiltinDefaults: true`, Pit adds:

- Deny paths: `**/.env`, `**/.env.*`, `**/.git/config`, `**/.ssh/**`,
  `**/.aws/credentials`, `**/.npmrc`, `**/id_rsa`, `**/id_ed25519`.
- Deny commands: recursive `rm -rf /` and `rm -rf ~`, classic fork-bomb,
  `mkfs` / `dd if=… of=/dev/`, `chmod -R 777 /`.

Disable when you're testing the system itself, or when working an authorized
target where the floor gets in the way. The dropped-floor (no-rails) state is
surfaced loudly in the footer so it is never on by accident.

## Audit

Permissions emit a decision (`allow` / `deny`) per tool call. To stream them,
register an extension and pass an `onPermissionDecision` callback when bundling
built-ins through the SDK (see `core/built-ins/permissions-extension.ts`).
