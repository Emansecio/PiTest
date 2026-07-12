import { Agent } from "@pit/agent-core";
import {
	type AssistantMessage,
	getModel,
	SYSTEM_PROMPT_DYNAMIC_MARKER,
	splitSystemPromptOnDynamic,
	type Usage,
} from "@pit/ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { estimateWireTokens } from "../src/core/compaction/compaction.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { agentToolToWireSurface, compactWireToolSurface } from "../src/core/tool-wire-schema.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-5")!;

function createUsage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function createAssistantMessage(text: string, totalTokens: number, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(totalTokens),
		stopReason: "stop",
		timestamp,
	};
}

function createUserMessage(text: string, timestamp: number) {
	return {
		role: "user" as const,
		content: text,
		timestamp,
	};
}

function createSession() {
	const settingsManager = SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "high",
			},
		}),
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});

	return { session, sessionManager };
}

function syncAgentMessages(session: AgentSession, sessionManager: SessionManager): void {
	session.agent.state.messages = sessionManager.buildSessionContext().messages;
}

function wirePercent(session: AgentSession): number {
	const tools = session.agent.state.tools.map(agentToolToWireSurface).map(compactWireToolSurface);
	const wire = estimateWireTokens(session.agent.state.messages, {
		systemPromptChars: session.agent.state.systemPrompt.length,
		tools,
	});
	return (wire.tokens / model.contextWindow!) * 100;
}

describe("AgentSession.getSessionStats", () => {
	it("exposes the current context usage alongside token totals", () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("hello", 1));
			sessionManager.appendMessage(createAssistantMessage("hi", 200, 2));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.contextUsage).toEqual(session.getContextUsage());
			expect(stats.contextUsage?.tokens).toBe(200);
			// Usage-anchored: provider usage already bills system prompt + tool
			// schemas, so the wire estimate must NOT re-add them (no double-count).
			expect(stats.contextUsage?.wireTokens).toBe(200);
			expect(stats.contextUsage?.contextWindow).toBe(model.contextWindow);
			expect(stats.contextUsage?.percent).toBe(wirePercent(session));
		} finally {
			session.dispose();
		}
	});

	it("reports an immediate structural estimate after compaction (not stale, not null)", () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			sessionManager.appendMessage(createAssistantMessage("response1", 180_000, 2));
			const keptUserId = sessionManager.appendMessage(createUserMessage("second", 3));
			sessionManager.appendMessage(createAssistantMessage("response2", 195_000, 4));
			sessionManager.appendCompaction("summary", keptUserId, 195_000);
			sessionManager.appendMessage(createUserMessage("third", 5));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.tokens.input).toBe(195_000);
			expect(stats.contextUsage).toBeDefined();
			// No provider usage exists after the compaction boundary, so the size is a STRUCTURAL
			// estimate over the reduced messages — flagged, small, and nowhere near the stale 195k.
			expect(stats.contextUsage?.estimated).toBe(true);
			expect(stats.contextUsage?.tokens ?? 0).toBeGreaterThan(0);
			expect(stats.contextUsage?.tokens ?? Number.POSITIVE_INFINITY).toBeLessThan(50_000);
			expect(stats.contextUsage?.percent ?? 0).toBeGreaterThan(0);
		} finally {
			session.dispose();
		}
	});

	it("memoizes context usage and invalidates it when messages change", () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("hello", 1));
			sessionManager.appendMessage(createAssistantMessage("hi", 200, 2));
			syncAgentMessages(session, sessionManager);

			const first = session.getContextUsage();
			expect(first?.tokens).toBe(200);
			// A second call without any mutation returns the same memoized result.
			expect(session.getContextUsage()).toEqual(first);

			// Appending a newer assistant turn must invalidate the cache (leaf id +
			// message count change), not return the stale 200-token value.
			sessionManager.appendMessage(createUserMessage("again", 3));
			sessionManager.appendMessage(createAssistantMessage("hi2", 350, 4));
			syncAgentMessages(session, sessionManager);

			const second = session.getContextUsage();
			expect(second?.tokens).toBe(350);
			// Usage-anchored: no system/tool re-add on top of provider usage.
			expect(second?.wireTokens).toBe(350);
			expect(second?.percent).toBe(wirePercent(session));
		} finally {
			session.dispose();
		}
	});

	it("uses post-compaction usage for current context instead of stale kept usage", () => {
		const { session, sessionManager } = createSession();

		try {
			sessionManager.appendMessage(createUserMessage("first", 1));
			sessionManager.appendMessage(createAssistantMessage("response1", 180_000, 2));
			const keptUserId = sessionManager.appendMessage(createUserMessage("second", 3));
			sessionManager.appendMessage(createAssistantMessage("response2", 195_000, 4));
			sessionManager.appendCompaction("summary", keptUserId, 195_000);
			sessionManager.appendMessage(createUserMessage("third", 5));
			sessionManager.appendMessage(createAssistantMessage("response3", 25_000, 6));
			syncAgentMessages(session, sessionManager);

			const stats = session.getSessionStats();
			expect(stats.tokens.input).toBe(220_000);
			expect(stats.contextUsage).toBeDefined();
			expect(stats.contextUsage?.tokens).toBe(25_000);
			// Usage-anchored: no system/tool re-add on top of provider usage.
			expect(stats.contextUsage?.wireTokens).toBe(25_000);
			expect(stats.contextUsage?.percent).toBe(wirePercent(session));
		} finally {
			session.dispose();
		}
	});
});

describe("AgentSession.getFixedCostSurface", () => {
	it("returns null before the first LLM request", () => {
		const { session } = createSession();
		try {
			// No messages at all — pre-first-turn.
			expect(session.getFixedCostSurface()).toBeNull();
		} finally {
			session.dispose();
		}
	});

	it("returns null when only user messages exist (no assistant turn yet)", () => {
		const { session, sessionManager } = createSession();
		try {
			sessionManager.appendMessage(createUserMessage("hello", 1));
			syncAgentMessages(session, sessionManager);
			expect(session.getFixedCostSurface()).toBeNull();
		} finally {
			session.dispose();
		}
	});

	it("returns systemTokens and toolTokens after the first assistant turn", () => {
		const { session, sessionManager } = createSession();
		try {
			sessionManager.appendMessage(createUserMessage("hello", 1));
			sessionManager.appendMessage(createAssistantMessage("hi", 200, 2));
			syncAgentMessages(session, sessionManager);

			const surface = session.getFixedCostSurface();
			expect(surface).not.toBeNull();
			expect(surface!.systemTokens).toBeGreaterThan(0);
			// The constructed session rebuilds agent.state.systemPrompt with the real
			// dynamic suffix (date/cwd behind the marker) — the marker-free initial
			// prompt does not survive construction, so assert the getter's contract
			// against the session's ACTUAL prompt: chars/4 per part, split on marker.
			const prompt = session.agent.state.systemPrompt;
			const { staticPart, dynamicPart } = splitSystemPromptOnDynamic(prompt);
			expect(surface!.staticSystemTokens).toBe(Math.ceil(staticPart.length / 4));
			expect(surface!.dynamicSystemTokens).toBe(Math.ceil(dynamicPart.length / 4));
			expect(surface!.systemTokens).toBe(Math.ceil(prompt.length / 4));
			expect(surface!.toolTokens).toBeGreaterThanOrEqual(0);
		} finally {
			session.dispose();
		}
	});

	it("splits system tokens into static and dynamic when the dynamic marker is present", () => {
		// Use the real SYSTEM_PROMPT_DYNAMIC_MARKER so splitSystemPromptOnDynamic fires.
		const staticText = "Static prefix. ".repeat(50); // ~750 chars → staticSystemTokens > 0
		const dynamicText = "Dynamic suffix. ".repeat(10); // ~150 chars → dynamicSystemTokens > 0
		const settingsManager = SettingsManager.inMemory();
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: {
					model,
					systemPrompt: staticText + SYSTEM_PROMPT_DYNAMIC_MARKER + dynamicText,
					tools: [],
					thinkingLevel: "high",
				},
			}),
			sessionManager,
			settingsManager,
			cwd: process.cwd(),
			modelRegistry: ModelRegistry.inMemory(authStorage),
			resourceLoader: createTestResourceLoader(),
		});

		try {
			sessionManager.appendMessage(createUserMessage("hello", 1));
			sessionManager.appendMessage(createAssistantMessage("hi", 200, 2));
			syncAgentMessages(session, sessionManager);

			const surface = session.getFixedCostSurface();
			expect(surface).not.toBeNull();
			// Both parts should be non-zero.
			expect(surface!.staticSystemTokens).toBeGreaterThan(0);
			expect(surface!.dynamicSystemTokens).toBeGreaterThan(0);
			// Static part is ~5× longer so its token estimate should dominate.
			expect(surface!.staticSystemTokens).toBeGreaterThan(surface!.dynamicSystemTokens);
			// systemTokens is estimated from the full prompt length (including marker
			// chars); just verify it's a non-zero positive integer.
			expect(surface!.systemTokens).toBeGreaterThan(0);
		} finally {
			session.dispose();
		}
	});
});
