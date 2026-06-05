import { Agent, type AgentMessage } from "@pit/agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { convertToLlm } from "../../src/core/messages.ts";
import { makeAgentDelivery, makeAgentResponder, renderPassiveNotice } from "../../src/core/messaging/responder.ts";

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

	it("remembers prior exchanges within the side-channel thread", async () => {
		const { faux, agent } = fauxAgent("You are Worker.", []);
		const seen: Context[] = [];
		faux.setResponses([
			(ctx: Context) => {
				seen.push(ctx);
				return fauxAssistantMessage("auth lives in src/auth.ts");
			},
			(ctx: Context) => {
				seen.push(ctx);
				return fauxAssistantMessage("line 42");
			},
		]);
		const respond = makeAgentResponder(agent);
		await respond("Main", "where is auth?");
		await respond("Main", "which line?");

		// The first turn carried no prior thread; the second recaps exchange #1.
		expect(JSON.stringify(seen[0]?.messages)).not.toContain("Earlier in this side-channel thread");
		const second = JSON.stringify(seen[1]?.messages);
		expect(second).toContain("Earlier in this side-channel thread");
		expect(second).toContain("where is auth?");
		expect(second).toContain("auth lives in src/auth.ts");
		expect(second).toContain("which line?");
	});

	it("thread memory stays in the side-channel — never touches task history", async () => {
		const { faux, agent } = fauxAgent("You are Worker.", [
			{ role: "user", content: [{ type: "text", text: "task" }], timestamp: 1 },
		]);
		faux.setResponses([fauxAssistantMessage("r1"), fauxAssistantMessage("r2")]);
		const respond = makeAgentResponder(agent);
		await respond("Main", "q1");
		await respond("Main", "q2");
		expect(agent.state.messages).toHaveLength(1); // still just the original task message
	});
});

describe("makeAgentDelivery (fire-and-forget)", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});

	it("renderPassiveNotice frames a no-reply notice with sender and body", () => {
		const out = renderPassiveNotice("Main", "schema changed");
		expect(out).toContain("Main");
		expect(out).toContain("schema changed");
		expect(out).toMatch(/don't need to reply|do not need to reply/i);
	});

	it("delivers a passive notice into a running agent without awaiting a reply", async () => {
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		const agent = new Agent({
			initialState: { systemPrompt: "You are Worker.", model: faux.getModel(), messages: [], tools: [] },
			convertToLlm: (m) => convertToLlm(m),
		});
		// Turn 1 makes a tool call (loop continues); turn 2 finishes. The notice,
		// queued before the run, lands as a passive message and the final answer
		// is still the agent's "done".
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("nonexistent_tool", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		makeAgentDelivery(agent)("Main", "FYI-DELIVERED");
		await agent.prompt("work");
		expect(JSON.stringify(agent.state.messages)).toContain("FYI-DELIVERED");
		const assistants = agent.state.messages.filter((m) => m.role === "assistant");
		expect(assistants.at(-1)?.content).toEqual([{ type: "text", text: "done" }]);
	});
});
