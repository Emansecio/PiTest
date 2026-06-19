import type { AgentMessage } from "@pit/agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pruneOldToolOutputs } from "../src/core/compaction/compaction.ts";
import { type DeferredOutputStore, setCurrentDeferredOutputStore } from "../src/core/deferred-output-store.ts";

function messagesWithToolOutput(text: string): AgentMessage[] {
	return [
		{
			role: "toolResult",
			toolCallId: "t1",
			toolName: "bash",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 1,
		},
		{ role: "user", content: [{ type: "text", text: "a" }], timestamp: 2 },
		{ role: "user", content: [{ type: "text", text: "b" }], timestamp: 3 },
	] as unknown as AgentMessage[];
}

function firstText(messages: AgentMessage[]): string {
	return (messages[0] as unknown as { content: { text: string }[] }).content[0].text;
}

const prevFlag = process.env.PIT_DEFER_HISTORY;

beforeEach(() => {
	process.env.PIT_DEFER_HISTORY = "1";
});

afterEach(() => {
	setCurrentDeferredOutputStore(undefined);
	if (prevFlag === undefined) delete process.env.PIT_DEFER_HISTORY;
	else process.env.PIT_DEFER_HISTORY = prevFlag;
});

/**
 * Regression for #15: a failing store.put (e.g. ENOSPC on writeFileSync) must
 * NOT propagate out of pruneOldToolOutputs and abort the turn. It must degrade
 * to the in-message head+tail excerpt instead.
 */
describe("pruneOldToolOutputs tolerates a failing deferred store", () => {
	it("falls back to the excerpt instead of throwing when put() fails", () => {
		const throwingStore: DeferredOutputStore = {
			put: () => {
				throw new Error("ENOSPC: no space left on device");
			},
			get: () => undefined,
			dispose: () => {},
		};
		setCurrentDeferredOutputStore(throwingStore);

		const big = "x".repeat(120_000); // > prune threshold so it defers
		const messages = messagesWithToolOutput(big);

		expect(() => pruneOldToolOutputs(messages)).not.toThrow();
		const text = firstText(messages);
		// Degraded to an excerpt, not the deferred placeholder.
		expect(text).not.toContain("recall_tool_output");
		expect(text).toContain("elided");
		expect(text.length).toBeLessThan(big.length);
	});
});
