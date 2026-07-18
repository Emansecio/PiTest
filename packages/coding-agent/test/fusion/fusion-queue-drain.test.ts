/**
 * Bug 1: a steer/follow-up queued DURING a Fusion turn must be delivered as a new
 * turn once the Fusion turn ends. A Fusion turn runs outside the agent loop, so the
 * loop never drains those queues — the session drains them itself afterwards and
 * re-routes each through the normal prompt path.
 */

import { fauxAssistantMessage } from "@pit/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../suite/harness.js";

const { runFusionSessionTurnMock } = vi.hoisted(() => ({ runFusionSessionTurnMock: vi.fn() }));

vi.mock("../../src/core/agent-session-fusion.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/core/agent-session-fusion.ts")>();
	return { ...actual, runFusionSessionTurn: runFusionSessionTurnMock };
});

describe("Fusion queue drain (Bug 1)", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		runFusionSessionTurnMock.mockReset();
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("delivers follow-ups queued during a Fusion turn as new turns, in order, and clears the mirror", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setOrchestration("fusion");

		let call = 0;
		runFusionSessionTurnMock.mockImplementation(async (host: Harness["session"]) => {
			call++;
			if (call === 1) {
				// Two mid-turn submits arrive while the Fusion turn is running. Real code
				// routes them here via _promptOnce's queue branch → session.followUp.
				await host.followUp("queued one");
				await host.followUp("queued two");
				return true; // Fusion owns and handled the first turn.
			}
			return false; // Drained messages fall through to a normal solo turn.
		});

		harness.setResponses([fauxAssistantMessage("handled one"), fauxAssistantMessage("handled two")]);

		await harness.session.prompt("first");

		// Both queued follow-ups became real turns, in FIFO order.
		expect(getUserTexts(harness)).toEqual(["queued one", "queued two"]);
		expect(getAssistantTexts(harness)).toEqual(["handled one", "handled two"]);
		// The UI mirror is empty again.
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.session.pendingMessageCount).toBe(0);
		// Fusion routed once for "first", then once per drained message (each returned false → solo).
		expect(call).toBe(3);
	});
});
