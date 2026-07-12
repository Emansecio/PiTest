import { describe, expect, it } from "vitest";
import { defaultSupportsAdaptiveThinking } from "../src/providers/anthropic.js";

describe("defaultSupportsAdaptiveThinking", () => {
	it("returns true for current adaptive models (Opus 4.6+, Sonnet 4.6+)", () => {
		for (const id of [
			"claude-opus-4-8",
			"claude-opus-4-8",
			"claude-opus-4-8",
			"claude-opus-4.8",
			"claude-opus-4-8-20260101",
			"claude-sonnet-5",
			"claude-sonnet-4-6-20250514",
		]) {
			expect(defaultSupportsAdaptiveThinking(id)).toBe(true);
		}
	});

	it("future 4.6+ bumps work without a code change", () => {
		for (const id of ["claude-opus-4-9", "claude-sonnet-4-7", "claude-opus-5-0", "claude-sonnet-4-10"]) {
			expect(defaultSupportsAdaptiveThinking(id)).toBe(true);
		}
	});

	it("returns false for pre-4.6 models, including a bare date suffix", () => {
		for (const id of [
			"claude-opus-4-1", // Opus 4.1 — budget tokens
			"claude-opus-4-20250514", // Opus 4.0 release id — date must NOT read as a huge minor
			"claude-sonnet-4-20250514",
			"claude-3-5-sonnet-20241022",
			"claude-3-7-sonnet-20250219",
			"claude-3-5-haiku-20241022",
			"claude-haiku-4-5", // Haiku is not adaptive
		]) {
			expect(defaultSupportsAdaptiveThinking(id)).toBe(false);
		}
	});
});
