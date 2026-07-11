/**
 * Grounding Guard — Half A of the Grounding Firewall.
 *
 * PURE, decoupled pre-execution logic. Given a candidate tool call (name + args)
 * whose argument NAMES a GLOBAL symbol that MUST already exist in the project (a
 * REFERENCE — a debug function-breakpoint name, or an lsp workspace-symbol query),
 * it grounds that name against the real code and returns one of three verdicts:
 *
 *   (1) the symbol exists                                   -> { action: "allow" }
 *   (2) it does NOT exist and there is exactly ONE dominant
 *       fuzzy candidate (distance <= threshold)             -> { action: "rewrite", args }
 *   (3) it does NOT exist and there are N candidates         -> { action: "block", message }
 *
 * THREE LOAD-BEARING INVARIANTS:
 *
 *   - CASCADE, never the lossy index alone. The living-repo-map is LOSSY (cap
 *     ~12 top-level symbols per file). It is a FAST-PATH of confirmation only.
 *     On a MISS we consult the authoritative LSP (workspace/symbol) BEFORE
 *     blocking. We only block after BOTH index and LSP fail to find the name.
 *
 *   - GLOBAL references only — never definitions nor line-scoped selectors. We act
 *     solely on the two args that denote a global symbol name (debug function
 *     breakpoint, lsp workspace-symbol query). We NEVER touch a name the model is
 *     creating (lsp `new_name`) nor the line-scoped `symbol` of lsp navigation,
 *     which legitimately names locals/members the global index can't carry.
 *
 *   - FAIL-OPEN absolutely. No index / no LSP / any throw / opt-out env flag ->
 *     return { action: "allow" }. Missing infra must never block a real symbol
 *     the lossy index simply doesn't carry. Same posture as debug-verify.
 *
 * This module touches NO agent-session / registries / hubs. It only imports
 * types and takes injectable deps (each with a real default). The wiring — where
 * the main loop builds the deps from `getLivingRepoMap` + the LSP client and
 * registers the pre-exec handler — is documented in the WIRING block at the end
 * and intentionally NOT performed here.
 */

import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import type { LivingRepoMap, RepoMapEntry } from "./repo-map/living-index.ts";

// ============================================================================
// Public verdict / input shapes
// ============================================================================

/** Verdict returned by `groundToolCall`. Mirrors the pre-exec pipeline's options. */
export type GroundingDecision =
	| { action: "allow" }
	| { action: "rewrite"; args: Record<string, unknown> }
	| { action: "block"; message: string };

/** A candidate tool call to ground, before it executes. */
export interface GroundingCandidate {
	toolName: string;
	args: Record<string, unknown>;
}

/**
 * Resolved reference target extracted from a candidate: which argument key holds
 * the symbol name, and the name itself. `undefined` when the candidate is not a
 * grounded reference (wrong tool, wrong action, a DEFINITION arg, or no name).
 */
interface ReferenceTarget {
	/** The arg key whose value names the symbol (e.g. "function", "symbol", "query"). */
	argKey: string;
	/** The raw symbol name to ground. */
	name: string;
}

// ============================================================================
// Injectable dependencies (real defaults wired below)
// ============================================================================

/**
 * Flattened repo-map symbol index: original-cased `names` for fuzzy pools, and
 * `lowerSet` for O(1) case-insensitive membership.
 */
export type SymbolNameSet = { names: Set<string>; lowerSet: Set<string> };

/**
 * Confirm a symbol name against the LOSSY repo-map index. Returns the flattened
 * symbol sets; the guard treats lowerSet membership as existence (fast-path)
 * and absence as "ask the LSP", never as "block".
 */
export type IndexLookup = () => Promise<SymbolNameSet>;

/**
 * Authoritative resolution via the LSP (workspace/symbol). Returns the names the
 * language server actually knows for `query`, or `undefined` when no LSP is
 * available / it errored — in which case the guard FAILS OPEN (never blocks on
 * absence it cannot prove). An empty array means "the LSP answered and found
 * nothing", which (combined with an index miss) is the only thing that blocks.
 */
export type LspResolve = (query: string, signal?: AbortSignal) => Promise<string[] | undefined>;

/**
 * Closest-name matcher. Defaults to `suggestClosest` from `@pit/ai` (Levenshtein
 * + affix fallback). Returns the single best candidate name, or `undefined`.
 */
export type FuzzyClosest = (
	name: string,
	candidates: string[],
	options: { maxDistance: number; prefixMinOverlap: number },
) => string | undefined;

/**
 * Top-N variant of {@link FuzzyClosest} (same `suggestClosestN` from `@pit/ai`).
 * Returns up to `limit` best candidates, best-first, with IDENTICAL scoring/order
 * to calling {@link FuzzyClosest} repeatedly and removing each pick. OPTIONAL: when
 * wired, `rankCandidates` ranks in a single pass instead of re-scanning the pool
 * per pick (O(k·pool·L²) -> O(pool·L²)). When omitted, the per-pick loop over
 * `fuzzy` is used (identical result).
 */
export type FuzzyClosestN = (
	name: string,
	candidates: string[],
	options: { maxDistance: number; prefixMinOverlap: number },
	limit: number,
) => string[];

export interface GroundingGuardDeps {
	/** Fast-path: flattened symbol sets from the repo-map (`names` + `lowerSet`). */
	indexLookup: IndexLookup;
	/** Authoritative fallback: LSP workspace/symbol resolution. Optional infra. */
	lspResolve?: LspResolve;
	/** Fuzzy matcher (defaults to suggestClosest from @pit/ai). */
	fuzzy: FuzzyClosest;
	/**
	 * OPTIONAL single-pass top-N fuzzy matcher (suggestClosestN from @pit/ai). When
	 * wired, candidate ranking does ONE scan; when omitted, the `fuzzy` loop is used
	 * (identical output). See {@link FuzzyClosestN}.
	 */
	fuzzyN?: FuzzyClosestN;
	/** Max edit distance for an auto-fix / candidate to qualify. */
	maxDistance: number;
	/** Min affix overlap for the fuzzy affix fallback. */
	prefixMinOverlap: number;
	/** Abort signal forwarded to the LSP request, if any. */
	signal?: AbortSignal;
}

// Calibrated to match the existing "did you mean" tuning used for unknown-tool
// and key hints (validation.ts KEY_DYM_MAX_DISTANCE=4 / agent-loop UNKNOWN_TOOL=3).
const DEFAULT_MAX_DISTANCE = 3;
// Effectively DISABLES suggestClosest's affix (substring) fallback for the guard.
// That fallback returns a match even beyond maxDistance when one name contains the
// other (validation.ts:343-348); for grounding that means `count` -> `accountId`,
// a false auto-fix/block. A floor larger than any real identifier makes the
// `shorter.length < prefixMinOverlap` guard always trip, so ONLY true edit-distance
// matches (typos) qualify.
const DEFAULT_PREFIX_MIN_OVERLAP = 64;
/** Cap the candidate list in a block message so a noisy match set can't flood. */
const MAX_BLOCK_CANDIDATES = 5;
/**
 * Names shorter than this are too ambiguous to ground: the fuzzy pool yields
 * near-neighbours that are almost always wrong (idx, ctx, row, add…). Below the
 * floor the guard never intervenes.
 */
const MIN_GROUNDED_NAME_LENGTH = 4;

/**
 * Only a bare, simple identifier is a groundable GLOBAL name. A qualified or
 * multi-token value (pkg.Func, Class.method, "My Class", a.b.c) is language-
 * qualified, line-scoped, or a search expression that the global index and a
 * bare-name workspace/symbol cannot carry — grounding it would false-block a
 * valid target (e.g. a Go `main.run` / Java method breakpoint). Such names pass
 * through untouched.
 */
const SIMPLE_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// ============================================================================
// Reference extraction — the ONLY place a tool/arg becomes "groundable"
// ============================================================================

/**
 * Debug actions where `function` names an existing function (the breakpoint
 * target) — a REFERENCE that must already exist in the program. Only `set` is
 * grounded: `remove_breakpoint` targets a PREVIOUSLY-SET breakpoint by name
 * (debug.ts removeFunctionBreakpoint), so the live symbol index is the wrong
 * oracle — a rewrite there could silently retarget and no-op the removal.
 */
const DEBUG_FUNCTION_REFERENCE_ACTIONS = new Set<string>(["set_breakpoint"]);

function asString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Map a candidate to its single REFERENCE target, or `undefined` if nothing on
 * this call should be grounded. Only TWO args denote a GLOBAL symbol name the
 * project must already carry:
 *   - `debug` function breakpoint   -> args.function  (no file/line form)
 *   - `lsp` workspace-symbol search -> args.query     (action=symbols, file="*")
 *
 * Deliberately NOT grounded: the `symbol` arg of lsp navigation/rename
 * (definition/references/rename/…). That `symbol` is a per-LINE column selector
 * resolved by resolveSymbolColumn against a single file line (lsp/utils.ts:597) —
 * it legitimately names locals, parameters, members, and aliased imports that the
 * repo-map (top-level) and workspace/symbol (globals) never carry, so grounding it
 * would false-block/false-rewrite valid references. `new_name` (a DEFINITION) and
 * `rename_file` (a path) are likewise never grounded.
 */
function extractReferenceTarget(candidate: GroundingCandidate): ReferenceTarget | undefined {
	const { toolName, args } = candidate;

	if (toolName === "debug") {
		const action = asString(args.action);
		if (action === undefined || !DEBUG_FUNCTION_REFERENCE_ACTIONS.has(action)) return undefined;
		// Only the FUNCTION-breakpoint form (a global function name); the file+line
		// form targets a source position, not a symbol.
		if (args.file !== undefined || args.line !== undefined) return undefined;
		const fn = asString(args.function);
		if (fn === undefined) return undefined;
		return { argKey: "function", name: fn };
	}

	if (toolName === "lsp") {
		// Workspace symbol search is the ONLY lsp action whose arg is a global symbol
		// name: action=symbols with file="*", where `query` IS the name. Every other
		// lsp action's `symbol`/`query` is line-scoped or not a name at all.
		if (asString(args.action) !== "symbols") return undefined;
		if (asString(args.file) !== "*") return undefined;
		const query = asString(args.query);
		if (query === undefined) return undefined;
		return { argKey: "query", name: query };
	}

	return undefined;
}

// ============================================================================
// Cascade existence check (repo-map fast-path -> LSP authority)
// ============================================================================

interface ExistenceResult {
	/** true = found, false = authoritatively absent, undefined = could not prove (fail-open). */
	exists: boolean | undefined;
	/** Candidate names gathered along the way (for fuzzy ranking on a miss). */
	candidates: string[];
}

/**
 * Run the cascade for `name`:
 *   1. repo-map fast-path (lossy): a hit short-circuits to exists=true.
 *   2. on miss, LSP workspace/symbol (authoritative): an exact name hit -> true;
 *      an answer with no exact hit -> false (the only thing that authorizes a
 *      block); no LSP / a throw -> undefined (FAIL-OPEN).
 *
 * Candidate names accumulate from BOTH layers so the fuzzy step has the richest
 * pool even when the index is sparse.
 */
async function checkExistence(name: string, deps: GroundingGuardDeps): Promise<ExistenceResult> {
	const candidates: string[] = [];

	// --- Fast-path: lossy repo-map index ---------------------------------------
	let index: SymbolNameSet;
	try {
		index = await deps.indexLookup();
	} catch {
		// Index unavailable: cannot use the fast-path, but the LSP may still
		// resolve. Treat as an empty index (not a failure) and continue.
		index = { names: new Set<string>(), lowerSet: new Set<string>() };
	}
	// Case-insensitive existence via precomputed lowerSet — O(1). Matches the LSP
	// exact-match and the fuzzy layer, so a case-variant hit short-circuits here
	// instead of slipping to a silent case rewrite downstream. Original-cased
	// names still feed the fuzzy pool on a miss.
	if (index.lowerSet.has(name.toLowerCase())) return { exists: true, candidates: [] };
	for (const candidate of index.names) candidates.push(candidate);

	// --- Authority: LSP workspace/symbol ---------------------------------------
	if (deps.lspResolve === undefined) {
		// No LSP wired at all -> we cannot prove absence -> FAIL-OPEN.
		return { exists: undefined, candidates };
	}

	let lspNames: string[] | undefined;
	try {
		lspNames = await deps.lspResolve(name, deps.signal);
	} catch {
		lspNames = undefined;
	}
	if (lspNames === undefined) {
		// LSP errored / unavailable for this query -> FAIL-OPEN.
		return { exists: undefined, candidates };
	}

	for (const lspName of lspNames) candidates.push(lspName);
	// workspace/symbol is fuzzy/substring server-side, so prove existence with an
	// EXACT (case-insensitive) name match — never trust a substring as presence.
	const lowered = name.toLowerCase();
	const exact = lspNames.some((candidate) => candidate.toLowerCase() === lowered);
	if (exact) return { exists: true, candidates };

	// Both layers consulted, name not found, LSP answered -> authoritative absence.
	return { exists: false, candidates };
}

// ============================================================================
// Fuzzy candidate ranking for the block / rewrite branch
// ============================================================================

/**
 * Rank the candidate pool by closeness to `name`, keeping only those within the
 * configured fuzzy threshold and returning them best-first (deduped). Reuses the
 * SAME `fuzzy` matcher used for the auto-fix decision, by repeatedly extracting
 * the closest and removing it, so the threshold is consistent across (2) and (3).
 */
function rankCandidates(name: string, pool: string[], deps: GroundingGuardDeps): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const candidate of pool) {
		if (candidate === name) continue;
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		unique.push(candidate);
	}

	const options = { maxDistance: deps.maxDistance, prefixMinOverlap: deps.prefixMinOverlap };
	const fuzzyN = deps.fuzzyN;
	if (fuzzyN !== undefined) {
		// Single pass over the deduped pool: IDENTICAL top-N ordering — `fuzzyN` IS
		// `suggestClosestN`, whose stable ascending-score sort matches the loop's
		// repeated `< best.score` selection below.
		return fuzzyN(name, unique, options, MAX_BLOCK_CANDIDATES);
	}

	const ranked: string[] = [];
	let remaining = unique;
	while (remaining.length > 0 && ranked.length < MAX_BLOCK_CANDIDATES) {
		const closest = deps.fuzzy(name, remaining, options);
		if (closest === undefined) break;
		ranked.push(closest);
		remaining = remaining.filter((candidate) => candidate !== closest);
	}
	return ranked;
}

/**
 * Block message in the established tool-error-hint tone — copy-pasteable, with
 * the "(no write/exec attempted)" prefix used by edit-precondition and the
 * canonical "Did you mean" verb used across the codebase.
 */
function formatBlockMessage(argName: string, candidates: string[]): string {
	const list = candidates.join(", ");
	return (
		`Grounding guard (no write/exec attempted): symbol "${argName}" was not found in this project. ` +
		`Did you mean: ${list}? Re-issue the call with the exact name, ` +
		"or re-issue the identical call to run it anyway."
	);
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Ground a single candidate tool call. Pure: all I/O is via injected deps.
 *
 * Returns:
 *   - { action: "allow" }                  — not a reference, exists, or FAIL-OPEN
 *   - { action: "rewrite", args }          — 1 dominant fuzzy candidate; args patched
 *   - { action: "block", message }         — N candidates; model must choose
 *
 * NOTE: a totally absent symbol with NO fuzzy candidates falls through to
 * `allow` — the guard only intervenes when it has something actionable to say,
 * so it can never wedge on a legitimately new/uncommon name.
 */
export async function groundToolCall(
	candidate: GroundingCandidate,
	deps: GroundingGuardDeps,
): Promise<GroundingDecision> {
	try {
		const target = extractReferenceTarget(candidate);
		if (target === undefined) return { action: "allow" };

		const name = target.name;
		// Short names are too ambiguous to ground; non-simple identifiers (qualified
		// names, multi-token queries, punctuation) are not global names the index can
		// carry. Either way, never intervene.
		if (name.length < MIN_GROUNDED_NAME_LENGTH) return { action: "allow" };
		if (!SIMPLE_IDENTIFIER.test(name)) return { action: "allow" };

		const { exists, candidates } = await checkExistence(name, deps);

		// Found, or could-not-prove (no LSP / throw / index-only miss) -> FAIL-OPEN.
		if (exists !== false) return { action: "allow" };

		// Authoritatively absent. Build the fuzzy candidate list.
		const ranked = rankCandidates(name, candidates, deps);
		if (ranked.length === 0) {
			// Nothing close enough to suggest — don't wedge a possibly-valid name.
			return { action: "allow" };
		}

		// (2) Exactly one dominant candidate within threshold -> AUTO-FIX (rewrite).
		if (ranked.length === 1) {
			const nextArgs: Record<string, unknown> = { ...candidate.args };
			nextArgs[target.argKey] = ranked[0];
			return { action: "rewrite", args: nextArgs };
		}

		// (3) Multiple candidates -> BLOCK and let the model choose.
		return { action: "block", message: formatBlockMessage(name, ranked) };
	} catch {
		// Any unexpected throw anywhere in the cascade -> FAIL-OPEN.
		return { action: "allow" };
	}
}

// ============================================================================
// Real-default dep builders (used by the wire; injectable for tests)
// ============================================================================

/** Flatten a living-repo-map into symbol sets (O(1) lowerSet + original names). */
export function repoMapToSymbolSet(map: LivingRepoMap): SymbolNameSet {
	const names = new Set<string>();
	const lowerSet = new Set<string>();
	for (const entry of map.entries as RepoMapEntry[]) {
		for (const symbol of entry.symbols) {
			names.add(symbol);
			lowerSet.add(symbol.toLowerCase());
		}
	}
	return { names, lowerSet };
}

/** Default fuzzy threshold/overlap constants, exported so the wire stays in sync. */
export const GROUNDING_GUARD_DEFAULTS = {
	maxDistance: DEFAULT_MAX_DISTANCE,
	prefixMinOverlap: DEFAULT_PREFIX_MIN_OVERLAP,
} as const;

/** Opt-out: PIT_NO_GROUNDING (or legacy PIT_NO_GROUNDING_GUARD) disables the guard entirely (FAIL-OPEN). */
export function isGroundingGuardDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(env.PIT_NO_GROUNDING || env.PIT_NO_GROUNDING_GUARD);
}

/* ============================================================================
 * WIRING (performed by the main loop — NOT in this lane)
 * ============================================================================
 *
 * The guard plugs in exactly like read-guard / edit-precondition /
 * learned-error-guard: a new ExtensionFactory on the pre-exec `tool_call` event.
 *
 * 1. NEW FILE — packages/coding-agent/src/core/built-ins/grounding-guard-extension.ts
 *    (thin adapter; keeps THIS module pure):
 *
 *      import type { ExtensionAPI } from "../extensions/index.js";
 *      import { suggestClosest } from "@pit/ai";
 *      import { getLivingRepoMap } from "../repo-map/living-index.ts";
 *      import { getConfig, getLspServers } from "../lsp/manager.ts";
 *      import { getOrCreateClient, sendRequest } from "../lsp/client.ts";
 *      import { filterWorkspaceSymbols } from "../lsp/utils.ts";
 *      import type { SymbolInformation } from "../lsp/types.ts";
 *      import {
 *        groundToolCall, repoMapToSymbolSet, isGroundingGuardDisabled,
 *        GROUNDING_GUARD_DEFAULTS, type GroundingGuardDeps,
 *      } from "../grounding-guard.ts";
 *
 *      export function createGroundingGuardExtension(options: { cwd: string }) {
 *        return (pi: ExtensionAPI) => {
 *          pi.on("tool_call", async (event) => {
 *            if (isGroundingGuardDisabled()) return undefined;
 *            if (event.toolName !== "debug" && event.toolName !== "lsp") return undefined;
 *
 *            const indexLookup = async () => {
 *              const { map } = await getLivingRepoMap(options.cwd);   // living-index.ts:345
 *              return repoMapToSymbolSet(map);                        // grounding-guard.ts
 *            };
 *            const lspResolve: GroundingGuardDeps["lspResolve"] = async (query, signal) => {
 *              const config = getConfig(options.cwd);                 // manager.ts:20
 *              const servers = getLspServers(config);                 // manager.ts:39
 *              if (servers.length === 0) return undefined;            // no LSP -> FAIL-OPEN
 *              const names: string[] = [];
 *              for (const [, serverConfig] of servers) {
 *                try {
 *                  const client = await getOrCreateClient(serverConfig, options.cwd); // client.ts:350
 *                  const res = (await sendRequest(
 *                    client, "workspace/symbol", { query }, signal, 8000, // client.ts:700 (short timeout)
 *                  )) as SymbolInformation[] | null;
 *                  if (res) for (const s of filterWorkspaceSymbols(res, query)) names.push(s.name);
 *                } catch {  // per-server failure: keep aggregating, never throw out
 *                }
 *              }
 *              return names;  // [] = answered-but-empty (block-eligible); names = pool
 *            };
 *
 *            const decision = await groundToolCall(
 *              { toolName: event.toolName, args: event.input as Record<string, unknown> },
 *              {
 *                indexLookup,
 *                lspResolve,
 *                fuzzy: suggestClosest,                               // validation.ts:332 (@pit/ai index.ts:52)
 *                maxDistance: GROUNDING_GUARD_DEFAULTS.maxDistance,
 *                prefixMinOverlap: GROUNDING_GUARD_DEFAULTS.prefixMinOverlap,
 *              },
 *            );
 *
 *            if (decision.action === "rewrite") {
 *              // event.input is mutable; patch in place (types.ts:826-831). No re-validation.
 *              Object.assign(event.input as Record<string, unknown>, decision.args);
 *              return undefined;                                      // PASS with corrected args
 *            }
 *            if (decision.action === "block") return { block: true, reason: decision.message };
 *            return undefined;                                        // allow
 *          });
 *        };
 *      }
 *
 * 2. REGISTER — packages/coding-agent/src/core/built-ins/index.ts
 *    - import (alongside the others, around index.ts:27):
 *        import { createGroundingGuardExtension } from "./grounding-guard-extension.ts";
 *    - push into the `factories` array, AFTER createLearnedErrorGuardExtension
 *      (index.ts:91) so basic errors (not-read / dry-run / learned) report first:
 *        createGroundingGuardExtension({ cwd: options.cwd }),
 *
 * That is the ONLY wiring. agent-session.ts already bridges beforeToolCall ->
 * runner.emitToolCall (agent-session.ts:1157) and short-circuits on the first
 * block (runner.ts:951-955); no change there.
 * ========================================================================== */
