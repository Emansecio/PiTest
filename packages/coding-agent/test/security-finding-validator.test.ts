import { describe, expect, it } from "vitest";
import { validateFinding } from "../src/core/security/finding-validator.js";

function validInput() {
	return {
		currentState: "reproduced" as const,
		marker: {
			value: "pit-marker-93f7",
			baselineBody: "normal",
			controlBody: "normal",
			mutationBody: "reflected pit-marker-93f7",
		},
		bodies: { baseline: '{"ok":true}', control: '{"ok":true}', mutation: '{"ok":false,"proof":1}' },
		reproduction: { attempts: [true, true] },
		timing: {
			claimed: true,
			interleaved: true,
			baselineMs: [100, 102, 98, 101, 99],
			controlMs: [103, 101, 100, 102, 99],
			mutationMs: [450, 460, 455, 448, 452],
		},
		chain: {
			required: true,
			complete: true,
			steps: [
				{ name: "entry", evidenceIds: ["e1"] },
				{ name: "impact", evidenceIds: ["e2"] },
			],
		},
	};
}

describe("anti-false-positive finding validation", () => {
	it("validates only a reproduced finding with all evidence checks", () => {
		const result = validateFinding(validInput());
		expect(result.valid).toBe(true);
		expect(result.nextState).toBe("validated");
		expect(result.checks.every((check) => check.passed)).toBe(true);
	});

	it.each([
		[
			"marker also present in control",
			(input: ReturnType<typeof validInput>) => {
				input.marker.controlBody = input.marker.mutationBody;
			},
		],
		[
			"status-like change without body diff",
			(input: ReturnType<typeof validInput>) => {
				input.bodies.mutation = input.bodies.control;
			},
		],
		[
			"single reproduction",
			(input: ReturnType<typeof validInput>) => {
				input.reproduction.attempts = [true];
			},
		],
		[
			"non-interleaved timing",
			(input: ReturnType<typeof validInput>) => {
				input.timing.interleaved = false;
			},
		],
		[
			"incomplete chain",
			(input: ReturnType<typeof validInput>) => {
				input.chain.complete = false;
			},
		],
	])("rejects %s", (_name, mutate) => {
		const input = validInput();
		mutate(input);
		const result = validateFinding(input);
		expect(result.valid).toBe(false);
		expect(result.nextState).toBe("reproduced");
		expect(result.checks.some((check) => !check.passed)).toBe(true);
	});

	it("does not let candidate state skip reproduction", () => {
		const input = validInput();
		const result = validateFinding({ ...input, currentState: "candidate" });
		expect(result.valid).toBe(false);
		expect(result.checks.find((check) => check.name === "lifecycle")?.passed).toBe(false);
	});
});
