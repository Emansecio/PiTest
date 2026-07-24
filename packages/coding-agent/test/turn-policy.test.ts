/**
 * Gearbox policy + transcript predicate, extracted from `InteractiveMode`.
 *
 * `gearboxObserveToolEnd` used to be a private method with no coverage; the
 * decision it makes (upshift vs re-evaluate) is now data.
 */

import { describe, expect, test } from "vitest";
import {
	decideGearboxToolEnd,
	gearboxPlanOp,
	gearboxResultText,
	sessionHasThinkingOnlyAssistant,
} from "../src/modes/interactive/turn-policy.ts";

const base = { gearboxActive: true, recoveryLevel: "lean", toolName: "plan", result: {}, isError: false };

describe("gearboxPlanOp", () => {
	test("reads details.op defensively", () => {
		expect(gearboxPlanOp({ details: { op: "propose" } })).toBe("propose");
		expect(gearboxPlanOp({ details: { op: 42 } })).toBeUndefined();
		expect(gearboxPlanOp({})).toBeUndefined();
		expect(gearboxPlanOp(null)).toBeUndefined();
		expect(gearboxPlanOp("nope")).toBeUndefined();
	});
});

describe("gearboxResultText", () => {
	test("flattens text blocks and ignores the rest", () => {
		expect(gearboxResultText({ content: [{ text: "a" }, { type: "image" }, { text: "b" }] })).toBe("ab");
		expect(gearboxResultText({ content: "not-an-array" })).toBe("");
		expect(gearboxResultText(undefined)).toBe("");
	});
});

describe("decideGearboxToolEnd", () => {
	test("a doom-loop recovery escalation upshifts before anything else", () => {
		expect(decideGearboxToolEnd({ ...base, recoveryLevel: "deep", toolName: "read" })).toEqual({
			action: "upshift",
			reason: "recovery",
		});
	});

	test("an exhausted retry budget upshifts on any failing tool", () => {
		expect(
			decideGearboxToolEnd({
				...base,
				toolName: "bash",
				isError: true,
				result: { content: [{ text: "… retry budget exhausted …" }] },
			}),
		).toEqual({ action: "upshift", reason: "retry-exhausted" });
	});

	test("a failed step_done is a verify failure", () => {
		expect(decideGearboxToolEnd({ ...base, isError: true, result: { details: { op: "step_done" } } })).toEqual({
			action: "upshift",
			reason: "verify-failed",
		});
	});

	test("any other failed plan op is a no-op", () => {
		expect(decideGearboxToolEnd({ ...base, isError: true, result: { details: { op: "propose" } } })).toEqual({
			action: "none",
		});
	});

	test("a fresh proposal clears prior poison before re-evaluating", () => {
		expect(decideGearboxToolEnd({ ...base, result: { details: { op: "propose" } } })).toEqual({
			action: "clear-poison",
			thenReevaluate: true,
		});
	});

	test("any other successful plan op just re-evaluates", () => {
		expect(decideGearboxToolEnd({ ...base, result: { details: { op: "step_done" } } })).toEqual({
			action: "reevaluate",
		});
	});

	test("non-plan tools are ignored while the gearbox is idle", () => {
		expect(decideGearboxToolEnd({ ...base, toolName: "read" })).toEqual({ action: "none" });
	});

	test("an inactive gearbox never fires the anomaly upshifts", () => {
		expect(
			decideGearboxToolEnd({
				...base,
				gearboxActive: false,
				recoveryLevel: "deep",
				toolName: "bash",
				isError: true,
				result: { content: [{ text: "retry budget exhausted" }] },
			}),
		).toEqual({ action: "none" });
	});
});

describe("sessionHasThinkingOnlyAssistant", () => {
	test("true only when an assistant message has thinking and no text", () => {
		expect(
			sessionHasThinkingOnlyAssistant([{ role: "assistant", content: [{ type: "thinking", thinking: "hm" }] }]),
		).toBe(true);
		expect(
			sessionHasThinkingOnlyAssistant([
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "hm" },
						{ type: "text", text: "hi" },
					],
				},
			]),
		).toBe(false);
		expect(sessionHasThinkingOnlyAssistant([{ role: "user", content: [{ type: "text", text: "hi" }] }])).toBe(false);
		expect(sessionHasThinkingOnlyAssistant([])).toBe(false);
	});
});
