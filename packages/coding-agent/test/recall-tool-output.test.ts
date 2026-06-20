import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferredOutputStore, setCurrentDeferredOutputStore } from "../src/core/deferred-output-store.js";
import type { ToolDefinition } from "../src/core/extensions/types.js";
import { createRecallToolOutputDefinition, createRecallToolOutputTool } from "../src/core/tools/recall-tool-output.js";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.js";

const CWD = process.cwd();

afterEach(() => {
	setCurrentDeferredOutputStore(undefined);
});

describe("recall_tool_output tool", () => {
	it("returns content for a valid id when store is set", async () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);
		const id = store.put("the full tool output text");

		const def = createRecallToolOutputDefinition(CWD);
		const result = (await def.execute("tc1", { id }, undefined, undefined, undefined as any)) as any;

		expect(result.isError).toBeFalsy();
		const text = result.content.find((b: any) => b.type === "text")?.text;
		expect(text).toBe("the full tool output text");
		expect(result.details?.found).toBe(true);
		store.dispose();
	});

	it("returns isError and message for unknown id when store is set", async () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);

		const def = createRecallToolOutputDefinition(CWD);
		const result = (await def.execute("tc2", { id: "d999" }, undefined, undefined, undefined as any)) as any;

		expect(result.isError).toBe(true);
		const text = result.content.find((b: any) => b.type === "text")?.text;
		expect(text).toContain("d999");
		expect(result.details?.found).toBe(false);
		store.dispose();
	});

	it("returns isError and unavailable message when no store is set", async () => {
		setCurrentDeferredOutputStore(undefined);
		const def = createRecallToolOutputDefinition(CWD);
		const result = (await def.execute("tc3", { id: "d1" }, undefined, undefined, undefined as any)) as any;

		expect(result.isError).toBe(true);
		const text = result.content.find((b: any) => b.type === "text")?.text;
		expect(text).toMatch(/unavailable/i);
	});

	it("tool name and label are recall_tool_output", () => {
		const def = createRecallToolOutputDefinition(CWD);
		expect(def.name).toBe("recall_tool_output");
		expect(def.label).toBe("recall_tool_output");
	});

	it("wrapped recall preserves HEAD and TAIL for a >64KB deferred output (head+tail, not head-only)", async () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);
		// Build a >64KB payload with distinct head/tail sentinels; the middle is a
		// large filler that must be elided. The tail carries the decisive signal.
		const head = "HEAD_SENTINEL_START\n";
		const tail = "\nTAIL_SENTINEL_END__error: boom at line 42";
		// Exceed the dedicated 256KB recall cap so the middle is actually elided.
		const filler = `${"x".repeat(120)}\n`.repeat(3000); // ~363KB of middle
		const full = head + filler + tail;
		expect(Buffer.byteLength(full, "utf-8")).toBeGreaterThan(256 * 1024);
		const id = store.put(full);

		const tool = createRecallToolOutputTool(CWD);
		const result = (await tool.execute(id, { id }, undefined, undefined)) as any;
		const text: string = result.content.find((b: any) => b.type === "text")?.text;

		expect(text).toContain("HEAD_SENTINEL_START");
		// The decisive proof: head-only truncation would DROP this. It must survive.
		expect(text).toContain("TAIL_SENTINEL_END__error: boom at line 42");
		expect(text).toContain("truncated from the middle");
		// And the recall must still fit within its dedicated 256KB cap.
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(256 * 1024 + 4096);
		store.dispose();
	});

	it("a common wrapped tool still gets the 64KB HEAD-ONLY cap (no regression)", async () => {
		const head = "COMMON_HEAD_SENTINEL\n";
		const tail = "\nCOMMON_TAIL_SENTINEL";
		const filler = `${"y".repeat(120)}\n`.repeat(1200); // ~145KB
		const big = head + filler + tail;

		const def: ToolDefinition<any, unknown> = {
			name: "common_tool",
			label: "common_tool",
			description: "test",
			parameters: Type.Object({}),
			async execute() {
				return { content: [{ type: "text" as const, text: big }], details: undefined };
			},
		};
		const tool = wrapToolDefinition(def);
		const result = (await tool.execute("tc", {}, undefined, undefined)) as any;
		const text: string = result.content.find((b: any) => b.type === "text")?.text;

		expect(text).toContain("COMMON_HEAD_SENTINEL");
		// Head-only cap: the tail sentinel is dropped, and the head-only note (not the
		// head+tail note) is used.
		expect(text).not.toContain("COMMON_TAIL_SENTINEL");
		expect(text).toContain("was truncated");
		expect(text).not.toContain("truncated from the middle");
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThanOrEqual(64 * 1024 + 4096);
	});
});
