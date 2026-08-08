/**
 * Property test: the doom-loop Tier-3 abort must not leave orphaned tool calls.
 *
 * The Tier-3 relapse throws from `tool_execution_end` (`maybeInjectDoomLoop` in
 * turn-steering-engine) to abort the turn — this is DESIGN, not a bug. But the
 * throw unwinds through the agent loop's tool executor. In the default (parallel)
 * executor the tool-RESULT message fan-out runs only AFTER the batch's
 * `tool_execution_end` events; a throw from one of those events bails before the
 * fan-out, so the just-executed call's assistant `tool_use` is left with NO paired
 * `tool_result` message. A transcript with an assistant `tool_use` and no matching
 * `tool_result` is rejected by the next provider request (Anthropic 400).
 *
 * Invariant under test (independent of WHY the turn aborted): every `toolCall` id
 * that appears in an assistant message has a corresponding `toolResult` message.
 *
 * NOTE on ids: reusing one `fauxAssistantMessage` object across turns would give
 * every turn the SAME tool-call id, so an orphaned final call's id would collide
 * with earlier resolved results and the check would falsely pass. Each turn here
 * gets a UNIQUE id, so the pairing assertion is real.
 */

import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./suite/harness.js";
import { assertNoOrphanToolCalls } from "./suite/tool-pairing.js";

function errorMessageOf(message: unknown): string {
	return (message as { errorMessage?: string }).errorMessage ?? "";
}

describe("doom-loop abort — transcript tool-call/result pairing invariant", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("leaves no orphaned toolCall when the loop aborts on a Tier-3 relapse", async () => {
		const harness = await createHarness({
			settings: { toolFeedback: { doomLoopReminder: { enabled: true, threshold: 2, cooldownMs: 0 } } },
		});
		harnesses.push(harness);

		// The model fixates on the same failing read. Same name+args+result every turn
		// (unique call id per turn) → the streak climbs and the turn aborts at count 8
		// (recovery consumed once). The throwing call's tool_execution_end fires before
		// its tool_result message is emitted — the orphan window under test.
		harness.setResponses(
			Array.from({ length: 12 }, (_, i) =>
				fauxAssistantMessage([fauxToolCall("read", { path: "does-not-exist.txt" }, { id: `read-${i}` })], {
					stopReason: "toolUse",
				}),
			),
		);

		await harness.session.prompt("read the file");

		// Sanity: the turn actually aborted via the doom-loop (otherwise the invariant
		// is trivially satisfied and proves nothing).
		const aborted = harness.session.messages.some(
			(m) => m.role === "assistant" && errorMessageOf(m).includes("Doom loop abort"),
		);
		expect(aborted).toBe(true);

		// The load-bearing assertion: no assistant tool_use is left without a result.
		assertNoOrphanToolCalls(harness.session.messages);
	});

	it("keeps the invariant with a higher threshold (abort lands later in the streak)", async () => {
		const harness = await createHarness({
			settings: { toolFeedback: { doomLoopReminder: { enabled: true, threshold: 5, cooldownMs: 0 } } },
		});
		harnesses.push(harness);

		harness.setResponses(
			Array.from({ length: 16 }, (_, i) =>
				fauxAssistantMessage([fauxToolCall("read", { path: "nope.txt" }, { id: `r-${i}` })], {
					stopReason: "toolUse",
				}),
			),
		);

		await harness.session.prompt("read it");

		const aborted = harness.session.messages.some(
			(m) => m.role === "assistant" && errorMessageOf(m).includes("Doom loop abort"),
		);
		expect(aborted).toBe(true);
		assertNoOrphanToolCalls(harness.session.messages);
	});
});
