import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveEmitRepairNotes, shouldAutoEmitRepairNotes } from "../src/core/repair-note-policy.ts";

describe("shouldAutoEmitRepairNotes", () => {
	it("is OFF for native frontier providers", () => {
		for (const provider of ["anthropic", "google", "openai", "openai-codex"]) {
			expect(shouldAutoEmitRepairNotes({ provider })).toBe(false);
		}
	});

	it("is ON for weak/open providers", () => {
		for (const provider of ["opencode", "opencode-go", "kimi-coding", "xiaomi", "minimax", "openrouter", "zai"]) {
			expect(shouldAutoEmitRepairNotes({ provider })).toBe(true);
		}
	});

	it("is ON for an unknown custom OpenAI-compat provider", () => {
		expect(shouldAutoEmitRepairNotes({ provider: "my-custom-deepseek" })).toBe(true);
	});
});

describe("resolveEmitRepairNotes (env override)", () => {
	const original = process.env.PIT_TOOL_REPAIR_NOTE;
	beforeEach(() => {
		delete process.env.PIT_TOOL_REPAIR_NOTE;
	});
	afterEach(() => {
		if (original === undefined) delete process.env.PIT_TOOL_REPAIR_NOTE;
		else process.env.PIT_TOOL_REPAIR_NOTE = original;
	});

	it("falls back to the auto rule when unset", () => {
		expect(resolveEmitRepairNotes({ provider: "anthropic" })).toBe(false);
		expect(resolveEmitRepairNotes({ provider: "opencode" })).toBe(true);
	});

	it("forces ON for a strong provider when PIT_TOOL_REPAIR_NOTE=1", () => {
		process.env.PIT_TOOL_REPAIR_NOTE = "1";
		expect(resolveEmitRepairNotes({ provider: "anthropic" })).toBe(true);
	});

	it("forces OFF for a weak provider when PIT_TOOL_REPAIR_NOTE=0", () => {
		process.env.PIT_TOOL_REPAIR_NOTE = "0";
		expect(resolveEmitRepairNotes({ provider: "opencode" })).toBe(false);
	});

	it("treats whitespace-only as unset (auto)", () => {
		process.env.PIT_TOOL_REPAIR_NOTE = "  ";
		expect(resolveEmitRepairNotes({ provider: "openai" })).toBe(false);
		expect(resolveEmitRepairNotes({ provider: "kimi-coding" })).toBe(true);
	});
});
