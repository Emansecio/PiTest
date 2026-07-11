import { describe, expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.js";
import { type BashOperations, createBashTool } from "../src/core/tools/bash.js";
import { BASH_MAX_LINES } from "../src/core/tools/truncate.js";

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

// json-crush is ON by default; PIT_NO_JSON_CRUSH=1 opts out.
function withCrush(enabled: boolean, fn: () => Promise<void>): Promise<void> {
	const prev = process.env.PIT_NO_JSON_CRUSH;
	if (enabled) delete process.env.PIT_NO_JSON_CRUSH;
	else process.env.PIT_NO_JSON_CRUSH = "1";
	return fn().finally(() => {
		if (prev === undefined) delete process.env.PIT_NO_JSON_CRUSH;
		else process.env.PIT_NO_JSON_CRUSH = prev;
	});
}

// > 24KB bash byte budget so the output truncates and the full body is persisted
// to the temp file the crush reads back. Minified (single line), like `gh api`.
const bigJson = JSON.stringify(
	Array.from({ length: 1500 }, (_, i) => ({ id: i, name: `item-${i}`, status: i % 2 ? "ok" : "err" })),
);

describe("bash + json-crush (on by default, opt out with PIT_NO_JSON_CRUSH)", () => {
	it("structurally crushes large truncated JSON bash output by default", async () => {
		await withCrush(true, async () => {
			const text = await runBash(bigJson);
			expect(text).toContain("items elided"); // structural crush from the temp file
			expect(text).toContain('"status"'); // schema preserved
			expect(text).toContain("item-0"); // head sample
			expect(text).toContain("crushed to schema"); // recovery footer
			expect(text).toContain("Full output:"); // temp-file path for recovery
		});
	});

	it("falls back to the blind truncation when crush is disabled", async () => {
		await withCrush(false, async () => {
			const text = await runBash(bigJson);
			expect(text).not.toContain("items elided");
			expect(text).toContain("Full output:"); // normal truncation notice
		});
	});

	it("leaves non-JSON output to normal truncation even when enabled", async () => {
		await withCrush(true, async () => {
			const bigLog = Array.from({ length: 3000 }, (_, i) => `log line ${i} doing work`).join("\n");
			const text = await runBash(bigLog);
			expect(text).not.toContain("items elided");
			expect(text).toContain("Full output:");
		});
	});
});

describe("executeBashWithOperations output budget (user `!` command)", () => {
	it("applies the bash tail budget (BASH_MAX_LINES) instead of the 2000-line default", async () => {
		// 3000 lines: truncated under the 1000-line bash budget but NOT under the
		// old 2000-line default — proves the bash budget is now in effect.
		const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
		const res = await executeBashWithOperations("seq 3000", process.cwd(), bashEmitting(lines));

		expect(res.truncated).toBe(true);
		// Tail-only: the last line survives, the first does not.
		expect(res.output).toContain("line 2999");
		expect(res.output).not.toContain("line 0\n");
		// Honors the 1000-line cap (well under the previous 2000-line default).
		expect(res.output.split("\n").length).toBeLessThanOrEqual(BASH_MAX_LINES);
		// Full output is spilled to a temp file for recovery.
		expect(res.fullOutputPath).toBeDefined();
	});

	it("collapses runs of identical consecutive lines like the agent bash tool", async () => {
		// 50 identical lines + a unique tail line — small enough to NOT truncate, so
		// the only transform under test is collapseRepeatedLines.
		const repeated = `${Array.from({ length: 50 }, () => "duplicate warning").join("\n")}\ndone`;
		const res = await executeBashWithOperations("noisy", process.cwd(), bashEmitting(repeated));

		expect(res.truncated).toBe(false);
		expect(res.output).toContain("duplicate warning … (×50)");
		expect(res.output).toContain("done");
		// Collapsed: the 50 raw repetitions are gone (one marker line remains).
		expect(res.output.split("\n").length).toBeLessThan(50);
	});

	it("survives a flood of small chunks with a bounded rolling buffer", async () => {
		// Many tiny onData pushes force the rolling head to advance and compact via splice.
		const ops: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 0; i < 8_000; i++) {
					onData(Buffer.from(`chunk-${i} padding\n`, "utf-8"));
				}
				return { exitCode: 0 };
			},
		};
		const started = performance.now();
		const res = await executeBashWithOperations("flood", process.cwd(), ops);
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(res.truncated).toBe(true);
		// Tail survives (possibly collapsed into a similarity marker); head is gone.
		expect(res.output).toMatch(/chunk-7\d{3}/);
		expect(res.output).not.toContain("chunk-0\n");
	});
});
