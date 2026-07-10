import type { RecordedDiagnosticEvent } from "@pit/ai";
import { describe, expect, it } from "vitest";
import {
	GuardEfficacyCorrelator,
	type GuardEfficacyRecord,
	getToolCallFromDiagnostic,
} from "../src/core/telemetry/guard-efficacy.js";

function guardEvent(
	category: string,
	context: RecordedDiagnosticEvent["context"],
	seq = 1,
	ts = 1000,
): RecordedDiagnosticEvent {
	return { category: category as RecordedDiagnosticEvent["category"], level: "warn", source: "t", context, seq, ts };
}

describe("getToolCallFromDiagnostic", () => {
	it("uses structured tool-call identity", () => {
		expect(
			getToolCallFromDiagnostic(guardEvent("guard.edit-precondition", { toolName: "edit", toolCallId: "call-1" })),
		).toEqual({
			toolName: "edit",
			toolCallId: "call-1",
		});
	});

	it("does not infer identity from free-form notes", () => {
		expect(getToolCallFromDiagnostic(guardEvent("guard.grounding", { note: "edit blocked" }))).toBeUndefined();
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
		c.onDiagnostic(
			guardEvent("guard.grounding", {
				outcome: "blocked",
				ruleId: "sym-exists",
				toolName: "edit",
				toolCallId: "blocked-call",
			}),
		);
		c.onToolExecutionEnd("edit", "blocked-call", true);
		expect(records).toHaveLength(0);
		c.onToolExecutionEnd("edit", "retry-call", false);
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
		c.onDiagnostic(guardEvent("guard.read", { outcome: "overridden", toolName: "read", toolCallId: "call-1" }));
		c.onToolExecutionEnd("read", "retry-call", true);
		expect(records[0]).toMatchObject({ outcome: "overridden", nextCallOk: false });
	});

	it("ignores guard fires without a blocked/overridden outcome", () => {
		const { records, emit } = collector();
		const c = new GuardEfficacyCorrelator(emit);
		c.onDiagnostic(guardEvent("guard.read", { note: "read" }));
		c.onToolExecutionEnd("read", "call-1", false);
		expect(records).toHaveLength(0);
	});

	it("ignores non-guard diagnostics", () => {
		const { records, emit } = collector();
		const c = new GuardEfficacyCorrelator(emit);
		c.onDiagnostic(guardEvent("stream.idle-timeout", { outcome: "blocked", note: "read" }));
		c.onToolExecutionEnd("read", "call-1", false);
		expect(records).toHaveLength(0);
	});

	it("does not emit for a tool with no pending fire", () => {
		const { records, emit } = collector();
		const c = new GuardEfficacyCorrelator(emit);
		c.onToolExecutionEnd("bash", "call-1", false);
		expect(records).toHaveLength(0);
	});

	it("keeps only the most recent fire per tool", () => {
		const { records, emit } = collector();
		const c = new GuardEfficacyCorrelator(emit);
		c.onDiagnostic(
			guardEvent("guard.grounding", { outcome: "blocked", ruleId: "first", toolName: "edit", toolCallId: "call-1" }),
		);
		c.onDiagnostic(
			guardEvent("guard.import-grounding", {
				outcome: "blocked",
				ruleId: "second",
				toolName: "edit",
				toolCallId: "call-2",
			}),
		);
		c.onToolExecutionEnd("edit", "retry-call", false);
		expect(records).toHaveLength(1);
		expect(records[0].ruleId).toBe("second");
	});

	it("resolves each fire once (second tool-end has nothing pending)", () => {
		const { records, emit } = collector();
		const c = new GuardEfficacyCorrelator(emit);
		c.onDiagnostic(guardEvent("guard.read", { outcome: "blocked", toolName: "read", toolCallId: "call-1" }));
		c.onToolExecutionEnd("read", "retry-call", false);
		c.onToolExecutionEnd("read", "retry-call-2", true);
		expect(records).toHaveLength(1);
	});

	it("bounds pending memory to the configured cap", () => {
		const { records, emit } = collector();
		const c = new GuardEfficacyCorrelator(emit, 2);
		// Three distinct tools fire; the oldest (read) is evicted.
		c.onDiagnostic(guardEvent("guard.read", { outcome: "blocked", toolName: "read", toolCallId: "call-1" }));
		c.onDiagnostic(guardEvent("guard.grounding", { outcome: "blocked", toolName: "edit", toolCallId: "call-2" }));
		c.onDiagnostic(
			guardEvent("guard.bash-grounding", { outcome: "blocked", toolName: "bash", toolCallId: "call-3" }),
		);
		c.onToolExecutionEnd("read", "retry-read", false);
		expect(records).toHaveLength(0);
		c.onToolExecutionEnd("edit", "retry-edit", false);
		c.onToolExecutionEnd("bash", "retry-bash", false);
		expect(records).toHaveLength(2);
	});
});
