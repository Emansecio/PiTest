/**
 * Built-in impact-graph extension — Fase 2 (behavior layer) of the native code
 * graph. Fase 1 (`repo-map/edges.ts` + `repo-map/graph.ts`) gave us `RepoGraph` /
 * `blastRadius`: a pure query over the Living Repo Map's `deps` edges answering
 * "what depends on this file". This extension is the first consumer that acts on
 * it, post-exec, the same slot as `patch-audit-extension.ts`:
 *
 *  a) Advisory. After a successful `edit`/`write`, blastRadius(seed=edited file,
 *     maxDepth 2) is appended to the tool result as a compact note (bounded to 5
 *     paths + "+N more") — same appendix idiom as the LSP writethrough cross-file
 *     block (`lsp/writethrough.ts`). Text only; never blocks the edit
 *     (Invariant #4, escalation over termination).
 *  b) Pending + registry. DIRECT dependents (distance 1) go into a per-turn
 *     `pending` set until the model reads/edits/writes them, or runs `lsp` with
 *     them as the target — i.e. proves it looked. The unreviewed remainder is
 *     published to a module-level registry (mirroring `self-review.ts`'s
 *     findings registry) that `goal_complete` (R10, `tools/goal-complete.ts`)
 *     consults to refuse a premature "done".
 *  c) Anti-friction. A single edit whose direct-dependent count exceeds
 *     HUB_DIRECT_DEPENDENTS_THRESHOLD (a hub/barrel/index file) skips the
 *     pending feed entirely — the project check (R7) is what actually catches a
 *     broken hub change, and forcing a review of 30 importers would just be
 *     noise. The advisory still fires, with a suffix pointing at R7.
 *  d) Kill-switch: PIT_NO_IMPACT_GUARD disables advisory + pending + telemetry
 *     as a whole. With PIT_NO_REPO_GRAPH the Living Repo Map carries no `deps`
 *     at all (see `repo-map/living-index.ts`), so `buildRepoGraph` yields an
 *     edge-less graph and every blastRadius call returns zero files — this
 *     extension degrades to a no-op on its own, no special-casing needed here.
 *
 * Graph access mirrors `grounding-guard-extension.ts`'s `indexCache`: the same
 * `getLivingRepoMap(cwd)` call, memoized behind a short TTL (closure-scoped per
 * extension instance, so a worktree subagent's own cwd is never cross-cached)
 * so a burst of edits in one turn doesn't re-read + re-diff the map per call.
 *
 * Fail-open by construction: any error building the graph, resolving a path, or
 * computing blastRadius degrades to "no note, no pending" — it can never break
 * the underlying edit/write/read/lsp call.
 */

import { relative } from "node:path";
import { recordDiagnostic } from "@pit/ai";
import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import type { ExtensionAPI } from "../extensions/index.js";
import { type BlastRadiusEntry, blastRadius, buildRepoGraph, isTestPath, type RepoGraph } from "../repo-map/graph.ts";
import { getLivingRepoMap } from "../repo-map/living-index.ts";
import { extractPathArg, resolveToolPath } from "../tools/argument-prep.ts";

/** How long the built `RepoGraph` is reused before re-reading the living map (mirrors grounding-guard's indexCache). */
const GRAPH_CACHE_TTL_MS = 5000;
/** BFS depth for the advisory + pending computation — direct dependents + one more hop. */
const BLAST_MAX_DEPTH = 2;
/** Max dependent paths shown in the advisory note before folding the rest into "+N more". */
const DISPLAY_CAP = 5;
/**
 * A single edit whose DIRECT dependent count exceeds this is treated as a
 * hub/barrel/index file: feeding all its importers into `pending` would just be
 * anti-signal noise the model can't realistically clear one by one. The project
 * check (R7) is what actually covers a broken hub change. Named constant, not an
 * env knob — this is a shape decision, not a tuning one.
 */
const HUB_DIRECT_DEPENDENTS_THRESHOLD = 15;

export function isImpactGuardDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(env.PIT_NO_IMPACT_GUARD);
}

// ---------------------------------------------------------------------------
// Path helpers — same repo-relative, forward-slash convention as
// `RepoMapEntry.path` (see `repo-map/living-index.ts`'s `toRelKey`, not
// exported from there, so this is a local twin). `normalizeRelKey` additionally
// case-folds on win32 for the pending/predicted lookup keys ONLY (display paths
// keep their original casing), mirroring `verification.ts`'s `toRelKey`.
// ---------------------------------------------------------------------------

function toRepoRelPath(cwd: string, absPath: string): string {
	return relative(cwd, absPath).split("\\").join("/");
}

function normalizeRelKey(relPath: string): string {
	const posixPath = relPath.split("\\").join("/");
	return process.platform === "win32" ? posixPath.toLowerCase() : posixPath;
}

// ---------------------------------------------------------------------------
// Module-level registry, mirroring `self-review.ts`'s findings registry: the
// active session's impact-extension instance publishes state here so
// `goal_complete` (R10) and agent-session's cross-file-escape telemetry can
// read it without per-call plumbing. Shared across whatever extension
// instances exist in this process (parent + subagents) — the same tradeoff
// self-review already accepts; a subagent essentially never calls
// goal_complete, so cross-talk is a non-issue in practice.
// ---------------------------------------------------------------------------

interface PendingImpactEntry {
	/** Repo-relative, forward-slash display path (original casing). */
	path: string;
	/** Always 1 — only DIRECT dependents are tracked for the completion gate. */
	distance: 1;
	/** Repo-relative paths of the edit(s) that made this file impacted. */
	seeds: string[];
}

let currentPending = new Map<string, PendingImpactEntry>();
let currentPredicted = new Set<string>();
/**
 * Fase 4B: direct dependents that are themselves test files (`isTestPath`),
 * keyed by normalized path -> original-casing display path. These are pulled
 * OUT of `currentPending` — the right action for a test dependent is to RUN
 * it, not read it, so forcing a read would just be friction — but they still
 * count toward `currentPredicted` (unchanged: every surfaced path, test or
 * not, is "predicted" for telemetry).
 */
let currentCoveringTests = new Map<string, string>();

/** Unreviewed DIRECT dependents impacted this turn, sorted by path for stable output. */
export function getCurrentUnreviewedImpact(): Array<{ path: string; seeds: string[] }> {
	return Array.from(currentPending.values())
		.map((e) => ({ path: e.path, seeds: [...e.seeds] }))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * True when `path` (any spelling/casing) was ever surfaced by the impact graph
 * THIS turn — whether still pending, already reviewed (cleared), or suppressed
 * from `pending` by the hub cap. Lets the cross-file-escape diagnostic
 * (`agent-session.ts` `_recordCrossFileEscape`) record whether a verification
 * failure was something the import graph had already flagged as at-risk.
 */
export function wasFileInPredictedImpact(path: string): boolean {
	return currentPredicted.has(normalizeRelKey(path));
}

/**
 * Fase 3 (token-economy layer): every path surfaced by the impact graph THIS
 * turn (any hop, hub-suppressed or not — the same set `wasFileInPredictedImpact`
 * checks against), sorted. Feeds the self-review call-site (`agent-session.ts`
 * `_runSelfReviewPhase`), which threads this into `runSelfReviewLoop`'s
 * `impactedFiles` so the review subagent sees "these files import what
 * changed" as extra read-only context. Reuses `currentPredicted` verbatim — its
 * keys are already normalized (forward-slash, lowercased on win32 only) since
 * that is the same registry `wasFileInPredictedImpact` reads. Empty when
 * nothing was edited this turn (fail-open: the self-review call-site degrades
 * to its pre-Fase-3 behavior).
 */
export function getCurrentPredictedImpactPaths(): string[] {
	return Array.from(currentPredicted).sort();
}

/**
 * Fase 4B: direct dependents (this turn) that are test files by convention,
 * pulled out of `getCurrentUnreviewedImpact` — see `currentCoveringTests`.
 * Sorted, original casing preserved. Consulted by `goal_complete` (R10) to
 * suggest running these instead of demanding a read, and by the advisory note
 * as a "Tests covering this" suffix.
 */
export function getCurrentCoveringTests(): string[] {
	return Array.from(currentCoveringTests.values()).sort();
}

/** Test-only: seed the pending registry directly, bypassing the event pipeline. */
export function _setUnreviewedImpactForTest(entries: Array<{ path: string; seeds: string[] }>): void {
	currentPending = new Map(
		entries.map((e) => [normalizeRelKey(e.path), { path: e.path, distance: 1 as const, seeds: [...e.seeds] }]),
	);
}

/** Test-only: seed the covering-tests registry directly, bypassing the event pipeline. */
export function _setCoveringTestsForTest(paths: string[]): void {
	currentCoveringTests = new Map(paths.map((p) => [normalizeRelKey(p), p]));
}

/** Test-only: reset all module-level impact state (pending + predicted + covering tests). */
export function _resetImpactStateForTest(): void {
	currentPending = new Map();
	currentPredicted = new Set();
	currentCoveringTests = new Map();
}

// ---------------------------------------------------------------------------
// Advisory note rendering.
// ---------------------------------------------------------------------------

/** Max test paths shown in the advisory's "Tests covering this" suffix before folding into "+N more". */
const ADVISORY_TESTS_CAP = 3;

/**
 * Render the bounded "Tests covering this" suffix for the advisory note, or ""
 * when `testPaths` is empty (no suffix at all — the common case for files
 * with no test coverage). `testPaths` is assumed pre-sorted.
 */
function buildCoveringTestsSuffix(testPaths: readonly string[]): string {
	if (testPaths.length === 0) return "";
	const shown = testPaths.slice(0, ADVISORY_TESTS_CAP);
	const remaining = testPaths.length - shown.length;
	const more = remaining > 0 ? `, +${remaining} more` : "";
	return ` Tests covering this: ${shown.join(", ")}${more}.`;
}

/**
 * Render the bounded advisory note: up to DISPLAY_CAP paths grouped by hop
 * distance ("(direct)" / "(N hops)"), the rest folded into "+N more". `files`
 * is assumed pre-sorted by (distance, path) — exactly what `blastRadius`
 * guarantees. A hub-suppressed edit gets a different tail pointing at R7
 * instead of "review them" (nothing was fed into `pending` to review).
 * `directTestPaths` (Fase 4B) — the direct dependents that are test files —
 * append a "Tests covering this" suffix regardless of hub status; empty
 * yields no suffix.
 */
function buildImpactNote(files: readonly BlastRadiusEntry[], hub: boolean, directTestPaths: readonly string[]): string {
	const total = files.length;
	const shown = files.slice(0, DISPLAY_CAP);
	const remaining = total - shown.length;

	const groups: Array<{ distance: number; paths: string[] }> = [];
	for (const f of shown) {
		const last = groups[groups.length - 1];
		if (last && last.distance === f.distance) last.paths.push(f.path);
		else groups.push({ distance: f.distance, paths: [f.path] });
	}
	const groupText = groups
		.map((g) => `${g.paths.join(", ")} (${g.distance === 1 ? "direct" : `${g.distance} hops`})`)
		.join("; ");
	const moreSuffix = remaining > 0 ? `; +${remaining} more` : "";
	const head = `Impact graph: ${total} file(s) depend on this one — ${groupText}${moreSuffix}`;
	const body = hub ? `${head} (hub file — rely on the project check).` : `${head}. Review them before declaring done.`;
	return `${body}${buildCoveringTestsSuffix(directTestPaths)}`;
}

// ---------------------------------------------------------------------------
// Extension.
// ---------------------------------------------------------------------------

export interface ImpactExtensionOptions {
	cwd: string;
}

export function createImpactExtension(options: ImpactExtensionOptions) {
	return (pi: ExtensionAPI) => {
		let graphCache: { at: number; graph: RepoGraph } | undefined;

		const getCachedGraph = async (): Promise<RepoGraph> => {
			const now = Date.now();
			if (graphCache && now - graphCache.at < GRAPH_CACHE_TTL_MS) return graphCache.graph;
			const { map } = await getLivingRepoMap(options.cwd);
			const graph = buildRepoGraph(map.entries);
			graphCache = { at: now, graph };
			return graph;
		};

		// Reset per-turn state at the start of each new user turn — mirrors
		// edit-precondition-extension's `editedThisTurn.clear()` on the same hook.
		pi.on("turn_start", () => {
			currentPending = new Map();
			currentPredicted = new Set();
			currentCoveringTests = new Map();
		});

		pi.on("tool_result", async (event) => {
			try {
				if (isImpactGuardDisabled()) return undefined;
				if (event.isError) return undefined;

				// (b) Clearing pass: a read/edit/write/lsp of an already-pending file
				// proves the model looked at it — clear it regardless of whether this
				// same call also seeds NEW pending entries below (an edit of a pending
				// file both clears it and re-seeds from it).
				if (
					event.toolName === "read" ||
					event.toolName === "edit" ||
					event.toolName === "write" ||
					event.toolName === "lsp"
				) {
					const reviewedRaw = extractPathArg(event.input);
					if (reviewedRaw) {
						const reviewedAbs = resolveToolPath(reviewedRaw, options.cwd);
						currentPending.delete(normalizeRelKey(toRepoRelPath(options.cwd, reviewedAbs)));
					}
				}

				// (a) Advisory + pending-seeding pass: only a successful edit/write
				// actually changed content the graph should reason about.
				if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
				const editedRaw = extractPathArg(event.input);
				if (!editedRaw) return undefined;
				const editedAbs = resolveToolPath(editedRaw, options.cwd);
				const editedRepoRel = toRepoRelPath(options.cwd, editedAbs);

				const graph = await getCachedGraph();
				const blast = blastRadius(graph, [editedRepoRel], { maxDepth: BLAST_MAX_DEPTH });
				if (blast.files.length === 0) return undefined;

				const directCount = blast.files.filter((f) => f.distance === 1).length;
				const hub = directCount > HUB_DIRECT_DEPENDENTS_THRESHOLD;

				// Every surfaced file (any hop) counts as "predicted" for the
				// cross-file-escape telemetry, hub-suppressed or not — the advisory
				// text told the model about it either way.
				for (const f of blast.files) currentPredicted.add(normalizeRelKey(f.path));

				// Direct dependents split two ways: test-shaped paths (Fase 4B) go to
				// `currentCoveringTests` — the model should RUN them, not read them —
				// regardless of hub status (a hub file's test dependents are still
				// worth naming). Non-test direct dependents follow the existing
				// pending-review flow, still gated by the hub cap.
				const directTestPaths: string[] = [];
				for (const f of blast.files) {
					if (f.distance !== 1) continue;
					if (isTestPath(f.path)) {
						currentCoveringTests.set(normalizeRelKey(f.path), f.path);
						directTestPaths.push(f.path);
						continue;
					}
					if (hub) continue;
					const key = normalizeRelKey(f.path);
					const existing = currentPending.get(key);
					if (existing) {
						if (!existing.seeds.includes(editedRepoRel)) existing.seeds.push(editedRepoRel);
					} else {
						currentPending.set(key, { path: f.path, distance: 1, seeds: [editedRepoRel] });
					}
				}
				directTestPaths.sort();

				recordDiagnostic({
					category: "quality.impact-guard",
					level: "info",
					source: "impact-extension",
					context: {
						path: editedRepoRel,
						ruleId: hub ? "impact-hub" : "impact-advisory",
						note: `dependents=${blast.files.length} direct=${directCount}`,
					},
				});

				const note = buildImpactNote(blast.files, hub, directTestPaths);
				return { content: [...event.content, { type: "text" as const, text: `\n${note}` }] };
			} catch {
				return undefined;
			}
		});
	};
}
