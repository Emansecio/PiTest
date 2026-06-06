import { describe, expect, it } from "vitest";
import { type BashOperations, createBashTool } from "../src/core/tools/bash.js";

/** A bash op that emits the given output once and exits 0 (no real process). */
function bashEmitting(content: string): BashOperations {
	return {
		exec: async (_command, _cwd, { onData }) => {
			onData(Buffer.from(content, "utf-8"));
			return { exitCode: 0 };
		},
	};
}

async function runBash(content: string): Promise<string> {
	const tool = createBashTool(process.cwd(), { operations: bashEmitting(content) });
	const res = await tool.execute("t1", { command: "gh api repos/x/y/issues" });
	return (res.content[0] as { text: string }).text;
}

function withFlag(value: string | undefined, fn: () => Promise<void>): Promise<void> {
	const prev = process.env.PIT_JSON_CRUSH;
	if (value === undefined) delete process.env.PIT_JSON_CRUSH;
	else process.env.PIT_JSON_CRUSH = value;
	return fn().finally(() => {
		if (prev === undefined) delete process.env.PIT_JSON_CRUSH;
		else process.env.PIT_JSON_CRUSH = prev;
	});
}

// > 24KB bash byte budget so the output truncates and the full body is persisted
// to the temp file the crush reads back. Minified (single line), like `gh api`.
const bigJson = JSON.stringify(
	Array.from({ length: 1500 }, (_, i) => ({ id: i, name: `item-${i}`, status: i % 2 ? "ok" : "err" })),
);

describe("bash + json-crush (phase 3 follow-up, behind PIT_JSON_CRUSH)", () => {
	it("structurally crushes large truncated JSON bash output when the flag is on", async () => {
		await withFlag("1", async () => {
			const text = await runBash(bigJson);
			expect(text).toContain("items elided"); // structural crush from the temp file
			expect(text).toContain('"status"'); // schema preserved
			expect(text).toContain("item-0"); // head sample
			expect(text).toContain("crushed to schema"); // recovery footer
			expect(text).toContain("Full output:"); // temp-file path for recovery
		});
	});

	it("falls back to the blind truncation when the flag is off", async () => {
		await withFlag(undefined, async () => {
			const text = await runBash(bigJson);
			expect(text).not.toContain("items elided");
			expect(text).toContain("Full output:"); // normal truncation notice
		});
	});

	it("leaves non-JSON output to normal truncation even with the flag on", async () => {
		await withFlag("1", async () => {
			const bigLog = Array.from({ length: 3000 }, (_, i) => `log line ${i} doing work`).join("\n");
			const text = await runBash(bigLog);
			expect(text).not.toContain("items elided");
			expect(text).toContain("Full output:");
		});
	});
});
