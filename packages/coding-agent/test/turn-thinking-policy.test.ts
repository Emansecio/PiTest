import type { ToolResultMessage } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveNextTurnThinkingLevel } from "../src/core/turn-thinking-policy.ts";

function toolResult(isError: boolean): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `tc-${Math.random().toString(36).slice(2)}`,
		toolName: "bash",
		content: [{ type: "text", text: isError ? "boom" : "ok" }],
		isError,
		timestamp: Date.now(),
	};
}

describe("resolveNextTurnThinkingLevel", () => {
	const savedFlag = process.env.PIT_NO_ADAPTIVE_THINKING;
	beforeEach(() => {
		delete process.env.PIT_NO_ADAPTIVE_THINKING;
	});
	afterEach(() => {
		if (savedFlag === undefined) delete process.env.PIT_NO_ADAPTIVE_THINKING;
		else process.env.PIT_NO_ADAPTIVE_THINKING = savedFlag;
	});

	describe("levels at or below the floor never override", () => {
		for (const level of ["off", "minimal", "low"] as const) {
			it(`returns undefined for userLevel="${level}" regardless of tool results`, () => {
				expect(resolveNextTurnThinkingLevel(level, [])).toBeUndefined();
				expect(resolveNextTurnThinkingLevel(level, [toolResult(false)])).toBeUndefined();
				expect(resolveNextTurnThinkingLevel(level, [toolResult(true)])).toBeUndefined();
				expect(resolveNextTurnThinkingLevel(level, undefined)).toBeUndefined();
			});
		}
	});

	describe("levels above the floor", () => {
		for (const level of ["medium", "high", "xhigh", "max", "ultra"] as const) {
			it(`downshifts to "low" when ≥1 result and none errored (userLevel="${level}")`, () => {
				expect(resolveNextTurnThinkingLevel(level, [toolResult(false)])).toBe("low");
				expect(resolveNextTurnThinkingLevel(level, [toolResult(false), toolResult(false)])).toBe("low");
			});

			it(`restores userLevel="${level}" when any result errored`, () => {
				expect(resolveNextTurnThinkingLevel(level, [toolResult(true)])).toBe(level);
				// mixed: one clean, one error → still restore
				expect(resolveNextTurnThinkingLevel(level, [toolResult(false), toolResult(true)])).toBe(level);
			});

			it(`restores userLevel="${level}" when there were no tool results`, () => {
				expect(resolveNextTurnThinkingLevel(level, [])).toBe(level);
				expect(resolveNextTurnThinkingLevel(level, undefined)).toBe(level);
			});
		}
	});

	describe("kill-switch PIT_NO_ADAPTIVE_THINKING", () => {
		for (const flag of ["1", "true", "yes", "TRUE", "Yes"]) {
			it(`returns undefined for every input when flag="${flag}"`, () => {
				process.env.PIT_NO_ADAPTIVE_THINKING = flag;
				expect(resolveNextTurnThinkingLevel("high", [toolResult(false)])).toBeUndefined();
				expect(resolveNextTurnThinkingLevel("high", [toolResult(true)])).toBeUndefined();
				expect(resolveNextTurnThinkingLevel("high", [])).toBeUndefined();
			});
		}

		for (const flag of ["0", "false", "no", ""]) {
			it(`stays active when flag="${flag}" (not truthy)`, () => {
				process.env.PIT_NO_ADAPTIVE_THINKING = flag;
				expect(resolveNextTurnThinkingLevel("high", [toolResult(false)])).toBe("low");
			});
		}
	});
});
