import { afterEach, describe, expect, it } from "vitest";
import { agentMessageBus } from "../../src/core/messaging/index.ts";
import { createHarness } from "../suite/harness.ts";

describe("AgentSession ↔ message bus", () => {
	let cleanup: (() => Promise<void>) | undefined;
	afterEach(async () => {
		await cleanup?.();
		cleanup = undefined;
	});

	it("registers a reachable Main participant on boot and removes it on dispose", async () => {
		const harness = await createHarness();
		const { session } = harness;
		cleanup = harness.cleanup;

		const mainId = session.messagingId;
		expect(mainId).toBeDefined();
		const main = agentMessageBus.get(mainId!);
		expect(main?.kind).toBe("main");
		expect(main?.respond).toBeTypeOf("function");

		await harness.cleanup();
		cleanup = undefined;
		expect(agentMessageBus.get(mainId!)).toBeUndefined();
	});
});
