/**
 * Tests for the MCP → Pi tool-definition wrapper, focused on the aggregate
 * text budget applied when flattening an McpCallToolResult into content blocks.
 */

import { describe, expect, it } from "vitest";
import type { McpManager } from "../src/core/mcp/manager.js";
import { capMcpText, wrapMcpToolAsDefinition } from "../src/core/mcp/tools.js";
import type { McpCallToolResult } from "../src/core/mcp/types.js";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.js";

// Minimal manager stub: the wrapper's execute path only ever calls callTool, so
// a single-method fake exercises the real flattenMcpContent aggregation.
function managerReturning(result: McpCallToolResult): McpManager {
	return {
		callTool: async () => result,
	} as unknown as McpManager;
}

function runTool(result: McpCallToolResult) {
	const def = wrapMcpToolAsDefinition(managerReturning(result), "mcp__test__big", {
		name: "big",
		inputSchema: { type: "object" },
	});
	// execute ignores onUpdate/ctx; pass throwaways to satisfy the signature.
	return def.execute("call-1", {}, undefined, undefined, {} as never);
}

function utf8Bytes(s: string): number {
	return Buffer.byteLength(s, "utf8");
}

describe("flattenMcpContent aggregate budget", () => {
	it("passes a single small block through intact (byte-identical)", async () => {
		const res = await runTool({ content: [{ type: "text", text: "pong" }] });
		expect((res as { isError?: boolean }).isError).toBe(false);
		expect(res.content).toEqual([{ type: "text", text: "pong" }]);
	});

	it("caps total text output near DEFAULT_MAX_BYTES across many large blocks", async () => {
		// 10 blocks of ~30KB each = ~300KB unbudgeted; the aggregate cap must keep
		// the emitted text at or just past one DEFAULT_MAX_BYTES plus the marker.
		const big = "x".repeat(30 * 1024);
		const blocks = Array.from({ length: 10 }, () => ({ type: "text" as const, text: big }));
		const res = await runTool({ content: blocks });

		const totalTextBytes = res.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.reduce((sum, b) => sum + utf8Bytes(b.text), 0);

		// One marker line at the end summarising what was dropped.
		const marker = res.content.at(-1);
		expect(marker?.type).toBe("text");
		expect((marker as { text: string }).text).toMatch(/^\[\+\d+ blocos \(.+\) elididos — refine a query\]$/);

		// The emitted text must not stack 10× the per-block cap. Allow one full
		// budget + the marker; this is far below the unbudgeted ~300KB.
		expect(totalTextBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES + 512);
	});

	it("elides only the overflow blocks and reports the right count", async () => {
		// Two blocks just under half the budget each fit; the third overflows.
		const half = "y".repeat(Math.floor(DEFAULT_MAX_BYTES / 2) - 100);
		const res = await runTool({
			content: [
				{ type: "text", text: half },
				{ type: "text", text: half },
				{ type: "text", text: half },
				{ type: "text", text: half },
			],
		});
		const marker = res.content.at(-1) as { type: "text"; text: string };
		// 2 fit, 2 elided.
		expect(marker.text).toContain("+2 blocos");
	});

	it("never counts images against the text budget and keeps them after the budget is spent", async () => {
		const big = "z".repeat(DEFAULT_MAX_BYTES); // spends the whole budget alone
		const res = await runTool({
			content: [
				{ type: "text", text: big },
				{ type: "image", data: "AAAA", mimeType: "image/png" },
				{ type: "text", text: big }, // this one is elided
			],
		});
		const image = res.content.find((b) => b.type === "image");
		expect(image).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
		const marker = res.content.at(-1) as { type: "text"; text: string };
		expect(marker.text).toContain("+1 blocos");
	});

	it("always emits the first text block even when its own per-block cap exceeds the budget", async () => {
		// A single block larger than DEFAULT_MAX_BYTES is capped per-block (which
		// appends a truncation note, pushing it slightly past the budget). It must
		// still be emitted in full as the sole block — no elision marker.
		const huge = "q".repeat(DEFAULT_MAX_BYTES * 3);
		const res = await runTool({ content: [{ type: "text", text: huge }] });
		expect(res.content).toHaveLength(1);
		expect(res.content[0].type).toBe("text");
		expect((res.content[0] as { text: string }).text).toBe(capMcpText(huge));
	});

	it("flattens a resource block into a budgeted text block", async () => {
		const res = await runTool({
			content: [{ type: "resource", resource: { uri: "file://x", text: "hello" } }],
		});
		expect(res.content).toEqual([{ type: "text", text: "[Resource file://x]\nhello" }]);
	});
});

describe("capMcpText JSON crush", () => {
	it("structurally crushes a large JSON array instead of a blind head-cut", () => {
		const bigJson = JSON.stringify(
			Array.from({ length: 6000 }, (_, i) => ({ id: i, name: `item-${i}`, ok: i % 2 === 0 })),
		);
		expect(bigJson.length).toBeGreaterThan(DEFAULT_MAX_BYTES); // would otherwise be head-cut
		const out = capMcpText(bigJson);
		// Crushed, not blind-truncated: keeps the schema + samples + omitted count.
		expect(out).toContain("[crushed JSON");
		expect(out).toContain("Large JSON crushed to schema + samples");
		expect(out).not.toContain("[MCP output truncated");
		// Far smaller than the original payload AND smaller than the old 50KB head-cut.
		expect(out.length).toBeLessThan(DEFAULT_MAX_BYTES / 2);
	});

	it("falls back to the head-cut for large non-JSON output (byte-identical to before)", () => {
		const blob = "x".repeat(DEFAULT_MAX_BYTES * 2);
		const out = capMcpText(blob);
		expect(out).toContain("[MCP output truncated");
		expect(out).not.toContain("[crushed JSON");
	});
});
