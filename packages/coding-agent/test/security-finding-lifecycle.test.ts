import { describe, expect, it } from "vitest";
import { assertFindingTransition, type FindingEvent } from "../src/core/security/finding-lifecycle.js";

const candidate: FindingEvent = { state: "candidate", summary: "sink match", source: "security_static_scan" };
const reproduced: FindingEvent = { state: "reproduced", evidenceIds: ["ev-1"], summary: "clean repro" };
const validated: FindingEvent = { state: "validated", evidenceIds: ["ev-1", "ev-2"], summary: "all checks passed" };

describe("security finding lifecycle", () => {
	it("accepts only candidate -> reproduced -> validated", () => {
		expect(() => assertFindingTransition([], candidate)).not.toThrow();
		expect(() => assertFindingTransition([candidate], reproduced)).not.toThrow();
		expect(() => assertFindingTransition([candidate, reproduced], validated)).not.toThrow();
	});

	it("rejects a static candidate promoted directly to validated", () => {
		expect(() => assertFindingTransition([candidate], validated)).toThrow(/candidate.*validated/i);
	});

	it("allows retraction from an active state and makes it terminal", () => {
		const retracted: FindingEvent = { state: "retracted", reason: "control reproduced the behavior" };
		expect(() => assertFindingTransition([candidate, reproduced], retracted)).not.toThrow();
		expect(() => assertFindingTransition([candidate, reproduced, retracted], validated)).toThrow(/terminal/i);
	});
});
