/**
 * Regression test for the doom-loop escalation tiers.
 *
 * The Tier-3 abort (the hard backstop that stops a wedged agent) was unreachable
 * under the default config: Tier 2 reset the consecutive-call counter at 4, so it
 * never climbed to the Tier-3 threshold of 6 and the agent looped on "urgent"
 * steers until the per-run turn budget caught it. The tiers now fire once each
 * while the counter keeps climbing, so a persistent identical-call loop actually
 * aborts.
 */

import type { AgentTool } from "@pit/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isKnownPollingCall } from "../src/core/turn-steering-engine.js";
import { createHarness, type Harness } from "./suite/harness.js";

function errorMessageOf(message: unknown): string {
	return (message as { errorMessage?: string }).errorMessage ?? "";
}

describe("doom-loop escalation", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		delete process.env.PIT_NO_DOOM_LOOP_GUARD;
		vi.restoreAllMocks();
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	function customMessageCount(harness: Harness, customType: string): number {
		return harness.session.messages.filter(
			(m) => m.role === "custom" && (m as { customType?: string }).customType === customType,
		).length;
	}

	it("recognizes coordinator, bash-job, and status polling without exempting mutations", () => {
		expect(isKnownPollingCall("task", { op: "poll", handles: ["a"] })).toBe(true);
		expect(isKnownPollingCall("task", { op: "join", handles: ["a"] })).toBe(true);
		expect(isKnownPollingCall("task", { op: "run", prompt: "work" })).toBe(false);
		expect(isKnownPollingCall("bash", { jobId: "bg-1", action: "wait" })).toBe(true);
		expect(isKnownPollingCall("bash", { jobId: "bg-1", action: "kill" })).toBe(false);
		expect(isKnownPollingCall("run_status", { action: "status" })).toBe(true);
	});

	it("aborts the turn once identical tool calls reach the Tier-3 threshold", async () => {
		const harness = await createHarness({
			settings: { toolFeedback: { doomLoopReminder: { enabled: true, threshold: 2, cooldownMs: 0 } } },
		});
		harnesses.push(harness);

		// The model fixates on the same failing read. Far more identical calls than
		// the Tier-3 threshold (6) — without the fix this would loop until the turn
		// budget, re-emitting Tier-2 steers forever and never aborting.
		const fixated = fauxAssistantMessage([fauxToolCall("read", { path: "does-not-exist.txt" })], {
			stopReason: "toolUse",
		});
		harness.setResponses(Array.from({ length: 12 }, () => fixated));

		await harness.session.prompt("read the file");

		const abortMsg = harness.session.messages.find(
			(m) => m.role === "assistant" && errorMessageOf(m).includes("Doom loop abort"),
		);
		expect(abortMsg).toBeDefined();
		// CR6: the first Tier-3 (count 6) injects a recovery steer instead of
		// aborting; relapse aborts one past the recovery budget. Session recovery
		// in `strict` raises the budget to 2, so abort lands at 8 (not 7).
		expect(errorMessageOf(abortMsg)).toContain("8 consecutive");

		// The loop was actually cut short — far fewer reads ran than were queued.
		const reads = harness.session.messages.filter((m) => m.role === "toolResult").length;
		expect(reads).toBeLessThan(12);
	});

	it("does not abort when identical calls stay below the threshold", async () => {
		const harness = await createHarness({
			settings: { toolFeedback: { doomLoopReminder: { enabled: true, threshold: 2 } } },
		});
		harnesses.push(harness);

		// Three identical reads then a normal text reply: hits Tier 1 (soft reminder)
		// but never the abort.
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("giving up on that file"),
		]);

		await harness.session.prompt("read the file");

		const aborted = harness.session.messages.some(
			(m) => m.role === "assistant" && errorMessageOf(m).includes("Doom loop abort"),
		);
		expect(aborted).toBe(false);
	});

	it("keeps tier order when threshold > 3 (abort clamps above the soft reminder)", async () => {
		// With threshold=5 the abort must clamp to max(6, 5+4)=9 instead of the literal
		// 6, so the soft reminder (tier 1 at 5) still fires before the urgent pause and
		// the abort. The pre-fix literals (4/6) would have inverted the order: the pause
		// at 4 and abort at 6 both fire before the configured tier-1 threshold of 5.
		const harness = await createHarness({
			settings: { toolFeedback: { doomLoopReminder: { enabled: true, threshold: 5, cooldownMs: 0 } } },
		});
		harnesses.push(harness);

		const fixated = fauxAssistantMessage([fauxToolCall("read", { path: "does-not-exist.txt" })], {
			stopReason: "toolUse",
		});
		harness.setResponses(Array.from({ length: 14 }, () => fixated));

		await harness.session.prompt("read the file");

		const abortMsg = harness.session.messages.find(
			(m) => m.role === "assistant" && errorMessageOf(m).includes("Doom loop abort"),
		);
		expect(abortMsg).toBeDefined();
		// CR6: recovery fires at the clamped tier-3 count of 9, then the relapse aborts
		// at 10 (not the old literal 6, and one past the recovery point).
		expect(errorMessageOf(abortMsg)).toContain("10 consecutive");
	});

	it("does not abort identical calls that return a NEW result each time (real progress)", async () => {
		// A tool whose args never change but whose RESULT advances every call — the
		// canonical false positive (debugger stepping, tailing a growing log). The
		// pre-fix detector counted by name+args only and aborted on the 6th step; the
		// result-aware count must let it run to completion.
		let tick = 0;
		const stepper: AgentTool = {
			name: "stepper",
			label: "Stepper",
			description: "Advances one step and reports new state",
			parameters: Type.Object({}),
			execute: async () => {
				tick += 1;
				return { content: [{ type: "text", text: `at line ${tick}` }], details: undefined };
			},
		};

		const harness = await createHarness({
			settings: { toolFeedback: { doomLoopReminder: { enabled: true, threshold: 2 } } },
			tools: [stepper],
		});
		harnesses.push(harness);

		// Twelve identical-args calls (well past the Tier-3 threshold of 6), then a
		// normal reply. Each yields a distinct result, so the streak never climbs.
		const stepCall = fauxAssistantMessage([fauxToolCall("stepper", {})], { stopReason: "toolUse" });
		harness.setResponses([...Array.from({ length: 12 }, () => stepCall), fauxAssistantMessage("done stepping")]);

		await harness.session.prompt("step through it");

		const aborted = harness.session.messages.some(
			(m) => m.role === "assistant" && errorMessageOf(m).includes("Doom loop abort"),
		);
		expect(aborted).toBe(false);
		// All twelve steps ran — the loop was NOT cut short.
		const stepResults = harness.session.messages.filter((m) => m.role === "toolResult").length;
		expect(stepResults).toBe(12);
	});

	it("never hard-aborts identical bash background-job polling results", async () => {
		const harness = await createHarness({
			settings: { toolFeedback: { doomLoopReminder: { enabled: true, threshold: 2, cooldownMs: 0 } } },
		});
		harnesses.push(harness);

		const poll = fauxAssistantMessage([fauxToolCall("bash", { jobId: "missing-job", action: "poll" })], {
			stopReason: "toolUse",
		});
		harness.setResponses([...Array.from({ length: 10 }, () => poll), fauxAssistantMessage("still pending")]);
		await harness.session.prompt("wait for the background job");

		expect(harness.session.messages.some((m) => errorMessageOf(m).includes("Doom loop abort"))).toBe(false);
		expect(harness.session.messages.filter((m) => m.role === "toolResult")).toHaveLength(10);
	});

	it("honors the configured cooldown before repeating identical-call reminders", async () => {
		const harness = await createHarness({
			settings: { toolFeedback: { doomLoopReminder: { enabled: true, threshold: 2, cooldownMs: 60_000 } } },
		});
		harnesses.push(harness);
		const callA = () =>
			fauxAssistantMessage([fauxToolCall("read", { path: "missing-a.txt" })], { stopReason: "toolUse" });
		const callB = fauxAssistantMessage([fauxToolCall("read", { path: "missing-b.txt" })], { stopReason: "toolUse" });
		harness.setResponses([callA(), callA(), callB, callA(), callA(), fauxAssistantMessage("done")]);

		await harness.session.prompt("read the files");

		expect(customMessageCount(harness, "pi.doom-loop-reminder")).toBe(1);
	});

	it("spaces every same-streak escalation and never aborts before suppressed recovery is delivered", async () => {
		let now = 10_000;
		let executions = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const probe: AgentTool = {
			name: "probe",
			label: "Probe",
			description: "Returns the same stalled result",
			parameters: Type.Object({}),
			execute: async () => {
				executions++;
				if (executions === 8 || executions === 10) now += 60_000;
				return { content: [{ type: "text", text: "still stalled" }], details: undefined };
			},
		};
		const harness = await createHarness({
			settings: { toolFeedback: { doomLoopReminder: { enabled: true, threshold: 2, cooldownMs: 60_000 } } },
			tools: [probe],
		});
		harnesses.push(harness);
		const fixated = fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" });
		harness.setResponses([...Array.from({ length: 12 }, () => fixated), fauxAssistantMessage("done")]);

		await harness.session.prompt("keep probing");

		expect(customMessageCount(harness, "pi.doom-loop-reminder")).toBe(1);
		expect(customMessageCount(harness, "pi.doom-loop-pause")).toBe(0);
		expect(customMessageCount(harness, "pi.doom-loop-recovery")).toBe(1);
		const abort = harness.session.messages.find(
			(message) => message.role === "assistant" && errorMessageOf(message).includes("Doom loop abort"),
		);
		expect(errorMessageOf(abort)).toContain("9 consecutive");
	});

	it("PIT_NO_DOOM_LOOP_GUARD disables the identical-call guard", async () => {
		process.env.PIT_NO_DOOM_LOOP_GUARD = "1";
		const harness = await createHarness({
			settings: { toolFeedback: { doomLoopReminder: { enabled: true, threshold: 2, cooldownMs: 0 } } },
		});
		harnesses.push(harness);
		const fixated = fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })], {
			stopReason: "toolUse",
		});
		harness.setResponses([...Array.from({ length: 10 }, () => fixated), fauxAssistantMessage("done")]);

		await harness.session.prompt("read the file");

		expect(harness.session.messages.some((m) => errorMessageOf(m).includes("Doom loop abort"))).toBe(false);
		expect(customMessageCount(harness, "pi.doom-loop-reminder")).toBe(0);
		expect(harness.session.messages.filter((m) => m.role === "toolResult")).toHaveLength(10);
	});
});
