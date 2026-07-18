/**
 * CR5 — result-only doom-loop ("thrash") detector.
 *
 * The args-keyed doom-loop counts repetition by (toolName, argsFingerprint,
 * resultHash). When the model TWEAKS the arguments every attempt (shifted
 * offset, slightly different oldText) but keeps getting the SAME error, that
 * streak resets each call and the ladder never escalates. This detector keys on
 * the RESULT only (error-only, higher threshold) and steers ONCE — without
 * aborting — telling the model to change approach instead of varying args.
 *
 * Regression guard: when args ARE identical, the existing args-keyed ladder owns
 * the loop and the result-only signal must stay silent (no double-steer).
 */

import type { AgentTool } from "@pit/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { Type } from "typebox";
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

/** A tool that ALWAYS fails with the SAME error, regardless of its args — so the
 * result hash is constant while callers can still vary `n` between calls. */
function makeConstantErrorTool(name = "repeater"): AgentTool {
	return {
		name,
		label: name,
		description: "Always fails with the same error regardless of args",
		parameters: Type.Object({ n: Type.Optional(Type.Number()) }),
		execute: async () => {
			throw new Error("the same boom every time");
		},
	};
}

describe("result-only doom-loop (thrash) detector", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("steers once when the args vary every call but the error is always the same", async () => {
		const harness = await createHarness({
			settings: { toolFeedback: { doomLoopReminder: { enabled: true, threshold: 2 } } },
			tools: [makeConstantErrorTool("repeater")],
		});
		harnesses.push(harness);

		// Six calls, DIFFERENT args each (n = 0..5), same error every time → the
		// args-keyed ladder never climbs (streak resets each call), but the
		// result-only count reaches the threshold (5) and steers once.
		harness.setResponses([
			...Array.from({ length: 6 }, (_, i) =>
				fauxAssistantMessage([fauxToolCall("repeater", { n: i })], { stopReason: "toolUse" }),
			),
			fauxAssistantMessage("ok, switching approach"),
		]);

		await harness.session.prompt("do the thing");

		const resultLoop = customMessages(harness, "pi.result-loop-reminder");
		// Exactly one steer, even though it kept failing.
		expect(resultLoop.length).toBe(1);
		expect(resultLoop[0]?.content).toContain("<result-loop-reminder>");
		expect(resultLoop[0]?.content).toContain("the same boom every time");
		// Steers the model to re-read the error it already received before retrying.
		expect(resultLoop[0]?.content).toContain("re-read the full error above");

		// The args-keyed doom-loop is unchanged: it never tripped (args varied) — no
		// abort and no args-keyed steers.
		const aborted = harness.session.messages.some(
			(m) => m.role === "assistant" && errorMessageOf(m).includes("Doom loop abort"),
		);
		expect(aborted).toBe(false);
		expect(customMessages(harness, "pi.doom-loop-pause").length).toBe(0);
		expect(customMessages(harness, "pi.doom-loop-reminder").length).toBe(0);
	});

	it("stays silent (no double-steer) when args are identical — the args-keyed ladder owns it", async () => {
		const harness = await createHarness({
			settings: { toolFeedback: { doomLoopReminder: { enabled: true, threshold: 2 } } },
			tools: [makeConstantErrorTool("repeater")],
		});
		harnesses.push(harness);

		// SAME args every call → the existing args-keyed ladder escalates and aborts
		// at its Tier-3 threshold (6). The result-only signal must defer.
		const sameCall = fauxAssistantMessage([fauxToolCall("repeater", { n: 1 })], { stopReason: "toolUse" });
		harness.setResponses([...Array.from({ length: 10 }, () => sameCall), fauxAssistantMessage("stop")]);

		await harness.session.prompt("do the thing");

		// The args-keyed doom-loop ran (it aborts on identical calls)...
		const aborted = harness.session.messages.some(
			(m) => m.role === "assistant" && errorMessageOf(m).includes("Doom loop abort"),
		);
		expect(aborted).toBe(true);
		// ...and the result-only detector did NOT also fire.
		expect(customMessages(harness, "pi.result-loop-reminder").length).toBe(0);
	});
});
