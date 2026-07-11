/**
 * Fusion must run the same context-economy preflight as solo (background join +
 * hard threshold + presend overflow) before panel/judge/writer stages.
 */

import { Agent } from "@pit/agent-core";
import { type AssistantMessage, getModel } from "@pit/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/agent-session.js";
import * as compactionModule from "../../src/core/agent-session-compaction.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { createTestResourceLoader } from "../utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function createSession() {
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	return new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "off",
			},
		}),
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory(),
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});
}

function seedAssistant(session: AgentSession): AssistantMessage {
	const msg: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "prior" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 1000,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1050,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	session.agent.state.messages.push(msg);
	session.setLastAssistantMessage(msg);
	return msg;
}

describe("prepareFusionContextEconomy", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("awaits background compact, then threshold + presend with pending user text", async () => {
		const session = createSession();
		try {
			seedAssistant(session);

			const awaitBg = vi.spyOn(compactionModule, "awaitBackgroundCompaction").mockResolvedValue();
			const checkCompact = vi.spyOn(compactionModule, "checkCompaction").mockResolvedValue(false);
			const checkPresend = vi.spyOn(compactionModule, "checkPresendOverflow").mockResolvedValue(false);

			await session.prepareFusionContextEconomy("fusion user prompt");

			expect(awaitBg).toHaveBeenCalledOnce();
			expect(checkCompact).toHaveBeenCalledWith(
				session.compaction,
				expect.objectContaining({ role: "assistant" }),
				false,
				false,
				{ skipPresendGuard: true },
			);
			expect(checkPresend).toHaveBeenCalledWith(
				session.compaction,
				expect.objectContaining({ role: "assistant" }),
				expect.objectContaining({
					systemPrompt: expect.any(String),
					tools: expect.any(Array),
					pendingMessages: [
						expect.objectContaining({
							role: "user",
							content: [expect.objectContaining({ type: "text", text: "fusion user prompt" })],
						}),
					],
				}),
			);
			expect(awaitBg.mock.invocationCallOrder[0]).toBeLessThan(checkCompact.mock.invocationCallOrder[0]!);
			expect(checkCompact.mock.invocationCallOrder[0]).toBeLessThan(checkPresend.mock.invocationCallOrder[0]!);
		} finally {
			await session.dispose();
		}
	});

	it("no-ops compact/presend when there is no prior assistant message", async () => {
		const session = createSession();
		try {
			const awaitBg = vi.spyOn(compactionModule, "awaitBackgroundCompaction").mockResolvedValue();
			const checkCompact = vi.spyOn(compactionModule, "checkCompaction").mockResolvedValue(false);
			const checkPresend = vi.spyOn(compactionModule, "checkPresendOverflow").mockResolvedValue(false);

			await session.prepareFusionContextEconomy("first turn");

			expect(awaitBg).toHaveBeenCalledOnce();
			expect(checkCompact).not.toHaveBeenCalled();
			expect(checkPresend).not.toHaveBeenCalled();
		} finally {
			await session.dispose();
		}
	});
});
