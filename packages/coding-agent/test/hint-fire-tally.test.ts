import type { RecordedDiagnosticEvent } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { HintFireTally } from "../src/core/telemetry/hint-fire-tally.js";

function hintFired(ruleId: string, toolName = "bash"): RecordedDiagnosticEvent {
	return {
		category: "hint.fired",
		level: "info",
		source: "agent-loop.applyToolErrorHints",
		context: { ruleId, toolName },
	} as RecordedDiagnosticEvent;
}

describe("HintFireTally", () => {
	it("counts fires per rule id and totals across rules", () => {
		const tally = new HintFireTally();
		tally.onDiagnostic(hintFired("bash-grep-exit-1-no-match"));
		tally.onDiagnostic(hintFired("bash-grep-exit-1-no-match"));
		tally.onDiagnostic(hintFired("read-enoent"));
		const snap = tally.snapshot();
		expect(snap?.total).toBe(3);
		expect(snap?.byRule).toEqual([
			{ ruleId: "bash-grep-exit-1-no-match", count: 2 },
			{ ruleId: "read-enoent", count: 1 },
		]);
	});

	it("ignores non-hint categories and hint events without a rule id", () => {
		const tally = new HintFireTally();
		tally.onDiagnostic({
			category: "guard.path-grounding",
			level: "info",
			source: "x",
			context: { ruleId: "path-enoent" },
		} as RecordedDiagnosticEvent);
		tally.onDiagnostic({
			category: "hint.fired",
			level: "info",
			source: "x",
			context: {},
		} as RecordedDiagnosticEvent);
		expect(tally.snapshot()).toBeNull();
	});

	it("returns null when nothing fired (summary omits the field)", () => {
		expect(new HintFireTally().snapshot()).toBeNull();
	});

	it("folds distinct ids beyond the cap into the overflow bucket, keeping the total honest", () => {
		const tally = new HintFireTally(2);
		tally.onDiagnostic(hintFired("a"));
		tally.onDiagnostic(hintFired("b"));
		tally.onDiagnostic(hintFired("c"));
		tally.onDiagnostic(hintFired("d"));
		// A known id keeps counting normally even after the cap is reached.
		tally.onDiagnostic(hintFired("a"));
		const snap = tally.snapshot();
		expect(snap?.total).toBe(5);
		// Order within a count tie is locale-dependent ("…" vs letters); assert content.
		const byRule = new Map(snap?.byRule.map((e) => [e.ruleId, e.count]));
		expect(byRule).toEqual(
			new Map([
				["a", 2],
				["b", 1],
				["…overflow", 2],
			]),
		);
	});

	it("ties in byRule break by rule id ascending", () => {
		const tally = new HintFireTally();
		tally.onDiagnostic(hintFired("zeta"));
		tally.onDiagnostic(hintFired("alpha"));
		expect(tally.snapshot()?.byRule.map((e) => e.ruleId)).toEqual(["alpha", "zeta"]);
	});
});
