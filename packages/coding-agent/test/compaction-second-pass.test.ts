import { describe, expect, it } from "vitest";
import { shouldRunCompactionSecondPass } from "../src/core/agent-session-compaction.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/compaction.js";

describe("shouldRunCompactionSecondPass (T08)", () => {
	const settings = { ...DEFAULT_COMPACTION_SETTINGS };
	// hard threshold = contextWindow - reserveTokens = 100_000 - 16_384 = 83_616
	const window = 100_000;

	it("returns true only when hard shouldCompact would fire", () => {
		expect(shouldRunCompactionSecondPass(90_000, window, settings)).toBe(true);
	});

	it("returns false in the soft-only band (no second LLM pass)", () => {
		// Soft band is below hard; previously soft alone re-fired the pipeline.
		expect(shouldRunCompactionSecondPass(75_000, window, settings)).toBe(false);
		expect(shouldRunCompactionSecondPass(83_616, window, settings)).toBe(false);
	});

	it("returns false when compaction is disabled", () => {
		expect(shouldRunCompactionSecondPass(90_000, window, { ...settings, enabled: false })).toBe(false);
	});
});
