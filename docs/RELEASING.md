# Releasing pi packages

> Moved out of `AGENTS.md` to keep the model's per-turn project context lean.
> Loaded on demand only when a release task is in progress.

## Changelog

Location: `packages/*/CHANGELOG.md` (each package has its own).

### Format

Use these sections under `## [Unreleased]`:

- `### Breaking Changes` - API changes requiring migration
- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Removed` - Removed features

### Rules

- Before adding entries, read the full `[Unreleased]` section to see which subsections already exist.
- New entries ALWAYS go under `## [Unreleased]`.
- Append to existing subsections (e.g., `### Fixed`); do not create duplicates.
- NEVER modify already-released version sections (e.g., `## [0.12.2]`).
- Each version section is immutable once released.

### Attribution

- **Internal changes (from issues)**: `Fixed foo bar ([#123](https://github.com/earendil-works/pi-mono/issues/123))`
- **External contributions**: `Added feature X ([#456](https://github.com/earendil-works/pi-mono/pull/456) by [@username](https://github.com/username))`

## Releasing

**Lockstep versioning**: All packages always share the same version number.
Every release updates all packages together.

**Version semantics** (no major releases):

- `patch`: Bug fixes and new features
- `minor`: API breaking changes

### Steps

1. **Update CHANGELOGs**: Ensure all changes since last release are documented
   in the `[Unreleased]` section of each affected package's CHANGELOG.md.

2. **Run release script**:

   ```bash
   npm run release:patch    # Fixes and additions
   npm run release:minor    # API breaking changes
   ```

The script handles: version bump, CHANGELOG finalization, commit, tag, publish,
and adding new `[Unreleased]` sections.

## Adding a New LLM Provider (packages/ai)

Adding a new provider requires changes across multiple files:

### 1. Core Types (`packages/ai/src/types.ts`)

- Add API identifier to `Api` type union (e.g., `"bedrock-converse-stream"`).
- Create options interface extending `StreamOptions`.
- Add mapping to `ApiOptionsMap`.
- Add provider name to `KnownProvider` type union.

### 2. Provider Implementation (`packages/ai/src/providers/`)

Create provider file exporting:

- `stream<Provider>()` function returning `AssistantMessageEventStream`.
- `streamSimple<Provider>()` for `SimpleStreamOptions` mapping.
- Provider-specific options interface.
- Message/tool conversion functions.
- Response parsing emitting standardized events (`text`, `tool_call`,
  `thinking`, `usage`, `stop`).

### 3. Provider Exports and Lazy Registration

- Add a package subpath export in `packages/ai/package.json` pointing at
  `./dist/providers/<provider>.js`.
- Add `export type` re-exports in `packages/ai/src/index.ts` for provider
  option types that should remain available from the root entry.
- Register the provider in `packages/ai/src/providers/register-builtins.ts`
  via lazy loader wrappers. Do not statically import provider implementation
  modules there.
- Add credential detection in `packages/ai/src/env-api-keys.ts`.

### 4. Model Generation (`packages/ai/scripts/generate-models.ts`)

- Add logic to fetch/parse models from provider source.
- Map to standardized `Model` interface.

### 5. Tests (`packages/ai/test/`)

- Always add the provider to `stream.test.ts` with at least one
  representative model, even if it reuses an existing API implementation
  such as `openai-completions`.
- Add the provider to the broader provider matrix where applicable:
  `tokens.test.ts`, `abort.test.ts`, `empty.test.ts`,
  `context-overflow.test.ts`, `unicode-surrogate.test.ts`,
  `tool-call-without-result.test.ts`, `image-tool-result.test.ts`,
  `total-tokens.test.ts`, `cross-provider-handoff.test.ts`.
- For `cross-provider-handoff.test.ts`, add at least one provider/model pair.
  If the provider exposes multiple model families (e.g. GPT and Claude), add
  at least one pair per family.
- For non-standard auth, create utility (e.g., `bedrock-utils.ts`) with
  credential detection.

### 6. Coding Agent (`packages/coding-agent/`)

- `src/core/model-resolver.ts`: Add default model ID to
  `defaultModelPerProvider`.
- `src/core/provider-display-names.ts`: Add API-key login display name so
  `/login` and related UI show the provider for built-in API-key auth.
- `src/cli/args.ts`: Add env var documentation.
- `README.md`: Add provider setup instructions.
- `docs/providers.md`: Add setup instructions, env var, and `auth.json` key.

### 7. Documentation

- `packages/ai/README.md`: Add to providers table, document options/auth,
  add env vars.
- `packages/ai/CHANGELOG.md`: Add entry under `## [Unreleased]`.
