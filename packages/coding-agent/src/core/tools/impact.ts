/**
 * `impact` tool — Fase 3 (token-economy layer) of the native code graph.
 *
 * Fase 1 (`repo-map/graph.ts`) built a pure query layer over the Living Repo
 * Map's persisted import edges: `buildRepoGraph` / `blastRadius` /
 * `dependenciesOf`. Fase 2 (`built-ins/impact-extension.ts`) is the
 * post-edit ADVISORY consumer — it fires automatically after an edit/write.
 * This tool is the ON-DEMAND consumer: the model can ask "who depends on
 * this file/symbol" BEFORE touching it, instead of grepping for importers by
 * hand — the Living Repo Map is already indexed and cached, so this is a
 * cheap lookup, not a fresh scan.
 *
 * Read-only navigation tool, same shape as `repo-map.ts`/`find-symbol.ts`: a
 * cwd-bound factory producing a `ToolDefinition`, wrapped by
 * `wrapToolDefinition` for the `AgentTool` export.
 *
 * Fail-open by construction: an empty/edge-less map (PIT_NO_REPO_GRAPH, or a
 * file the extractor doesn't cover) just yields "none found" — never throws.
 * The output is explicitly labeled heuristic (regex-extracted edges, not an
 * AST/typechecker), pointing at `lsp` references for authoritative usage.
 */

import { relative } from "node:path";
import type { AgentTool } from "@pit/agent-core";
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.js";
import { type BlastRadiusEntry, blastRadius, buildRepoGraph, dependenciesOf } from "../repo-map/graph.ts";
import { getLivingRepoMap, type RepoMapEntry } from "../repo-map/living-index.ts";
import { resolveToolPath } from "./argument-prep.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const impactSchema = Type.Object(
	{
		path: Type.Optional(
			Type.String({
				description: "File to query (absolute or repo-relative). Exactly one of path/symbol is required.",
			}),
		),
		symbol: Type.Optional(
			Type.String({
				description:
					"Symbol name to locate first, then query its declaring file(s). Exactly one of path/symbol is required.",
			}),
		),
		direction: Type.Optional(
			Type.Union([Type.Literal("dependents"), Type.Literal("dependencies"), Type.Literal("both")], {
				description:
					"'dependents' (default) = who imports this, transitively (blast radius — what might break). 'dependencies' = what this directly imports. 'both' = both sections.",
			}),
		),
		depth: Type.Optional(Type.Number({ description: "BFS hop depth for 'dependents'. Default 2, capped at 4." })),
	},
	{ additionalProperties: false },
);

/** Hop-depth bounds for the `dependents` BFS. */
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 4;
/** Hard cap on nodes returned by blastRadius — generous; display is capped separately. */
const MAX_NODES = 500;
/** Paths shown before folding the rest into "+N more" (dependents groups + flat dependency lists). */
const DISPLAY_CAP = 40;
/** Symbol-declaration matches shown before folding into "+N more". */
const MAX_SYMBOL_MATCHES = 5;

export interface ImpactToolOptions {}

/** A file's declared symbol names, with the living-map truncation sentinel filtered out. */
function symbolNames(entry: RepoMapEntry): string[] {
	return entry.symbols.filter((s) => !s.startsWith("(+"));
}

/**
 * Locate the file(s) declaring `symbol`: exact (case-sensitive) match first: if
 * that finds nothing, fall back to a case-insensitive pass. Returns repo-relative
 * paths, sorted, deduplicated implicitly (one entry per file).
 */
function findSymbolSeeds(entries: readonly RepoMapEntry[], symbol: string): string[] {
	const exact = entries.filter((e) => symbolNames(e).includes(symbol)).map((e) => e.path);
	if (exact.length > 0) return exact.sort();
	const lower = symbol.toLowerCase();
	return entries
		.filter((e) => symbolNames(e).some((s) => s.toLowerCase() === lower))
		.map((e) => e.path)
		.sort();
}

/** Resolve a `path` arg (absolute or repo-relative) to a repo-relative, forward-slash path. */
function resolveRepoRelPath(rawPath: string, cwd: string): string {
	const abs = resolveToolPath(rawPath, cwd);
	return relative(cwd, abs).split("\\").join("/");
}

/**
 * Render blastRadius results grouped by hop distance, capped at `cap` shown
 * entries: `direct: a.ts, b.ts · 2 hops: c.ts` (+N more when truncated).
 * `files` is assumed pre-sorted by (distance, path) — what blastRadius guarantees.
 */
function formatByDistance(files: readonly BlastRadiusEntry[], cap: number): string {
	const shown = files.slice(0, cap);
	const remaining = files.length - shown.length;
	const groups: Array<{ distance: number; paths: string[] }> = [];
	for (const f of shown) {
		const last = groups[groups.length - 1];
		if (last && last.distance === f.distance) last.paths.push(f.path);
		else groups.push({ distance: f.distance, paths: [f.path] });
	}
	const body = groups
		.map((g) => `${g.distance === 1 ? "direct" : `${g.distance} hops`}: ${g.paths.join(", ")}`)
		.join(" · ");
	return remaining > 0 ? `${body} · +${remaining} more` : body;
}

/** Render a flat, sorted path list capped at `cap` entries, "(+N more)" when truncated. */
function formatFlatList(paths: readonly string[], cap: number): string {
	const shown = paths.slice(0, cap);
	const remaining = paths.length - shown.length;
	return remaining > 0 ? `${shown.join(", ")} (+${remaining} more)` : shown.join(", ");
}

export function createImpactToolDefinition(cwd: string): ToolDefinition<typeof impactSchema, undefined> {
	return {
		name: "impact",
		label: "impact",
		activity: "navigation",
		description:
			"Who depends on this file/symbol (persisted import graph) — cheap alternative to grepping for importers. 'dependents' = what might break if it changes; 'dependencies' = what it imports. Heuristic (regex-extracted edges), not authoritative — cross-check with lsp references before a risky change.",
		promptSnippet: "Query the import graph: who depends on / is depended on by a file or symbol.",
		parameters: impactSchema,
		async execute(_toolCallId, args, _signal) {
			const hasPath = typeof args.path === "string" && args.path.length > 0;
			const hasSymbol = typeof args.symbol === "string" && args.symbol.length > 0;
			if (hasPath === hasSymbol) {
				const text = hasPath
					? "Provide exactly one of `path` or `symbol`, not both."
					: "Provide either `path` or `symbol` to query the import graph.";
				return { content: [{ type: "text" as const, text }], isError: true, details: undefined };
			}

			const { map } = await getLivingRepoMap(cwd);
			const graph = buildRepoGraph(map.entries);

			let seeds: string[];
			let subject: string;
			if (hasSymbol) {
				const symbol = args.symbol as string;
				const matches = findSymbolSeeds(map.entries, symbol);
				if (matches.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No declaration of "${symbol}" found in the indexed repo map. Try find_symbol or grep for usages.`,
							},
						],
						details: undefined,
					};
				}
				seeds = matches;
				const shown = matches.slice(0, MAX_SYMBOL_MATCHES);
				const more = matches.length - shown.length;
				subject = `symbol "${symbol}" (declared in ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""})`;
			} else {
				seeds = [resolveRepoRelPath(args.path as string, cwd)];
				subject = seeds[0]!;
			}

			const direction = args.direction ?? "dependents";
			const rawDepth = args.depth ?? DEFAULT_DEPTH;
			const depth = Math.min(Math.max(1, Math.trunc(rawDepth)), MAX_DEPTH);

			const lines: string[] = [];
			if (direction === "dependents" || direction === "both") {
				const blast = blastRadius(graph, seeds, { maxDepth: depth, maxNodes: MAX_NODES });
				lines.push(
					blast.files.length > 0
						? `Dependents of ${subject} (depth <=${depth}): ${formatByDistance(blast.files, DISPLAY_CAP)}`
						: `Dependents of ${subject}: none found.`,
				);
			}
			if (direction === "dependencies" || direction === "both") {
				const depsSet = new Set<string>();
				for (const seed of seeds) {
					for (const d of dependenciesOf(graph, seed)) depsSet.add(d);
				}
				const deps = [...depsSet].sort();
				lines.push(
					deps.length > 0
						? `Dependencies of ${subject} (direct only): ${formatFlatList(deps, DISPLAY_CAP)}`
						: `Dependencies of ${subject}: none found.`,
				);
			}
			lines.push("(from the persisted import graph — heuristic; use lsp references for authority)");

			return { content: [{ type: "text" as const, text: lines.join("\n") }], details: undefined };
		},
	};
}

export function createImpactTool(cwd: string): AgentTool<typeof impactSchema> {
	return wrapToolDefinition(createImpactToolDefinition(cwd));
}
