import type { AgentMessage } from "@pit/agent-core";
import { Agent } from "@pit/agent-core";
import { getModel } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

describe("AgentSession transformContext prune memoization (P02)", () => {
	it("reuses pruned result when transcript identity is unchanged", async () => {
		let transformCalls = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "off",
			},
			transformContext: async (messages: AgentMessage[]) => {
				transformCalls++;
				return messages;
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

		const messages: AgentMessage[] = [
			{ role: "user", content: "hello", timestamp: 1_000 },
			{
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
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
			},
		];

		const first = await session.agent.transformContext!(messages);
		const second = await session.agent.transformContext!(messages);

		expect(transformCalls).toBe(1);
		expect(second).toBe(first);

		const extended: AgentMessage[] = [...messages, { role: "user", content: "again", timestamp: 3_000 }];
		const third = await session.agent.transformContext!(extended);
		expect(transformCalls).toBe(2);
		expect(third).not.toBe(first);
	});
});
