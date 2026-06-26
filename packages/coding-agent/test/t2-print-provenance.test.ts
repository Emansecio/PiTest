/**
 * T2 #6: in `pit -p` text mode, model-provenance events (fallback to a weaker
 * model, exhausted retries) were dropped entirely — a CI run could consume output
 * from a silently downgraded model with no signal. provenanceStderrLine derives
 * the stderr line to surface for such an event (stdout stays the byte-identical
 * `-p` contract); it returns undefined for everything that must NOT be surfaced.
 */

import { describe, expect, it } from "vitest";
import { provenanceStderrLine } from "../src/modes/print-mode.ts";

describe("T2 #6: provenance events surfaced on stderr in text mode", () => {
	it("formats a fallback_warning (silent model downgrade)", () => {
		expect(
			provenanceStderrLine({
				type: "fallback_warning",
				from: "claude-opus-4-8",
				to: "glm-5.2",
				reason: "rate_limit",
			}),
		).toBe("[fallback] model claude-opus-4-8 -> glm-5.2 (rate_limit)");
	});

	it("formats an exhausted auto_retry (success:false)", () => {
		expect(
			provenanceStderrLine({ type: "auto_retry_end", success: false, attempt: 3, finalError: "overloaded" }),
		).toBe("[retry] gave up after 3 attempt(s): overloaded");
	});

	it("ignores a SUCCESSFUL auto_retry_end (no stderr noise on recovery)", () => {
		expect(provenanceStderrLine({ type: "auto_retry_end", success: true, attempt: 1 })).toBeUndefined();
	});

	it("ignores unrelated events (stdout contract untouched)", () => {
		expect(provenanceStderrLine({ type: "message_update" })).toBeUndefined();
		expect(provenanceStderrLine({ type: "auto_retry_start", attempt: 1 })).toBeUndefined();
		expect(provenanceStderrLine({})).toBeUndefined();
	});
});
