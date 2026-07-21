/**
 * Pacote 4 — supersede machine: M10 (normalized path keys), M11 (write
 * invalidation), M12 (single live-trigger source of truth), M13 (bash defer on
 * supersede collapse), N4 (full read covers single-file grep), N5 (user paste
 * prune), and the size-scaled image token estimate.
 */
import { join } from "node:path";
import type { AgentMessage } from "@pit/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { applyLiveContextEconomyAfterToolSuccess } from "../src/core/agent-session-live-prune.js";
import {
	adoptSupersedeScanState,
	applySupersedeOnly,
	cloneForArgElision,
	cloneToolResultMessagesForPrune,
	elideMutatingToolCallArguments,
	estimateTokens,
	imageBlockTokens,
	planContextPrune,
	pruneOldToolOutputs,
	wouldApplySupersedeOnly,
	wouldPruneOldToolOutputs,
} from "../src/core/compaction/compaction.js";
import {
	createDeferredOutputStore,
	type DeferredOutputStore,
	setCurrentDeferredOutputStore,
} from "../src/core/deferred-output-store.js";
import { FS_CASE_INSENSITIVE } from "../src/core/tools/path-utils.js";

const PRUNE_TOKEN_THRESHOLD = 20_000;
const CONTEXT_WINDOW = 1_000_000;

/** Multi-line, non-JSON blob above the head+tail excerpt budget so headTailExcerpt shrinks it. */
function bigBlob(head = "HEAD_MARKER", tail = "TAIL_MARKER"): string {
	return `${head}\n${"filler line\n".repeat(800)}${tail}`;
}

function toolCall(name: string, id: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		timestamp: 1,
	} as unknown as AgentMessage;
}

function toolResult(toolName: string, toolCallId: string, text: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: 1,
	} as unknown as AgentMessage;
}

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as unknown as AgentMessage;
}

function textAt(messages: AgentMessage[], i: number): string {
	return (messages[i] as unknown as { content: { text: string }[] }).content[0].text;
}

function sorted(set: Set<number>): number[] {
	return [...set].sort((a, b) => a - b);
}

afterEach(() => {
	setCurrentDeferredOutputStore(undefined);
});

// ============================================================================
// M10 — normalized supersede/read keys
// ============================================================================

describe("M10 — path spelling variants collapse to one read resource key", () => {
	it("relative and absolute spellings of the same file share a key", () => {
		const blob = bigBlob();
		const messages = [
			toolCall("read", "c1", { path: "m10-a.ts" }),
			toolResult("read", "c1", blob),
			toolCall("read", "c2", { path: join(process.cwd(), "m10-a.ts") }),
			toolResult("read", "c2", "fresh"),
			user("a"),
			user("b"),
		];

		expect(sorted(planContextPrune(messages, 2).supersededIndices)).toEqual([1]);
		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2);
		expect(reclaimed).toBeGreaterThan(0);
		expect(textAt(messages, 1).length).toBeLessThan(blob.length);
		expect(textAt(messages, 3)).toBe("fresh");
	});

	it("./-prefixed and bare relative spellings share a key", () => {
		const messages = [
			toolCall("read", "c1", { path: "./m10-b.ts" }),
			toolResult("read", "c1", bigBlob()),
			toolCall("read", "c2", { path: "m10-b.ts" }),
			toolResult("read", "c2", "fresh"),
			user("a"),
			user("b"),
		];

		expect(sorted(planContextPrune(messages, 2).supersededIndices)).toEqual([1]);
	});

	it.runIf(FS_CASE_INSENSITIVE)("case variants share a key on case-insensitive filesystems", () => {
		const messages = [
			toolCall("read", "c1", { path: "M10-C.TS" }),
			toolResult("read", "c1", bigBlob()),
			toolCall("read", "c2", { path: "m10-c.ts" }),
			toolResult("read", "c2", "fresh"),
			user("a"),
			user("b"),
		];

		expect(sorted(planContextPrune(messages, 2).supersededIndices)).toEqual([1]);
	});

	it("different files still get distinct keys", () => {
		const messages = [
			toolCall("read", "c1", { path: "m10-d.ts" }),
			toolResult("read", "c1", bigBlob()),
			toolCall("read", "c2", { path: "m10-e.ts" }),
			toolResult("read", "c2", "fresh"),
			user("a"),
			user("b"),
		];

		expect(sorted(planContextPrune(messages, 2).supersededIndices)).toEqual([]);
	});
});

// ============================================================================
// M11 — write invalidation of stale reads
// ============================================================================

describe("M11 — a later successful write/edit invalidates older reads of the same file", () => {
	it("collapses an old read after a successful write, with a cause marker", () => {
		const blob = bigBlob();
		const messages = [
			toolCall("read", "c1", { path: "m11-a.ts" }),
			toolResult("read", "c1", blob),
			toolCall("write", "w1", { path: "m11-a.ts", content: "new content" }),
			toolResult("write", "w1", "File written."),
			user("a"),
			user("b"),
		];

		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2);

		expect(reclaimed).toBeGreaterThan(0);
		const collapsed = textAt(messages, 1);
		expect(collapsed.length).toBeLessThan(blob.length);
		expect(collapsed).toContain("HEAD_MARKER");
		expect(collapsed).toContain(
			"[superseded: m11-a.ts was modified by a later write/edit — re-read for current content]",
		);
	});

	it("edit (not just write) invalidates too, via applySupersedeOnly", () => {
		const blob = bigBlob();
		const messages = [
			toolCall("read", "c1", { path: "m11-b.ts" }),
			toolResult("read", "c1", blob),
			toolCall("edit", "e1", { path: "m11-b.ts", oldText: "a", newText: "b" }),
			toolResult("edit", "e1", "Edited m11-b.ts"),
			user("a"),
			user("b"),
		];

		expect(wouldApplySupersedeOnly(messages, 2)).toBe(true);
		const reclaimed = applySupersedeOnly(messages, 2);
		expect(reclaimed).toBeGreaterThan(0);
		expect(textAt(messages, 1)).toContain("was modified by a later write/edit");
	});

	it("invalidates partial-range reads of the mutated file as well", () => {
		const blob = bigBlob();
		const messages = [
			toolCall("read", "c1", { path: "m11-c.ts", offset: 10, limit: 50 }),
			toolResult("read", "c1", blob),
			toolCall("write", "w1", { path: "m11-c.ts", content: "x" }),
			toolResult("write", "w1", "ok"),
			user("a"),
			user("b"),
		];

		expect(sorted(planContextPrune(messages, 2).supersededIndices)).toEqual([1]);
	});

	it("uses the M10 normalization: an absolute-path write invalidates a relative-path read", () => {
		const messages = [
			toolCall("read", "c1", { path: "m11-d.ts" }),
			toolResult("read", "c1", bigBlob()),
			toolCall("write", "w1", { path: join(process.cwd(), "m11-d.ts"), content: "x" }),
			toolResult("write", "w1", "ok"),
			user("a"),
			user("b"),
		];

		expect(sorted(planContextPrune(messages, 2).supersededIndices)).toEqual([1]);
	});

	it("a FAILED write does NOT invalidate (the disk did not change)", () => {
		const blob = bigBlob();
		const messages = [
			toolCall("read", "c1", { path: "m11-e.ts" }),
			toolResult("read", "c1", blob),
			toolCall("write", "w1", { path: "m11-e.ts", content: "x" }),
			toolResult("write", "w1", "Error: EACCES", true),
			user("a"),
			user("b"),
		];

		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2);
		expect(reclaimed).toBe(0);
		expect(textAt(messages, 1)).toBe(blob);
	});

	it("respects M9c: the newest ERROR read of the file is never collapsed", () => {
		const errorBlob = bigBlob("ERR_HEAD", "ERR_TAIL");
		const messages = [
			toolCall("read", "c1", { path: "m11-f.ts" }),
			toolResult("read", "c1", errorBlob, true),
			toolCall("write", "w1", { path: "m11-f.ts", content: "x" }),
			toolResult("write", "w1", "ok"),
			user("a"),
			user("b"),
		];

		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2);
		expect(reclaimed).toBe(0);
		expect(textAt(messages, 1)).toBe(errorBlob);
	});

	it("respects the protected window: recent reads stay intact even after a write", () => {
		const blob = bigBlob();
		const messages = [
			user("start"),
			toolCall("read", "c1", { path: "m11-g.ts" }),
			toolResult("read", "c1", blob),
			toolCall("write", "w1", { path: "m11-g.ts", content: "x" }),
			toolResult("write", "w1", "ok"),
			user("a"),
			user("b"),
		];

		// protectTurns=3 → protectFromIndex=0: everything is protected.
		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 3);
		expect(reclaimed).toBe(0);
		expect(textAt(messages, 2)).toBe(blob);
	});

	it("a read AFTER the write is fresh and never invalidated by it", () => {
		const blob = bigBlob();
		const messages = [
			toolCall("write", "w1", { path: "m11-h.ts", content: "x" }),
			toolResult("write", "w1", "ok"),
			toolCall("read", "c1", { path: "m11-h.ts" }),
			toolResult("read", "c1", blob),
			user("a"),
			user("b"),
		];

		expect(sorted(planContextPrune(messages, 2).supersededIndices)).toEqual([]);
	});
});

// ============================================================================
// M12 — single source of truth for the live supersede trigger
// ============================================================================

describe("M12 — live trigger delegates to wouldApplySupersedeOnly (no separate allowlist)", () => {
	afterEach(() => {
		delete process.env.PIT_NO_LIVE_SUPERSEDE;
	});

	it("a duplicate bash success now fires the live supersede (was excluded by the old list)", () => {
		const blob = bigBlob("BASH_HEAD", "BASH_TAIL");
		const messages = [
			toolCall("bash", "b1", { command: "npm test" }),
			toolResult("bash", "b1", blob),
			toolCall("bash", "b2", { command: "npm test" }),
			toolResult("bash", "b2", "fresh"),
			user("a"),
			user("b"),
		];

		const outcome = applyLiveContextEconomyAfterToolSuccess(
			messages,
			{ type: "toolCall", id: "b2", name: "bash", arguments: { command: "npm test" } },
			false,
			CONTEXT_WINDOW,
		);

		expect(outcome.supersedeReclaimed).toBeGreaterThan(0);
		expect(textAt(outcome.messages, 1).length).toBeLessThan(blob.length);
		expect(textAt(outcome.messages, 3)).toBe("fresh");
	});

	it("a successful write fires the live scan and invalidates the stale read (M11 live)", () => {
		const blob = bigBlob();
		const messages = [
			toolCall("read", "c1", { path: "m12-a.ts" }),
			toolResult("read", "c1", blob),
			toolCall("write", "w1", { path: "m12-a.ts", content: "x" }),
			toolResult("write", "w1", "ok"),
			user("a"),
			user("b"),
		];

		const outcome = applyLiveContextEconomyAfterToolSuccess(
			messages,
			{ type: "toolCall", id: "w1", name: "write", arguments: { path: "m12-a.ts", content: "x" } },
			false,
			CONTEXT_WINDOW,
		);

		expect(outcome.supersedeReclaimed).toBeGreaterThan(0);
		expect(textAt(outcome.messages, 1)).toContain("was modified by a later write/edit");
	});

	it("still respects PIT_NO_LIVE_SUPERSEDE", () => {
		process.env.PIT_NO_LIVE_SUPERSEDE = "1";
		const blob = bigBlob();
		const messages = [
			toolCall("bash", "b1", { command: "npm test" }),
			toolResult("bash", "b1", blob),
			toolCall("bash", "b2", { command: "npm test" }),
			toolResult("bash", "b2", "fresh"),
			user("a"),
			user("b"),
		];

		const outcome = applyLiveContextEconomyAfterToolSuccess(
			messages,
			{ type: "toolCall", id: "b2", name: "bash", arguments: { command: "npm test" } },
			false,
			CONTEXT_WINDOW,
		);

		expect(outcome.supersedeReclaimed).toBe(0);
		expect(textAt(outcome.messages, 1)).toBe(blob);
	});
});

// ============================================================================
// T11 — ast_grep / repo_map join the supersede allowlist
// ============================================================================

describe("T11 — ast_grep and repo_map supersede identical prior results", () => {
	it("collapses an older ast_grep result when the same query succeeds again", () => {
		const blob = bigBlob("AST_HEAD", "AST_TAIL");
		const args = { pattern: "console.log($X)", lang: "ts", path: "src" };
		const messages = [
			toolCall("ast_grep", "a1", args),
			toolResult("ast_grep", "a1", blob),
			toolCall("ast_grep", "a2", args),
			toolResult("ast_grep", "a2", "fresh matches"),
			user("a"),
			user("b"),
		];

		const outcome = applyLiveContextEconomyAfterToolSuccess(
			messages,
			{ type: "toolCall", id: "a2", name: "ast_grep", arguments: args },
			false,
			CONTEXT_WINDOW,
		);

		expect(outcome.supersedeReclaimed).toBeGreaterThan(0);
		expect(textAt(outcome.messages, 1).length).toBeLessThan(blob.length);
		expect(textAt(outcome.messages, 3)).toBe("fresh matches");
	});

	it("collapses an older repo_map result when the same path is remapped", () => {
		const blob = bigBlob("MAP_HEAD", "MAP_TAIL");
		const args = { path: "packages/coding-agent", max_files: 200 };
		const messages = [
			toolCall("repo_map", "r1", args),
			toolResult("repo_map", "r1", blob),
			toolCall("repo_map", "r2", args),
			toolResult("repo_map", "r2", "fresh map"),
			user("a"),
			user("b"),
		];

		const outcome = applyLiveContextEconomyAfterToolSuccess(
			messages,
			{ type: "toolCall", id: "r2", name: "repo_map", arguments: args },
			false,
			CONTEXT_WINDOW,
		);

		expect(outcome.supersedeReclaimed).toBeGreaterThan(0);
		expect(textAt(outcome.messages, 1).length).toBeLessThan(blob.length);
		expect(textAt(outcome.messages, 3)).toBe("fresh map");
	});

	it("does not supersede ast_grep results with different patterns", () => {
		const blob = bigBlob("AST_HEAD", "AST_TAIL");
		const messages = [
			toolCall("ast_grep", "a1", { pattern: "console.log($X)", lang: "ts" }),
			toolResult("ast_grep", "a1", blob),
			toolCall("ast_grep", "a2", { pattern: "throw $E", lang: "ts" }),
			toolResult("ast_grep", "a2", "other matches"),
			user("a"),
			user("b"),
		];

		const outcome = applyLiveContextEconomyAfterToolSuccess(
			messages,
			{ type: "toolCall", id: "a2", name: "ast_grep", arguments: { pattern: "throw $E", lang: "ts" } },
			false,
			CONTEXT_WINDOW,
		);

		expect(outcome.supersedeReclaimed).toBe(0);
		expect(textAt(outcome.messages, 1)).toBe(blob);
	});

	it("does not supersede repo_map results with different paths", () => {
		const blob = bigBlob("MAP_HEAD", "MAP_TAIL");
		const messages = [
			toolCall("repo_map", "r1", { path: "packages/a" }),
			toolResult("repo_map", "r1", blob),
			toolCall("repo_map", "r2", { path: "packages/b" }),
			toolResult("repo_map", "r2", "other map"),
			user("a"),
			user("b"),
		];

		const outcome = applyLiveContextEconomyAfterToolSuccess(
			messages,
			{ type: "toolCall", id: "r2", name: "repo_map", arguments: { path: "packages/b" } },
			false,
			CONTEXT_WINDOW,
		);

		expect(outcome.supersedeReclaimed).toBe(0);
		expect(textAt(outcome.messages, 1)).toBe(blob);
	});
});

// ============================================================================
// M13 — bash supersede collapse defers the full output
// ============================================================================

describe("M13 — superseded bash output is deferred with a recall id", () => {
	function bashDuplicateMessages(blob: string): AgentMessage[] {
		return [
			toolCall("bash", "b1", { command: "npm test" }),
			toolResult("bash", "b1", blob),
			toolCall("bash", "b2", { command: "npm test" }),
			toolResult("bash", "b2", "fresh"),
			user("a"),
			user("b"),
		];
	}

	it("applySupersedeOnly appends the canonical placeholder and the store round-trips the full text", () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);
		const blob = bigBlob("BASH_HEAD", "BASH_TAIL");
		const messages = bashDuplicateMessages(blob);

		const reclaimed = applySupersedeOnly(messages, 2);

		expect(reclaimed).toBeGreaterThan(0);
		const collapsed = textAt(messages, 1);
		expect(collapsed).toContain("BASH_HEAD");
		const match = collapsed.match(/recall_tool_output\(\{ id: "(d\d+)" \}\)/);
		expect(match).not.toBeNull();
		expect(store.get(match?.[1] ?? "")).toBe(blob);
		store.dispose();
	});

	it("pruneOldToolOutputs (defer=true) defers superseded bash below the size threshold too", () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);
		const blob = bigBlob("BASH_HEAD", "BASH_TAIL");
		const messages = bashDuplicateMessages(blob);

		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2, true);

		expect(reclaimed).toBeGreaterThan(0);
		const match = textAt(messages, 1).match(/recall_tool_output\(\{ id: "(d\d+)" \}\)/);
		expect(match).not.toBeNull();
		expect(store.get(match?.[1] ?? "")).toBe(blob);
		store.dispose();
	});

	it("degrades to the plain collapse when no store is open", () => {
		const blob = bigBlob("BASH_HEAD", "BASH_TAIL");
		const messages = bashDuplicateMessages(blob);

		const reclaimed = applySupersedeOnly(messages, 2);

		expect(reclaimed).toBeGreaterThan(0);
		expect(textAt(messages, 1)).not.toContain("recall_tool_output");
	});

	it("degrades to the plain collapse when the store put throws", () => {
		const throwingStore: DeferredOutputStore = {
			put: () => {
				throw new Error("boom");
			},
			get: () => undefined,
			dispose: () => {},
		};
		setCurrentDeferredOutputStore(throwingStore);
		const blob = bigBlob("BASH_HEAD", "BASH_TAIL");
		const messages = bashDuplicateMessages(blob);

		const reclaimed = applySupersedeOnly(messages, 2);

		expect(reclaimed).toBeGreaterThan(0);
		expect(textAt(messages, 1)).not.toContain("recall_tool_output");
	});

	it("does NOT defer deterministic tools (read) — their content re-derives from disk", () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);
		const blob = bigBlob();
		const messages = [
			toolCall("read", "c1", { path: "m13-a.ts" }),
			toolResult("read", "c1", blob),
			toolCall("read", "c2", { path: "m13-a.ts" }),
			toolResult("read", "c2", "fresh"),
			user("a"),
			user("b"),
		];

		const reclaimed = applySupersedeOnly(messages, 2);

		expect(reclaimed).toBeGreaterThan(0);
		expect(textAt(messages, 1)).not.toContain("recall_tool_output");
		store.dispose();
	});
});

// ============================================================================
// N4 — a later FULL read covers older single-file greps
// ============================================================================

describe("N4 — full read of file P supersedes older greps scoped to exactly P", () => {
	it("collapses a single-file grep after a later successful full read of the same file", () => {
		const blob = bigBlob("GREP_HEAD", "GREP_TAIL");
		const messages = [
			toolCall("grep", "g1", { pattern: "alpha", path: "n4-a.ts" }),
			toolResult("grep", "g1", blob),
			toolCall("read", "c1", { path: "n4-a.ts" }),
			toolResult("read", "c1", "full file content"),
			user("a"),
			user("b"),
		];

		expect(sorted(planContextPrune(messages, 2).supersededIndices)).toEqual([1]);
		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2);
		expect(reclaimed).toBeGreaterThan(0);
		expect(textAt(messages, 1).length).toBeLessThan(blob.length);
		expect(textAt(messages, 3)).toBe("full file content");
	});

	it("normalizes the grep path (M10): absolute read covers a relative grep", () => {
		const messages = [
			toolCall("grep", "g1", { pattern: "alpha", path: "n4-b.ts" }),
			toolResult("grep", "g1", bigBlob()),
			toolCall("read", "c1", { path: join(process.cwd(), "n4-b.ts") }),
			toolResult("read", "c1", "content"),
			user("a"),
			user("b"),
		];

		expect(sorted(planContextPrune(messages, 2).supersededIndices)).toEqual([1]);
	});

	it("a directory grep is NOT covered by a read of a different path", () => {
		const blob = bigBlob("GREP_HEAD", "GREP_TAIL");
		const messages = [
			toolCall("grep", "g1", { pattern: "alpha", path: "src" }),
			toolResult("grep", "g1", blob),
			toolCall("read", "c1", { path: "n4-c.ts" }),
			toolResult("read", "c1", "content"),
			user("a"),
			user("b"),
		];

		expect(sorted(planContextPrune(messages, 2).supersededIndices)).toEqual([]);
		expect(pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2)).toBe(0);
		expect(textAt(messages, 1)).toBe(blob);
	});

	it("a PARTIAL read (offset/limit) does not cover the grep", () => {
		const blob = bigBlob();
		const messages = [
			toolCall("grep", "g1", { pattern: "alpha", path: "n4-d.ts" }),
			toolResult("grep", "g1", blob),
			toolCall("read", "c1", { path: "n4-d.ts", offset: 1, limit: 50 }),
			toolResult("read", "c1", "partial"),
			user("a"),
			user("b"),
		];

		expect(sorted(planContextPrune(messages, 2).supersededIndices)).toEqual([]);
	});

	it("a FAILED full read does not cover the grep", () => {
		const blob = bigBlob();
		const messages = [
			toolCall("grep", "g1", { pattern: "alpha", path: "n4-e.ts" }),
			toolResult("grep", "g1", blob),
			toolCall("read", "c1", { path: "n4-e.ts" }),
			toolResult("read", "c1", "Error: ENOENT", true),
			user("a"),
			user("b"),
		];

		expect(sorted(planContextPrune(messages, 2).supersededIndices)).toEqual([]);
	});

	it("a grep AFTER the full read stays intact", () => {
		const blob = bigBlob();
		const messages = [
			toolCall("read", "c1", { path: "n4-f.ts" }),
			toolResult("read", "c1", "content"),
			toolCall("grep", "g1", { pattern: "alpha", path: "n4-f.ts" }),
			toolResult("grep", "g1", blob),
			user("a"),
			user("b"),
		];

		expect(sorted(planContextPrune(messages, 2).supersededIndices)).toEqual([]);
	});
});

// ============================================================================
// N5 — user paste prune (defer mandatory)
// ============================================================================

describe("N5 — oversized user pastes defer to the store with a recall id", () => {
	/** ~130k chars of log-like content — far above the 20k-token threshold. */
	function giantPaste(marker: string): string {
		return `${marker}\n${"2026-07-03 ERROR stack frame at module.fn (file.ts:42)\n".repeat(2400)}END_${marker}`;
	}

	function pasteMessages(paste: string): AgentMessage[] {
		return [user("task statement — never pruned"), user(paste), user("a"), user("b")];
	}

	it("shrinks an old paste to excerpt + recall id and the store round-trips it", () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);
		const paste = giantPaste("PASTE_ONE");
		const messages = pasteMessages(paste);

		expect(wouldPruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2)).toBe(true);
		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2, true);

		expect(reclaimed).toBeGreaterThan(0);
		const text = textAt(messages, 1);
		expect(text.length).toBeLessThan(paste.length);
		expect(text).toContain("PASTE_ONE");
		const match = text.match(/recall_tool_output\(\{ id: "(d\d+)" \}\)/);
		expect(match).not.toBeNull();
		expect(store.get(match?.[1] ?? "")).toBe(paste);
		store.dispose();
	});

	it("NEVER prunes the first user message of the session (the task statement)", () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);
		const paste = giantPaste("FIRST_PASTE");
		const messages = [user(paste), user("follow-up"), user("a"), user("b")];

		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2, true);

		expect(reclaimed).toBe(0);
		expect(textAt(messages, 0)).toBe(paste);
		store.dispose();
	});

	it("leaves the paste intact when there is no store (defer is mandatory)", () => {
		const paste = giantPaste("NO_STORE");
		const messages = pasteMessages(paste);

		expect(wouldPruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2)).toBe(false);
		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2, true);

		expect(reclaimed).toBe(0);
		expect(textAt(messages, 1)).toBe(paste);
	});

	it("leaves the paste intact when the store put throws", () => {
		const throwingStore: DeferredOutputStore = {
			put: () => {
				throw new Error("boom");
			},
			get: () => undefined,
			dispose: () => {},
		};
		setCurrentDeferredOutputStore(throwingStore);
		const paste = giantPaste("THROWING");
		const messages = pasteMessages(paste);

		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2, true);

		expect(reclaimed).toBe(0);
		expect(textAt(messages, 1)).toBe(paste);
	});

	it("handles string-content user messages", () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);
		const paste = giantPaste("STRING_CONTENT");
		const messages = [
			user("task"),
			{ role: "user", content: paste, timestamp: 1 } as unknown as AgentMessage,
			user("a"),
			user("b"),
		];

		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2, true);

		expect(reclaimed).toBeGreaterThan(0);
		const content = (messages[1] as unknown as { content: string }).content;
		expect(typeof content).toBe("string");
		expect(content.length).toBeLessThan(paste.length);
		expect(content).toContain("recall_tool_output");
		store.dispose();
	});

	it("small user messages are untouched", () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);
		const messages = pasteMessages("just a normal short message");

		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2, true);

		expect(reclaimed).toBe(0);
		expect(textAt(messages, 1)).toBe("just a normal short message");
		store.dispose();
	});

	it("prunes the CLONE only — the original session messages stay byte-identical", () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);
		const paste = giantPaste("CLONE_SAFETY");
		const messages = pasteMessages(paste);

		const copy = cloneToolResultMessagesForPrune(messages);
		const reclaimed = pruneOldToolOutputs(copy, PRUNE_TOKEN_THRESHOLD, 2, true);

		expect(reclaimed).toBeGreaterThan(0);
		expect(textAt(copy, 1)).toContain("recall_tool_output");
		// The original (the branch's entry.message layer) is untouched.
		expect(textAt(messages, 1)).toBe(paste);
		store.dispose();
	});
});

// ============================================================================
// Micro — image token estimate scales with payload size
// ============================================================================

describe("imageBlockTokens — size-scaled image cost", () => {
	it("keeps the legacy flat floor for small/typical images and odd payloads", () => {
		expect(imageBlockTokens(undefined)).toBe(1200);
		expect(imageBlockTokens("")).toBe(1200);
		expect(imageBlockTokens("a".repeat(1_000))).toBe(1200);
		// 1.2M base64 chars ≈ 900KB ≈ 1200 tokens — right at the floor.
		expect(imageBlockTokens("a".repeat(1_200_000))).toBe(1200);
	});

	it("scales with payload size above the floor", () => {
		// 3M base64 chars → 2.25MB → 3000 tokens.
		expect(imageBlockTokens("a".repeat(3_000_000))).toBe(3000);
	});

	it("clamps at the ceiling for huge images", () => {
		// 9M base64 chars → 6.75MB → 9000 tokens → clamped to 8000.
		expect(imageBlockTokens("a".repeat(9_000_000))).toBe(8000);
	});

	it("estimateTokens uses the scaled cost for toolResult image blocks", () => {
		const message = {
			role: "toolResult",
			toolCallId: "t1",
			toolName: "read",
			content: [{ type: "image", data: "a".repeat(3_000_000), mimeType: "image/png" }],
			isError: false,
			timestamp: 1,
		} as unknown as AgentMessage;

		expect(estimateTokens(message)).toBe(3000);
	});
});

// ============================================================================
// Scan-state adoption + cheap arg-elision clone (send-path cache re-key)
// ============================================================================

describe("adoptSupersedeScanState — re-key incremental scan across derived arrays", () => {
	it("adopted state plans identically and ingests a suffix appended only to the derived array", () => {
		const blob = bigBlob();
		const base = [toolCall("read", "c1", { path: "adopt-a.ts" }), toolResult("read", "c1", blob), user("a")];
		// Warm the scan cache on `base`.
		planContextPrune(base, 1);
		const derived = base.slice();
		adoptSupersedeScanState(base, derived);
		// Duplicate read appended ONLY to `derived` — the adopted state must scan
		// the new suffix rather than treat it as already ingested.
		derived.push(
			toolCall("read", "c2", { path: "adopt-a.ts" }),
			toolResult("read", "c2", "fresh"),
			user("b"),
			user("c"),
		);
		expect(sorted(planContextPrune(derived, 2).supersededIndices)).toEqual([1]);
		// The source array's own state is unaffected by the derived array's scan.
		expect(sorted(planContextPrune(base, 1).supersededIndices)).toEqual([]);
	});

	it("refuses adoption when the derived array does not correspond to the source prefix", () => {
		const base = [toolCall("read", "c1", { path: "adopt-b.ts" }), toolResult("read", "c1", bigBlob()), user("a")];
		planContextPrune(base, 1);
		const unrelated = [user("x"), user("y"), user("z")];
		adoptSupersedeScanState(base, unrelated);
		// No stale indices leak into the unrelated array's plan.
		expect(sorted(planContextPrune(unrelated, 1).supersededIndices)).toEqual([]);
	});
});

describe("cloneForArgElision — clones only the targeted assistant messages", () => {
	it("shares all non-target messages by reference and isolates elision from the original", () => {
		const big = "x".repeat(4000);
		const messages = [
			toolCall("write", "w1", { path: "f1.ts", content: big }),
			toolResult("write", "w1", "ok"),
			toolCall("write", "w2", { path: "f2.ts", content: big }),
			toolResult("write", "w2", "ok"),
			user("a"),
		];
		const copy = cloneForArgElision(messages, ["w1", "w2"]);
		expect(copy).not.toBe(messages);
		expect(copy[0]).not.toBe(messages[0]);
		expect(copy[2]).not.toBe(messages[2]);
		expect(copy[1]).toBe(messages[1]);
		expect(copy[4]).toBe(messages[4]);
		expect(elideMutatingToolCallArguments(copy, "w1")).toBeGreaterThan(0);
		const originalArgs = (messages[0] as unknown as { content: { arguments: { content: string } }[] }).content[0]
			.arguments;
		expect(originalArgs.content.length).toBe(4000);
	});
});
