/**
 * The Anthropic payload is cached by explicit breakpoints, and every breakpoint
 * caches EVERYTHING above it: `tools` → `system` → the message history. So the
 * cost of a turn is decided by how far up the payload the first difference is.
 * Both guards here defend that boundary.
 */

import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { buildParams } from "../src/providers/anthropic.js";
import type { Context, Tool } from "../src/types.js";
import { SYSTEM_PROMPT_DYNAMIC_MARKER } from "../src/types.js";

const model = getModel("anthropic", "claude-haiku-4-5");

const tool = (name: string): Tool =>
	({ name, description: `${name} tool`, parameters: { type: "object", properties: {}, required: [] } }) as Tool;

/** Tool surface in activation order — the order the caller keeps append-only. */
const BASE_TOOLS = ["read", "write", "edit", "bash", "grep", "ls", "todo", "task"].map(tool);

function toolNames(rawParams: unknown): string[] {
	const tools = (rawParams as { tools?: Array<{ name: string }> }).tools ?? [];
	return tools.map((t) => t.name);
}

/** Index of the first element that differs — i.e. where the cached prefix dies. */
function firstDivergence(before: string[], after: string[]): number {
	for (let i = 0; i < Math.min(before.length, after.length); i++) {
		if (before[i] !== after[i]) return i;
	}
	return Math.min(before.length, after.length);
}

describe("Anthropic wire prefix stability", () => {
	it("does not sort the tool surface, so a newly activated tool only grows the tail", () => {
		// Regression: `[...context.tools].sort(...)` spliced a new tool into the
		// MIDDLE of the array by name, invalidating the tools block, the system
		// prompt and the entire history behind it on every discovery activation.
		const messages: Context["messages"] = [{ role: "user", content: "hi", timestamp: 1 }];
		const before = toolNames(buildParams(model, { systemPrompt: "sys", messages, tools: BASE_TOOLS }, false));
		// `ast_edit` sorts near the front but is activated last.
		const after = toolNames(
			buildParams(model, { systemPrompt: "sys", messages, tools: [...BASE_TOOLS, tool("ast_edit")] }, false),
		);

		expect(after).toEqual([...before, "ast_edit"]);
		expect(firstDivergence(before, after)).toBe(before.length);
	});

	it("relocates the dynamic system suffix behind the history breakpoint", () => {
		const messages: Context["messages"] = [
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 } as Context["messages"][number],
			{ role: "user", content: "second", timestamp: 3 },
		];
		const withSuffix = (suffix: string): Context => ({
			systemPrompt: `static prompt${SYSTEM_PROMPT_DYNAMIC_MARKER}${suffix}`,
			messages,
			tools: BASE_TOOLS,
		});

		const turn1 = buildParams(model, withSuffix("Current date: 2026-07-26"), false);
		const turn2 = buildParams(model, withSuffix("Current date: 2026-07-27"), false);

		// The whole cached prefix — tools and system — is byte-identical.
		expect(JSON.stringify(turn2.tools)).toBe(JSON.stringify(turn1.tools));
		expect(JSON.stringify(turn2.system)).toBe(JSON.stringify(turn1.system));
		// The suffix left `system` entirely.
		expect(JSON.stringify(turn1.system)).not.toContain("Current date");
		expect(JSON.stringify(turn1.system)).not.toContain(SYSTEM_PROMPT_DYNAMIC_MARKER);

		// It rides at the very END of the last user message, so it sits BEHIND the
		// `cache_control` that convertMessages pinned — outside the cached prefix.
		const last = turn1.messages[turn1.messages.length - 1];
		const blocks = last.content as Array<{ type: string; text?: string; cache_control?: unknown }>;
		expect(last.role).toBe("user");
		expect(blocks[blocks.length - 1].text).toContain("Current date: 2026-07-26");
		expect(blocks[blocks.length - 1].cache_control).toBeUndefined();
		expect(blocks.some((b) => b.cache_control)).toBe(true);
		// Everything before the relocated block is unchanged across the two turns.
		expect(JSON.stringify(turn1.messages.slice(0, -1))).toBe(JSON.stringify(turn2.messages.slice(0, -1)));
	});

	it("keeps the suffix in system when there is no user message to carry it", () => {
		const params = buildParams(
			model,
			{
				systemPrompt: `static${SYSTEM_PROMPT_DYNAMIC_MARKER}volatile`,
				messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1 } as never],
			},
			false,
		);
		expect(JSON.stringify(params.system)).toContain("volatile");
		expect(JSON.stringify(params.system)).not.toContain(SYSTEM_PROMPT_DYNAMIC_MARKER);
	});
});
