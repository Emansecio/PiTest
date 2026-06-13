import type { AgentTool } from "@pit/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.js";

/**
 * Characterizes the Esc/interrupt contract: interrupt() must cancel the WHOLE
 * active task (turn + any orchestration loop), not just the current turn — the
 * bug was that the verification gate / goal loop re-dispatched the agent right
 * after the turn aborted, so Esc appeared to do nothing.
 */
describe("AgentSession interrupt (Esc)", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	}, 60_000);

	/** A tool that blocks until its abort signal fires, signalling when it starts. */
	const waitSchema = Type.Object({});
	function makeBlockingTool(onStart: () => void): AgentTool<typeof waitSchema> {
		return {
			name: "wait",
			label: "Wait",
			description: "Blocks until aborted",
			parameters: waitSchema,
			execute: async (_id, _params, signal) => {
				onStart();
				await new Promise<void>((resolve) => {
					if (signal?.aborted) return resolve();
					signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return { content: [{ type: "text", text: "stopped" }], details: undefined };
			},
		};
	}

	it("isBusy is false while idle and clears after a turn completes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		expect(harness.session.isBusy).toBe(false);
		harness.setResponses([fauxAssistantMessage("hi")]);
		await harness.session.prompt("hello");
		expect(harness.session.isBusy).toBe(false);
	});

	it("interrupt() aborts the active turn and stops the task from re-dispatching", async () => {
		let signalStarted!: () => void;
		const toolStarted = new Promise<void>((resolve) => {
			signalStarted = resolve;
		});
		const harness = await createHarness({ tools: [makeBlockingTool(() => signalStarted())] });
		harnesses.push(harness);

		// First response calls the blocking tool; the second would only run if the
		// turn continued after the tool — i.e. if the abort failed to stop the loop.
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("should-not-run"),
		]);

		const promptDone = harness.session.prompt("go");
		await toolStarted;
		expect(harness.session.isBusy).toBe(true);

		harness.session.interrupt();
		await promptDone;

		// If interrupt() failed to abort, the blocking tool never resolves and this
		// test times out — so reaching here already proves the turn was cancelled.
		const assistantTexts = harness.session.messages
			.filter((message) => message.role === "assistant")
			.map((message) => getMessageText(message));
		// The queued continuation never reached the transcript: the task stopped.
		expect(assistantTexts).not.toContain("should-not-run");
		expect(harness.session.isBusy).toBe(false);
	});

	it("a fresh prompt after an interrupt runs normally (the one-shot flag is cleared)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// Interrupt while idle raises the one-shot flag; the next prompt must clear it.
		harness.session.interrupt();
		harness.setResponses([fauxAssistantMessage("fresh")]);
		await harness.session.prompt("again");

		const assistantTexts = harness.session.messages
			.filter((message) => message.role === "assistant")
			.map((message) => getMessageText(message));
		expect(assistantTexts).toContain("fresh");
	});
});
