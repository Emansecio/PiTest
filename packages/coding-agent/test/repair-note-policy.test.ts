import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveEmitRepairNotes, shouldAutoEmitRepairNotes } from "../src/core/repair-note-policy.ts";

describe("shouldAutoEmitRepairNotes", () => {
	it("is OFF for native frontier providers", () => {
		for (const provider of ["anthropic", "google", "openai", "openai-codex"]) {
			expect(shouldAutoEmitRepairNotes({ provider })).toBe(false);
		}
	});

	it("is ON for weak/open providers without a frontier model id", () => {
		for (const provider of ["opencode", "opencode-go", "kimi-coding", "xiaomi", "minimax", "openrouter", "zai"]) {
			expect(shouldAutoEmitRepairNotes({ provider })).toBe(true);
		}
	});

	it("is ON for an unknown custom OpenAI-compat provider", () => {
		expect(shouldAutoEmitRepairNotes({ provider: "my-custom-deepseek" })).toBe(true);
	});

	it("is OFF for frontier model ids on weak providers", () => {
		const cases = [
			{ provider: "openrouter", id: "anthropic/claude-3.5-sonnet" },
			{ provider: "openrouter", id: "openai/gpt-4o" },
			{ provider: "openrouter", id: "openai/gpt-5" },
			{ provider: "openrouter", id: "google/gemini-2.0-flash" },
			{ provider: "openrouter", id: "openai/o1-preview" },
			{ provider: "openrouter", id: "openai/o3-mini" },
			{ provider: "opencode", id: "claude-sonnet-4" },
		];
		for (const model of cases) {
			expect(shouldAutoEmitRepairNotes(model)).toBe(false);
		}
	});

	it("is ON for weak model ids on weak providers", () => {
		const cases = [
			{ provider: "openrouter", id: "deepseek/deepseek-chat" },
			{ provider: "openrouter", id: "qwen/qwen-2.5-72b-instruct" },
			{ provider: "opencode", id: "glm-4-plus" },
			{ provider: "kimi-coding", id: "kimi-k2" },
		];
		for (const model of cases) {
			expect(shouldAutoEmitRepairNotes(model)).toBe(true);
		}
	});

	it("matches frontier model id patterns case-insensitively", () => {
		expect(shouldAutoEmitRepairNotes({ provider: "openrouter", id: "CLAUDE-3-opus" })).toBe(false);
		expect(shouldAutoEmitRepairNotes({ provider: "openrouter", id: "GPT-4-TURBO" })).toBe(false);
		expect(shouldAutoEmitRepairNotes({ provider: "openrouter", id: "Gemini-Pro" })).toBe(false);
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
		expect(resolveEmitRepairNotes({ provider: "openrouter", id: "anthropic/claude-3.5-sonnet" })).toBe(false);
		expect(resolveEmitRepairNotes({ provider: "openrouter", id: "deepseek/deepseek-chat" })).toBe(true);
	});

	it("forces ON for a strong provider when PIT_TOOL_REPAIR_NOTE=1", () => {
		process.env.PIT_TOOL_REPAIR_NOTE = "1";
		expect(resolveEmitRepairNotes({ provider: "anthropic" })).toBe(true);
		expect(resolveEmitRepairNotes({ provider: "openrouter", id: "anthropic/claude-3.5-sonnet" })).toBe(true);
	});

	it("forces OFF for a weak provider when PIT_TOOL_REPAIR_NOTE=0", () => {
		process.env.PIT_TOOL_REPAIR_NOTE = "0";
		expect(resolveEmitRepairNotes({ provider: "opencode" })).toBe(false);
	});

	it("treats whitespace-only as unset (auto)", () => {
		process.env.PIT_TOOL_REPAIR_NOTE = "  ";
		expect(resolveEmitRepairNotes({ provider: "openai" })).toBe(false);
		expect(resolveEmitRepairNotes({ provider: "kimi-coding" })).toBe(true);
		expect(resolveEmitRepairNotes({ provider: "openrouter", id: "openai/gpt-4o" })).toBe(false);
	});
});
