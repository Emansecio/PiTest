import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { buildParams } from "../src/providers/anthropic.js";
import type { Context, Tool } from "../src/types.js";

// Anthropic rejects a request carrying more than 4 `cache_control` breakpoints.
// Regression guard for the OAuth + compaction-summary overflow: identity(1) +
// static system(1) + tools(1) + last-user(1) + compaction-pin(1) used to emit 5.
const COMPACTION_MARKER = "The conversation history before this point was compacted into the following summary:";

const model = getModel("anthropic", "claude-haiku-4-5");

const readTool: Tool = {
	name: "read",
	description: "Read a file.",
	parameters: { type: "object", properties: {}, required: [] },
} as Tool;

function countCacheBreakpoints(rawParams: unknown): number {
	const params = rawParams as { system?: unknown; messages?: unknown; tools?: unknown };
	let n = 0;
	const scan = (content: unknown) => {
		if (!Array.isArray(content)) return;
		for (const b of content) {
			if (b && typeof b === "object" && "cache_control" in b && (b as { cache_control?: unknown }).cache_control) {
				n++;
			}
		}
	};
	scan(params.system);
	if (Array.isArray(params.messages)) {
		for (const m of params.messages as Array<{ content?: unknown }>) scan(m.content);
	}
	if (Array.isArray(params.tools)) {
		for (const t of params.tools as Array<{ cache_control?: unknown }>) if (t?.cache_control) n++;
	}
	return n;
}

function sysBreakpoints(rawParams: unknown): number {
	const system = (rawParams as { system?: unknown }).system;
	return Array.isArray(system)
		? (system as Array<{ cache_control?: unknown }>).filter((b) => b?.cache_control).length
		: 0;
}

describe("Anthropic cache_control breakpoint budget", () => {
	it("OAuth: identity + static system share ONE breakpoint, not two", () => {
		const ctx: Context = {
			systemPrompt: "You are an expert coding assistant.",
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		};
		// The static system block carries the single system breakpoint; prefix
		// caching covers the identity block above it for free.
		expect(sysBreakpoints(buildParams(model, ctx, true))).toBe(1);
	});

	it("OAuth: identity carries the breakpoint when there is no static system block", () => {
		const ctx: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		expect(sysBreakpoints(buildParams(model, ctx, true))).toBe(1);
	});

	it("non-OAuth keeps a single system breakpoint", () => {
		const ctx: Context = {
			systemPrompt: "You are an expert coding assistant.",
			messages: [{ role: "user", content: "hi", timestamp: 1 }],
		};
		expect(sysBreakpoints(buildParams(model, ctx, false))).toBe(1);
	});

	it("OAuth + compaction summary + tools stays within the 4-breakpoint limit", () => {
		const ctx: Context = {
			systemPrompt: "You are an expert coding assistant.",
			tools: [readTool],
			messages: [
				// Array content so the compaction marker is detected and the pin fires.
				{ role: "user", content: [{ type: "text", text: `${COMPACTION_MARKER} prior work.` }], timestamp: 1 },
				{ role: "user", content: "next task", timestamp: 3 },
			],
		};
		const params = buildParams(model, ctx, true);
		// System must not be the source of overflow.
		expect(sysBreakpoints(params)).toBe(1);
		// Pre-fix this path emitted 5; the cap is 4.
		expect(countCacheBreakpoints(params)).toBeLessThanOrEqual(4);
	});
});
