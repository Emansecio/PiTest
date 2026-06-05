import { Agent, type AgentMessage } from "@pit/agent-core";
import { type Context, fauxAssistantMessage, registerFauxProvider } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { convertToLlm } from "../../src/core/messages.ts";
import { makeAgentResponder } from "../../src/core/messaging/responder.ts";

describe("makeAgentResponder", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	function fauxAgent(systemPrompt: string, history: AgentMessage[]) {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		const agent = new Agent({
			initialState: { systemPrompt, model: faux.getModel(), messages: history, tools: [] },
			convertToLlm: (m) => convertToLlm(m),
		});
		return { faux, agent };
	}

	it("returns the recipient's prose reply", async () => {
		const { faux, agent } = fauxAgent("You are Worker.", [
			{ role: "user", content: [{ type: "text", text: "do the thing" }], timestamp: 1 },
		]);
		faux.setResponses([fauxAssistantMessage("yes, path is src/auth.ts")]);
		const respond = makeAgentResponder(agent);
		await expect(respond("Main", "where does auth live?")).resolves.toBe("yes, path is src/auth.ts");
	});

	it("runs tool-less, keeps the recipient's own system prompt, and includes the incoming message", async () => {
		const { faux, agent } = fauxAgent("You are Worker.", []);
		let seen: Context | undefined;
		faux.setResponses([
			(ctx: Context) => {
				seen = ctx;
				return fauxAssistantMessage("ack");
			},
		]);
		await makeAgentResponder(agent)("Main", "ping-123");
		expect(seen?.tools).toEqual([]); // no tools offered to the side-channel turn
		expect(seen?.systemPrompt).toBe("You are Worker.");
		const lastText = JSON.stringify(seen?.messages.at(-1));
		expect(lastText).toContain("ping-123");
		expect(lastText).toContain("Main");
	});

	it("does not mutate the recipient's live message history", async () => {
		const { faux, agent } = fauxAgent("You are Worker.", [
			{ role: "user", content: [{ type: "text", text: "original" }], timestamp: 1 },
		]);
		faux.setResponses([fauxAssistantMessage("reply")]);
		await makeAgentResponder(agent)("Main", "hello");
		expect(agent.state.messages).toHaveLength(1); // snapshot was read-only
	});
});
