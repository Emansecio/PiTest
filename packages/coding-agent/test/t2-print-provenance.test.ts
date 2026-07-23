/**
 * T2 #6: in `pit -p` text mode, model-provenance events (fallback to a weaker
 * model, exhausted retries) were dropped entirely — a CI run could consume output
 * from a silently downgraded model with no signal. provenanceStderrLine derives
 * the stderr line to surface for such an event (stdout stays the byte-identical
 * `-p` contract); it returns undefined for everything that must NOT be surfaced.
 */

import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_JSON_HEARTBEAT_MS, provenanceStderrLine, resolveJsonHeartbeatMs } from "../src/modes/print-mode.ts";

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

describe("resolveJsonHeartbeatMs (--mode json generation_progress cadence)", () => {
	afterEach(() => {
		delete process.env.PIT_NO_JSON_HEARTBEAT;
		delete process.env.PIT_JSON_HEARTBEAT_MS;
	});

	it("defaults to DEFAULT_JSON_HEARTBEAT_MS", () => {
		expect(resolveJsonHeartbeatMs()).toBe(DEFAULT_JSON_HEARTBEAT_MS);
	});

	it("PIT_NO_JSON_HEARTBEAT=1 disables (returns 0), overriding a cadence override", () => {
		process.env.PIT_NO_JSON_HEARTBEAT = "1";
		process.env.PIT_JSON_HEARTBEAT_MS = "5000";
		expect(resolveJsonHeartbeatMs()).toBe(0);
	});

	it("PIT_JSON_HEARTBEAT_MS overrides the cadence; garbage falls back to the default", () => {
		process.env.PIT_JSON_HEARTBEAT_MS = "5000";
		expect(resolveJsonHeartbeatMs()).toBe(5000);
		process.env.PIT_JSON_HEARTBEAT_MS = "banana";
		expect(resolveJsonHeartbeatMs()).toBe(DEFAULT_JSON_HEARTBEAT_MS);
		process.env.PIT_JSON_HEARTBEAT_MS = "-1";
		expect(resolveJsonHeartbeatMs()).toBe(DEFAULT_JSON_HEARTBEAT_MS);
	});
});
