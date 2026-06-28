import type { AgentMessage } from "@pit/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { applyLiveContextEconomyAfterToolSuccess } from "../src/core/agent-session-live-prune.js";
import {
	applySupersedeOnly,
	elideMutatingToolCallArguments,
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
