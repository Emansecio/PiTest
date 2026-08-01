/**
 * The turn-files rail ledger, driven end to end through the REAL
 * InteractiveMode.handleEvent (headless harness).
 *
 * Regression anchor: the rail listed files with a permanent `+0 −0` because
 * `write` reported no details — the ledger only ever counted `edit`'s diff.
 * Write now reports `details.files` with a real old→new delta (see
 * write.ts/WriteToolDetails); these tests pin the full event → ledger path
 * for both report shapes and the args-only fallback.
 */

import { afterEach, describe, expect, test } from "vitest";
import { TurnFilesComponent } from "../src/modes/interactive/components/turn-files.ts";
import { createInteractiveHarness, type InteractiveHarness } from "./interactive-harness.ts";

let harness: InteractiveHarness | undefined;

afterEach(() => {
	harness?.dispose();
	harness = undefined;
});

async function setup(): Promise<{ h: InteractiveHarness; internals: Record<string, any> }> {
	harness = createInteractiveHarness();
	const internals = harness.internals();
	// init() is what mounts turnFiles; the harness skips init, so inject it.
	internals.turnFiles = new TurnFilesComponent();
	await harness.emit({ type: "agent_start" } as never);
	return { h: harness, internals };
}

async function emitTool(
	h: InteractiveHarness,
	toolName: string,
	callId: string,
	args: unknown,
	result: unknown,
): Promise<void> {
	await h.emit({ type: "tool_execution_start", toolName, toolCallId: callId, args } as never);
	await h.emit({ type: "tool_execution_end", toolName, toolCallId: callId, isError: false, result } as never);
}

describe("turn files ledger (headless InteractiveMode)", () => {
	test("edit counts its details.diff", async () => {
		const { h, internals } = await setup();
		await emitTool(
			h,
			"edit",
			"c1",
			{ path: "src/foo.ts" },
			{
				content: [{ type: "text", text: "ok" }],
				details: { diff: "+10 novo\n+11 novo2\n-10 velho\n 12 contexto", firstChangedLine: 10 },
			},
		);
		expect([...internals.turnFileLedger.values()]).toEqual([{ path: "src/foo.ts", added: 2, removed: 1 }]);
	});

	test("write's details.files lands real counters (the +0 −0 regression)", async () => {
		const { h, internals } = await setup();
		await emitTool(
			h,
			"write",
			"c1",
			{ path: "scan4.ps1", content: "x" },
			{
				content: [{ type: "text", text: "Successfully wrote" }],
				details: { files: [{ path: "scan4.ps1", added: 12, removed: 3 }] },
			},
		);
		expect([...internals.turnFileLedger.values()]).toEqual([{ path: "scan4.ps1", added: 12, removed: 3 }]);
	});

	test("write and edit to the same path accumulate in one row", async () => {
		const { h, internals } = await setup();
		await emitTool(
			h,
			"write",
			"c1",
			{ path: "src/foo.ts", content: "x" },
			{
				content: [{ type: "text", text: "ok" }],
				details: { files: [{ path: "src/foo.ts", added: 5, removed: 0 }] },
			},
		);
		await emitTool(
			h,
			"edit",
			"c2",
			{ path: "src/foo.ts" },
			{
				content: [{ type: "text", text: "ok" }],
				details: { diff: "+1 a\n-1 b" },
			},
		);
		expect([...internals.turnFileLedger.values()]).toEqual([{ path: "src/foo.ts", added: 6, removed: 1 }]);
	});

	test("code-mode: inner write events count; the outer code call adds no row", async () => {
		const { h, internals } = await setup();
		// The real sequence a `code` program produces: the outer `code` call plus
		// one harness-routed inner event pair per `tools.write(...)` it runs (the
		// session's code-mode dispatcher mirrors the agent loop's start/end with
		// the FULL tool result — details included).
		await h.emit({
			type: "tool_execution_start",
			toolName: "code",
			toolCallId: "outer",
			args: { code: "await tools.write({ path: 'scan5.ps1', content: '...' })" },
		} as never);
		await emitTool(
			h,
			"write",
			"code_inner1",
			{ path: "scan5.ps1", content: "x" },
			{
				content: [{ type: "text", text: "Successfully wrote" }],
				details: { files: [{ path: "scan5.ps1", added: 7, removed: 2 }] },
			},
		);
		await h.emit({
			type: "tool_execution_end",
			toolName: "code",
			toolCallId: "outer",
			isError: false,
			result: { content: [{ type: "text", text: "ok" }], details: { durationMs: 12, hadError: false } },
		} as never);

		expect([...internals.turnFileLedger.values()]).toEqual([{ path: "scan5.ps1", added: 7, removed: 2 }]);
	});

	test("a detail-less single-file tool still lands as a touch (args fallback)", async () => {
		const { h, internals } = await setup();
		await emitTool(
			h,
			"write",
			"c1",
			{ path: "remote.txt", content: "x" },
			{
				content: [{ type: "text", text: "ok" }],
				details: undefined,
			},
		);
		expect([...internals.turnFileLedger.values()]).toEqual([{ path: "remote.txt", added: 0, removed: 0 }]);
	});
});
