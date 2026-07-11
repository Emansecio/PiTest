/**
 * Intent Gate — Band P / pillar P2 (validator half; PURE, no session deps).
 *
 * Given the active plan's current version, validate every step's stated intent
 * against the REAL tree BEFORE the model starts editing: the paths a step claims
 * it will READ/EDIT and (fast-path only) the symbols it names. This is the
 * "kill the wrong-mental-model edit" check from
 * docs/agents/conditioning-band-study.md §4-P2 / §3.2.
 *
 * Like path-grounding.ts / grounding-guard.ts this module touches NO
 * agent-session / registries / hubs — all fs + fuzzy + index access is via
 * injected deps, so it is unit-testable and reused by the thin
 * built-ins/intent-gate-extension.ts adapter (which wires the real deps exactly
 * as path-grounding-extension.ts does).
 *
 * LOAD-BEARING INVARIANTS (mirroring the grounding trio):
 *   - CREATE is fine. A path a step will CREATE (its `producesArtifact`, or a path
 *     produced by any earlier step) is NEVER flagged — a missing path there is the
 *     intent, not a typo. We only flag paths a step claims to mutate.
 *   - EDIT-VERB gated. A path token in a step intent is only checked when that
 *     intent carries a mutation verb (edit/fix/refactor/… — the ACTION_PATTERN
 *     idea from task-rigor.ts, minus the create-like verbs). A plan step that
 *     merely mentions a path in passing is left alone.
 *   - Two-tier path finding: parent dir exists but the file doesn't → WARN with
 *     fuzzy sibling candidates ("did you mean src/util/helper.ts?"); the parent
 *     dir itself is missing → BLOCK-level (the mental model is off, not a typo).
 *   - FAIL-OPEN symbols. Symbol names are checked repo-map-first: a HIT in the
 *     lossy index confirms existence; a MISS is inconclusive (the index caps
 *     ~12 symbols/file). An optional `symbolResolve` (LSP, wired in the extension)
 *     is the authority when available; when it returns undefined (unavailable) or
 *     throws, misses stay silent (FAIL-OPEN).
 */

import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import type { FuzzyClosest, FuzzyClosestN, PathGroundingDeps } from "./path-grounding.ts";
import { groundPath, PATH_GROUNDING_DEFAULTS } from "./path-grounding.ts";
import type { PlanVersion } from "./plan/plan-manager.ts";
import type { SupervisionLevel } from "./supervision-thermostat.ts";
import type { RigorLevel } from "./task-rigor.ts";

// ============================================================================
// Findings
// ============================================================================

export type IntentGateSeverity = "block" | "warn";

export interface IntentGateFinding {
	/** The plan step id the finding belongs to. */
	stepId: string;
	kind: "path" | "symbol";
	/** The offending token as written in the step intent. */
	token: string;
	/** block = parent dir missing / authoritative absence; warn = missing file with siblings. */
	severity: IntentGateSeverity;
	/** Fuzzy candidates (best-first), possibly empty. */
	candidates: string[];
	/** Human-readable, copy-pasteable finding line. */
	message: string;
}

// ============================================================================
// Injectable dependencies
// ============================================================================

export interface IntentGateDeps {
	/** Resolve a raw path to an absolute fs path (adapter binds resolveReadPath to cwd). */
	resolve: (rawPath: string) => string;
	/** True iff `absPath` exists on disk (file OR directory). */
	fileExists: (absPath: string) => boolean;
	/** Directory entry basenames, or throws if unlistable. */
	listDir: (absDir: string) => string[];
	/** Closest-name matcher (suggestClosest from @pit/ai). */
	fuzzy: FuzzyClosest;
	/** Optional single-pass top-N matcher (suggestClosestN); falls back to `fuzzy`. */
	fuzzyN?: FuzzyClosestN;
	/** Optional path normalizer (expandPath: strips `:line`, expands ~/@). */
	normalize?: (rawPath: string) => string;
	/** Optional case-fold entry equality (sameCanonicalName on win32/darwin). */
	sameName?: (a: string, b: string) => boolean;
	/**
	 * Repo-map symbol fast-path (lossy). A case-insensitive HIT via `lowerSet`
	 * confirms a symbol exists; a MISS is inconclusive and FAILS OPEN.
	 * Optional — omitted = no fast-path. `names` is unused here (fuzzy pools come
	 * from `symbolResolve`); accepted so callers can pass `repoMapToSymbolSet` as-is.
	 */
	symbolSet?: { names: Set<string>; lowerSet: Set<string> };
	/**
	 * Future authority for symbol absence (LSP workspace/symbol). Returns the names
	 * the server knows for a query, or undefined when unavailable (FAIL-OPEN). When
	 * omitted (v1), a repo-map miss never blocks. Kept so the LSP wiring is a
	 * one-liner later, exactly like grounding-guard's `lspResolve`.
	 */
	symbolResolve?: (name: string) => string[] | undefined;
}

// ============================================================================
// Extraction tuning
// ============================================================================

/**
 * File extensions we treat as "this token is a path". Deliberately a closed list
 * so incidental prose (`e.g.`, `v1.2`) is never mistaken for a file reference.
 */
const KNOWN_EXTENSIONS = new Set<string>([
	"ts",
	"tsx",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"json",
	"jsonl",
	"md",
	"mdx",
	"css",
	"scss",
	"less",
	"html",
	"htm",
	"py",
	"go",
	"rs",
	"java",
	"kt",
	"rb",
	"php",
	"c",
	"cc",
	"cpp",
	"h",
	"hpp",
	"cs",
	"swift",
	"sh",
	"bash",
	"zsh",
	"yml",
	"yaml",
	"toml",
	"ini",
	"sql",
	"txt",
	"vue",
	"svelte",
	"astro",
	"proto",
]);

/** Path-looking token: optional dir chain + `basename.ext`. Extension filtered below. */
const PATH_TOKEN_RE = /(?:[A-Za-z0-9_@.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+|[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g;

/**
 * Mutation-of-existing verbs. The ACTION_PATTERN idea from task-rigor.ts, but
 * DELIBERATELY excludes create-like verbs (create/add/new/criar/…) — a path a
 * step is creating is not a typo to flag.
 */
const EDIT_VERB_RE =
	/\b(edit|change|fix|update|modify|patch|refactor|rewrite|wire|remove|delete|rename|corrig\w+|alter\w*|atualiz\w*|editar|modific\w*|refator\w*|renome\w*|remov\w*|mexer|ajust\w*|revis\w*)\b/i;

/** Glob/brace magic — a path carrying any is a pattern, not a literal file. */
const GLOB_MAGIC = /[*?[\]{}]/;

/** Symbol-looking identifier: camelCase/PascalCase, length ≥ 4 (excludes plain words / short ids). */
const SYMBOL_TOKEN_RE = /\b[A-Za-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*\b/g;

// ============================================================================
// Dosing matrix (thermostat level × task rigor) — §5 / decision 5
// ============================================================================

export type IntentGateDose = "block" | "nudge" | "off";

/**
 * Resolve the gate dose from the current supervision level and the classified
 * task rigor. Encodes the §5 table exactly:
 *   - assistido: BLOCK the 1st unplanned edit at rigor ≥ 2 (max protection).
 *   - padrao:    NUDGE at rigor 2, BLOCK at rigor 3.
 *   - leve:      NUDGE at rigor 3 only.
 * Anything below the threshold (and every trivial prompt, rigor < 2) is `off`.
 */
export function intentGateDose(level: SupervisionLevel, rigor: RigorLevel): IntentGateDose {
	switch (level) {
		case "assistido":
			return rigor >= 2 ? "block" : "off";
		case "padrao":
			return rigor >= 3 ? "block" : rigor === 2 ? "nudge" : "off";
		case "leve":
			return rigor >= 3 ? "nudge" : "off";
	}
}

// ============================================================================
// Kill-switch
// ============================================================================

/** Opt-out: PIT_NO_INTENT_GATE disables the gate entirely (FAIL-OPEN). */
export function isIntentGateDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(env.PIT_NO_INTENT_GATE);
}

// ============================================================================
// Path / symbol token extraction
// ============================================================================

function normalizePathish(raw: string): string {
	return raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function hasKnownExtension(token: string): boolean {
	const dot = token.lastIndexOf(".");
	if (dot < 0) return false;
	return KNOWN_EXTENSIONS.has(token.slice(dot + 1).toLowerCase());
}

/** Path-looking tokens in `text` filtered to a known extension, deduped. */
export function extractPathTokens(text: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(PATH_TOKEN_RE)) {
		const token = match[0];
		if (!hasKnownExtension(token)) continue;
		if (GLOB_MAGIC.test(token)) continue;
		if (seen.has(token)) continue;
		seen.add(token);
		out.push(token);
	}
	return out;
}

function extractSymbolTokens(text: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(SYMBOL_TOKEN_RE)) {
		const token = match[0];
		if (token.length < 4) continue;
		if (seen.has(token)) continue;
		seen.add(token);
		out.push(token);
	}
	return out;
}

// ============================================================================
// Path validation
// ============================================================================

function toPathDeps(deps: IntentGateDeps): PathGroundingDeps {
	return {
		resolve: deps.resolve,
		fileExists: deps.fileExists,
		listDir: deps.listDir,
		fuzzy: deps.fuzzy,
		fuzzyN: deps.fuzzyN,
		normalize: deps.normalize,
		sameName: deps.sameName,
		maxDistance: PATH_GROUNDING_DEFAULTS.maxDistance,
		prefixMinOverlap: PATH_GROUNDING_DEFAULTS.prefixMinOverlap,
	};
}

/** Fuzzy-rank close siblings for a missing basename, re-attaching the original dir prefix. */
function siblingCandidates(token: string, deps: IntentGateDeps): string[] {
	const norm = (deps.normalize ? deps.normalize(token) : token).replace(/\\/g, "/");
	const lastSlash = norm.lastIndexOf("/");
	const dirPart = lastSlash >= 0 ? norm.slice(0, lastSlash) : ".";
	const wanted = norm.slice(lastSlash + 1);
	const prefix = lastSlash >= 0 ? `${norm.slice(0, lastSlash)}/` : "";
	let entries: string[];
	try {
		entries = deps.listDir(deps.resolve(dirPart));
	} catch {
		return [];
	}
	const sameName = deps.sameName ?? ((a, b) => a === b);
	const pool = entries.filter((e) => e.length > 0 && !sameName(e, wanted));
	const options = {
		maxDistance: PATH_GROUNDING_DEFAULTS.maxDistance,
		prefixMinOverlap: PATH_GROUNDING_DEFAULTS.prefixMinOverlap,
	};
	const ranked = deps.fuzzyN
		? deps.fuzzyN(wanted, pool, options, 5)
		: rankWithFuzzy(wanted, pool, deps.fuzzy, options);
	return ranked.map((name) => `${prefix}${name}`);
}

function rankWithFuzzy(
	wanted: string,
	pool: string[],
	fuzzy: FuzzyClosest,
	options: { maxDistance: number; prefixMinOverlap: number },
): string[] {
	const ranked: string[] = [];
	let remaining = pool;
	while (remaining.length > 0 && ranked.length < 5) {
		const closest = fuzzy(wanted, remaining, options);
		if (closest === undefined) break;
		ranked.push(closest);
		remaining = remaining.filter((e) => e !== closest);
	}
	return ranked;
}

function validatePathToken(stepId: string, token: string, deps: IntentGateDeps): IntentGateFinding | undefined {
	const norm = deps.normalize ? deps.normalize(token) : token;
	if (norm.length === 0 || GLOB_MAGIC.test(norm)) return undefined;

	// Exists on disk -> the plan's mental model is correct here.
	if (deps.fileExists(deps.resolve(norm))) return undefined;

	// Split parent dir / basename on normalized separators.
	const slash = norm.replace(/\\/g, "/");
	const lastSlash = slash.lastIndexOf("/");
	const dirPart = lastSlash >= 0 ? norm.slice(0, lastSlash) : ".";

	// Parent dir missing -> BLOCK-level: this is a wrong mental model, not a typo.
	if (!deps.fileExists(deps.resolve(dirPart))) {
		return {
			stepId,
			kind: "path",
			token,
			severity: "block",
			candidates: [],
			message: `step "${stepId}" plans to edit "${token}", but its directory "${dirPart}" does not exist in the repo`,
		};
	}

	// Parent exists, file missing. groundPath is the authority for "really absent"
	// (it also honors case-fold same-name / normalize invariants); allow == fail-open.
	const decision = groundPath({ path: token }, toPathDeps(deps));
	if (decision.action === "allow") return undefined;

	const candidates = siblingCandidates(token, deps);
	const message =
		candidates.length > 0
			? `step "${stepId}" cites "${token}" which does not exist — did you mean: ${candidates.join(", ")}?`
			: `step "${stepId}" cites "${token}" which does not exist under "${dirPart}"`;
	return { stepId, kind: "path", token, severity: "warn", candidates, message };
}

/** Collect deduped symbol tokens from every step intent in `version`. */
export function collectPlanSymbolTokens(version: PlanVersion): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const step of version.steps) {
		for (const token of extractSymbolTokens(step.intent)) {
			if (seen.has(token)) continue;
			seen.add(token);
			out.push(token);
		}
	}
	return out;
}

// ============================================================================
// Symbol validation (repo-map fast-path + optional LSP authority)
// ============================================================================

function validateSymbolToken(stepId: string, token: string, deps: IntentGateDeps): IntentGateFinding | undefined {
	// Fast-path: a HIT in the lossy repo-map index confirms existence (O(1)).
	if (deps.symbolSet?.lowerSet.has(token.toLowerCase())) return undefined;
	// Miss. Without an authoritative resolver we CANNOT prove absence (the index is
	// lossy, ~12 symbols/file) -> FAIL-OPEN (v1 always lands here).
	if (deps.symbolResolve === undefined) return undefined;
	let names: string[] | undefined;
	try {
		names = deps.symbolResolve(token);
	} catch {
		names = undefined;
	}
	if (names === undefined) return undefined; // resolver unavailable -> FAIL-OPEN
	const lowered = token.toLowerCase();
	if (names.some((n) => n.toLowerCase() === lowered)) return undefined;
	const options = {
		maxDistance: PATH_GROUNDING_DEFAULTS.maxDistance,
		prefixMinOverlap: PATH_GROUNDING_DEFAULTS.prefixMinOverlap,
	};
	const candidates = deps.fuzzyN
		? deps.fuzzyN(token, names, options, 5)
		: rankWithFuzzy(token, names, deps.fuzzy, options);
	if (candidates.length === 0) return undefined; // nothing close -> don't wedge a new name
	return {
		stepId,
		kind: "symbol",
		token,
		severity: "warn",
		candidates,
		message: `step "${stepId}" names symbol "${token}" which was not found — did you mean: ${candidates.join(", ")}?`,
	};
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Validate every step of `version` against the real tree. Pure: all I/O via deps.
 * Returns a flat, per-step finding list (empty == the plan is grounded, gate opens).
 */
export function validatePlan(version: PlanVersion, deps: IntentGateDeps): IntentGateFinding[] {
	const findings: IntentGateFinding[] = [];
	try {
		// Every path a step CREATES is fine — collect them so a later step that
		// touches an about-to-be-created file is not falsely flagged.
		const produced = new Set<string>();
		for (const step of version.steps) {
			if (step.producesArtifact) {
				for (const t of extractPathTokens(step.producesArtifact)) produced.add(normalizePathish(t));
			}
		}

		for (const step of version.steps) {
			const isEdit = EDIT_VERB_RE.test(step.intent);
			if (isEdit) {
				for (const token of extractPathTokens(step.intent)) {
					if (produced.has(normalizePathish(token))) continue; // will be created
					const f = validatePathToken(step.id, token, deps);
					if (f) findings.push(f);
				}
			}
			for (const token of extractSymbolTokens(step.intent)) {
				const f = validateSymbolToken(step.id, token, deps);
				if (f) findings.push(f);
			}
		}
	} catch {
		// FAIL-OPEN: a validator throw must never wedge the gate.
		return [];
	}
	return findings;
}

/** Compose a single copy-pasteable block/nudge message from a non-empty finding list. */
export function formatIntentGateFindings(findings: IntentGateFinding[]): string {
	const lines = findings.map((f) => `  - ${f.message}`);
	return (
		"Intent gate (no edit attempted): your plan does not match the repo tree:\n" +
		`${lines.join("\n")}\n` +
		"Revise the plan with `plan revise` (correct the paths/names), then retry the edit — " +
		"a grounded plan opens the gate for the rest of this task. " +
		"Or re-issue the edit to proceed anyway."
	);
}
