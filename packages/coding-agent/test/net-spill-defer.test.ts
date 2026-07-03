/**
 * N1 — universal spill on the 64KB net (AUDITORIA-ECONOMIA-TOKENS.md §5.4).
 *
 * When `capToolOutputBytes` cuts a tool result it now (a) defaults to head+tail
 * (keeps the decisive tail), and (b) spills the FULL original text to the session
 * deferred-output store and appends a `recall_tool_output` placeholder, so nothing
 * the net elides is unrecoverable. Deferral degrades silently with no store and on
 * a store write failure; the thrown-error cap never defers.
 */

import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFERRED_OUTPUT_PLACEHOLDER_FORMAT,
	formatDeferredOutputPlaceholder,
} from "../src/core/compaction/compaction.js";
import {
	createDeferredOutputStore,
	type DeferredOutputStore,
	setCurrentDeferredOutputStore,
} from "../src/core/deferred-output-store.js";
import type { ToolDefinition } from "../src/core/extensions/types.js";
import { withOutputCap, wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.js";

afterEach(() => setCurrentDeferredOutputStore(undefined));

function textTool(text: string): ToolDefinition<any, unknown> {
	return {
		name: "gen",
		label: "gen",
		description: "returns a fixed text block",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text" as const, text }], details: undefined };
		},
	};
}

async function runText(def: ToolDefinition<any, unknown>): Promise<string> {
	const tool = wrapToolDefinition(def);
	const result = (await tool.execute("id", {}, undefined, undefined)) as {
		content: Array<{ type: string; text?: string }>;
	};
	return result.content.find((b) => b.type === "text")?.text ?? "";
}

/** A >64KB block with distinct head/tail sentinels and a large elidable middle. */
function bigBlock(): string {
	const head = "HEAD_SENTINEL_START\n";
	const tail = "\nTAIL_SENTINEL_END_decisive_final_status";
	const filler = `${"z".repeat(120)}\n`.repeat(1200); // ~145KB
	return head + filler + tail;
}

function extractId(text: string): string | undefined {
	return text.match(/recall_tool_output\(\{ id: "(d\d+)" \}\)/)?.[1];
}

describe("N1 universal net spill (capToolOutputBytes)", () => {
	it("spills the full text and appends a recoverable recall placeholder when a store is set", async () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);
		const full = bigBlock();

		const text = await runText(textTool(full));

		// Head+tail default: both ends survive inline, middle elided.
		expect(text).toContain("HEAD_SENTINEL_START");
		expect(text).toContain("TAIL_SENTINEL_END_decisive_final_status");
		expect(text).toContain("truncated from the middle");
		// A recall placeholder is appended...
		const id = extractId(text);
		expect(id).toBeTruthy();
		expect(text).toContain(`recall_tool_output({ id: "${id}" })`);
		// ...and the id resolves to the COMPLETE original text (including the elided middle).
		expect(store.get(id as string)).toBe(full);
		store.dispose();
	});

	it("emits a placeholder that matches the shared DEFERRED_OUTPUT_PLACEHOLDER_FORMAT", async () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);

		const text = await runText(textTool(bigBlock()));
		const id = extractId(text) as string;
		// The appended line is exactly what formatDeferredOutputPlaceholder produces,
		// which is the same template recall_tool_output's description quotes.
		expect(text).toContain("[Full output (~");
		expect(DEFERRED_OUTPUT_PLACEHOLDER_FORMAT).toContain('recall_tool_output({ id: "dN" })');
		// Reconstruct the exact line from the emitter and assert it is present verbatim.
		const tokens = Number(text.match(/\(~(\d+) tokens\)/)?.[1]);
		expect(text).toContain(formatDeferredOutputPlaceholder(tokens, id));
		store.dispose();
	});

	it("falls back to a plain head+tail cut (no placeholder) when there is no current store", async () => {
		setCurrentDeferredOutputStore(undefined);
		const text = await runText(textTool(bigBlock()));
		expect(text).toContain("HEAD_SENTINEL_START");
		expect(text).toContain("TAIL_SENTINEL_END_decisive_final_status");
		expect(text).not.toContain("recall_tool_output");
	});

	it("degrades silently (no placeholder, still cut) when the store write throws", async () => {
		const throwingStore: DeferredOutputStore = {
			put() {
				throw new Error("disk exploded");
			},
			get() {
				return undefined;
			},
			dispose() {},
		};
		setCurrentDeferredOutputStore(throwingStore);
		const text = await runText(textTool(bigBlock()));
		// The cut still happened and the tool did not throw.
		expect(text).toContain("kept head + tail");
		expect(text).not.toContain("recall_tool_output");
	});

	it("leaves a per-tool head-only cap head-only, but still spills the dropped tail", async () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);
		const full = bigBlock();

		const text = await runText(withOutputCap(textTool(full), { maxBytes: 64 * 1024, mode: "head" }));

		// Head-only inline excerpt: the tail is dropped from what the model sees...
		expect(text).toContain("HEAD_SENTINEL_START");
		expect(text).not.toContain("TAIL_SENTINEL_END_decisive_final_status");
		expect(text).toContain("was truncated");
		expect(text).not.toContain("truncated from the middle");
		// ...but the full text (including the dropped tail) is recoverable via the store.
		const id = extractId(text) as string;
		expect(id).toBeTruthy();
		expect(store.get(id)).toBe(full);
		expect(store.get(id)).toContain("TAIL_SENTINEL_END_decisive_final_status");
		store.dispose();
	});

	it("does not cut or defer when a raised per-tool cap comfortably fits the output", async () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);
		const full = bigBlock(); // ~145KB, well under a 256KB cap

		const text = await runText(withOutputCap(textTool(full), { maxBytes: 256 * 1024, mode: "headTail" }));

		expect(text).toBe(full); // untouched
		expect(text).not.toContain("recall_tool_output");
		expect(text).not.toContain("truncated from the middle");
		store.dispose();
	});

	it("never defers a THROWN error, even with a store set (N1.5)", async () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);
		const tool = wrapToolDefinition({
			name: "boom",
			label: "boom",
			description: "throws big",
			parameters: Type.Object({}),
			async execute() {
				throw new Error("E".repeat(64 * 1024));
			},
		});
		let caught: unknown;
		try {
			await tool.execute("t", {}, undefined, undefined);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).not.toContain("recall_tool_output");
		// The thrown-error path never touched the store.
		expect(store.get("d1")).toBeUndefined();
		store.dispose();
	});
});
