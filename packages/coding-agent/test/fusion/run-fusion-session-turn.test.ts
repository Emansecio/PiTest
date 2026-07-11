/**
 * Integration-style coverage for runFusionSessionTurn: panel gate, budget gate,
 * abort transcript, images on writer, judge EMPTY note.
 */

import { Agent } from "@pit/agent-core";
import type { AssistantMessage, ImageContent } from "@pit/ai";
import { getModel } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { completeSimpleMock, streamSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
	streamSimpleMock: vi.fn(() => {
		const result: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		return {
			[Symbol.asyncIterator]: async function* () {
				yield { type: "start", partial: result };
			},
			result: async () => result,
		};
	}),
}));

vi.mock("@pit/ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@pit/ai")>();
	return { ...actual, completeSimple: completeSimpleMock, streamSimple: streamSimpleMock };
});

import { CompactionController } from "../../src/core/agent-session-compaction.ts";
import type { AgentSessionEvent } from "../../src/core/agent-session-events.ts";
import { type FusionHost, runFusionSessionTurn } from "../../src/core/agent-session-fusion.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import * as orchestrator from "../../src/core/fusion/orchestrator.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function messageText(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((c) => (c as { text?: string }).text ?? "").join("");
	}
	return "";
}

function createHost(opts?: {
	panel?: Array<{ cli: "claude" | "codex"; model: string }>;
	budget?: { allowed: boolean; reason?: string };
}): { host: FusionHost; agent: Agent; events: AgentSessionEvent[] } {
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const settingsManager = SettingsManager.inMemory({
		fusion: {
			panel: opts?.panel ?? [
				{ cli: "claude", model: "opus" },
				{ cli: "codex", model: "gpt" },
			],
			brief: false,
			verify: false,
			staggerSameCliMs: 0,
		},
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "sys",
			tools: [],
			thinkingLevel: "off",
		},
	});
	const sessionManager = SessionManager.inMemory();
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const events: AgentSessionEvent[] = [];
	let fusionAbort: AbortController | undefined;
	const host: FusionHost = {
		model,
		agent,
		sessionManager,
		settingsManager,
		modelRegistry,
		cwd: process.cwd(),
		compaction: new CompactionController({
			sessionId: "test",
			model,
			thinkingLevel: "off",
			agent,
			sessionManager,
			settingsManager,
			extensionRunner: { emit: async () => {}, hasHandlers: () => false } as never,
			modelRegistry,
			hindsightBank: undefined,
			readDedupeStore: undefined,
			cwd: process.cwd(),
			isCompacting: false,
			isStreaming: false,
			emit: () => {},
			getCompactionRequestAuth: async () => ({}),
			disconnectFromAgent: () => {},
			reconnectToAgent: () => {},
			abort: async () => {},
		}),
		get fusionAbort() {
			return fusionAbort;
		},
		setFusionAbort(value) {
			fusionAbort = value;
		},
		userInterrupted: false,
		emit(event: AgentSessionEvent) {
			events.push(event);
		},
		getRequiredRequestAuth: async () => ({}),
		setLastAssistantMessage: () => {},
		prepareFusionContextEconomy: async () => {},
		evaluateFusionBudget: () => opts?.budget ?? { allowed: true },
	};
	return { host, agent, events };
}

function noteContents(events: AgentSessionEvent[]): string[] {
	return events
		.filter((e): e is AgentSessionEvent & { type: "message_start"; message: { content?: unknown } } => {
			return e.type === "message_start" && (e.message as { role?: string }).role === "custom";
		})
		.map((e) => messageText(e.message));
}

describe("runFusionSessionTurn", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		streamSimpleMock.mockClear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PIT_NO_FUSION;
	});

	it("returns false with synthetic message when panel has fewer than 2 members", async () => {
		const { host, agent } = createHost({ panel: [{ cli: "claude", model: "opus" }] });
		const handled = await runFusionSessionTurn(host, "hello");
		expect(handled).toBe(false);
		expect(agent.state.messages.some((m) => messageText(m).includes("panel isn't configured"))).toBe(true);
	});

	it("returns true without running the panel when goal budget is exhausted", async () => {
		const turn = vi.spyOn(orchestrator, "runFusionTurn");
		const { host, agent } = createHost({
			budget: { allowed: false, reason: "Goal token budget exhausted (1m/1m)." },
		});
		const handled = await runFusionSessionTurn(host, "hello");
		expect(handled).toBe(true);
		expect(turn).not.toHaveBeenCalled();
		expect(agent.state.messages.some((m) => messageText(m).includes("budget exhausted"))).toBe(true);
	});

	it("persists user message + interrupted note when aborted before writer", async () => {
		const { host, agent, events } = createHost();
		vi.spyOn(orchestrator, "runFusionTurn").mockImplementation(async () => {
			host.fusionAbort?.abort();
			return { handled: false, text: "" };
		});
		const handled = await runFusionSessionTurn(host, "abort me");
		expect(handled).toBe(true);
		expect(agent.state.messages[0]?.role).toBe("user");
		expect(messageText(agent.state.messages[0])).toContain("abort me");
		expect(noteContents(events).some((t) => t.includes("Fusion interrupted."))).toBe(true);
	});

	it("passes attached images into the writer user message", async () => {
		const img: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };
		vi.spyOn(orchestrator, "runFusionTurn").mockImplementation(async (deps) => {
			await deps.writer("prompt with image", [], {
				consensus: [],
				contradictions: [],
				partialCoverage: [],
				uniqueInsights: [],
				blindSpots: [],
				unsupportedClaims: [],
			});
			return { handled: true, text: "ok" };
		});
		const { host, agent } = createHost();
		const handled = await runFusionSessionTurn(host, "prompt with image", [img]);
		expect(handled).toBe(true);
		const user = agent.state.messages.find((m) => m.role === "user");
		expect(user).toBeTruthy();
		expect(Array.isArray(user!.content)).toBe(true);
		expect((user!.content as Array<{ type: string }>).some((c) => c.type === "image")).toBe(true);
	});

	it("emits a note when the judge cannot parse structured output", async () => {
		completeSimpleMock.mockResolvedValue({
			role: "assistant",
			content: [{ type: "text", text: "not-json" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} satisfies AssistantMessage);

		vi.spyOn(orchestrator, "runFusionTurn").mockImplementation(async (deps) => {
			const analysis = await deps.runJudge("Q", [
				{ member: { cli: "claude", model: "opus" }, ok: true, text: "A" },
				{ member: { cli: "codex", model: "gpt" }, ok: true, text: "B" },
			]);
			await deps.writer("Q", [], analysis);
			return { handled: true, text: "ok", analysis };
		});

		const { host, events } = createHost();
		await runFusionSessionTurn(host, "Q");
		expect(noteContents(events).some((t) => t.includes("could not parse structured output"))).toBe(true);
	});
});
