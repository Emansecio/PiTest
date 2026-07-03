import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@pit/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { pruneOldToolOutputs } from "../src/core/compaction/compaction.ts";
import {
	createDeferredOutputStore,
	type DeferredOutputStore,
	setCurrentDeferredOutputStore,
} from "../src/core/deferred-output-store.ts";

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

afterEach(() => {
	setCurrentDeferredOutputStore(undefined);
});

/**
 * Regression for #15 / M17: a deferred-store failure during the live-context
 * prune must NOT abort the turn that awaits it.
 *
 * The real store degrades a spill I/O failure internally (put keeps the entry
 * in memory and never throws), so the primary scenario is: spill fails →
 * store stays usable → prune still defers and the recall id round-trips.
 */
describe("pruneOldToolOutputs tolerates deferred-store failures", () => {
	it("spill I/O failure degrades the real store to memory-only; prune defers and recall works", () => {
		const tmp = mkdtempSync(join(tmpdir(), "pit-prune-spill-"));
		try {
			// A regular file where the spill dir's parent should be makes the lazy
			// mkdirSync of the spill dir fail — a real I/O failure during spill.
			const blocker = join(tmp, "blocker");
			writeFileSync(blocker, "not a dir", "utf8");
			const store = createDeferredOutputStore({ memoryCapBytes: 1024, spillDir: join(blocker, "sub") });
			setCurrentDeferredOutputStore(store);

			const big = "x".repeat(120_000); // > prune threshold so it defers; > cap so it tries to spill
			const messages = messagesWithToolOutput(big);

			expect(() => pruneOldToolOutputs(messages, undefined, undefined, true)).not.toThrow();
			const text = firstText(messages);
			// put succeeded (memory-only degradation), so the hybrid excerpt carries a recall id.
			expect(text).toContain("recall_tool_output");
			const match = text.match(/recall_tool_output\(\{ id: "(d\d+)" \}\)/);
			expect(match).not.toBeNull();
			const id = match?.[1] ?? "";
			// The full text is still recoverable despite the dead disk.
			expect(store.get(id)).toBe(big);
			store.dispose();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("defensive: a store whose put() throws still degrades to the excerpt instead of aborting", () => {
		// The real store's put never throws (I/O failures degrade internally), but
		// compaction guards against arbitrary store implementations; keep that
		// catch-branch covered.
		const throwingStore: DeferredOutputStore = {
			put: () => {
				throw new Error("boom");
			},
			get: () => undefined,
			dispose: () => {},
		};
		setCurrentDeferredOutputStore(throwingStore);

		const big = "x".repeat(120_000);
		const messages = messagesWithToolOutput(big);

		expect(() => pruneOldToolOutputs(messages, undefined, undefined, true)).not.toThrow();
		const text = firstText(messages);
		// Degraded to an excerpt, not the deferred placeholder.
		expect(text).not.toContain("recall_tool_output");
		expect(text).toContain("elided");
		expect(text.length).toBeLessThan(big.length);
	});
});
