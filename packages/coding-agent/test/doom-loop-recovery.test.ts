/**
 * CR6 — structured recovery at the doom-loop Tier-3 threshold.
 *
 * The old Tier-3 was a bare `throw` that killed the turn the instant a streak of
 * identical tool calls reached the threshold. CR6 replaces that first hard stop
 * with a structured-recovery steer (decompose the step, switch approach) and only
 * aborts on RELAPSE — the model ignored the steer and kept repeating the call.
 *
 *  1. Reaching Tier-3 the first time injects a recovery steer and does NOT throw.
 *  2. Relapsing (the streak keeps climbing past Tier-3) DOES abort — the safety
 *     throw stays reachable so recovery cannot be injected forever.
 *  3. A different call that breaks the streak resets the recovery budget, so the
 *     NEXT genuine loop is offered recovery again instead of aborting on sight.
 */

import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./suite/harness.js";

function errorMessageOf(message: unknown): string {
	return (message as { errorMessage?: string }).errorMessage ?? "";
}

function customMessages(harness: Harness, customType: string) {
	return harness.session.messages.filter(
		(m) => (m as { role?: string }).role === "custom" && (m as { customType?: string }).customType === customType,
	) as Array<{ content: string }>;
}

function didAbort(harness: Harness): boolean {
	return harness.session.messages.some((m) => m.role === "assistant" && errorMessageOf(m).includes("Doom loop abort"));
}

describe("doom-loop Tier-3 structured recovery (CR6)", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("injects a recovery steer (not an abort) the first time a streak reaches Tier-3", async () => {
		const harness = await createHarness({
			settings: { toolFeedback: { doomLoopReminder: { enabled: true, threshold: 2 } } },
		});
		harnesses.push(harness);

		// Exactly enough identical calls to hit the Tier-3 threshold (6), then a plain
		// text reply so the loop ends before it can relapse.
		const fixated = fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })], { stopReason: "toolUse" });
		harness.setResponses([...Array.from({ length: 6 }, () => fixated), fauxAssistantMessage("stopping")]);

		await harness.session.prompt("read the file");

		// Recovery steer fired once, and the turn was NOT aborted.
		const recovery = customMessages(harness, "pi.doom-loop-recovery");
		expect(recovery.length).toBe(1);
		expect(recovery[0]?.content).toContain("Rethink from scratch");
		expect(recovery[0]?.content).toContain("STOP repeating this call");
		expect(didAbort(harness)).toBe(false);
	});

	it("aborts on relapse — the streak keeps climbing past Tier-3 after the recovery steer", async () => {
		const harness = await createHarness({
			settings: { toolFeedback: { doomLoopReminder: { enabled: true, threshold: 2 } } },
		});
		harnesses.push(harness);

		// Far more identical calls than the threshold: recovery fires at 6, then the
		// model ignores it and keeps looping, so the 7th identical call relapses and
		// the safety abort fires.
		const fixated = fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })], { stopReason: "toolUse" });
		harness.setResponses(Array.from({ length: 12 }, () => fixated));

		await harness.session.prompt("read the file");

		// Recovery was offered first...
		expect(customMessages(harness, "pi.doom-loop-recovery").length).toBe(1);
		// ...then the relapse aborted at the climbing count (Tier-3 + 1).
		const abortMsg = harness.session.messages.find(
			(m) => m.role === "assistant" && errorMessageOf(m).includes("Doom loop abort"),
		);
		expect(abortMsg).toBeDefined();
		expect(errorMessageOf(abortMsg)).toContain("7 consecutive");
		// The loop was cut short well before the 12 queued calls drained.
		expect(harness.session.messages.filter((m) => m.role === "toolResult").length).toBeLessThan(12);
	});

	it("resets the recovery budget when a different call breaks the streak", async () => {
		const harness = await createHarness({
			settings: { toolFeedback: { doomLoopReminder: { enabled: true, threshold: 2 } } },
		});
		harnesses.push(harness);

		// Loop A reaches Tier-3 (recovery #1), a DIFFERENT call breaks the streak
		// (recovery budget resets), then loop A reaches Tier-3 again. Because the
		// budget was forgiven, the second Tier-3 RECOVERS again instead of aborting.
		const callA = fauxAssistantMessage([fauxToolCall("read", { path: "missing-a.txt" })], { stopReason: "toolUse" });
		const callB = fauxAssistantMessage([fauxToolCall("read", { path: "missing-b.txt" })], { stopReason: "toolUse" });
		harness.setResponses([
			...Array.from({ length: 6 }, () => callA), // climbs to Tier-3 → recovery #1
			callB, // different call breaks the streak → budget reset
			...Array.from({ length: 6 }, () => callA), // climbs to Tier-3 again → recovery #2
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read the files");

		// Two recovery steers, and NO abort — proves the streak-break forgave the
		// budget (otherwise the second Tier-3 would have aborted after one recovery).
		expect(customMessages(harness, "pi.doom-loop-recovery").length).toBe(2);
		expect(didAbort(harness)).toBe(false);
	});
});
