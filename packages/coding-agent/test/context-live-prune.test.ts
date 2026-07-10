import type { AgentMessage } from "@pit/agent-core";
import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { applyLiveContextEconomyAfterToolSuccess } from "../src/core/agent-session-live-prune.js";
import {
	applySupersedeOnly,
	cloneToolResultMessagesForPrune,
	elideMutatingToolCallArguments,
	planContextPrune,
	pruneOldToolOutputs,
	wouldApplySupersedeOnly,
} from "../src/core/compaction/compaction.js";

const CONTEXT_WINDOW = 1_000_000;

function bigBlob(): string {
	return `HEAD\n${"line\n".repeat(800)}TAIL`;
}

function toolCall(name: string, id: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		timestamp: 1,
	} as AgentMessage;
}

function toolResult(toolName: string, toolCallId: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	} as AgentMessage;
}

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function textAt(messages: AgentMessage[], i: number): string {
	return (messages[i] as { content: { text: string }[] }).content[0].text;
}

function argsAt(messages: AgentMessage[], i: number): Record<string, unknown> {
	const block = (messages[i] as { content: { arguments: Record<string, unknown> }[] }).content[0];
	return block.arguments;
}

describe("applySupersedeOnly (A1′)", () => {
	it("collapses superseded reads without a size threshold", () => {
		const blob = bigBlob();
		const messages = [
			toolCall("read", "c1", { path: "foo.ts" }),
			toolResult("read", "c1", blob),
			toolCall("read", "c2", { path: "foo.ts" }),
			toolResult("read", "c2", "fresh"),
			user("a"),
			user("b"),
		];

		expect(wouldApplySupersedeOnly(messages, 2)).toBe(true);
		const reclaimed = applySupersedeOnly(messages, 2);
		expect(reclaimed).toBeGreaterThan(0);
		expect(textAt(messages, 1).length).toBeLessThan(blob.length);
		expect(textAt(messages, 3)).toBe("fresh");
	});
});

describe("elideMutatingToolCallArguments (A3)", () => {
	afterEach(() => {
		delete process.env.PIT_NO_LIVE_ARG_ELISION;
	});

	it("elides heavy edit args immediately after success", () => {
		const oldBody = "x".repeat(5000);
		const messages = [
			toolCall("edit", "e1", { path: "a.ts", oldText: oldBody, newText: "y".repeat(5000) }),
			toolResult("edit", "e1", "Edited a.ts"),
			user("done"),
		];

		const reclaimed = elideMutatingToolCallArguments(messages, "e1");
		expect(reclaimed).toBeGreaterThan(1000);
		expect(JSON.stringify(argsAt(messages, 0))).toContain("chars elided");
	});
});

describe("applyLiveContextEconomyAfterToolSuccess (D2 + A3)", () => {
	afterEach(() => {
		delete process.env.PIT_NO_LIVE_SUPERSEDE;
		delete process.env.PIT_NO_LIVE_ARG_ELISION;
		resetRuntimeDiagnostics();
	});

	it("supersedes older read output when a duplicate read succeeds", () => {
		const blob = bigBlob();
		const messages = [
			toolCall("read", "c1", { path: "foo.ts" }),
			toolResult("read", "c1", blob),
			toolCall("read", "c2", { path: "foo.ts" }),
			toolResult("read", "c2", "fresh"),
			user("a"),
			user("b"),
		];

		const outcome = applyLiveContextEconomyAfterToolSuccess(
			messages,
			{ type: "toolCall", id: "c2", name: "read", arguments: { path: "foo.ts" } },
			false,
			CONTEXT_WINDOW,
		);

		expect(outcome.supersedeReclaimed).toBeGreaterThan(0);
		expect(textAt(outcome.messages, 1).length).toBeLessThan(blob.length);
	});

	it("records structured prune.live diagnostics with toolName and reclaimedTokens", () => {
		const blob = bigBlob();
		const messages = [
			toolCall("read", "c1", { path: "foo.ts" }),
			toolResult("read", "c1", blob),
			toolCall("read", "c2", { path: "foo.ts" }),
			toolResult("read", "c2", "fresh"),
			user("a"),
			user("b"),
		];

		const outcome = applyLiveContextEconomyAfterToolSuccess(
			messages,
			{ type: "toolCall", id: "c2", name: "read", arguments: { path: "foo.ts" } },
			false,
			CONTEXT_WINDOW,
		);

		expect(outcome.reclaimed).toBeGreaterThan(0);
		const snap = getRuntimeDiagnostics();
		const live = snap.counters["prune.live"];
		expect(live?.count).toBeGreaterThanOrEqual(1);
		expect(live?.lastContext?.toolName).toBe("read");
		expect(live?.lastContext?.mechanism).toBe("supersede");
		expect(live?.lastContext?.reclaimedTokens).toBe(outcome.reclaimed);
		expect(live?.lastContext?.bytes).toBe(outcome.reclaimed);
	});

	it("elides edit args on successful mutating tool without waiting for prune threshold", () => {
		const oldBody = "z".repeat(6000);
		const messages = [
			toolCall("edit", "e1", { path: "b.ts", oldText: oldBody, newText: "w".repeat(6000) }),
			toolResult("edit", "e1", "Edited b.ts"),
			user("checkpoint"),
			user("final"),
		];

		const outcome = applyLiveContextEconomyAfterToolSuccess(
			messages,
			{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "b.ts", oldText: oldBody, newText: "w" } },
			false,
			CONTEXT_WINDOW,
		);

		expect(outcome.argElisionReclaimed).toBeGreaterThan(1000);
		expect(JSON.stringify(argsAt(outcome.messages, 0))).toContain("chars elided");
	});

	it("supersedes older lsp diagnostics output when the same file is rechecked", () => {
		const blob = bigBlob();
		const messages = [
			toolCall("lsp", "l1", { action: "diagnostics", file: "foo.ts" }),
			toolResult("lsp", "l1", blob),
			toolCall("lsp", "l2", { action: "diagnostics", file: "foo.ts" }),
			toolResult("lsp", "l2", "fresh diagnostics"),
			user("a"),
			user("b"),
		];

		const outcome = applyLiveContextEconomyAfterToolSuccess(
			messages,
			{ type: "toolCall", id: "l2", name: "lsp", arguments: { action: "diagnostics", file: "foo.ts" } },
			false,
			CONTEXT_WINDOW,
		);

		expect(outcome.supersedeReclaimed).toBeGreaterThan(0);
		expect(textAt(outcome.messages, 1).length).toBeLessThan(blob.length);
		expect(textAt(outcome.messages, 3)).toBe("fresh diagnostics");
	});

	it("does not supersede lsp rename results", () => {
		const messages = [
			toolCall("lsp", "r1", { action: "rename", file: "a.ts", line: 1, symbol: "foo", new_name: "bar" }),
			toolResult("lsp", "r1", "Applied rename"),
			toolCall("lsp", "r2", { action: "rename", file: "a.ts", line: 1, symbol: "foo", new_name: "bar" }),
			toolResult("lsp", "r2", "Applied rename again"),
			user("a"),
			user("b"),
		];

		const outcome = applyLiveContextEconomyAfterToolSuccess(
			messages,
			{
				type: "toolCall",
				id: "r2",
				name: "lsp",
				arguments: { action: "rename", file: "a.ts", line: 1, symbol: "foo", new_name: "bar" },
			},
			false,
			CONTEXT_WINDOW,
		);

		expect(outcome.supersedeReclaimed).toBe(0);
		expect(textAt(outcome.messages, 1)).toBe("Applied rename");
	});

	it("skips live economy when isError is true (e.g. tool_result hook override)", () => {
		const blob = bigBlob();
		const messages = [
			toolCall("read", "c1", { path: "foo.ts" }),
			toolResult("read", "c1", blob),
			toolCall("read", "c2", { path: "foo.ts" }),
			toolResult("read", "c2", "fresh"),
			user("a"),
			user("b"),
		];
		const beforeLen = textAt(messages, 1).length;

		const outcome = applyLiveContextEconomyAfterToolSuccess(
			messages,
			{ type: "toolCall", id: "c2", name: "read", arguments: { path: "foo.ts" } },
			true,
			CONTEXT_WINDOW,
		);

		expect(outcome.reclaimed).toBe(0);
		expect(outcome.messages).toBe(messages);
		expect(textAt(outcome.messages, 1).length).toBe(beforeLen);
	});

	it("respects PIT_NO_LIVE_ARG_ELISION", () => {
		process.env.PIT_NO_LIVE_ARG_ELISION = "1";
		const oldBody = "q".repeat(6000);
		const messages = [
			toolCall("edit", "e1", { path: "c.ts", oldText: oldBody, newText: "w".repeat(6000) }),
			toolResult("edit", "e1", "Edited c.ts"),
		];

		const outcome = applyLiveContextEconomyAfterToolSuccess(
			messages,
			{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "c.ts" } },
			false,
			CONTEXT_WINDOW,
		);

		expect(outcome.argElisionReclaimed).toBe(0);
		expect(JSON.stringify(argsAt(outcome.messages, 0))).toContain(oldBody.slice(0, 20));
	});
});

describe("incremental supersede scan cache (planContextPrune)", () => {
	/** Full rebuild oracle: a fresh slice is a new array reference → cache miss. */
	function fullRebuild(messages: AgentMessage[], protectTurns: number): Set<number> {
		return planContextPrune(messages.slice(), protectTurns).supersededIndices;
	}

	function sorted(set: Set<number>): number[] {
		return [...set].sort((a, b) => a - b);
	}

	it("matches a full rebuild after every push in a growing message array", () => {
		const blob = bigBlob();
		// Interleaved reads/greps/ls with duplicates, plus non-superseded traffic.
		const script: AgentMessage[] = [
			toolCall("read", "c1", { path: "foo.ts" }),
			toolResult("read", "c1", blob),
			user("look at foo"),
			toolCall("grep", "c2", { pattern: "alpha" }),
			toolResult("grep", "c2", blob),
			toolCall("read", "c3", { path: "foo.ts" }),
			toolResult("read", "c3", "fresh foo"),
			toolCall("edit", "c4", { path: "foo.ts", oldText: "a", newText: "b" }),
			toolResult("edit", "c4", "Edited"),
			toolCall("grep", "c5", { pattern: "alpha" }),
			toolResult("grep", "c5", "fresh grep"),
			toolCall("ls", "c6", { path: "src" }),
			toolResult("ls", "c6", blob),
			user("now bar"),
			toolCall("read", "c7", { path: "bar.ts" }),
			toolResult("read", "c7", blob),
			toolCall("ls", "c8", { path: "src" }),
			toolResult("ls", "c8", "fresh ls"),
			toolCall("read", "c9", { path: "bar.ts" }),
			toolResult("read", "c9", "fresh bar"),
			user("a"),
			user("b"),
		];

		for (const protectTurns of [0, 2]) {
			const messages: AgentMessage[] = [];
			for (const msg of script) {
				messages.push(msg);
				// Same array reference every iteration → the cache extends incrementally.
				const incremental = planContextPrune(messages, protectTurns).supersededIndices;
				expect(sorted(incremental)).toEqual(sorted(fullRebuild(messages, protectTurns)));
			}
		}
	});

	it("matches a full rebuild across array reassignment (slice) followed by more pushes", () => {
		const blob = bigBlob();
		let messages: AgentMessage[] = [
			toolCall("read", "c1", { path: "foo.ts" }),
			toolResult("read", "c1", blob),
			toolCall("read", "c2", { path: "foo.ts" }),
			toolResult("read", "c2", "fresh"),
			user("a"),
			user("b"),
		];
		planContextPrune(messages, 2); // warm the cache on the first reference

		// Simulate the prune/compaction cycle: reassignment produces a new reference.
		messages = messages.slice();
		messages.push(toolCall("read", "c3", { path: "foo.ts" }), toolResult("read", "c3", "freshest"), user("c"));
		const incremental = planContextPrune(messages, 2).supersededIndices;
		expect(sorted(incremental)).toEqual(sorted(fullRebuild(messages, 2)));

		// And keep growing the new reference incrementally.
		messages.push(toolCall("read", "c4", { path: "foo.ts" }), toolResult("read", "c4", "newest"), user("d"));
		const incremental2 = planContextPrune(messages, 2).supersededIndices;
		expect(sorted(incremental2)).toEqual(sorted(fullRebuild(messages, 2)));
	});

	it("derives per-protectFromIndex from the same cached scan (different protectTurns, same array)", () => {
		const blob = bigBlob();
		const messages: AgentMessage[] = [
			user("start"),
			toolCall("read", "c1", { path: "foo.ts" }),
			toolResult("read", "c1", blob),
			toolCall("read", "c2", { path: "foo.ts" }),
			toolResult("read", "c2", "fresh"),
			user("end"),
		];

		// protectTurns=2 protects from the first user onward → nothing markable.
		expect(sorted(planContextPrune(messages, 2).supersededIndices)).toEqual([]);
		// protectTurns=1 protects only the trailing turn → the stale read (index 2) is marked.
		expect(sorted(planContextPrune(messages, 1).supersededIndices)).toEqual([2]);
		// protectTurns=0 protects nothing → same marking.
		expect(sorted(planContextPrune(messages, 0).supersededIndices)).toEqual([2]);
		// Repeat the first query on the SAME array — the cached scan must not have
		// been narrowed by the later derivations.
		expect(sorted(planContextPrune(messages, 2).supersededIndices)).toEqual([]);
	});

	it("returns a fresh Set each call (mutating the result does not poison the cache)", () => {
		const blob = bigBlob();
		const messages: AgentMessage[] = [
			toolCall("read", "c1", { path: "foo.ts" }),
			toolResult("read", "c1", blob),
			toolCall("read", "c2", { path: "foo.ts" }),
			toolResult("read", "c2", "fresh"),
			user("a"),
			user("b"),
		];

		const first = planContextPrune(messages, 2).supersededIndices;
		expect(sorted(first)).toEqual([1]);
		first.clear();
		expect(sorted(planContextPrune(messages, 2).supersededIndices)).toEqual([1]);
	});

	it("is unaffected by pruning a clone of the cached array", () => {
		const blob = bigBlob();
		const messages: AgentMessage[] = [
			toolCall("read", "c1", { path: "foo.ts" }),
			toolResult("read", "c1", blob),
			toolCall("read", "c2", { path: "foo.ts" }),
			toolResult("read", "c2", "fresh"),
			user("a"),
			user("b"),
		];

		const before = sorted(planContextPrune(messages, 2).supersededIndices);
		const clone = cloneToolResultMessagesForPrune(messages);
		pruneOldToolOutputs(clone, 1, 2);
		const after = sorted(planContextPrune(messages, 2).supersededIndices);
		expect(after).toEqual(before);
		expect(after).toEqual(sorted(fullRebuild(messages, 2)));
	});

	it("handles a toolResult whose toolCall arrives in a later push (unkeyedResults retry)", () => {
		const blob = bigBlob();
		const messages: AgentMessage[] = [toolResult("read", "c9", blob)];
		// First scan sees an orphan result — nothing marked yet.
		expect(sorted(planContextPrune(messages, 0).supersededIndices)).toEqual([]);

		// The call for c9 (and a fresh duplicate read) arrive in a later push.
		messages.push(
			toolCall("read", "c9", { path: "late.ts" }),
			toolCall("read", "c10", { path: "late.ts" }),
			toolResult("read", "c10", "fresh late"),
			user("a"),
			user("b"),
		);
		const incremental = planContextPrune(messages, 2).supersededIndices;
		expect(sorted(incremental)).toEqual(sorted(fullRebuild(messages, 2)));
		expect(sorted(incremental)).toEqual([0]);
	});
});
