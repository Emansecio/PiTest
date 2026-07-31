/**
 * Tool-output pruning and supersede tracking.
 *
 * Head/tail excerpts of oversized tool results, superseded read/mutation
 * detection (incremental scan state), pinned paths, steering-reminder
 * collapse, and the clone helpers that protect the live context.
 * Extracted from compaction.ts (deep-modules decomposition); public surface
 * is re-exported from compaction.ts so existing importers are unaffected.
 */

import { isAbsolute, resolve } from "node:path";
import type { AgentMessage } from "@pit/agent-core";
import { OVERTHINK_STEER_TEXT_MARKER, TTSR_STEER_TEXT_MARKER } from "@pit/agent-core";
import { type DeferredOutputStore, getCurrentDeferredOutputStore } from "../deferred-output-store.ts";
import { lspSupersededResourceKey } from "../lsp/supersede.ts";
import { MUTATING_TOOL_NAMES } from "../stagnation.ts";
import { crushJson } from "../tools/json-crush.ts";
import { canonicalPathKey, FS_CASE_INSENSITIVE } from "../tools/path-utils.ts";
import { estimateTextTokens, pruneToolCallArguments } from "./message-tokens.ts";
import { capThinkingForContext, headTailExcerpt as headTailExcerptShared } from "./utils.ts";

// ============================================================================
// Pre-pruning of old tool outputs
// ============================================================================

/** Token threshold above which old tool outputs are pruned before summarization. */
export const PRUNE_TOKEN_THRESHOLD = 20_000;
/** Number of recent turns (user→assistant pairs) protected from pruning. */
const PRUNE_PROTECT_TURNS = 2;
/** Chars of the head/tail kept when shrinking a large tool output (see headTailExcerpt). */
export const PRUNE_HEAD_CHARS = 1500;
export const PRUNE_TAIL_CHARS = 800;
/** Text shorter than this cannot shrink via head+tail excerpt alone. */
const PRUNE_MIN_SHRINK_CHARS = PRUNE_HEAD_CHARS + PRUNE_TAIL_CHARS + 64;

/**
 * N5, first-user exception. The session's FIRST user message is the task
 * statement, so it never prunes at the normal paste threshold. But an opening
 * message is not automatically a task statement: a 40k-token paste dropped at
 * the top of the session rides EVERY request until compaction. Above this
 * multiple of the normal threshold N5 applies to it too — with a far more
 * generous excerpt, so the statement (head) and any closing instructions (tail)
 * survive verbatim and only the bulk paste in the middle is deferred.
 */
const FIRST_USER_PASTE_THRESHOLD_MULTIPLIER = 3;
const FIRST_USER_PRUNE_HEAD_CHARS = 6_000;
const FIRST_USER_PRUNE_TAIL_CHARS = 3_000;
const FIRST_USER_PRUNE_MIN_SHRINK_CHARS = FIRST_USER_PRUNE_HEAD_CHARS + FIRST_USER_PRUNE_TAIL_CHARS + 64;

/** M11: why a read result was marked superseded — selects the collapse marker. */
export interface SupersededMutationCause {
	/** Path VERBATIM as the model passed it to the write/edit (never the normalized key). */
	path: string;
}

/** Precomputed supersede scan shared across would* / apply* on the same turn. */
export interface ContextPrunePlan {
	protectFromIndex: number;
	supersededIndices: Set<number>;
	/**
	 * M11 write-invalidation causes by superseded index. Entries exist only for
	 * reads collapsed because a later write/edit changed their file; plain
	 * duplicate/N4 supersedes use the default (marker-less) collapse.
	 */
	supersededMutationCauses: Map<number, SupersededMutationCause>;
	/**
	 * P5 `/pin`: message indices immune to prune/supersede/elision because a file
	 * pin makes that file's window evidence load-bearing. Empty (and byte-identical
	 * to the pin-less pipeline) whenever no file is pinned.
	 */
	pinnedIndices: Set<number>;
}

/** Shared empty set so the pin-less path allocates nothing extra per plan. */
const EMPTY_PINNED_PATHS: ReadonlySet<string> = new Set();

/** One O(n) walk producing protect window + supersede index for reuse. */
export function planContextPrune(
	messages: AgentMessage[],
	protectTurns = PRUNE_PROTECT_TURNS,
	pinnedPaths?: ReadonlySet<string>,
): ContextPrunePlan {
	const protectFromIndex = computePruneProtectFromIndex(messages, protectTurns);
	const derivation = buildSupersededToolResultIndices(messages, protectFromIndex);
	const pinnedIndices = computePinnedToolResultIndices(messages, pinnedPaths ?? EMPTY_PINNED_PATHS);
	// A file pin makes its window evidence load-bearing: never supersede-collapse
	// it. deriveSupersededIndices always returns fresh containers, so mutating them
	// here is safe. No-op when nothing is pinned.
	if (pinnedIndices.size > 0) {
		for (const i of pinnedIndices) {
			derivation.indices.delete(i);
			derivation.mutationCauses.delete(i);
		}
	}
	return {
		protectFromIndex,
		supersededIndices: derivation.indices,
		supersededMutationCauses: derivation.mutationCauses,
		pinnedIndices,
	};
}

function resolveContextPrunePlan(
	messages: AgentMessage[],
	protectTurns: number,
	plan: ContextPrunePlan | undefined,
): ContextPrunePlan {
	return plan ?? planContextPrune(messages, protectTurns);
}

/**
 * Split a plan's supersede set by CAUSE (P2-6). `deriveSupersededIndices` mixes
 * three classes under one Set, and they do NOT deserve the same treatment:
 *
 * - **mutation** — M11 write-invalidation: a read the disk now contradicts.
 *   Collapsing it is a CORRECTION (the stale bytes actively mislead the model),
 *   so it must run unconditionally, whatever the cache costs.
 * - **economy** — exact duplicate + N4 (grep covered by a later full read): the
 *   current view is already in context, so the older copy misleads nobody; it
 *   only costs tokens. Collapsing one in the MIDDLE of the history forces the
 *   provider to cold-write the whole cached tail, which routinely costs more
 *   than the few thousand tokens it reclaims (see prune-economics.ts).
 *
 * Both returned plans share `protectFromIndex`/`pinnedIndices` and carry a
 * disjoint partition of `supersededIndices`, so a caller can weigh the economy
 * half against cache economics while still applying the correction half. The
 * cause map is shared as-is: it only has entries for mutation indices, so an
 * economy-plan lookup misses exactly as it would on a freshly built map.
 */
export function splitSupersedePlanByCause(plan: ContextPrunePlan): {
	mutation: ContextPrunePlan;
	economy: ContextPrunePlan;
} {
	const mutationIndices = new Set<number>();
	const economyIndices = new Set<number>();
	for (const i of plan.supersededIndices) {
		if (plan.supersededMutationCauses.has(i)) mutationIndices.add(i);
		else economyIndices.add(i);
	}
	return {
		mutation: { ...plan, supersededIndices: mutationIndices },
		economy: { ...plan, supersededIndices: economyIndices },
	};
}

function wouldShrinkViaHeadTail(text: string): boolean {
	if (text.length <= PRUNE_MIN_SHRINK_CHARS) return false;
	const excerpt = headTailExcerpt(text);
	return excerpt.length < text.length;
}

/** Floor the adaptive per-output prune threshold approaches as the window fills. */
const ADAPTIVE_PRUNE_MIN_THRESHOLD = 4_000;
/** Occupancy at which the per-output threshold starts tightening below PRUNE_TOKEN_THRESHOLD. */
const ADAPTIVE_PRUNE_START_OCCUPANCY = 0.5;
/** Occupancy at/above which the threshold reaches ADAPTIVE_PRUNE_MIN_THRESHOLD. */
const ADAPTIVE_PRUNE_FULL_OCCUPANCY = 0.9;
const PRESSURE_PRUNE_SMALL_WINDOW = 200_000;
const PRESSURE_PRUNE_ONE_TURN_OCCUPANCY = 0.65;
const PRESSURE_PRUNE_CURRENT_TURN_OCCUPANCY = 0.8;
const PRESSURE_PRUNE_LARGE_WINDOW_OCCUPANCY = 0.9;

/**
 * Number of recent turns protected from live-context pruning under pressure.
 * Small-window models (DeepSeek/OpenRouter/GPT chat class) have little room for a
 * two-turn grace period once they pass ~65%; above ~80%, huge current-turn tool
 * outputs are still recoverable via recall_tool_output, so they can be excerpted.
 */
export function pressurePruneProtectTurns(contextTokens: number, contextWindow: number): number {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return PRUNE_PROTECT_TURNS;
	const occupancy = contextTokens / contextWindow;
	if (contextWindow <= PRESSURE_PRUNE_SMALL_WINDOW) {
		if (occupancy >= PRESSURE_PRUNE_CURRENT_TURN_OCCUPANCY) return 0;
		if (occupancy >= PRESSURE_PRUNE_ONE_TURN_OCCUPANCY) return 1;
		return PRUNE_PROTECT_TURNS;
	}
	return occupancy >= PRESSURE_PRUNE_LARGE_WINDOW_OCCUPANCY ? 1 : PRUNE_PROTECT_TURNS;
}

/**
 * Per-output prune threshold that tightens as the context window fills.
 *
 * The flat PRUNE_TOKEN_THRESHOLD (20k) is evaluated per output block, but read
 * caps at ~15k tokens and bash at ~7k — so a *medium* tool output never crosses
 * it on its own. A long session that accumulates dozens of medium reads/greps
 * ("death by a thousand cuts") therefore reclaims nothing even as the window
 * approaches full. This scales the threshold DOWN from 20k toward 4k between 50%
 * and 90% occupancy, so medium outputs become prunable exactly when there is real
 * pressure. At or below 50% occupancy it returns the flat 20k (byte-identical to
 * the previous behaviour — no early over-pruning, no extra cache churn). The
 * excerpt still keeps each output's head+tail shape and the on-disk file remains
 * the source of truth, so this only ever upgrades a reclaim that respects the
 * existing prune contract.
 */
export function adaptivePruneThreshold(contextTokens: number, contextWindow: number): number {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) return PRUNE_TOKEN_THRESHOLD;
	const occupancy = contextTokens / contextWindow;
	if (occupancy <= ADAPTIVE_PRUNE_START_OCCUPANCY) return PRUNE_TOKEN_THRESHOLD;
	if (occupancy >= ADAPTIVE_PRUNE_FULL_OCCUPANCY) return ADAPTIVE_PRUNE_MIN_THRESHOLD;
	const span = ADAPTIVE_PRUNE_FULL_OCCUPANCY - ADAPTIVE_PRUNE_START_OCCUPANCY;
	const t = (occupancy - ADAPTIVE_PRUNE_START_OCCUPANCY) / span;
	return Math.round(PRUNE_TOKEN_THRESHOLD - t * (PRUNE_TOKEN_THRESHOLD - ADAPTIVE_PRUNE_MIN_THRESHOLD));
}

/**
 * Shrink a large tool output to its head + tail, eliding the middle. Keeps the
 * output's *shape* for the summarizer — first/last grep matches, a file's header
 * + footer, an error message + the tail of its stack — instead of a bare
 * "[pruned]" marker that tells the summarizer nothing. Cuts snap to line breaks
 * so excerpts stay readable.
 */
export function headTailExcerpt(text: string): string {
	return headTailExcerptShared(text, {
		headBudget: PRUNE_HEAD_CHARS,
		tailBudget: PRUNE_TAIL_CHARS,
		snapWindow: 400,
		// Prefer a structural crush when the output is JSON/NDJSON: it keeps the
		// schema + head/tail samples + omitted counts at far fewer tokens than a
		// blind byte cut. Returns undefined (→ head+tail fallback) when not
		// applicable (not JSON, or won't fit even when fully collapsed).
		crush: (t) => crushJson(t, { targetChars: PRUNE_HEAD_CHARS + PRUNE_TAIL_CHARS }),
		marker: (_elidedChars, middle) => `[… ~${estimateTextTokens(middle, true)} tokens elided …]`,
	});
}

/**
 * N5 excerpt for the FIRST user message — same shape, ~4× the head/tail budget.
 * The opening message mixes the task statement with the paste, so the cut must
 * be generous enough that the statement itself is never the thing elided. No
 * JSON crush here: crushJson targets the small tool-output budget and would
 * defeat the point of the generous excerpt, and a user paste is a prose/code mix
 * (prose token divisor, matching {@link deferredUserPasteReplacement}).
 */
function firstUserHeadTailExcerpt(text: string): string {
	return headTailExcerptShared(text, {
		headBudget: FIRST_USER_PRUNE_HEAD_CHARS,
		tailBudget: FIRST_USER_PRUNE_TAIL_CHARS,
		snapWindow: 400,
		marker: (_elidedChars, middle) => `[… ~${estimateTextTokens(middle)} tokens elided …]`,
	});
}

/**
 * Prune large tool result content from old messages before sending to the
 * summarizer. This reduces the input to the summarization LLM and produces
 * more focused summaries.
 *
 * Only tool results older than the last `protectTurns` user messages are
 * eligible. Tool results above `tokenThreshold` (estimated) are shrunk to a
 * head+tail excerpt (so the reader still sees the output's shape). When `defer`
 * is set (the live-context prune) AND a deferred-output store is open, the full
 * text is ALSO persisted to disk and a `recall_tool_output` id is appended to the
 * excerpt — a hybrid that keeps the shape inline while leaving the elided middle
 * recoverable in full. Compaction-prep callers pass `defer=false` (the summarizer
 * discards these messages, so a recall id would dangle).
 *
 * Mutates the passed messages and their text blocks in place. `getMessageFromEntry`
 * returns `entry.message` BY REFERENCE for `type === "message"` entries (the same
 * object the live session context holds), so callers that prune before a fallible
 * summarization (e.g. compact()) MUST pass cloned toolResult messages — see
 * `cloneToolResultMessagesForPrune` — otherwise an aborted compaction leaves the
 * live context with elided tool results and no restore path.
 */
// Memoize the (stringify + token-estimate) of a mutation tool-call's arguments by
// reference. The same large write/edit body is re-checked every turn above the 64k
// floor; the cost number only changes when `block.arguments` is reassigned (which
// yields a fresh reference on prune), so a WeakMap keyed by the object naturally
// recomputes exactly once for the new (small) value.
const beforeTokensCache = new WeakMap<object, number>();

// Memoize the dense-token estimate of a toolResult text block BY BLOCK OBJECT.
// The would*/apply scans above the prune floor re-estimate the same old blocks
// every turn — an O(chars of history) scan per turn without this. Block text
// only changes via the in-place rewrites in pruneOldToolOutputs and
// applySupersedeOnly, and BOTH update the entry with the post-rewrite estimate,
// so a mutated block never serves a stale value. Cloned blocks (fresh objects
// from cloneToolResultMessagesForPrune) simply miss and recompute.
const denseTextTokensCache = new WeakMap<object, number>();

function cachedDenseTextTokens(block: object, text: string): number {
	const cached = denseTextTokensCache.get(block);
	if (cached !== undefined) return cached;
	const est = estimateTextTokens(text, true);
	denseTextTokensCache.set(block, est);
	return est;
}

const SUPERSEDED_TOOL_RESULT_NAMES = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"symbol",
	"find_symbol",
	"lsp",
	"bash",
	"ast_grep",
	"repo_map",
]);

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.keys(value as Record<string, unknown>)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

/**
 * Pure normalization for path identity inside the supersede machine (M10).
 *
 * `foo.ts`, `./foo.ts`, `C:\repo\foo.ts` and `C:/REPO/FOO.TS` (Windows) must
 * hash to ONE resource key, or duplicate reads slip past the dedup and write-
 * invalidation misses its target. Absolutize via node:path.resolve, unify
 * separators, and casefold on case-insensitive filesystems (win32/darwin, via
 * the shared FS_CASE_INSENSITIVE flag). This is the PURE subset of
 * `canonicalPathKey` (../tools/path-utils.ts): that helper additionally
 * resolves symlinks through realpathSync.native — filesystem I/O this
 * per-tool-call scan must not pay — so symlink aliases are deliberately NOT
 * collapsed here. KEY ONLY: never surface this in a marker or tool arg.
 */
function normalizedPathKey(path: string): string {
	const unified = resolve(path).split("\\").join("/");
	return FS_CASE_INSENSITIVE ? unified.toLowerCase() : unified;
}

/** First string path-like argument (same aliases the read key accepted historically), or undefined. */
function pathArgOf(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const a = args as Record<string, unknown>;
	for (const key of ["path", "file", "file_path", "filename"]) {
		const v = a[key];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

const READ_KEY_PREFIX = "read\u0000";

/** Normalized path component of a read resource key (see supersededResourceKey). */
function readKeyPath(key: string): string {
	return key.split("\u0000")[1] ?? "";
}

/**
 * Resource key for a tool call whose later identical result supersedes the old
 * copy. `read` keys on the NORMALIZED path (M10) + range, so spelling variants
 * (relative/absolute, slash direction, case on Windows) collapse to one
 * resource; other deterministic navigation/search tools use a sorted argument
 * fingerprint.
 */
function supersededResourceKey(toolName: string, args: unknown): string | undefined {
	if (!SUPERSEDED_TOOL_RESULT_NAMES.has(toolName)) return undefined;
	if (toolName === "lsp") return lspSupersededResourceKey(args);
	if (toolName !== "read") return `${toolName}\u0000${stableStringify(args)}`;
	const path = pathArgOf(args);
	if (!path) return undefined;
	const a = args as Record<string, unknown>;
	const offset = typeof a.offset === "number" ? a.offset : "";
	const limit = typeof a.limit === "number" ? a.limit : "";
	return `${READ_KEY_PREFIX}${normalizedPathKey(path)}\u0000${offset}\u0000${limit}`;
}

/**
 * Incremental supersede-scan state, keyed by the message ARRAY reference. The
 * live-prune hook plans over `agent.state.messages` after every successful tool
 * call; that array's reference is stable across a turn (the agent appends via
 * `push`; the state setter only swaps the reference on reassignment, which is a
 * rare prune/compaction event). Rebuilding the maps from scratch each call made
 * the per-tool-call cost O(session) → O(session²) over a long session. Caching
 * the scan and extending it over just the appended suffix makes it O(new
 * messages) per call, with a full rebuild only on reference change.
 *
 * Staleness safety: prune mutations (pruneOldToolOutputs / applySupersedeOnly /
 * elideMutatingToolCallArguments) operate on CLONED arrays that are then
 * reassigned — the cached array is never mutated in place. And even if it were,
 * they rewrite toolResult `block.text` and elide only LONG string values inside
 * MUTATING tool-call `arguments` (write/edit) — short strings like the `path`
 * the M11 index reads always survive elision — so neither rewrite changes what
 * `supersededResourceKey`/`pathArgOf` derive. Same invariant family as
 * `beforeTokensCache`.
 */
interface SupersedeScanState {
	/** Messages [0, scannedLength) have been ingested into the maps below. */
	scannedLength: number;
	/**
	 * toolCall id -> resource key. Calls of superseded-eligible tools whose key
	 * is underivable (e.g. read without a path) store "" so their results are
	 * skipped permanently instead of retried forever via `unkeyedResults`.
	 */
	keyByCallId: Map<string, string>;
	keyByIndex: Map<number, string>;
	lastIndexByKey: Map<string, number>;
	/** Newest ERROR result index per key — protected from supersede collapse. */
	lastErrorIndexByKey: Map<string, number>;
	/** Results whose toolCall was not yet seen — retried on each extension. */
	unkeyedResults: Array<{ index: number; toolCallId: string; isError: boolean }>;
	/**
	 * M11: mutating (write/edit/…) call id -> call index + normalized path.
	 * Calls whose args carry no derivable path store pathKey "" so their results
	 * are skipped permanently (mirrors the keyByCallId "" sentinel).
	 */
	mutationCallById: Map<string, { callIndex: number; pathKey: string; displayPath: string }>;
	/** M11: normalized path -> newest SUCCESSFUL mutation (verbatim path kept for the marker). */
	lastMutationByPathKey: Map<string, { index: number; displayPath: string }>;
	/** M11: successful mutation results whose call was not yet seen — retried like unkeyedResults. */
	pendingMutationResults: Array<{ toolCallId: string }>;
	/** N4: grep call id -> normalized `path` arg (single-file-scope candidate). */
	grepPathKeyByCallId: Map<string, string>;
	/** N4: grep result index -> normalized `path` arg of its call. */
	grepPathKeyByIndex: Map<number, string>;
	/** N4: normalized path -> newest successful FULL (no offset/limit) read result index. */
	lastFullReadIndexByPathKey: Map<string, number>;
}

const supersedeScanCache = new WeakMap<AgentMessage[], SupersedeScanState>();

function createSupersedeScanState(): SupersedeScanState {
	return {
		scannedLength: 0,
		keyByCallId: new Map(),
		keyByIndex: new Map(),
		lastIndexByKey: new Map(),
		lastErrorIndexByKey: new Map(),
		unkeyedResults: [],
		mutationCallById: new Map(),
		lastMutationByPathKey: new Map(),
		pendingMutationResults: [],
		grepPathKeyByCallId: new Map(),
		grepPathKeyByIndex: new Map(),
		lastFullReadIndexByPathKey: new Map(),
	};
}

/** NUL separator of resource keys, derived from the prefix to avoid re-typing the escape. */
const KEY_SEP = READ_KEY_PREFIX.slice("read".length);

/** Deep-copy a scan state: map/array containers are copied, value objects are
 * shared (they are replaced, never mutated, by the scan — see
 * `recordSuccessfulMutation` / `extendSupersedeScanState` step 3/3b). */
function cloneSupersedeScanState(state: SupersedeScanState): SupersedeScanState {
	return {
		scannedLength: state.scannedLength,
		keyByCallId: new Map(state.keyByCallId),
		keyByIndex: new Map(state.keyByIndex),
		lastIndexByKey: new Map(state.lastIndexByKey),
		lastErrorIndexByKey: new Map(state.lastErrorIndexByKey),
		unkeyedResults: state.unkeyedResults.slice(),
		mutationCallById: new Map(state.mutationCallById),
		lastMutationByPathKey: new Map(state.lastMutationByPathKey),
		pendingMutationResults: state.pendingMutationResults.slice(),
		grepPathKeyByCallId: new Map(state.grepPathKeyByCallId),
		grepPathKeyByIndex: new Map(state.grepPathKeyByIndex),
		lastFullReadIndexByPathKey: new Map(state.lastFullReadIndexByPathKey),
	};
}

/** Cheap structural identity check for the adopt guard: clones produced by the
 * prune/slice paths are `{ ...msg }` copies, so role + numeric timestamp
 * survive; a false negative merely skips the adopt (full rescan fallback). */
function sameMessageIdentity(a: AgentMessage | undefined, b: AgentMessage | undefined): boolean {
	if (a === undefined || b === undefined) return false;
	if (a === b) return true;
	if (a.role !== b.role) return false;
	const ta = (a as { timestamp?: unknown }).timestamp;
	const tb = (b as { timestamp?: unknown }).timestamp;
	return typeof ta === "number" && ta === tb;
}

/**
 * Re-key the incremental supersede-scan cache from `source` onto `derived`.
 *
 * The send path (agent-loop) and the prune/clone paths produce FRESH arrays
 * every turn, so the WeakMap keyed on array identity never hit there and every
 * turn paid a full O(session) rescan. When `derived` is a slice/clone of
 * `source` (same messages, possibly with appended suffix), the scan state is
 * position-and-content derived — indexes, toolCall ids, and resource keys are
 * identical — so it can be copied instead of rebuilt.
 *
 * Guarded: adopts only when the scanned prefix provably corresponds (length +
 * endpoint identity checks). On any mismatch it silently does nothing and the
 * next scan falls back to today's full rebuild — never incorrect, only slower.
 */
export function adoptSupersedeScanState(source: AgentMessage[], derived: AgentMessage[]): void {
	if (source === derived || supersedeScanCache.has(derived)) return;
	const state = supersedeScanCache.get(source);
	if (!state || state.scannedLength === 0 || state.scannedLength > derived.length) return;
	const last = state.scannedLength - 1;
	if (!sameMessageIdentity(source[0], derived[0]) || !sameMessageIdentity(source[last], derived[last])) return;
	supersedeScanCache.set(derived, cloneSupersedeScanState(state));
}

/** True for a read key with neither offset nor limit — the FULL current file content (N4). */
function isFullReadKey(key: string): boolean {
	if (!key.startsWith(READ_KEY_PREFIX)) return false;
	const parts = key.split(KEY_SEP); // ["read", pathKey, offset, limit]
	return parts[2] === "" && parts[3] === "";
}

function recordKeyedResult(state: SupersedeScanState, index: number, key: string, isError: boolean): void {
	state.keyByIndex.set(index, key);
	const prev = state.lastIndexByKey.get(key);
	if (prev === undefined || index > prev) state.lastIndexByKey.set(key, index);
	if (isError) {
		const prevError = state.lastErrorIndexByKey.get(key);
		if (prevError === undefined || index > prevError) state.lastErrorIndexByKey.set(key, index);
	} else if (isFullReadKey(key)) {
		// N4: a successful FULL read both proves the path is a file (reading a
		// directory errors) and carries its complete current content — older greps
		// scoped to exactly this file are covered by it.
		const pathKey = readKeyPath(key);
		const prevRead = state.lastFullReadIndexByPathKey.get(pathKey);
		if (prevRead === undefined || index > prevRead) state.lastFullReadIndexByPathKey.set(pathKey, index);
	}
}

/** M11: fold a SUCCESSFUL mutation call into the per-path invalidation index. */
function recordSuccessfulMutation(
	state: SupersedeScanState,
	call: { callIndex: number; pathKey: string; displayPath: string },
): void {
	if (call.pathKey === "") return; // no derivable path — nothing to invalidate
	const prev = state.lastMutationByPathKey.get(call.pathKey);
	if (prev === undefined || call.callIndex > prev.index) {
		state.lastMutationByPathKey.set(call.pathKey, { index: call.callIndex, displayPath: call.displayPath });
	}
}

/** Ingest messages[state.scannedLength ..] into the scan maps (one suffix pass). */
function extendSupersedeScanState(state: SupersedeScanState, messages: AgentMessage[]): void {
	// (1) Tool calls in the suffix — must land before the suffix's results are
	// resolved, mirroring the full algorithm's call-pass-then-result-pass order.
	for (let i = state.scannedLength; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block.type !== "toolCall") continue;
			const key = supersededResourceKey(block.name, block.arguments);
			if (key) state.keyByCallId.set(block.id, key);
			else if (SUPERSEDED_TOOL_RESULT_NAMES.has(block.name)) state.keyByCallId.set(block.id, "");
			// N4: remember each grep's path arg — if that exact path is later read
			// in FULL, the read covers (and refreshes) the grep's matches.
			if (block.name === "grep") {
				const grepPath = pathArgOf(block.arguments);
				if (grepPath !== undefined) state.grepPathKeyByCallId.set(block.id, normalizedPathKey(grepPath));
			}
			// M11: index mutating calls by path; activation waits for the SUCCESS
			// result (a rejected write never invalidates — the disk did not change).
			if (MUTATING_TOOL_NAMES.has(block.name)) {
				const mutPath = pathArgOf(block.arguments);
				state.mutationCallById.set(block.id, {
					callIndex: i,
					pathKey: mutPath !== undefined ? normalizedPathKey(mutPath) : "",
					displayPath: mutPath ?? "",
				});
			}
		}
	}
	// (2) Tool results in the suffix.
	for (let i = state.scannedLength; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "toolResult") continue;
		// M11: a successful mutation result activates write-invalidation for its path.
		if (MUTATING_TOOL_NAMES.has(msg.toolName ?? "") && msg.isError !== true) {
			const call = state.mutationCallById.get(msg.toolCallId);
			if (call === undefined) state.pendingMutationResults.push({ toolCallId: msg.toolCallId });
			else recordSuccessfulMutation(state, call);
			continue;
		}
		if (!SUPERSEDED_TOOL_RESULT_NAMES.has(msg.toolName ?? "")) continue;
		const key = state.keyByCallId.get(msg.toolCallId);
		if (key === undefined) {
			state.unkeyedResults.push({ index: i, toolCallId: msg.toolCallId, isError: msg.isError === true });
			continue;
		}
		if (key === "") continue; // known keyless call — never supersedes
		recordKeyedResult(state, i, key, msg.isError === true);
		const grepScope = state.grepPathKeyByCallId.get(msg.toolCallId);
		if (grepScope !== undefined) state.grepPathKeyByIndex.set(i, grepScope);
	}
	// (3) Retry results whose call may have arrived in this (or any later)
	// suffix. Keeps exact equivalence with the two full passes even when a
	// result precedes its call in the array.
	if (state.unkeyedResults.length > 0) {
		const stillUnkeyed: SupersedeScanState["unkeyedResults"] = [];
		for (const entry of state.unkeyedResults) {
			const key = state.keyByCallId.get(entry.toolCallId);
			if (key === undefined) stillUnkeyed.push(entry);
			else if (key !== "") {
				recordKeyedResult(state, entry.index, key, entry.isError);
				const grepScope = state.grepPathKeyByCallId.get(entry.toolCallId);
				if (grepScope !== undefined) state.grepPathKeyByIndex.set(entry.index, grepScope);
			}
		}
		state.unkeyedResults = stillUnkeyed;
	}
	// (3b) Same retry for successful mutation results that preceded their call.
	if (state.pendingMutationResults.length > 0) {
		const stillPending: SupersedeScanState["pendingMutationResults"] = [];
		for (const entry of state.pendingMutationResults) {
			const call = state.mutationCallById.get(entry.toolCallId);
			if (call === undefined) stillPending.push(entry);
			else recordSuccessfulMutation(state, call);
		}
		state.pendingMutationResults = stillPending;
	}
	state.scannedLength = messages.length;
}

/** Result of the supersede derivation: which indices collapse, and why (when it matters). */
interface SupersededDerivation {
	indices: Set<number>;
	/** M11 write-invalidation entries only; duplicate/N4 supersedes carry no cause. */
	mutationCauses: Map<number, SupersededMutationCause>;
}

/**
 * Derivation over the scan state — recomputed on EVERY call (protectFromIndex
 * varies per call, so the final Set must never be cached). Duplicate filter
 * identical to the previous full algorithm, extended with M11 (a later
 * successful write/edit of a read's file invalidates the read even without a
 * re-read) and N4 (a later FULL read of file P covers older greps scoped to
 * exactly P). Always returns fresh containers.
 */
function deriveSupersededIndices(state: SupersedeScanState, protectFromIndex: number): SupersededDerivation {
	const superseded = new Set<number>();
	const mutationCauses = new Map<number, SupersededMutationCause>();
	for (const [i, key] of state.keyByIndex) {
		if (i >= protectFromIndex) continue;
		// Never collapse the NEWEST error result for a resource. A later retry —
		// or a later mutation/full read (M11/N4) — supersedes the stale content,
		// but the error itself (why the previous attempt failed) is often the most
		// valuable context in the transcript. Older errors still collapse.
		if (state.lastErrorIndexByKey.get(key) === i) continue;
		const last = state.lastIndexByKey.get(key);
		if (last !== undefined && last > i) {
			superseded.add(i);
			continue;
		}
		// M11: a read whose file was successfully written/edited AFTER this result
		// contradicts the disk — the most dangerous class of stale context. Any
		// range of the file is invalidated (the mutation may have moved lines).
		if (key.startsWith(READ_KEY_PREFIX)) {
			const mutation = state.lastMutationByPathKey.get(readKeyPath(key));
			if (mutation !== undefined && mutation.index > i) {
				superseded.add(i);
				mutationCauses.set(i, { path: mutation.displayPath });
				continue;
			}
		}
		// N4: single-file grep covered by a later successful FULL read of the same
		// file. Directory/multi-file greps never match: a path only enters the
		// full-read map when a read of it succeeded, which fails for directories.
		const grepScope = state.grepPathKeyByIndex.get(i);
		if (grepScope !== undefined) {
			const fullRead = state.lastFullReadIndexByPathKey.get(grepScope);
			if (fullRead !== undefined && fullRead > i) superseded.add(i);
		}
	}
	return { indices: superseded, mutationCauses };
}

/**
 * Indices (in the prunable region, i.e. `< protectFromIndex`) of deterministic
 * tool results that a later identical call supersedes. The newer result carries
 * the current view, so the older copy is a stale duplicate safe to collapse to
 * head+tail even when it is below the size threshold. The newest result (and any
 * result inside the protected recent turns) is never marked.
 *
 * The scan is incremental per array reference (see {@link SupersedeScanState}):
 * a cache hit only ingests the appended suffix; a new/shrunk array rebuilds.
 */
function buildSupersededToolResultIndices(messages: AgentMessage[], protectFromIndex: number): SupersededDerivation {
	let state = supersedeScanCache.get(messages);
	if (!state || messages.length < state.scannedLength) {
		state = createSupersedeScanState();
		supersedeScanCache.set(messages, state);
	}
	if (messages.length > state.scannedLength) {
		extendSupersedeScanState(state, messages);
	}
	return deriveSupersededIndices(state, protectFromIndex);
}

function computePruneProtectFromIndex(messages: AgentMessage[], protectTurns: number): number {
	let userCount = 0;
	let protectFromIndex = protectTurns <= 0 ? messages.length : 0;
	if (protectTurns > 0) {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				userCount++;
				if (userCount >= protectTurns) {
					protectFromIndex = i;
					break;
				}
			}
		}
	}
	return protectFromIndex;
}

/**
 * File-pin (P5) path-bearing tools. Their tool-result (or, for mutations, the
 * assistant call) is protected when the target path is pinned — the same
 * `path`/`file`/`file_path` arg the supersede scan reads (see {@link pathArgOf}).
 */
const PINNABLE_TOOL_NAMES = new Set(["read", "grep", "find", "write", "edit", "edit_v2", "ast_edit"]);

/**
 * Canonical key for a verbatim tool-call path arg, matching the key a pin stores.
 * Uses the shared `canonicalPathKey` on BOTH the pin set and this side, so
 * spelling variants (relative/absolute, slash direction, case, symlinks) agree.
 * Relative paths resolve against `process.cwd()`, mirroring the supersede scan.
 */
function canonicalPinnedPathKey(pathArg: string): string {
	return canonicalPathKey(isAbsolute(pathArg) ? pathArg : resolve(pathArg));
}

/**
 * Message indices a FILE pin protects from prune/supersede/elision: the
 * tool-result of any pinnable call over a pinned path, PLUS the assistant message
 * that issued a MUTATING call to a pinned path (whose heavy body lives in the
 * args, not the result, so it must survive mutation-arg elision). Returns an
 * empty set — and the early return keeps the O(messages) walk off the hot path —
 * whenever nothing is pinned, so the prune pipeline stays byte-identical.
 */
function computePinnedToolResultIndices(messages: AgentMessage[], pinnedPaths: ReadonlySet<string>): Set<number> {
	const pinned = new Set<number>();
	if (pinnedPaths.size === 0) return pinned;
	const pinnedCallIds = new Set<string>();
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			let protectMessage = false;
			for (const block of msg.content) {
				if (block.type !== "toolCall" || !PINNABLE_TOOL_NAMES.has(block.name)) continue;
				const p = pathArgOf(block.arguments);
				if (p === undefined || !pinnedPaths.has(canonicalPinnedPathKey(p))) continue;
				pinnedCallIds.add(block.id);
				// A mutating call carries its heavy body in the ARGS, not the result —
				// protect the assistant message so arg-elision skips it.
				if (MUTATING_TOOL_NAMES.has(block.name)) protectMessage = true;
			}
			if (protectMessage) pinned.add(i);
		} else if (msg.role === "toolResult" && pinnedCallIds.has(msg.toolCallId)) {
			pinned.add(i);
		}
	}
	return pinned;
}

/**
 * toolCallId -> isError over the toolResults in `messages`, so mutation-arg
 * elision can pick the honest marker (a rejected write must not be labeled
 * "applied to disk"). Calls with no result present map to absent (treated as
 * not-failed — the optimistic marker, matching the pre-index behaviour).
 */
function buildToolCallErrorIndex(messages: AgentMessage[]): Map<string, boolean> {
	const errorByCallId = new Map<string, boolean>();
	for (const msg of messages) {
		if (msg.role === "toolResult") errorByCallId.set(msg.toolCallId, msg.isError === true);
	}
	return errorByCallId;
}

/** Read-only pre-check: would pruneOldToolOutputs reclaim anything? */
export function wouldPruneOldToolOutputs(
	messages: AgentMessage[],
	tokenThreshold = PRUNE_TOKEN_THRESHOLD,
	protectTurns = PRUNE_PROTECT_TURNS,
	plan?: ContextPrunePlan,
): boolean {
	const {
		protectFromIndex,
		supersededIndices: supersededReadIndices,
		pinnedIndices,
	} = resolveContextPrunePlan(messages, protectTurns, plan);
	// N5 parity: user pastes only prune when a store is open (defer mandatory), so
	// with no store they never make this pre-check fire. Resolved once per call.
	const userPasteStore = getCurrentDeferredOutputStore();
	const firstUserIndex = userPasteStore !== undefined ? firstUserMessageIndex(messages) : -1;
	for (let i = 0; i < protectFromIndex; i++) {
		if (pinnedIndices.has(i)) continue; // P5: file pin — never prune this index
		const msg = messages[i];
		if (msg.role === "user") {
			// First user message: only the 3× profile can fire (and only with a store —
			// `firstUserIndex` is -1 without one, so this branch is unreachable then).
			if (i === firstUserIndex) {
				if (wouldPruneUserPasteBlocks(msg, firstUserPasteProfile(tokenThreshold))) return true;
				continue;
			}
			// N8: a collapsible consumed steering reminder makes the prune worth running,
			// independent of the deferred-output store (no defer needed — see above).
			if (hasConsumedSteeringReminder(msg)) return true;
			if (userPasteStore === undefined) continue;
			if (wouldPruneUserPasteBlocks(msg, userPasteProfile(tokenThreshold))) return true;
			continue;
		}
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const block of msg.content) {
				if (block.type !== "toolCall" || !MUTATING_TOOL_NAMES.has(block.name)) continue;
				const argsRef =
					typeof block.arguments === "object" && block.arguments !== null ? block.arguments : undefined;
				let before = argsRef ? beforeTokensCache.get(argsRef) : undefined;
				if (before === undefined) {
					before = estimateTextTokens(JSON.stringify(block.arguments), true);
					// Populate the cache on the read-only path too — this check runs every
					// turn, and the stringify cost repeats until an apply happens otherwise.
					if (argsRef) beforeTokensCache.set(argsRef, before);
				}
				if (before > tokenThreshold && pruneToolCallArguments(block.arguments)) return true;
			}
			continue;
		}
		if (msg.role !== "toolResult" || !Array.isArray(msg.content)) continue;
		const superseded = supersededReadIndices.has(i);
		for (const block of msg.content) {
			if (block.type !== "text" || !block.text) continue;
			const est = cachedDenseTextTokens(block, block.text);
			if (est > tokenThreshold) return true;
			if (superseded && wouldShrinkViaHeadTail(block.text)) return true;
		}
	}
	return false;
}

/**
 * Generic form of the recall placeholder appended to a deferred output's inline
 * excerpt. The `recall_tool_output` tool description quotes this EXACT text so
 * the model can correlate the placeholder it sees in context with the tool that
 * resolves it — keep both in sync (enforced by a consistency test).
 */
export const DEFERRED_OUTPUT_PLACEHOLDER_FORMAT =
	'[Full output (~N tokens) deferred — recall_tool_output({ id: "dN" }) returns it in full.]';

/** Concrete recall placeholder for a deferred output (see the FORMAT constant). */
export function formatDeferredOutputPlaceholder(tokens: number, id: string): string {
	return `[Full output (~${tokens} tokens) deferred — recall_tool_output({ id: "${id}" }) returns it in full.]`;
}

/** M11 collapse marker: names the mutated file so the model knows WHY the read is stale. */
function formatMutationSupersededMarker(path: string): string {
	return `[superseded: ${path} was modified by a later write/edit — re-read for current content]`;
}

/**
 * Collapse one superseded toolResult text block to its head+tail excerpt.
 *
 * - M13: `bash` output is non-deterministic — unlike read/grep/ls it is NOT
 *   reproducible by re-running, so a plain collapse is real information loss.
 *   When a store is open the FULL text is deferred and the canonical recall
 *   placeholder rides on the excerpt (~20 tokens); a store failure degrades to
 *   the plain collapse and never aborts the prune.
 * - M11: mutation-invalidated reads append a cause marker naming the mutated
 *   path (verbatim as the model wrote it), telling the reader to re-read.
 *
 * Returns reclaimed tokens; 0 when the excerpt would not shrink the block (the
 * marker/placeholder are never worth ADDING tokens to an already-small block).
 */
function collapseSupersededTextBlock(
	block: { text: string },
	toolName: string | undefined,
	mutationCause: SupersededMutationCause | undefined,
	store: DeferredOutputStore | undefined,
): number {
	const est = cachedDenseTextTokens(block, block.text);
	const excerpt = headTailExcerpt(block.text);
	if (excerpt.length >= block.text.length) return 0;
	let replacement = excerpt;
	if (toolName === "bash" && store !== undefined) {
		try {
			replacement += `\n${formatDeferredOutputPlaceholder(est, store.put(block.text))}`;
		} catch {
			// Deferred-store failure — keep the plain excerpt.
		}
	}
	if (mutationCause !== undefined) {
		replacement += `\n${formatMutationSupersededMarker(mutationCause.path)}`;
	}
	block.text = replacement;
	const after = estimateTextTokens(replacement, true);
	denseTextTokensCache.set(block, after);
	return Math.max(0, est - after);
}

/** Index of the session's FIRST user message (the task statement) — see {@link firstUserPasteProfile}. */
function firstUserMessageIndex(messages: AgentMessage[]): number {
	for (let i = 0; i < messages.length; i++) {
		if (messages[i].role === "user") return i;
	}
	return -1;
}

/**
 * N5 knobs. The first user message prunes at a much higher bar with a much
 * larger excerpt than every other user message; everything else about the pass
 * (defer-mandatory, in-place rewrite, reclaim accounting) is identical, so the
 * two only differ by this profile.
 */
interface UserPasteProfile {
	/** Estimated tokens a single text must exceed to be shrunk. */
	tokenThreshold: number;
	/** Below this length the excerpt cannot shrink the text — cheap pre-filter. */
	minShrinkChars: number;
	excerpt: (text: string) => string;
}

/** N5 profile for ordinary (non-first) old user messages. */
function userPasteProfile(tokenThreshold: number): UserPasteProfile {
	return { tokenThreshold, minShrinkChars: PRUNE_MIN_SHRINK_CHARS, excerpt: headTailExcerpt };
}

/**
 * N5 profile for the session's FIRST user message: 3× the threshold and the
 * generous excerpt. Below that bar the opening message is left fully intact —
 * it is the task statement, and the whole point of the exception is that it
 * survives the session verbatim.
 */
function firstUserPasteProfile(tokenThreshold: number): UserPasteProfile {
	return {
		tokenThreshold: tokenThreshold * FIRST_USER_PASTE_THRESHOLD_MULTIPLIER,
		minShrinkChars: FIRST_USER_PRUNE_MIN_SHRINK_CHARS,
		excerpt: firstUserHeadTailExcerpt,
	};
}

/**
 * N5 — defer one oversized user text (pasted log/stack) to the store and return
 * the head+tail excerpt + recall placeholder. Returns undefined when the text is
 * below threshold, cannot shrink, or the store put failed: user input has NO
 * on-disk source of truth to re-derive it from, so without a successful defer
 * the paste must stay intact (never discardable, unlike tool outputs).
 */
function deferredUserPasteReplacement(
	text: string,
	profile: UserPasteProfile,
	store: DeferredOutputStore,
): { text: string; reclaimed: number } | undefined {
	// User pastes are prose/code mixes — classify density instead of forcing dense.
	const est = estimateTextTokens(text);
	if (est <= profile.tokenThreshold) return undefined;
	const excerpt = profile.excerpt(text);
	if (excerpt.length >= text.length) return undefined;
	let id: string;
	try {
		id = store.put(text);
	} catch {
		return undefined;
	}
	const replacement = `${excerpt}\n${formatDeferredOutputPlaceholder(est, id)}`;
	return { text: replacement, reclaimed: Math.max(0, est - estimateTextTokens(replacement)) };
}

/**
 * N5 — shrink oversized text blocks of an OLD user message. Handles both string
 * content and text-block arrays. Mutates the (cloned) message in place and
 * returns reclaimed tokens.
 */
function pruneUserPasteBlocks(msg: AgentMessage, profile: UserPasteProfile, store: DeferredOutputStore): number {
	const content = (msg as { content: string | Array<{ type: string; text?: string }> }).content;
	if (typeof content === "string") {
		const result = deferredUserPasteReplacement(content, profile, store);
		if (result === undefined) return 0;
		(msg as { content: string }).content = result.text;
		return result.reclaimed;
	}
	if (!Array.isArray(content)) return 0;
	let reclaimed = 0;
	for (const block of content) {
		if (block.type !== "text" || !block.text) continue;
		const result = deferredUserPasteReplacement(block.text, profile, store);
		if (result === undefined) continue;
		block.text = result.text;
		reclaimed += result.reclaimed;
	}
	return reclaimed;
}

/** Read-only counterpart of {@link pruneUserPasteBlocks} (same profile, no store needed). */
function wouldPruneUserPasteBlocks(msg: AgentMessage, profile: UserPasteProfile): boolean {
	const content = (msg as { content: string | Array<{ type: string; text?: string }> }).content;
	if (typeof content === "string") return wouldShrinkUserPaste(content, profile);
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (block.type !== "text" || !block.text) continue;
		if (wouldShrinkUserPaste(block.text, profile)) return true;
	}
	return false;
}

function wouldShrinkUserPaste(text: string, profile: UserPasteProfile): boolean {
	if (text.length <= profile.minShrinkChars) return false;
	if (estimateTextTokens(text) <= profile.tokenThreshold) return false;
	return profile.excerpt(text).length < text.length;
}

// ============================================================================
// N8 — Consumed steering-reminder collapse
// ============================================================================

/**
 * Steering reminders the anti-waste guards inject as synthetic user messages.
 * Each entry is a CONFIRMED generator of a `<system-reminder>…</system-reminder>`
 * steering block that the guard re-emits on demand (overthink-guard.ts /
 * ttsr-steer.ts in @pit/agent-core — the markers are imported from there as the
 * single source of truth), so once the turn a reminder steered has scrolled out
 * of the protected window the full text is dead weight: re-derivable, ~zero
 * historical value.
 *
 * CONSERVATIVE by construction: only the two prefixes that OPEN a known steering
 * block are matched. A bare `<system-reminder>` a hook or the user injected —
 * which may carry load-bearing content — never matches, because every entry
 * requires a specific steering prefix, not the generic tag.
 */
const STEERING_REMINDER_MATCHERS: ReadonlyArray<{ kind: string; prefix: string }> = [
	{ kind: "overthink", prefix: OVERTHINK_STEER_TEXT_MARKER },
	{ kind: "TTSR", prefix: TTSR_STEER_TEXT_MARKER },
];

const SYSTEM_REMINDER_CLOSE = "</system-reminder>";

/**
 * When `text` is ENTIRELY one consumed steering reminder (after trim), return its
 * kind; otherwise undefined. "Entirely" = the trimmed text OPENS with a known
 * steering prefix AND CLOSES with the sole `</system-reminder>` terminator. A
 * MIXED block (reminder + user prose in the same block) never matches: trailing
 * prose moves the close tag away from the end, and a second reminder/tag concat
 * leaves more than one terminator — both rejected. Synthetic reminders are always
 * a single self-contained block, so this recognizes them without false positives.
 */
function consumedSteeringReminderKind(text: string): string | undefined {
	const trimmed = text.trim();
	if (!trimmed.endsWith(SYSTEM_REMINDER_CLOSE)) return undefined;
	// Exactly one terminator — reject concatenated/duplicated reminders so a block
	// that carries extra content past the first reminder is left fully intact.
	if (trimmed.indexOf(SYSTEM_REMINDER_CLOSE) !== trimmed.length - SYSTEM_REMINDER_CLOSE.length) return undefined;
	for (const matcher of STEERING_REMINDER_MATCHERS) {
		if (trimmed.startsWith(matcher.prefix)) return matcher.kind;
	}
	return undefined;
}

/** One-line replacement for a consumed steering reminder (no defer — synthetic). */
function formatConsumedSteeringReminder(kind: string): string {
	return `[steering reminder (${kind}) consumed]`;
}

/**
 * N8 — collapse consumed steering reminders in an OLD user message to one line.
 * Only blocks whose ENTIRE text is a single known steering reminder collapse;
 * mixed blocks and unknown `<system-reminder>` content are left intact. No defer:
 * the guard re-generates these on demand, so there is nothing to recover. Handles
 * both the string and text-block-array content shapes (mutates the CLONED message
 * in place, mirroring the N5 paste prune). Returns reclaimed tokens.
 */
function collapseConsumedSteeringReminders(msg: AgentMessage): number {
	const content = (msg as { content: string | Array<{ type: string; text?: string }> }).content;
	if (typeof content === "string") {
		const kind = consumedSteeringReminderKind(content);
		if (kind === undefined) return 0;
		const replacement = formatConsumedSteeringReminder(kind);
		const before = estimateTextTokens(content);
		const after = estimateTextTokens(replacement);
		if (after >= before) return 0;
		(msg as { content: string }).content = replacement;
		return before - after;
	}
	if (!Array.isArray(content)) return 0;
	let reclaimed = 0;
	for (const block of content) {
		if (block.type !== "text" || !block.text) continue;
		const kind = consumedSteeringReminderKind(block.text);
		if (kind === undefined) continue;
		const replacement = formatConsumedSteeringReminder(kind);
		const before = estimateTextTokens(block.text);
		const after = estimateTextTokens(replacement);
		if (after >= before) continue;
		block.text = replacement;
		reclaimed += before - after;
	}
	return reclaimed;
}

/** Read-only counterpart: is there a collapsible consumed steering reminder? */
function hasConsumedSteeringReminder(msg: AgentMessage): boolean {
	const content = (msg as { content: string | Array<{ type: string; text?: string }> }).content;
	if (typeof content === "string") {
		const kind = consumedSteeringReminderKind(content);
		return (
			kind !== undefined && estimateTextTokens(formatConsumedSteeringReminder(kind)) < estimateTextTokens(content)
		);
	}
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (block.type !== "text" || !block.text) continue;
		const kind = consumedSteeringReminderKind(block.text);
		if (
			kind !== undefined &&
			estimateTextTokens(formatConsumedSteeringReminder(kind)) < estimateTextTokens(block.text)
		) {
			return true;
		}
	}
	return false;
}

export function pruneOldToolOutputs(
	messages: AgentMessage[],
	tokenThreshold = PRUNE_TOKEN_THRESHOLD,
	protectTurns = PRUNE_PROTECT_TURNS,
	defer = false,
	plan?: ContextPrunePlan,
): number {
	const {
		protectFromIndex,
		supersededIndices: supersededReadIndices,
		supersededMutationCauses,
		pinnedIndices,
	} = resolveContextPrunePlan(messages, protectTurns, plan);

	let prunedTokens = 0;

	const store = defer ? getCurrentDeferredOutputStore() : undefined;
	const errorByCallId = buildToolCallErrorIndex(messages);
	const firstUserIndex = firstUserMessageIndex(messages);

	for (let i = 0; i < protectFromIndex; i++) {
		// P5: a file pin protects this index from size-prune, superseded-collapse
		// AND mutation-arg elision (the assistant call of a pinned mutation is in the
		// set). No-op when nothing is pinned — pin-less prune stays byte-identical.
		if (pinnedIndices.has(i)) continue;
		const msg = messages[i];
		// N5: pasted logs/stacks in OLD user messages can be 5-50k tokens. Above
		// the same threshold, shrink to head+tail + recall id. The defer is
		// MANDATORY (no store / failed put → paste stays intact — user input has
		// no disk copy to re-derive). The FIRST user message (the task statement)
		// only prunes at 3× the threshold, with the generous excerpt.
		if (msg.role === "user") {
			if (i === firstUserIndex) {
				// No N8 here: a synthetic steering reminder is never the opening
				// message. Same defer-mandatory contract as N5 everywhere else.
				if (store !== undefined) {
					prunedTokens += pruneUserPasteBlocks(msg, firstUserPasteProfile(tokenThreshold), store);
				}
				continue;
			}
			// N8: collapse consumed steering reminders (overthink/TTSR) to one line
			// BEFORE the N5 paste prune. Reminders are far below the paste threshold
			// (a few hundred chars), so N5 never reaches them — that is why N8 exists
			// — and they need no store: the guard re-emits them, nothing to recover.
			prunedTokens += collapseConsumedSteeringReminders(msg);
			// N5: pasted logs/stacks are defer-mandatory (user input has no on-disk
			// source of truth), so they only prune when a store is open.
			if (store !== undefined) {
				prunedTokens += pruneUserPasteBlocks(msg, userPasteProfile(tokenThreshold), store);
			}
			continue;
		}
		// Assistant tool-call args for mutation tools (write/edit) carry the full
		// file body / edit text. Once old, that body is redundant — the result
		// already landed on disk — yet it stays in context at full cost every turn
		// until summarization. Elide the heavy string values, keep paths/flags.
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (let b = 0; b < msg.content.length; b++) {
				const block = msg.content[b];
				if (block.type !== "toolCall" || !MUTATING_TOOL_NAMES.has(block.name)) continue;
				const argsRef =
					typeof block.arguments === "object" && block.arguments !== null ? block.arguments : undefined;
				let before = argsRef ? beforeTokensCache.get(argsRef) : undefined;
				if (before === undefined) {
					before = estimateTextTokens(JSON.stringify(block.arguments), true);
					if (argsRef) beforeTokensCache.set(argsRef, before);
				}
				if (before <= tokenThreshold) continue;
				const result = pruneToolCallArguments(block.arguments, errorByCallId.get(block.id) === true);
				if (result) {
					(block as { arguments: unknown }).arguments = result.pruned;
					const after = estimateTextTokens(JSON.stringify(result.pruned), true);
					prunedTokens += Math.max(0, before - after);
				}
			}
			continue;
		}
		if (msg.role !== "toolResult") continue;
		if (!Array.isArray(msg.content)) continue;

		const superseded = supersededReadIndices.has(i);
		for (let b = 0; b < msg.content.length; b++) {
			const block = msg.content[b];
			if (block.type === "text" && block.text) {
				// Tool outputs are dense (JSON/code), use dense divisor
				const est = cachedDenseTextTokens(block, block.text);
				if (est > tokenThreshold) {
					// The store keeps outputs in memory and spills to disk above a memory
					// cap; get() falls back to disk. A spill failure (disk full/permission)
					// must degrade to the in-message head+tail excerpt rather than abort
					// the turn that awaits this prune.
					let id: string | undefined;
					if (store) {
						try {
							id = store.put(block.text);
						} catch {
							id = undefined;
						}
					}
					// Hybrid: always keep the head+tail excerpt inline (so the reader still
					// sees the output's shape) and, when the full text was stored, append the
					// recall id so the elided middle is recoverable in full. Strictly better
					// than a bare excerpt (adds a recovery path) and than a bare placeholder
					// (keeps shape). Degrades to the plain excerpt when there is no store
					// (compaction-prep / opt-out) or the deferred write failed.
					const excerpt = headTailExcerpt(block.text);
					const replacement =
						id !== undefined ? `${excerpt}\n${formatDeferredOutputPlaceholder(est, id)}` : excerpt;
					(msg.content[b] as any).text = replacement;
					const after = estimateTextTokens(replacement, true);
					denseTextTokensCache.set(block, after);
					prunedTokens += Math.max(0, est - after);
				} else if (superseded) {
					// A stale result a later call supersedes (below the size threshold):
					// duplicate read/grep/…, M11 write-invalidated read, or N4 grep covered
					// by a full read. Collapse to head+tail — deterministic tools re-derive
					// from disk; bash (non-reproducible) defers its full text when a store
					// is open (M13); M11 collapses carry a cause marker.
					prunedTokens += collapseSupersededTextBlock(
						msg.content[b] as { text: string },
						msg.toolName,
						supersededMutationCauses.get(i),
						store,
					);
				}
			}
		}
	}

	return prunedTokens;
}

/**
 * Collapse superseded deterministic tool results to head+tail excerpts only.
 * No large-output defer, no mutation-arg elision — minimal cache churn (A1′).
 * M13: a superseded `bash` result (non-reproducible output) additionally defers
 * its full text to the session store when one is open — see
 * {@link collapseSupersededTextBlock}.
 */
export function applySupersedeOnly(
	messages: AgentMessage[],
	protectTurns = PRUNE_PROTECT_TURNS,
	plan?: ContextPrunePlan,
): number {
	const {
		protectFromIndex,
		supersededIndices: supersededReadIndices,
		supersededMutationCauses,
		pinnedIndices,
	} = resolveContextPrunePlan(messages, protectTurns, plan);
	let prunedTokens = 0;
	const store = getCurrentDeferredOutputStore();

	for (let i = 0; i < protectFromIndex; i++) {
		// P5: file pin — never collapse (redundant with the plan's supersede
		// subtraction, kept as a defensive belt so the two can never drift).
		if (pinnedIndices.has(i)) continue;
		if (!supersededReadIndices.has(i)) continue;
		const msg = messages[i];
		if (msg.role !== "toolResult" || !Array.isArray(msg.content)) continue;
		for (let b = 0; b < msg.content.length; b++) {
			const block = msg.content[b];
			if (block.type !== "text" || !block.text) continue;
			prunedTokens += collapseSupersededTextBlock(
				block as { text: string },
				msg.toolName,
				supersededMutationCauses.get(i),
				store,
			);
		}
	}

	return prunedTokens;
}

/** Read-only: would {@link applySupersedeOnly} collapse any superseded result? */
export function wouldApplySupersedeOnly(
	messages: AgentMessage[],
	protectTurns = PRUNE_PROTECT_TURNS,
	plan?: ContextPrunePlan,
): boolean {
	const { supersededIndices: supersededReadIndices } = resolveContextPrunePlan(messages, protectTurns, plan);
	for (const i of supersededReadIndices) {
		const msg = messages[i];
		if (msg.role !== "toolResult" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block.type !== "text" || !block.text) continue;
			if (wouldShrinkViaHeadTail(block.text)) return true;
		}
	}
	return false;
}

/**
 * Elide heavy mutation-tool arguments on the assistant toolCall block for
 * `toolCallId` after a successful apply (A3). No occupancy threshold.
 */
/**
 * Cap assistant thinking blocks older than `protectTurns` user turns (A4).
 * Recent-turn reasoning stays intact for the model; stale blocks shrink on wire.
 */
export function applyOldThinkingCap(messages: AgentMessage[], protectTurns = PRUNE_PROTECT_TURNS): number {
	const protectFromIndex = computePruneProtectFromIndex(messages, protectTurns);
	let prunedTokens = 0;

	for (let i = 0; i < protectFromIndex; i++) {
		const msg = messages[i];
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (let b = 0; b < msg.content.length; b++) {
			const block = msg.content[b];
			if (block.type !== "thinking" || !block.thinking) continue;
			const capped = capThinkingForContext(block.thinking);
			if (capped.length >= block.thinking.length) continue;
			const before = estimateTextTokens(block.thinking, true);
			(msg.content[b] as { thinking: string }).thinking = capped;
			const after = estimateTextTokens(capped, true);
			prunedTokens += Math.max(0, before - after);
		}
	}

	return prunedTokens;
}

/** Read-only: would {@link applyOldThinkingCap} shrink any thinking block? */
export function wouldApplyOldThinkingCap(messages: AgentMessage[], protectTurns = PRUNE_PROTECT_TURNS): boolean {
	const protectFromIndex = computePruneProtectFromIndex(messages, protectTurns);
	for (let i = 0; i < protectFromIndex; i++) {
		const msg = messages[i];
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block.type !== "thinking" || !block.thinking) continue;
			const capped = capThinkingForContext(block.thinking);
			if (capped.length < block.thinking.length) return true;
		}
	}
	return false;
}

export function elideMutatingToolCallArguments(messages: AgentMessage[], toolCallId: string): number {
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (let b = 0; b < msg.content.length; b++) {
			const block = msg.content[b];
			if (block.type !== "toolCall" || block.id !== toolCallId) continue;
			if (!MUTATING_TOOL_NAMES.has(block.name)) return 0;
			const argsRef = typeof block.arguments === "object" && block.arguments !== null ? block.arguments : undefined;
			let before = argsRef ? beforeTokensCache.get(argsRef) : undefined;
			if (before === undefined) {
				before = estimateTextTokens(JSON.stringify(block.arguments), true);
				if (argsRef) beforeTokensCache.set(argsRef, before);
			}
			const result = pruneToolCallArguments(block.arguments);
			if (!result) return 0;
			(block as { arguments: unknown }).arguments = result.pruned;
			const after = estimateTextTokens(JSON.stringify(result.pruned), true);
			return Math.max(0, before - after);
		}
	}
	return 0;
}

/** Wire-path: elide long args on every mutating toolCall in the array (idempotent). */
export function elideAllMutatingToolCallArguments(messages: AgentMessage[]): number {
	let total = 0;
	for (const msg of messages) {
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (const block of msg.content) {
			if (block.type !== "toolCall" || !MUTATING_TOOL_NAMES.has(block.name)) continue;
			total += elideMutatingToolCallArguments(messages, block.id);
		}
	}
	return total;
}

/**
 * Return a new message array where every `toolResult`, assistant, and user
 * message — and the text-bearing content blocks inside it — is shallow-cloned,
 * while all other messages pass through by reference.
 *
 * `pruneOldToolOutputs` rewrites `block.text` in place. For `type === "message"`
 * entries, `getMessageFromEntry` hands back `entry.message` BY REFERENCE, so the
 * toolResult objects (and their content blocks) are the very ones the live
 * session context still points at. Cloning just the toolResult layer here means
 * the prune mutates throw-away copies: if summarization aborts after pruning, the
 * live context is untouched and no re-read/re-edit is needed. On the happy path
 * the produced summary is byte-identical — the clones carry the same text the
 * uncloned objects would have, the originals are simply discarded with the prep.
 *
 * Cloning also sidesteps the per-object `charCountCache` WeakMap: a fresh block
 * object cannot carry a stale cached char count from the pre-prune text.
 */
export function cloneToolResultMessagesForPrune(messages: AgentMessage[]): AgentMessage[] {
	return messages.map((msg) => {
		if (msg.role === "toolResult" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: msg.content.map((block) => (block.type === "text" ? { ...block } : block)),
			};
		}
		// Assistant tool-call blocks are reassigned a pruned `arguments` object by
		// pruneOldToolOutputs; shallow-clone the block so the live context's
		// arguments object is never swapped out under it.
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: msg.content.map((block) =>
					block.type === "toolCall" || block.type === "thinking" ? { ...block } : block,
				),
			};
		}
		// User messages: the N5 paste prune rewrites text blocks (or the whole
		// string content) in place. Clone the text layer so the live session /
		// branch entry.message stays byte-identical if the prune's consumer aborts.
		// Fresh objects also sidestep the per-object charCountCache.
		if (msg.role === "user") {
			const content = (msg as { content: unknown }).content;
			if (Array.isArray(content)) {
				return {
					...msg,
					content: content.map((block) => (block?.type === "text" ? { ...block } : block)),
				} as AgentMessage;
			}
			return { ...msg } as AgentMessage;
		}
		return msg;
	});
}

/**
 * Cheap clone for the arg-elision-only live-prune path: `elideMutatingToolCallArguments`
 * only reassigns `arguments` on the toolCall blocks matching `toolCallIds`, so
 * slicing the array and shallow-cloning just those assistant messages (and blocks)
 * gives the same abort-safety as `cloneToolResultMessagesForPrune` at O(ids) object
 * churn instead of O(N) — this runs on EVERY successful mutating tool call / turn end.
 */
export function cloneForArgElision(messages: AgentMessage[], toolCallIds: readonly string[]): AgentMessage[] {
	const copy = messages.slice();
	if (toolCallIds.length === 0) return copy;
	const ids = new Set(toolCallIds);
	for (let i = 0; i < copy.length; i++) {
		const msg = copy[i];
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		if (!msg.content.some((block) => block.type === "toolCall" && ids.has(block.id))) continue;
		copy[i] = {
			...msg,
			content: msg.content.map((block) => (block.type === "toolCall" && ids.has(block.id) ? { ...block } : block)),
		};
	}
	return copy;
}
