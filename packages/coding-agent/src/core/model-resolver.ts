/**
 * Model resolution, scoping, and initial selection
 */

import type { ThinkingLevel } from "@pit/agent-core";
import { type Api, type KnownProvider, type Model, modelsAreEqual } from "@pit/ai";
import chalk from "chalk";
import { minimatch } from "minimatch";
import { isValidThinkingLevel } from "../cli/args.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { ModelRoleConfig, ModelRoleSettings } from "./settings-manager.ts";

/**
 * Roles that map intent ("smol fan-out", "deep reasoning") to a concrete model + chain.
 *
 * `compact` is an INTERNAL role: the compaction pipeline routes the summarization
 * call to it when `modelRoles.compact` is configured, so a faster/cheaper model
 * can summarize while the session model keeps running the turns. It is NOT a
 * user-facing turn role (no `--role compact`); the user configures it in settings.
 */
export const MODEL_ROLES = ["default", "smol", "slow", "plan", "compact", "commit"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export interface RoleResolution {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	/** Ordered fallback chain. chain[0] is always the primary resolved model. */
	chain: Array<{ model: Model<Api>; thinkingLevel: ThinkingLevel }>;
}

export interface ResolveRoleOptions {
	role: ModelRole;
	/** Raw pattern from CLI (e.g. "anthropic/opus", or value supplied to --smol). */
	cliOverride?: string;
	availableModels: Model<Api>[];
	settings: ModelRoleSettings;
	/** Used to match path-scoped role overrides via minimatch globs. */
	cwd?: string;
}

/** Default model IDs for each known provider */
export const defaultModelPerProvider: Record<KnownProvider, string> = {
	anthropic: "claude-opus-4-8",
	"openai-codex": "gpt-5.5",
	opencode: "kimi-k2.6",
	"opencode-go": "kimi-k2.6",
	xai: "grok-4.5",
};

export interface ScopedModel {
	model: Model<Api>;
	/** Thinking level if explicitly specified in pattern (e.g., "model:high"), undefined otherwise */
	thinkingLevel?: ThinkingLevel;
}

/**
 * Helper to check if a model ID looks like an alias (no date suffix)
 * Dates are typically in format: -20241022 or -20250929
 */
function isAlias(id: string): boolean {
	// Check if ID ends with -latest
	if (id.endsWith("-latest")) return true;

	// Check if ID ends with a date pattern (-YYYYMMDD)
	const datePattern = /-\d{8}$/;
	return !datePattern.test(id);
}

/**
 * Find an exact model reference match.
 * Supports either a bare model id or a canonical provider/modelId reference.
 * When matching by bare id, ambiguous matches across providers are rejected.
 */
export function findExactModelReferenceMatch(
	modelReference: string,
	availableModels: Model<Api>[],
): Model<Api> | undefined {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) {
		return undefined;
	}

	const normalizedReference = trimmedReference.toLowerCase();

	const canonicalMatches = availableModels.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
	);
	if (canonicalMatches.length === 1) {
		return canonicalMatches[0];
	}
	if (canonicalMatches.length > 1) {
		return undefined;
	}

	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			const providerMatches = availableModels.filter(
				(model) =>
					model.provider.toLowerCase() === provider.toLowerCase() &&
					model.id.toLowerCase() === modelId.toLowerCase(),
			);
			if (providerMatches.length === 1) {
				return providerMatches[0];
			}
			if (providerMatches.length > 1) {
				return undefined;
			}
		}
	}

	const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

/**
 * Try to match a pattern to a model from the available models list.
 * Returns the matched model or undefined if no match found.
 */
function tryMatchModel(modelPattern: string, availableModels: Model<Api>[]): Model<Api> | undefined {
	// An empty/whitespace pattern is a malformed reference. Without this guard the
	// partial-match filter below uses `includes("")`, which is true for every model,
	// so ALL models would match and an arbitrary alias would be returned. Bail out so
	// the caller routes to its proper "not found" error/warning path instead.
	if (!modelPattern.trim()) {
		return undefined;
	}

	const exactMatch = findExactModelReferenceMatch(modelPattern, availableModels);
	if (exactMatch) {
		return exactMatch;
	}

	// No exact match - fall back to partial matching
	const matches = availableModels.filter(
		(m) =>
			m.id.toLowerCase().includes(modelPattern.toLowerCase()) ||
			m.name?.toLowerCase().includes(modelPattern.toLowerCase()),
	);

	if (matches.length === 0) {
		return undefined;
	}

	// Separate into aliases and dated versions
	const aliases = matches.filter((m) => isAlias(m.id));
	const datedVersions = matches.filter((m) => !isAlias(m.id));

	if (aliases.length > 0) {
		// Prefer alias - if multiple aliases, pick the one that sorts highest
		aliases.sort((a, b) => b.id.localeCompare(a.id));
		return aliases[0];
	} else {
		// No alias found, pick latest dated version
		datedVersions.sort((a, b) => b.id.localeCompare(a.id));
		return datedVersions[0];
	}
}

export interface ParsedModelResult {
	model: Model<Api> | undefined;
	/** Thinking level if explicitly specified in pattern, undefined otherwise */
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
}

function buildFallbackModel(provider: string, modelId: string, availableModels: Model<Api>[]): Model<Api> | undefined {
	const providerModels = availableModels.filter((m) => m.provider === provider);
	if (providerModels.length === 0) return undefined;

	const defaultId = defaultModelPerProvider[provider as KnownProvider];
	const baseModel = defaultId
		? (providerModels.find((m) => m.id === defaultId) ?? providerModels[0])
		: providerModels[0];

	return {
		...baseModel,
		id: modelId,
		name: modelId,
	};
}

/**
 * Parse a pattern to extract model and thinking level.
 * Handles models with colons in their IDs (e.g., OpenRouter's :exacto suffix).
 *
 * Algorithm:
 * 1. Try to match full pattern as a model
 * 2. If found, return it with "off" thinking level
 * 3. If not found and has colons, split on last colon:
 *    - If suffix is valid thinking level, use it and recurse on prefix
 *    - If suffix is invalid, warn and recurse on prefix with "off"
 *
 * @internal Exported for testing
 */
export function parseModelPattern(
	pattern: string,
	availableModels: Model<Api>[],
	options?: { allowInvalidThinkingLevelFallback?: boolean },
): ParsedModelResult {
	// Iterative form of the original tail recursion that stripped one trailing
	// colon segment per call. A colon-heavy pattern (e.g. a malformed `modelScope`
	// entry such as `":".repeat(100000) + "x"`) used to drive recursion depth =
	// number of colons, overflowing the stack with an uncaught RangeError that
	// aborted model resolution at startup. The loop below is behavior-identical
	// but bounded by the input length.

	// Phase 1: strip trailing colon segments from the right until a prefix matches
	// a model (innermost recursion), recording each stripped suffix and the frame
	// pattern it belonged to so the fold can reproduce per-frame warning strings.
	const segments: Array<{ suffix: string; framePattern: string }> = [];
	let current = pattern;
	let matched: Model<Api> | undefined = tryMatchModel(current, availableModels);

	while (!matched) {
		const lastColonIndex = current.lastIndexOf(":");
		if (lastColonIndex === -1) {
			// No colons left and nothing matched: the pattern resolves to no model.
			// Outer suffix segments are irrelevant (the original returned the inner
			// unmatched result unchanged), so bail with the empty result.
			return { model: undefined, thinkingLevel: undefined, warning: undefined };
		}

		const suffix = current.substring(lastColonIndex + 1);
		// In strict mode (CLI --model parsing) an invalid suffix is treated as part
		// of the model id and fails, rather than being stripped. This mirrors the
		// original early return and avoids resolving to a different model.
		const allowFallback = options?.allowInvalidThinkingLevelFallback ?? true;
		if (!allowFallback && !isValidThinkingLevel(suffix)) {
			return { model: undefined, thinkingLevel: undefined, warning: undefined };
		}

		segments.push({ suffix, framePattern: current });
		current = current.substring(0, lastColonIndex);
		matched = tryMatchModel(current, availableModels);
	}

	// Phase 2: fold the stripped suffixes from innermost (leftmost) to outermost
	// (rightmost). `segments` was filled right-to-left, so iterate it in reverse.
	let result: ParsedModelResult = { model: matched, thinkingLevel: undefined, warning: undefined };
	for (let i = segments.length - 1; i >= 0; i--) {
		const { suffix, framePattern } = segments[i];
		if (isValidThinkingLevel(suffix)) {
			// Only adopt this thinking level if no warning surfaced from an inner frame.
			result = {
				model: result.model,
				thinkingLevel: result.warning ? undefined : suffix,
				warning: result.warning,
			};
		} else {
			result = {
				model: result.model,
				thinkingLevel: undefined,
				warning: `Invalid thinking level "${suffix}" in pattern "${framePattern}". Using default instead.`,
			};
		}
	}

	return result;
}

/**
 * Score how specifically a glob matches a path. Closest match (most-specific
 * segment, deepest matching prefix) wins. We approximate "specificity" by the
 * length of the literal (non-glob) prefix of the glob — `src/foo/**` beats
 * `**` even though both match `src/foo/bar.ts`.
 */
function globSpecificity(glob: string): number {
	const star = glob.indexOf("*");
	const question = glob.indexOf("?");
	const bracket = glob.indexOf("[");
	const candidates = [star, question, bracket].filter((i) => i !== -1);
	const firstGlob = candidates.length === 0 ? glob.length : Math.min(...candidates);
	return firstGlob + glob.length / 1000; // tiebreak with raw length
}

/**
 * Pick the model pattern for a role given a cwd, applying path-scoped overrides
 * when configured. The closest-matching path glob wins.
 */
function pickRoleModelPattern(roleConfig: ModelRoleConfig, cwd: string | undefined): string {
	if (!cwd || !roleConfig.paths) return roleConfig.model;
	let bestMatch: { score: number; pattern: string } | undefined;
	for (const [glob, modelPattern] of Object.entries(roleConfig.paths)) {
		if (minimatch(cwd, glob, { nocase: true, dot: true })) {
			const score = globSpecificity(glob);
			if (!bestMatch || score > bestMatch.score) {
				bestMatch = { score, pattern: modelPattern };
			}
		}
	}
	return bestMatch ? bestMatch.pattern : roleConfig.model;
}

function resolvePatternToEntry(
	pattern: string,
	availableModels: Model<Api>[],
	fallbackThinking: ThinkingLevel,
): { model: Model<Api>; thinkingLevel: ThinkingLevel } | undefined {
	const { model, thinkingLevel } = parseModelPattern(pattern, availableModels, {
		allowInvalidThinkingLevelFallback: false,
	});
	if (!model) return undefined;
	return { model, thinkingLevel: thinkingLevel ?? fallbackThinking };
}

/**
 * Model-id substrings that mark a cheap/fast tier (haiku, mini, nano, flash, lite).
 * Used for zero-config compact-role sibling routing — same provider only.
 * Kept local (not imported from coordinator) so model-resolver stays free of
 * coordinator coupling; keep in sync with SMALL_CLASS_MODEL_MARKERS there.
 */
const COMPACT_SIBLING_MARKERS: readonly string[] = ["haiku", "mini", "nano", "flash", "lite"];

/**
 * Pick a same-provider small-class sibling of the session model for compaction
 * summarization. Returns undefined when the session model is already small-class,
 * or no sibling exists on that provider. Auth is NOT checked here — callers must
 * fail-open when the sibling has no credentials.
 */
export function resolveCompactSibling(sessionModel: Model<Api>, availableModels: Model<Api>[]): Model<Api> | undefined {
	const sessionId = sessionModel.id.toLowerCase();
	if (COMPACT_SIBLING_MARKERS.some((m) => sessionId.includes(m))) return undefined;
	const siblings = availableModels.filter(
		(m) =>
			m.provider === sessionModel.provider &&
			m.id !== sessionModel.id &&
			COMPACT_SIBLING_MARKERS.some((marker) => m.id.toLowerCase().includes(marker)),
	);
	if (siblings.length === 0) return undefined;
	// Prefer the cheapest sibling when cost metadata is present; otherwise first match.
	siblings.sort((a, b) => (a.cost?.input ?? Number.POSITIVE_INFINITY) - (b.cost?.input ?? Number.POSITIVE_INFINITY));
	return siblings[0];
}

/**
 * Resolve a role to a concrete model + thinking level + fallback chain.
 *
 * Resolution order:
 * 1. cliOverride (parsed via parseModelPattern) — used as the primary.
 * 2. settings.modelRoles[role].model, with path-scoped override if any glob in
 *    `paths` matches `cwd`. Closest match wins.
 * 3. settings.retry.fallbackChains[role] || settings.modelRoles[role].fallbackChain
 *    contribute additional chain entries after the primary.
 *
 * Returns `undefined` when nothing is configured for the role and no CLI
 * override was supplied — the caller can then fall back to its own logic
 * (typically the "default" role or saved defaults).
 */
export function resolveRole(opts: ResolveRoleOptions): RoleResolution | undefined {
	const { role, cliOverride, availableModels, settings, cwd } = opts;
	const roleConfig = settings.modelRoles?.[role];
	const defaultThinking: ThinkingLevel = DEFAULT_THINKING_LEVEL;

	let primaryEntry: { model: Model<Api>; thinkingLevel: ThinkingLevel } | undefined;
	let roleThinkingDefault: ThinkingLevel = defaultThinking;

	if (cliOverride) {
		primaryEntry = resolvePatternToEntry(cliOverride, availableModels, defaultThinking);
		if (!primaryEntry) return undefined;
	} else if (roleConfig) {
		const pattern = pickRoleModelPattern(roleConfig, cwd);
		if (roleConfig.thinkingLevel && isValidThinkingLevel(roleConfig.thinkingLevel)) {
			roleThinkingDefault = roleConfig.thinkingLevel;
		}
		primaryEntry = resolvePatternToEntry(pattern, availableModels, roleThinkingDefault);
		if (!primaryEntry) return undefined;
	} else {
		return undefined;
	}

	const chain: Array<{ model: Model<Api>; thinkingLevel: ThinkingLevel }> = [primaryEntry];

	const chainPatterns: string[] = [];
	const retryChain = settings.retry?.fallbackChains?.[role];
	if (retryChain && retryChain.length > 0) {
		chainPatterns.push(...retryChain);
	} else if (roleConfig?.fallbackChain && roleConfig.fallbackChain.length > 0) {
		chainPatterns.push(...roleConfig.fallbackChain);
	}

	for (const pattern of chainPatterns) {
		const entry = resolvePatternToEntry(pattern, availableModels, roleThinkingDefault);
		if (!entry) continue;
		// Dedupe by provider+id
		if (chain.find((e) => modelsAreEqual(e.model, entry.model))) continue;
		chain.push(entry);
	}

	return {
		model: primaryEntry.model,
		thinkingLevel: primaryEntry.thinkingLevel,
		chain,
	};
}

/**
 * Resolve model patterns to actual Model objects with optional thinking levels
 * Format: "pattern:level" where :level is optional
 * For each pattern, finds all matching models and picks the best version:
 * 1. Prefer alias (e.g., claude-sonnet-4-5) over dated versions (claude-sonnet-4-5-20250929)
 * 2. If no alias, pick the latest dated version
 *
 * Supports models with colons in their IDs (e.g., OpenRouter's model:exacto).
 * The algorithm tries to match the full pattern first, then progressively
 * strips colon-suffixes to find a match.
 */
export async function resolveModelScope(patterns: string[], modelRegistry: ModelRegistry): Promise<ScopedModel[]> {
	const availableModels = await modelRegistry.getAvailable();
	const scopedModels: ScopedModel[] = [];
	// Dedup in O(1) per model: modelsAreEqual compares provider+id, so a Set
	// keyed by `provider/id` is behavior-identical to the prior `.find` scan
	// while avoiding O(M^2) work when a broad glob matches the whole registry.
	const seen = new Set<string>();

	for (const pattern of patterns) {
		// Check if pattern contains glob characters
		if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
			// Extract optional thinking level suffix (e.g., "provider/*:high")
			const colonIdx = pattern.lastIndexOf(":");
			let globPattern = pattern;
			let thinkingLevel: ThinkingLevel | undefined;

			if (colonIdx !== -1) {
				const suffix = pattern.substring(colonIdx + 1);
				if (isValidThinkingLevel(suffix)) {
					thinkingLevel = suffix;
					globPattern = pattern.substring(0, colonIdx);
				}
			}

			// Match against "provider/modelId" format OR just model ID
			// This allows "*sonnet*" to match without requiring "anthropic/*sonnet*"
			const matchingModels = availableModels.filter((m) => {
				const fullId = `${m.provider}/${m.id}`;
				return minimatch(fullId, globPattern, { nocase: true }) || minimatch(m.id, globPattern, { nocase: true });
			});

			if (matchingModels.length === 0) {
				console.warn(chalk.yellow(`Warning: No models match pattern "${pattern}"`));
				continue;
			}

			for (const model of matchingModels) {
				const key = `${model.provider}/${model.id}`;
				if (!seen.has(key)) {
					seen.add(key);
					scopedModels.push({ model, thinkingLevel });
				}
			}
			continue;
		}

		const { model, thinkingLevel, warning } = parseModelPattern(pattern, availableModels);

		if (warning) {
			console.warn(chalk.yellow(`Warning: ${warning}`));
		}

		if (!model) {
			console.warn(chalk.yellow(`Warning: No models match pattern "${pattern}"`));
			continue;
		}

		// Avoid duplicates (O(1) membership check, same provider+id key)
		const key = `${model.provider}/${model.id}`;
		if (!seen.has(key)) {
			seen.add(key);
			scopedModels.push({ model, thinkingLevel });
		}
	}

	return scopedModels;
}

export interface ResolveCliModelResult {
	model: Model<Api> | undefined;
	thinkingLevel?: ThinkingLevel;
	warning: string | undefined;
	/**
	 * Error message suitable for CLI display.
	 * When set, model will be undefined.
	 */
	error: string | undefined;
}

/**
 * Resolve a single model from CLI flags.
 *
 * Supports:
 * - --provider <provider> --model <pattern>
 * - --model <provider>/<pattern>
 * - Fuzzy matching (same rules as model scoping: exact id, then partial id/name)
 *
 * Note: This does not apply the thinking level by itself, but it may *parse* and
 * return a thinking level from "<pattern>:<thinking>" so the caller can apply it.
 */
export function resolveCliModel(options: {
	cliProvider?: string;
	cliModel?: string;
	modelRegistry: ModelRegistry;
}): ResolveCliModelResult {
	const { cliProvider, cliModel, modelRegistry } = options;

	if (!cliModel) {
		return { model: undefined, warning: undefined, error: undefined };
	}

	// Important: use *all* models here, not just models with pre-configured auth.
	// This allows "--api-key" to be used for first-time setup.
	const availableModels = modelRegistry.getAll();
	if (availableModels.length === 0) {
		return {
			model: undefined,
			warning: undefined,
			error: "No models available. Check your installation or add models to models.json.",
		};
	}

	// Build canonical provider lookup (case-insensitive)
	const providerMap = new Map<string, string>();
	for (const m of availableModels) {
		providerMap.set(m.provider.toLowerCase(), m.provider);
	}

	let provider = cliProvider ? providerMap.get(cliProvider.toLowerCase()) : undefined;
	if (cliProvider && !provider) {
		return {
			model: undefined,
			warning: undefined,
			error: `Unknown provider "${cliProvider}". Use --list-models to see available providers/models.`,
		};
	}

	// If no explicit --provider, try to interpret "provider/model" format first.
	// When the prefix before the first slash matches a known provider, prefer that
	// interpretation over matching models whose IDs literally contain slashes
	// (e.g. "openai/gpt-5.4" should resolve to provider=openai, model=gpt-5.4, not
	// to an openrouter model whose id literally contains a slash).
	let pattern = cliModel;
	let inferredProvider = false;

	if (!provider) {
		const slashIndex = cliModel.indexOf("/");
		if (slashIndex !== -1) {
			const maybeProvider = cliModel.substring(0, slashIndex);
			const canonical = providerMap.get(maybeProvider.toLowerCase());
			if (canonical) {
				provider = canonical;
				pattern = cliModel.substring(slashIndex + 1);
				inferredProvider = true;
			}
		}
	}

	// If no provider was inferred from the slash, try exact matches without provider inference.
	// This handles models whose IDs naturally contain slashes (e.g. OpenRouter-style IDs).
	if (!provider) {
		const lower = cliModel.toLowerCase();
		const exact = availableModels.find(
			(m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower,
		);
		if (exact) {
			return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
		}
	}

	if (cliProvider && provider) {
		// If both were provided, tolerate --model <provider>/<pattern> by stripping the provider prefix
		const prefix = `${provider}/`;
		if (cliModel.toLowerCase().startsWith(prefix.toLowerCase())) {
			pattern = cliModel.substring(prefix.length);
		}
	}

	const candidates = provider ? availableModels.filter((m) => m.provider === provider) : availableModels;

	// When no provider was specified, prefer a model whose provider already has
	// configured auth. Otherwise a bare pattern like "haiku" can resolve to a
	// provider with no credentials while an authed provider (anthropic) offers the
	// same model. Falling back to the full candidate list afterwards preserves
	// first-time `--api-key` setup.
	if (!provider) {
		const authedModels = availableModels.filter((m) => modelRegistry.hasConfiguredAuth(m));
		if (authedModels.length > 0) {
			const authed = parseModelPattern(pattern, authedModels, {
				allowInvalidThinkingLevelFallback: false,
			});
			if (authed.model) {
				return {
					model: authed.model,
					thinkingLevel: authed.thinkingLevel,
					warning: authed.warning,
					error: undefined,
				};
			}
		}
	}

	const { model, thinkingLevel, warning } = parseModelPattern(pattern, candidates, {
		allowInvalidThinkingLevelFallback: false,
	});

	if (model) {
		return { model, thinkingLevel, warning, error: undefined };
	}

	// If we inferred a provider from the slash but found no match within that provider,
	// fall back to matching the full input as a raw model id across all models.
	// This handles OpenRouter-style IDs like "openai/gpt-4o:extended" where "openai"
	// looks like a provider but the full string is actually a model id on openrouter.
	if (inferredProvider) {
		const lower = cliModel.toLowerCase();
		const exact = availableModels.find(
			(m) => m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower,
		);
		if (exact) {
			return { model: exact, warning: undefined, thinkingLevel: undefined, error: undefined };
		}
		// Also try parseModelPattern on the full input against all models
		const fallback = parseModelPattern(cliModel, availableModels, {
			allowInvalidThinkingLevelFallback: false,
		});
		if (fallback.model) {
			return {
				model: fallback.model,
				thinkingLevel: fallback.thinkingLevel,
				warning: fallback.warning,
				error: undefined,
			};
		}
	}

	if (provider) {
		const fallbackModel = buildFallbackModel(provider, pattern, availableModels);
		if (fallbackModel) {
			const fallbackWarning = warning
				? `${warning} Model "${pattern}" not found for provider "${provider}". Using custom model id.`
				: `Model "${pattern}" not found for provider "${provider}". Using custom model id.`;
			return { model: fallbackModel, thinkingLevel: undefined, warning: fallbackWarning, error: undefined };
		}
	}

	const display = provider ? `${provider}/${pattern}` : cliModel;
	return {
		model: undefined,
		thinkingLevel: undefined,
		warning,
		error: `Model "${display}" not found. Use --list-models to see available models.`,
	};
}

export interface InitialModelResult {
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel;
	fallbackMessage: string | undefined;
}

/**
 * Find the initial model to use based on priority:
 * 1. CLI args (provider + model)
 * 2. First model from scoped models (if not continuing/resuming)
 * 3. Restored from session (if continuing/resuming)
 * 4. Saved default from settings
 * 5. First available model with valid API key
 */
export async function findInitialModel(options: {
	cliProvider?: string;
	cliModel?: string;
	scopedModels: ScopedModel[];
	isContinuing: boolean;
	defaultProvider?: string;
	defaultModelId?: string;
	defaultThinkingLevel?: ThinkingLevel;
	modelRegistry: ModelRegistry;
}): Promise<InitialModelResult> {
	const {
		cliProvider,
		cliModel,
		scopedModels,
		isContinuing,
		defaultProvider,
		defaultModelId,
		defaultThinkingLevel,
		modelRegistry,
	} = options;

	let model: Model<Api> | undefined;
	let thinkingLevel: ThinkingLevel = DEFAULT_THINKING_LEVEL;

	// 1. CLI args take priority
	if (cliProvider && cliModel) {
		const resolved = resolveCliModel({
			cliProvider,
			cliModel,
			modelRegistry,
		});
		if (resolved.error) {
			console.error(chalk.red(resolved.error));
			process.exit(1);
		}
		if (resolved.model) {
			return { model: resolved.model, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
		}
	}

	// 2. Use first model from scoped models (skip if continuing/resuming)
	if (scopedModels.length > 0 && !isContinuing) {
		return {
			model: scopedModels[0].model,
			thinkingLevel: scopedModels[0].thinkingLevel ?? defaultThinkingLevel ?? DEFAULT_THINKING_LEVEL,
			fallbackMessage: undefined,
		};
	}

	// 3. Try saved default from settings
	if (defaultProvider && defaultModelId) {
		const found = modelRegistry.find(defaultProvider, defaultModelId);
		if (found) {
			model = found;
			if (defaultThinkingLevel) {
				thinkingLevel = defaultThinkingLevel;
			}
			return { model, thinkingLevel, fallbackMessage: undefined };
		}
	}

	// 4. Try first available model with valid API key
	const availableModels = await modelRegistry.getAvailable();

	if (availableModels.length > 0) {
		const model = findDefaultModel(availableModels) ?? availableModels[0];
		return { model, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
	}

	// 5. No model found
	return { model: undefined, thinkingLevel: DEFAULT_THINKING_LEVEL, fallbackMessage: undefined };
}

/** Find a default model from a known provider among the available models. */
function findDefaultModel(availableModels: Model<Api>[]): Model<Api> | undefined {
	for (const provider of Object.keys(defaultModelPerProvider) as KnownProvider[]) {
		const defaultId = defaultModelPerProvider[provider];
		const match = availableModels.find((m) => m.provider === provider && m.id === defaultId);
		if (match) return match;
	}
	return undefined;
}

/**
 * Decide which model role to adopt when the permission mode changes, so the
 * host can swap to a stronger-reasoning model while planning and a cheaper one
 * while executing. Pure function — no I/O, no settings read beyond the supplied
 * role config — so it is unit-testable without a TUI or session.
 *
 *  - mode "plan" + a configured `plan` role → "plan"
 *  - mode "auto" + the active role is still "plan" → `roleBeforePlan` when
 *    provided, else "default" (never clobber a role the user picked manually
 *    mid-session — that path returns undefined because activeRole !== "plan")
 *  - otherwise → undefined (no-op / fail-open)
 *
 * `planRoleConfig` is `settings.modelRoles?.plan`; pass undefined when absent.
 * `roleBeforePlan` is the role that was active before entering plan mode.
 */
export function decideRoleForPermissionMode(
	mode: "plan" | "auto",
	activeRole: ModelRole,
	planRoleConfig: ModelRoleConfig | undefined,
	roleBeforePlan?: ModelRole,
): ModelRole | undefined {
	if (mode === "plan" && planRoleConfig) return "plan";
	if (mode === "auto" && activeRole === "plan") return roleBeforePlan ?? "default";
	return undefined;
}
