import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isWeakModelProfile,
	resolveEmitRepairNotes,
	shouldAutoEmitRepairNotes,
} from "../src/core/repair-note-policy.ts";

describe("shouldAutoEmitRepairNotes", () => {
	it("is OFF for native frontier providers", () => {
		for (const provider of ["anthropic", "openai-codex"]) {
			expect(shouldAutoEmitRepairNotes({ provider })).toBe(false);
		}
	});

	it("is ON for weak/open providers without a frontier model id", () => {
		for (const provider of ["opencode", "opencode-go", "zai", "my-proxy"]) {
			expect(shouldAutoEmitRepairNotes({ provider })).toBe(true);
		}
	});

	it("is ON for an unknown custom OpenAI-compat provider", () => {
		expect(shouldAutoEmitRepairNotes({ provider: "my-custom-deepseek" })).toBe(true);
	});

	it("is OFF for frontier model ids on weak providers", () => {
		const cases = [
			{ provider: "opencode", id: "anthropic/claude-3.5-sonnet" },
			{ provider: "opencode", id: "openai/gpt-4o" },
			{ provider: "opencode", id: "openai/gpt-5" },
			{ provider: "opencode", id: "google/gemini-2.0-flash" },
			{ provider: "opencode", id: "openai/o1-preview" },
			{ provider: "opencode", id: "openai/o3-mini" },
			{ provider: "opencode", id: "claude-sonnet-4" },
		];
		for (const model of cases) {
			expect(shouldAutoEmitRepairNotes(model)).toBe(false);
		}
	});

	it("is ON for weak model ids on weak providers", () => {
		const cases = [
			{ provider: "opencode", id: "deepseek/deepseek-chat" },
			{ provider: "opencode", id: "qwen/qwen-2.5-72b-instruct" },
			{ provider: "opencode", id: "glm-4-plus" },
			{ provider: "opencode-go", id: "kimi-k2" },
		];
		for (const model of cases) {
			expect(shouldAutoEmitRepairNotes(model)).toBe(true);
		}
	});

	it("matches frontier model id patterns case-insensitively", () => {
		expect(shouldAutoEmitRepairNotes({ provider: "opencode", id: "CLAUDE-3-opus" })).toBe(false);
		expect(shouldAutoEmitRepairNotes({ provider: "opencode", id: "GPT-4-TURBO" })).toBe(false);
		expect(shouldAutoEmitRepairNotes({ provider: "opencode", id: "Gemini-Pro" })).toBe(false);
	});
});

describe("isWeakModelProfile (P7 tiered-prompt predicate, extracted from shouldAutoEmitRepairNotes)", () => {
	const cases: Array<{ provider: string; id?: string }> = [
		{ provider: "anthropic" },
		{ provider: "openai-codex" },
		{ provider: "opencode" },
		{ provider: "opencode-go", id: "kimi-k2" },
		{ provider: "opencode", id: "anthropic/claude-3.5-sonnet" },
		{ provider: "opencode", id: "deepseek/deepseek-chat" },
		{ provider: "my-custom-deepseek" },
		{ provider: "opencode", id: "CLAUDE-3-opus" },
	];

	it("is identical to shouldAutoEmitRepairNotes for every case (pure delegation, same behavior)", () => {
		for (const model of cases) {
			expect(isWeakModelProfile(model)).toBe(shouldAutoEmitRepairNotes(model));
		}
	});

	it("is OFF for native frontier providers and ON for weak/open providers/ids", () => {
		expect(isWeakModelProfile({ provider: "anthropic" })).toBe(false);
		expect(isWeakModelProfile({ provider: "openai-codex" })).toBe(false);
		expect(isWeakModelProfile({ provider: "opencode" })).toBe(true);
		expect(isWeakModelProfile({ provider: "opencode", id: "deepseek/deepseek-chat" })).toBe(true);
		expect(isWeakModelProfile({ provider: "opencode", id: "anthropic/claude-3.5-sonnet" })).toBe(false);
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
		expect(resolveEmitRepairNotes({ provider: "opencode", id: "anthropic/claude-3.5-sonnet" })).toBe(false);
		expect(resolveEmitRepairNotes({ provider: "opencode", id: "deepseek/deepseek-chat" })).toBe(true);
	});

	it("forces ON for a strong provider when PIT_TOOL_REPAIR_NOTE=1", () => {
		process.env.PIT_TOOL_REPAIR_NOTE = "1";
		expect(resolveEmitRepairNotes({ provider: "anthropic" })).toBe(true);
		expect(resolveEmitRepairNotes({ provider: "opencode", id: "anthropic/claude-3.5-sonnet" })).toBe(true);
	});

	it("forces OFF for a weak provider when PIT_TOOL_REPAIR_NOTE=0", () => {
		process.env.PIT_TOOL_REPAIR_NOTE = "0";
		expect(resolveEmitRepairNotes({ provider: "opencode" })).toBe(false);
	});

	it("treats whitespace-only as unset (auto)", () => {
		process.env.PIT_TOOL_REPAIR_NOTE = "  ";
		expect(resolveEmitRepairNotes({ provider: "anthropic" })).toBe(false);
		expect(resolveEmitRepairNotes({ provider: "opencode-go" })).toBe(true);
		expect(resolveEmitRepairNotes({ provider: "opencode", id: "openai/gpt-4o" })).toBe(false);
	});
});
