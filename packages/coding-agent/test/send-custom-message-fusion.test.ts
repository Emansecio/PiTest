/**
 * `sendCustomMessage` during a Fusion turn.
 *
 * Fusion holds the session for minutes with `isStreaming === false`, because its
 * members are separate CLIs rather than a streaming provider call. Every branch in
 * `sendCustomMessage` read that flag as "idle": `triggerTurn` started a second,
 * concurrent agent turn writing into the same `agent.state.messages` the Fusion
 * writer is building, and a steer meant for the running turn degraded into a loose
 * transcript append. Extensions and timers are precisely the callers that land
 * here, because they fire on wall-clock rather than on turn boundaries.
 */

import { describe, expect, test, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";

const sendCustomMessage = Reflect.get(AgentSession.prototype, "sendCustomMessage") as (
	this: unknown,
	message: unknown,
	options?: unknown,
) => Promise<void>;

const setFusionAbort = Reflect.get(AgentSession.prototype, "setFusionAbort") as (
	this: unknown,
	value: AbortController | undefined,
) => void;

const awaitFusionSettled = Reflect.get(AgentSession.prototype, "awaitFusionSettled") as (
	this: unknown,
) => Promise<void>;

const serializeFusionHandoff = Reflect.get(AgentSession.prototype, "_serializeFusionHandoff") as (
	this: unknown,
	task: () => Promise<void>,
) => Promise<void>;

const isFusingDescriptor = Object.getOwnPropertyDescriptor(AgentSession.prototype, "isFusing");

/** Minimal stand-in carrying only what sendCustomMessage touches. */
function fakeSession(options: { streaming?: boolean } = {}) {
	const self = {
		_fusionAbort: undefined as AbortController | undefined,
		_fusionSettled: undefined as { promise: Promise<void>; resolve: () => void } | undefined,
		_fusionHandoffTail: Promise.resolve(),
		_pendingNextTurnMessages: [] as unknown[],
		isStreaming: options.streaming ?? false,
		setFusionAbort,
		awaitFusionSettled,
		_serializeFusionHandoff: serializeFusionHandoff,
		_runAgentPrompt: vi.fn(async () => {}),
		agent: { state: { messages: [] as unknown[] }, steer: vi.fn(), followUp: vi.fn() },
		sessionManager: { appendCustomMessageEntry: vi.fn() },
		emit: vi.fn(),
	};
	Object.defineProperty(self, "isFusing", isFusingDescriptor!);
	return self;
}

const NOTE = { customType: "note", content: "hello", display: undefined, details: undefined };

describe("sendCustomMessage while Fusion owns the turn", () => {
	test("triggerTurn waits for Fusion to settle instead of running alongside it", async () => {
		const self = fakeSession();
		self.setFusionAbort(new AbortController());

		let settled = false;
		const sent = sendCustomMessage.call(self, NOTE, { triggerTurn: true }).then(() => {
			settled = true;
		});

		await Promise.resolve();
		expect(self._runAgentPrompt).not.toHaveBeenCalled();
		expect(settled).toBe(false);

		self.setFusionAbort(undefined); // Fusion's finally
		await sent;
		expect(self._runAgentPrompt).toHaveBeenCalledTimes(1);
	});

	test("a steer becomes a next-turn delivery rather than a loose transcript note", async () => {
		const self = fakeSession();
		self.setFusionAbort(new AbortController());

		await sendCustomMessage.call(self, NOTE, { deliverAs: "steer" });

		expect(self._pendingNextTurnMessages).toHaveLength(1);
		expect(self.agent.state.messages).toHaveLength(0);
		expect(self.sessionManager.appendCustomMessageEntry).not.toHaveBeenCalled();
	});

	test("a plain note still shows up right away — it is not a turn, so it cannot race one", async () => {
		const self = fakeSession();
		self.setFusionAbort(new AbortController());

		await sendCustomMessage.call(self, NOTE);

		expect(self.agent.state.messages).toHaveLength(1);
		expect(self.sessionManager.appendCustomMessageEntry).toHaveBeenCalledTimes(1);
	});

	test("with no Fusion running the old behaviour is untouched", async () => {
		const self = fakeSession();
		await sendCustomMessage.call(self, NOTE, { triggerTurn: true });
		expect(self._runAgentPrompt).toHaveBeenCalledTimes(1);

		const streaming = fakeSession({ streaming: true });
		await sendCustomMessage.call(streaming, NOTE, { deliverAs: "steer" });
		expect(streaming.agent.steer).toHaveBeenCalledTimes(1);
	});

	test("awaitFusionSettled resolves immediately when nothing is fusing", async () => {
		const self = fakeSession();
		let done = false;
		await self.awaitFusionSettled().then(() => {
			done = true;
		});
		expect(done).toBe(true);
	});

	test("a second Fusion turn gets a fresh settle signal", async () => {
		const self = fakeSession();
		self.setFusionAbort(new AbortController());
		self.setFusionAbort(undefined);

		self.setFusionAbort(new AbortController());
		let settled = false;
		const waiting = self.awaitFusionSettled().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		self.setFusionAbort(undefined);
		await waiting;
		expect(settled).toBe(true);
	});
});
