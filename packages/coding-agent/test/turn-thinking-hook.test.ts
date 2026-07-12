import type { AgentMessage } from "@pit/agent-core";
import { Agent } from "@pit/agent-core";
import type { ToolResultMessage } from "@pit/ai";
import { getModel } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function makeSession(thinkingLevel: "off" | "low" | "high") {
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "You are a helpful assistant.",
			tools: [],
			thinkingLevel,
		},
	});
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory(),
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});
	return session;
}

function assistantMessage(): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2_000,
	};
}

function toolResult(isError: boolean): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `tc-${Math.random().toString(36).slice(2)}`,
		toolName: "bash",
		content: [{ type: "text", text: isError ? "boom" : "ok" }],
		isError,
		timestamp: 1_500,
	};
}

function turnContext(messages: AgentMessage[], toolResults: ToolResultMessage[]) {
	return {
		message: assistantMessage() as never,
		toolResults,
		context: { messages, tools: [] } as never,
		newMessages: [] as never,
	};
}

describe("AgentSession prepareNextTurn adaptive thinking downshift", () => {
	const savedFlag = process.env.PIT_NO_ADAPTIVE_THINKING;
	beforeEach(() => {
		delete process.env.PIT_NO_ADAPTIVE_THINKING;
	});
	afterEach(() => {
		if (savedFlag === undefined) delete process.env.PIT_NO_ADAPTIVE_THINKING;
		else process.env.PIT_NO_ADAPTIVE_THINKING = savedFlag;
	});

	const messages: AgentMessage[] = [{ role: "user", content: "hello", timestamp: 1_000 }, assistantMessage()];

	it("downshifts to low after a successful tool result when user level is high", async () => {
		const session = makeSession("high");
		const update = await session.agent.prepareNextTurn!(turnContext(messages, [toolResult(false)]));
		expect(update?.thinkingLevel).toBe("low");
	});

	it("restores the user level after a tool error", async () => {
		const session = makeSession("high");
		const update = await session.agent.prepareNextTurn!(turnContext(messages, [toolResult(true)]));
		expect(update?.thinkingLevel).toBe("high");
	});

	it("restores the user level when there were no tool results", async () => {
		const session = makeSession("high");
		const update = await session.agent.prepareNextTurn!(turnContext(messages, []));
		expect(update?.thinkingLevel).toBe("high");
	});

	it("never overrides when the user level is at/below the floor", async () => {
		const session = makeSession("low");
		const update = await session.agent.prepareNextTurn!(turnContext(messages, [toolResult(false)]));
		// No context reclaim on this tiny transcript and no thinking override → undefined.
		expect(update?.thinkingLevel).toBeUndefined();
	});

	it("never mutates the user's configured thinking level (state stays 'high')", async () => {
		const session = makeSession("high");
		await session.agent.prepareNextTurn!(turnContext(messages, [toolResult(false)]));
		expect(session.agent.state.thinkingLevel).toBe("high");
	});

	it("kill-switch PIT_NO_ADAPTIVE_THINKING suppresses the override", async () => {
		process.env.PIT_NO_ADAPTIVE_THINKING = "1";
		const session = makeSession("high");
		const update = await session.agent.prepareNextTurn!(turnContext(messages, [toolResult(false)]));
		expect(update?.thinkingLevel).toBeUndefined();
	});
});
