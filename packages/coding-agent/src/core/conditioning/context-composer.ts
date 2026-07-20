/**
 * Context Composer — Band P / Pillar P1 (ground-truth injection) + P3 (exemplar
 * anchoring). See docs/agents/conditioning-band-study.md §4-P1, §4-P3, §5.
 *
 * Given the enriched living repo-map, the user prompt, the session's hot files
 * and the most-recently-read file, this module PREDICTS which files the turn is
 * about to touch and ASSEMBLES a compact, token-budgeted outline of their real
 * top-level declarations (`path: kind name:line, …`) — so a weak model sees the
 * true shape of the code it is about to edit instead of hallucinating an API it
 * just read. When an edit looks imminent it also attaches a short STYLE EXEMPLAR:
 * the head of an analogous neighbor file (same dir + suffix pattern) so idiom is
 * learned by imitation, not instruction.
 *
 * Fase 3 (token-economy layer, see repo-map/graph.ts) adds a fifth prediction
 * layer, graph-neighbor: a file that is a DIRECT import-graph neighbor (either
 * side — what a strong seed imports, or what imports it) of a file already
 * matched by a strong layer (prompt-path, prompt-symbol, or the recently-read
 * file) gets `SCORE_GRAPH_NEIGHBOR` ADDED on top of its existing score — the
 * one deliberate departure from the max-across-layers rule the other four
 * layers share (see `applyGraphNeighborLayer`). The reverse index is built
 * once per call from `entries[].deps` via the same `buildRepoGraph` Fase-1
 * uses; entries carrying no `deps` (PIT_NO_REPO_GRAPH, or an unindexed
 * language) simply contribute no edges — the layer degrades to a no-op with
 * no special-casing needed here.
 *
 * Purity + fail-open by construction:
 *  - No I/O except the injectable `readFile` used ONLY for the exemplar body.
 *  - No clock / randomness → deterministic output for identical inputs.
 *  - Empty prompt / empty map / no prediction → empty block, zero cost.
 *  - Everything is capped by the thermostat-dosed token ceiling; the exemplar is
 *    counted INSIDE the same cap and is dropped before the ground-truth outline
 *    is ever starved (P1 is the higher-leverage pillar).
 *
 * Kill-switches (both fail-open):
 *  - PIT_NO_CONTEXT_COMPOSER=1 → whole block off (P1 + P3).
 *  - PIT_NO_STYLE_EXEMPLAR=1   → exemplar (P3) off, outline (P1) still on.
 *
 * This module is pure and does NOT read the thermostat/registry itself — the
 * wiring passes the current level in. The per-turn "surgical" injection lane
 * (the `context` event, §4-P1) is intentionally SKIPPED in v1: the cache-neutral
 * dynamic-suffix lane already delivers the outline before generation and is
 * safer (no supersede/compaction interaction). See §6 risk "Conteúdo injetado
 * podado/superseded".
 */

import { suggestClosest } from "@pit/ai";
import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import { buildRepoGraph } from "../repo-map/graph.ts";
import type { RepoMapDecl, RepoMapEntry } from "../repo-map/living-index.ts";
import type { SupervisionLevel } from "../supervision-thermostat.ts";

/**
 * Token ceiling per supervision level (§5 dosing table). The composer estimates
 * ~4 chars/token; the char budget is `cap * CHARS_PER_TOKEN`.
 */
export const LEVEL_TOKEN_CAP: Record<SupervisionLevel, number> = {
	assistido: 1200,
	padrao: 800,
	leve: 400,
};

const CHARS_PER_TOKEN = 4;

/** Default number of predicted files kept before budgeting trims further. */
const DEFAULT_TOP_K = 12;

/** Exemplar body bounds (§4-P3: "10-30 lines"). */
const EXEMPLAR_MIN_LINES = 10;
const EXEMPLAR_MAX_LINES = 30;

/** Relevance scores by predictor layer (higher wins; deterministic tie-break on path). */
const SCORE_PROMPT_PATH = 5;
const SCORE_PROMPT_SYMBOL = 4;
const SCORE_RECENT_IMPORT = 3;
const SCORE_FREQUENT_FILE = 1;
/**
 * Graph-neighbor bonus (Fase 3): added — not maxed — on top of whatever score a
 * direct import-graph neighbor of a STRONG seed (prompt-path/prompt-symbol match,
 * or the recently-read file) already carries. See `applyGraphNeighborLayer`.
 */
const SCORE_GRAPH_NEIGHBOR = 2;

export interface ComposeContextInput {
	/** The user prompt text for this turn (drives the prompt-mention layer). */
	prompt: string;
	/** The enriched living repo-map entries (kind+line where available). */
	entries: readonly RepoMapEntry[];
	/** Current thermostat level; defaults to `padrao` when the registry is empty. */
	level?: SupervisionLevel;
	/** Session hot files (rel paths), hottest first — the FrequentFilesTracker top-N. */
	frequentFiles?: readonly string[];
	/** Rel path of the most-recently-read file (edit-target signal for the exemplar). */
	recentReadPath?: string;
	/** Content of the most-recently-read file, if cheaply available (import layer). */
	recentReadContent?: string;
	/** Reader for exemplar bodies (rel path → text|null). Absent → no exemplar. */
	readFile?: (relPath: string) => string | null;
	/** Predicted-file cap before budgeting. Default {@link DEFAULT_TOP_K}. */
	topK?: number;
	/** Env for kill-switches (default `process.env`). */
	env?: NodeJS.ProcessEnv;
}

export interface ComposeContextResult {
	/** The full dynamic-suffix block (`<grounded_context>` [+ `<style_exemplar>`]) or "". */
	block: string;
	/** Predicted rel paths, ranked (highest relevance first). Exposed for tests/telemetry. */
	predicted: string[];
	/** Rel path of the exemplar neighbor, or undefined when none was included. */
	exemplarPath?: string;
	/** Approx token cost of `block` (chars/4). 0 when empty. */
	approxTokens: number;
}

interface Scored {
	path: string;
	score: number;
}

/** Normalize a path to forward slashes for stable comparison/dedupe. */
function norm(p: string): string {
	return p.split("\\").join("/");
}

function dirOf(p: string): string {
	const n = norm(p);
	const i = n.lastIndexOf("/");
	return i < 0 ? "" : n.slice(0, i);
}

function baseOf(p: string): string {
	const n = norm(p);
	const i = n.lastIndexOf("/");
	return i < 0 ? n : n.slice(i + 1);
}

/**
 * Suffix signatures used to match analogous neighbors (§4-P3):
 *  - `multiExt`: from the FIRST dot in the basename (`foo.test.ts` → `.test.ts`,
 *    `bar.ts` → `.ts`) — catches `*.test.ts ↔ *.test.ts`.
 *  - `dashSuffix`: a trailing `-word.ext` chunk (`x-extension.ts` → `-extension.ts`)
 *    — catches `*-extension.ts ↔ *-extension.ts`. Empty when absent.
 */
function suffixSignatures(base: string): { multiExt: string; dashSuffix: string } {
	const dot = base.indexOf(".");
	const multiExt = dot >= 0 ? base.slice(dot) : "";
	const m = /(-[A-Za-z0-9]+\.[^.]+)$/.exec(base);
	return { multiExt, dashSuffix: m ? m[1]! : "" };
}

/** Plain final extension (`.ts`, `.py`, …), or "" when none. */
function plainExt(base: string): string {
	const i = base.lastIndexOf(".");
	return i < 0 ? "" : base.slice(i);
}

const IDENT_RE = /[A-Za-z_$][\w$]*/g;
// Path-ish tokens in the prompt: contain a slash and a dotted filename, e.g.
// `src/core/foo.ts` or `foo.test.ts`. Kept deliberately narrow to avoid noise.
const PATH_RE = /[\w./-]*\/[\w.-]+\.[A-Za-z0-9]+|[\w-]+\.[A-Za-z]{1,5}\b/g;

/** Extract candidate identifier tokens from the prompt (deduped, length-filtered). */
function promptIdentifiers(prompt: string): string[] {
	const out = new Set<string>();
	for (const m of prompt.matchAll(IDENT_RE)) {
		const t = m[0]!;
		// Skip trivial words; a 3+ char identifier is the smallest worth grounding.
		if (t.length >= 3) out.add(t);
	}
	return [...out];
}

/** Extract path-ish mentions from the prompt (deduped, normalized). */
function promptPaths(prompt: string): string[] {
	const out = new Set<string>();
	for (const m of prompt.matchAll(PATH_RE)) out.add(norm(m[0]!));
	return [...out];
}

/**
 * Parse `import ... from "x"` / `require("x")` / `from x import` specifiers from
 * the most-recently-read file. Heuristic + cheap (regex, not AST); only used to
 * bias prediction toward the file's neighbors, so false positives are harmless.
 */
function extractImportSpecifiers(content: string): string[] {
	const out = new Set<string>();
	const re = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']|^\s*from\s+([\w./]+)\s+import/gm;
	for (const m of content.matchAll(re)) {
		const spec = m[1] ?? m[2];
		if (spec) out.add(spec);
	}
	return [...out];
}

/**
 * Predict the files this turn is likely to touch, ranked. Layered heuristic
 * (no ML): prompt-mentioned paths/symbols (fuzzy-matched against the map) >
 * imports of the most-recently-read file > session hot files > (Fase 3) direct
 * import-graph neighbors of the strong (path/symbol/recent-read) seeds.
 */
export function predictRelevantFiles(input: ComposeContextInput): string[] {
	const { entries } = input;
	if (entries.length === 0) return [];
	const topK = input.topK ?? DEFAULT_TOP_K;

	// Indexes over the map (built once).
	const pathSet = new Set<string>();
	const baseToPaths = new Map<string, string[]>();
	const symbolToPaths = new Map<string, string[]>();
	for (const e of entries) {
		const p = norm(e.path);
		pathSet.add(p);
		const b = baseOf(p);
		(baseToPaths.get(b) ?? baseToPaths.set(b, []).get(b)!).push(p);
		for (const s of e.symbols) {
			(symbolToPaths.get(s) ?? symbolToPaths.set(s, []).get(s)!).push(p);
		}
	}
	const allPaths = [...pathSet];
	const allBases = [...baseToPaths.keys()];
	const allSymbols = [...symbolToPaths.keys()];

	const scores = new Map<string, number>();
	const add = (p: string, s: number): void => {
		scores.set(p, Math.max(scores.get(p) ?? 0, s));
	};
	// Files matched by a STRONG layer (prompt-path / prompt-symbol), plus the
	// recently-read file itself — the seed set for the graph-neighbor layer (e)
	// below. Tracked separately from `scores` because (e) must run after ALL
	// four other layers (so it sees their final scores) while only SEEDING from
	// these two.
	const strongSeeds = new Set<string>();

	// (a) prompt-mentioned paths (exact or fuzzy against basenames/full paths).
	for (const mention of promptPaths(input.prompt)) {
		if (pathSet.has(mention)) {
			add(mention, SCORE_PROMPT_PATH);
			strongSeeds.add(mention);
			continue;
		}
		const base = baseOf(mention);
		const direct = baseToPaths.get(base);
		if (direct) {
			for (const p of direct) {
				add(p, SCORE_PROMPT_PATH);
				strongSeeds.add(p);
			}
			continue;
		}
		const closeBase = suggestClosest(base, allBases, { maxDistance: 3, prefixMinOverlap: 64 });
		if (closeBase) {
			for (const p of baseToPaths.get(closeBase) ?? []) {
				add(p, SCORE_PROMPT_PATH);
				strongSeeds.add(p);
			}
		} else {
			const closePath = suggestClosest(mention, allPaths, { maxDistance: 4, prefixMinOverlap: 64 });
			if (closePath) {
				add(closePath, SCORE_PROMPT_PATH);
				strongSeeds.add(closePath);
			}
		}
	}

	// (b) prompt-mentioned symbols → the file(s) declaring them (exact, then fuzzy).
	for (const ident of promptIdentifiers(input.prompt)) {
		const exact = symbolToPaths.get(ident);
		if (exact) {
			for (const p of exact) {
				add(p, SCORE_PROMPT_SYMBOL);
				strongSeeds.add(p);
			}
			continue;
		}
		const close = suggestClosest(ident, allSymbols, { maxDistance: 2, prefixMinOverlap: 64 });
		if (close) {
			for (const p of symbolToPaths.get(close) ?? []) {
				add(p, SCORE_PROMPT_SYMBOL);
				strongSeeds.add(p);
			}
		}
	}

	// (c) imports of the most-recently-read file → its likely neighbors.
	if (input.recentReadContent) {
		const recentDir = input.recentReadPath ? dirOf(input.recentReadPath) : "";
		for (const spec of extractImportSpecifiers(input.recentReadContent)) {
			const resolved = resolveImportToPath(spec, recentDir, pathSet, baseToPaths);
			if (resolved) add(resolved, SCORE_RECENT_IMPORT);
		}
	}

	// (d) session hot files (already-touched → likely still relevant).
	for (const f of input.frequentFiles ?? []) {
		const p = norm(f);
		if (pathSet.has(p)) add(p, SCORE_FREQUENT_FILE);
	}

	// The recently-read file is a strong signal too (the file about to be
	// edited) even though it is never itself surfaced in the output (see the
	// delete below) — its graph neighbors still deserve the bonus.
	if (input.recentReadPath) strongSeeds.add(norm(input.recentReadPath));

	// (e) Fase 3 — graph-neighbor: direct import-graph neighbors (both `deps`,
	// what a seed imports, AND `dependents`, who imports it — one hop, never
	// transitive) of a strong seed get SCORE_GRAPH_NEIGHBOR ADDED to whatever
	// they already scored. This is the one layer that accumulates rather than
	// maxes: being independently relevant AND graph-adjacent to another
	// relevant file is a stronger signal than either alone. Built fresh each
	// call from `entries[].deps` (no I/O, mirrors repo-map/graph.ts exactly) —
	// entries without `deps` (PIT_NO_REPO_GRAPH) simply yield no edges here.
	if (strongSeeds.size > 0) {
		const graph = buildRepoGraph([...entries]);
		for (const seed of strongSeeds) {
			const neighbors = new Set<string>([...(graph.deps.get(seed) ?? []), ...(graph.dependents.get(seed) ?? [])]);
			for (const neighbor of neighbors) {
				const n = norm(neighbor);
				if (!pathSet.has(n)) continue;
				scores.set(n, (scores.get(n) ?? 0) + SCORE_GRAPH_NEIGHBOR);
			}
		}
	}

	// Never re-surface the file the model just read (already in context) — run
	// LAST so a graph-neighbor bonus from another seed can't reintroduce it.
	if (input.recentReadPath) scores.delete(norm(input.recentReadPath));

	const ranked: Scored[] = [...scores.entries()].map(([path, score]) => ({ path, score }));
	// Deterministic: score desc, then path asc.
	ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
	return ranked.slice(0, topK).map((r) => r.path);
}

/**
 * Resolve an import specifier to a map path. Handles relative specifiers against
 * the reader's directory (with common source extensions) and bare basename
 * matches. Returns undefined when nothing in the map plausibly matches.
 */
function resolveImportToPath(
	spec: string,
	fromDir: string,
	pathSet: Set<string>,
	baseToPaths: Map<string, string[]>,
): string | undefined {
	const stripped = spec.replace(/\.(ts|tsx|js|jsx|mts|cts|py)$/, "");
	const baseName = baseOf(stripped);
	// Relative import: resolve against the reader's directory, try source exts.
	if (spec.startsWith(".") && fromDir !== undefined) {
		const joined = norm(joinRel(fromDir, stripped));
		for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".py", ""]) {
			const cand = `${joined}${ext}`;
			if (pathSet.has(cand)) return cand;
			const idx = `${joined}/index${ext}`;
			if (pathSet.has(idx)) return idx;
		}
	}
	// Fall back to a unique basename match anywhere in the map.
	for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".py"]) {
		const hits = baseToPaths.get(`${baseName}${ext}`);
		if (hits && hits.length === 1) return hits[0];
	}
	return undefined;
}

/** Minimal POSIX-style relative join with `..`/`.` resolution (forward slashes). */
function joinRel(fromDir: string, rel: string): string {
	const parts = fromDir.length > 0 ? fromDir.split("/") : [];
	for (const seg of rel.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") parts.pop();
		else parts.push(seg);
	}
	return parts.join("/");
}

/** Render one file's outline line: `path: kind name:line, kind name:line, …`. */
function renderOutlineLine(entry: RepoMapEntry): string {
	const parts = entry.decls
		? entry.decls.map((d: RepoMapDecl) => `${d.kind} ${d.name}:${d.line}`)
		: // Fallback for name-only (v1 cache / non-enriched deps): bare names.
			entry.symbols.filter((s) => !s.startsWith("(+"));
	if (parts.length === 0) return "";
	return `  ${norm(entry.path)}: ${parts.join(", ")}`;
}

/**
 * Choose an analogous neighbor of `recentReadPath` for the style exemplar:
 * same directory, matching suffix signature (multi-ext / dash-suffix, then plain
 * ext), preferring the closest kind-mix. Deterministic; returns undefined when
 * no plausible neighbor exists.
 */
function selectExemplar(recentReadPath: string, byPath: Map<string, RepoMapEntry>): string | undefined {
	const target = norm(recentReadPath);
	const dir = dirOf(target);
	const base = baseOf(target);
	const sig = suffixSignatures(base);
	const ext = plainExt(base);
	const targetKinds = kindMultiset(byPath.get(target));

	interface Cand {
		path: string;
		tier: number; // lower = better suffix match
		kindOverlap: number; // higher = better
	}
	const cands: Cand[] = [];
	for (const [p, entry] of byPath) {
		if (p === target) continue;
		if (dirOf(p) !== dir) continue;
		const b = baseOf(p);
		let tier: number;
		if (sig.dashSuffix && b.endsWith(sig.dashSuffix)) tier = 0;
		else if (sig.multiExt?.includes(".") && sig.multiExt !== ext && b.endsWith(sig.multiExt)) tier = 1;
		else if (ext && plainExt(b) === ext) tier = 2;
		else continue;
		cands.push({ path: p, tier, kindOverlap: kindOverlapCount(targetKinds, kindMultiset(entry)) });
	}
	if (cands.length === 0) return undefined;
	// Best: lowest tier, then highest kind overlap, then path asc (deterministic).
	cands.sort((a, b) => a.tier - b.tier || b.kindOverlap - a.kindOverlap || a.path.localeCompare(b.path));
	return cands[0]!.path;
}

function kindMultiset(entry: RepoMapEntry | undefined): Map<string, number> {
	const m = new Map<string, number>();
	if (!entry?.decls) return m;
	for (const d of entry.decls) m.set(d.kind, (m.get(d.kind) ?? 0) + 1);
	return m;
}

function kindOverlapCount(a: Map<string, number>, b: Map<string, number>): number {
	let n = 0;
	for (const [k, av] of a) n += Math.min(av, b.get(k) ?? 0);
	return n;
}

/** Head of a file trimmed to a line budget, right-trimmed of trailing blanks. */
function exemplarBody(content: string, maxLines: number): string {
	const lines = content.split(/\r?\n/).slice(0, maxLines);
	while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
	return lines.join("\n");
}

/**
 * Compose the grounded-context block (P1) plus an optional style exemplar (P3),
 * both under the thermostat-dosed token cap. Fail-open: any degenerate input
 * yields an empty block.
 */
export function composeContext(input: ComposeContextInput): ComposeContextResult {
	const empty: ComposeContextResult = { block: "", predicted: [], approxTokens: 0 };
	const env = input.env ?? process.env;
	if (isTruthyEnvFlag(env.PIT_NO_CONTEXT_COMPOSER)) return empty;
	if (input.entries.length === 0) return empty;

	const level = input.level ?? "padrao";
	const charBudget = LEVEL_TOKEN_CAP[level] * CHARS_PER_TOKEN;

	const predicted = predictRelevantFiles(input);
	const byPath = new Map<string, RepoMapEntry>();
	for (const e of input.entries) byPath.set(norm(e.path), e);

	// --- P1: ground-truth outline (greedy under budget) ---
	const header = "<grounded_context>";
	const footer = "</grounded_context>";
	const note = "  (real top-level symbols of the files this task likely touches — verify before editing)";
	const outlineLines: string[] = [];
	let used = header.length + 1 + note.length + 1 + footer.length + 1;
	for (const p of predicted) {
		const entry = byPath.get(p);
		if (!entry) continue;
		const line = renderOutlineLine(entry);
		if (line === "") continue;
		const cost = line.length + 1;
		if (used + cost > charBudget) continue; // skip, try smaller later files
		outlineLines.push(line);
		used += cost;
	}
	const groundedBlock = outlineLines.length > 0 ? `${header}\n${note}\n${outlineLines.join("\n")}\n${footer}` : "";

	// --- P3: style exemplar (only at protected levels, within REMAINING budget) ---
	let exemplarBlock = "";
	let exemplarPath: string | undefined;
	const exemplarAllowed =
		level !== "leve" && !isTruthyEnvFlag(env.PIT_NO_STYLE_EXEMPLAR) && !!input.readFile && !!input.recentReadPath;
	if (exemplarAllowed) {
		const chosen = selectExemplar(input.recentReadPath!, byPath);
		if (chosen) {
			const content = input.readFile!(chosen);
			if (content) {
				const exHeader = "<style_exemplar>";
				const exNote = `  (style reference from ${chosen} — match its naming, comment density and idiom)`;
				const exFooter = "</style_exemplar>";
				const fixed = exHeader.length + 1 + exNote.length + 1 + exFooter.length + 1;
				const remaining = charBudget - used - fixed;
				// Fit as many lines as the remaining budget allows, within 10-30 lines.
				let body = exemplarBody(content, EXEMPLAR_MAX_LINES);
				while (body.length > remaining) {
					const lc = body.split("\n").length;
					if (lc <= EXEMPLAR_MIN_LINES) break;
					body = exemplarBody(content, lc - 1);
				}
				if (body.length <= remaining && body.split("\n").length >= EXEMPLAR_MIN_LINES) {
					exemplarBlock = `${exHeader}\n${exNote}\n${body}\n${exFooter}`;
					exemplarPath = chosen;
					used += exemplarBlock.length + 1;
				}
			}
		}
	}

	const blocks = [groundedBlock, exemplarBlock].filter((b) => b.length > 0);
	if (blocks.length === 0) return { block: "", predicted, approxTokens: 0 };
	const block = blocks.join("\n\n");
	return { block, predicted, exemplarPath, approxTokens: Math.ceil(block.length / CHARS_PER_TOKEN) };
}

/** Opt-out helper (mirrors the other guards' env checks). */
export function isContextComposerDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(env.PIT_NO_CONTEXT_COMPOSER);
}
