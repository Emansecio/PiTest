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
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./suite/harness.js";

function errorMessageOf(message: unknown): string {
	return (message as { errorMessage?: string }).errorMessage ?? "";
}

describe("doom-loop escalation", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("aborts the turn once identical tool calls reach the Tier-3 threshold", async () => {
		const harness = await createHarness({
			settings: { toolFeedback: { doomLoopReminder: { enabled: true, threshold: 2 } } },
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
		// Reached the Tier-3 count of 6 (the old bug capped it at the Tier-2 reset).
		expect(errorMessageOf(abortMsg)).toContain("6 consecutive");

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
});
