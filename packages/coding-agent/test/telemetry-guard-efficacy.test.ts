import type { RecordedDiagnosticEvent } from "@pit/ai";
import { describe, expect, it } from "vitest";
import {
	GuardEfficacyCorrelator,
	type GuardEfficacyRecord,
	inferToolFromDiagnostic,
} from "../src/core/telemetry/guard-efficacy.js";

function guardEvent(
	category: string,
	context: RecordedDiagnosticEvent["context"],
	seq = 1,
	ts = 1000,
): RecordedDiagnosticEvent {
	return { category: category as RecordedDiagnosticEvent["category"], level: "warn", source: "t", context, seq, ts };
}

describe("inferToolFromDiagnostic", () => {
	it("extracts a known tool token from the note", () => {
		expect(inferToolFromDiagnostic(guardEvent("guard.edit-precondition", { note: "edit blocked: no match" }))).toBe(
			"edit",
		);
	});

	it("returns undefined when no tool token is present", () => {
		expect(
			inferToolFromDiagnostic(guardEvent("guard.grounding", { note: "identifier not in tree" })),
		).toBeUndefined();
		expect(inferToolFromDiagnostic(guardEvent("guard.grounding", {}))).toBeUndefined();
	});
});

describe("GuardEfficacyCorrelator", () => {
	function collector() {
		const records: GuardEfficacyRecord[] = [];
		return { records, emit: (r: GuardEfficacyRecord) => records.push(r) };
	}

	it("emits one efficacy record when the next call to the same tool succeeds", () => {
		const { records, emit } = collector();
		const c = new GuardEfficacyCorrelator(emit);
		c.onDiagnostic(guardEvent("guard.grounding", { outcome: "blocked", ruleId: "sym-exists", note: "edit" }));
		c.onToolExecutionEnd("edit", false);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			type: "efficacy",
			guard: "guard.grounding",
			ruleId: "sym-exists",
			outcome: "blocked",
			nextCallOk: true,
		});
	});

	it("records nextCallOk=false when the next call errors", () => {
		const { records, emit } = collector();
		const c = new GuardEfficacyCorrelator(emit);
		c.onDiagnostic(guardEvent("guard.read", { outcome: "overridden", note: "read" }));
		c.onToolExecutionEnd("read", true);
		expect(records[0]).toMatchObject({ outcome: "overridden", nextCallOk: false });
	});

	it("ignores guard fires without a blocked/overridden outcome", () => {
		const { records, emit } = collector();
		const c = new GuardEfficacyCorrelator(emit);
		c.onDiagnostic(guardEvent("guard.read", { note: "read" }));
		c.onToolExecutionEnd("read", false);
		expect(records).toHaveLength(0);
	});

	it("ignores non-guard diagnostics", () => {
		const { records, emit } = collector();
		const c = new GuardEfficacyCorrelator(emit);
		c.onDiagnostic(guardEvent("stream.idle-timeout", { outcome: "blocked", note: "read" }));
		c.onToolExecutionEnd("read", false);
		expect(records).toHaveLength(0);
	});

	it("does not emit for a tool with no pending fire", () => {
		const { records, emit } = collector();
		const c = new GuardEfficacyCorrelator(emit);
		c.onToolExecutionEnd("bash", false);
		expect(records).toHaveLength(0);
	});

	it("keeps only the most recent fire per tool", () => {
		const { records, emit } = collector();
		const c = new GuardEfficacyCorrelator(emit);
		c.onDiagnostic(guardEvent("guard.grounding", { outcome: "blocked", ruleId: "first", note: "edit" }));
		c.onDiagnostic(guardEvent("guard.import-grounding", { outcome: "blocked", ruleId: "second", note: "edit" }));
		c.onToolExecutionEnd("edit", false);
		expect(records).toHaveLength(1);
		expect(records[0].ruleId).toBe("second");
	});

	it("resolves each fire once (second tool-end has nothing pending)", () => {
		const { records, emit } = collector();
		const c = new GuardEfficacyCorrelator(emit);
		c.onDiagnostic(guardEvent("guard.read", { outcome: "blocked", note: "read" }));
		c.onToolExecutionEnd("read", false);
		c.onToolExecutionEnd("read", true);
		expect(records).toHaveLength(1);
	});

	it("bounds pending memory to the configured cap", () => {
		const { records, emit } = collector();
		const c = new GuardEfficacyCorrelator(emit, 2);
		// Three distinct tools fire; the oldest (read) is evicted.
		c.onDiagnostic(guardEvent("guard.read", { outcome: "blocked", note: "read" }));
		c.onDiagnostic(guardEvent("guard.grounding", { outcome: "blocked", note: "edit" }));
		c.onDiagnostic(guardEvent("guard.bash-grounding", { outcome: "blocked", note: "bash" }));
		c.onToolExecutionEnd("read", false);
		expect(records).toHaveLength(0);
		c.onToolExecutionEnd("edit", false);
		c.onToolExecutionEnd("bash", false);
		expect(records).toHaveLength(2);
	});
});
