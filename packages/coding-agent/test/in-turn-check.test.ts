/**
 * Grounding for the DEFAULT in-turn verification mode: the policy that decides
 * whether a cycle that edited files without running a check deserves a
 * correction, a bounded give-up, or silence.
 */

import { describe, expect, it } from "vitest";
import {
	buildInTurnCheckPrompt,
	decideInTurnCheckSteer,
	IN_TURN_CHECK_MAX_IGNORED,
	type InTurnCheckState,
} from "../src/core/verification/in-turn-check.ts";

const state = (overrides: Partial<InTurnCheckState> = {}): InTurnCheckState => ({
	touchedFiles: true,
	ranCheck: false,
	checkCommand: "npm run check",
	ignoredStreak: 0,
	autonomousGoalActive: false,
	aborted: false,
	...overrides,
});

describe("decideInTurnCheckSteer", () => {
	it("corrects a cycle that edited files and never ran a check", () => {
		const decision = decideInTurnCheckSteer(state());
		expect(decision.action).toBe("steer");
		expect(decision.action === "steer" && decision.prompt).toContain("npm run check");
	});

	it("stays silent when the model already verified", () => {
		expect(decideInTurnCheckSteer(state({ ranCheck: true })).action).toBe("none");
	});

	it("stays silent on a read-only cycle", () => {
		expect(decideInTurnCheckSteer(state({ touchedFiles: false })).action).toBe("none");
	});

	it("stays silent on an aborted/interrupted cycle", () => {
		// A half-finished turn is not evidence that the model skipped the check.
		expect(decideInTurnCheckSteer(state({ aborted: true })).action).toBe("none");
	});

	it("stays silent when the project has no check command to ask for", () => {
		// The system-prompt guideline is inert in such a project; so is this.
		expect(decideInTurnCheckSteer(state({ checkCommand: null })).action).toBe("none");
	});

	it("runs one mechanical fallback check after the bounded corrections are ignored", () => {
		for (let streak = 0; streak < IN_TURN_CHECK_MAX_IGNORED; streak++) {
			expect(decideInTurnCheckSteer(state({ ignoredStreak: streak })).action).toBe("steer");
		}
		expect(decideInTurnCheckSteer(state({ ignoredStreak: IN_TURN_CHECK_MAX_IGNORED }))).toEqual({
			action: "run-check",
			command: "npm run check",
		});
	});

	it("leaves an active autonomous goal to goal_complete after the bounded corrections", () => {
		expect(
			decideInTurnCheckSteer(state({ ignoredStreak: IN_TURN_CHECK_MAX_IGNORED, autonomousGoalActive: true })),
		).toEqual({ action: "give-up" });
	});
});

describe("buildInTurnCheckPrompt", () => {
	it("names the command and leaves an explicit escape hatch", () => {
		const prompt = buildInTurnCheckPrompt("pnpm verify");
		expect(prompt).toContain("pnpm verify");
		// Asks for the missing STEP, never asserts the work itself is wrong...
		expect(prompt).toContain("before reporting this task as done");
		// ...and lets the model decline with a reason instead of burning a run.
		expect(prompt).toContain("not applicable");
	});
});
