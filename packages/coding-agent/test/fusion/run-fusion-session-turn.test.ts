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
			model: "claude-sonnet-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 5,
				cacheWrite: 7,
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

const model = getModel("anthropic", "claude-sonnet-5")!;

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
}): { host: FusionHost; agent: Agent; events: AgentSessionEvent[]; fusionSpend: ReturnType<typeof vi.fn> } {
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
	const fusionSpend = vi.fn();
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
		recordFusionSpend: fusionSpend,
		prepareFusionContextEconomy: async () => {},
		evaluateFusionBudget: () => opts?.budget ?? { allowed: true },
	};
	return { host, agent, events, fusionSpend };
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

	it("emits the user message BEFORE the synthetic answer when the goal budget is exhausted", async () => {
		// The budget branch owns the turn (returns true, no solo fallthrough), so it
		// must persist the user message itself — and before the synthetic assistant so
		// the transcript keeps user→assistant ordering and the prompt is not lost.
		const { host, agent } = createHost({
			budget: { allowed: false, reason: "Goal token budget exhausted (1m/1m)." },
		});
		await runFusionSessionTurn(host, "over budget prompt");
		expect(agent.state.messages).toHaveLength(2);
		expect(agent.state.messages[0]?.role).toBe("user");
		expect(messageText(agent.state.messages[0])).toContain("over budget prompt");
		expect(agent.state.messages[1]?.role).toBe("assistant");
		expect(messageText(agent.state.messages[1])).toContain("budget exhausted");
	});

	it("refuses to start a second turn while one is in flight and preserves the live abort controller", async () => {
		// Double-start guard (P1): a concurrent turn would overwrite host.fusionAbort
		// (orphaning the first turn's abort) and interleave transcript writes.
		const turn = vi.spyOn(orchestrator, "runFusionTurn");
		const { host, agent } = createHost();
		const live = new AbortController();
		host.setFusionAbort(live);

		const handled = await runFusionSessionTurn(host, "second turn while busy");

		// Reported handled so the caller does not fall through to a concurrent solo turn.
		expect(handled).toBe(true);
		// The live controller is untouched: not overwritten, and the early return skips
		// the `finally` that would have cleared it.
		expect(host.fusionAbort).toBe(live);
		expect(live.signal.aborted).toBe(false);
		// No panel work and no transcript writes from the refused turn.
		expect(turn).not.toHaveBeenCalled();
		expect(agent.state.messages).toHaveLength(0);
	});

	it("reserves the turn synchronously so a concurrent call is queued, not run twice (Bug 3 TOCTOU)", async () => {
		// Before the fix the abort controller was only registered AFTER three long awaits
		// (prepareFusionContextEconomy / auth / cli tokens), so a second prompt arriving in
		// that window saw isFusing === false, routed to Fusion again, and started a
		// concurrent turn. The reservation is now synchronous (before the first await).
		const turn = vi.spyOn(orchestrator, "runFusionTurn").mockResolvedValue({ handled: true, text: "ok" });
		const { host, agent } = createHost();

		// Block the first turn inside its first await so the second call arrives mid-flight.
		let releasePrepare!: () => void;
		let prepareCalls = 0;
		const prepareGate = new Promise<void>((resolve) => {
			releasePrepare = resolve;
		});
		host.prepareFusionContextEconomy = async () => {
			prepareCalls++;
			await prepareGate;
		};

		const first = runFusionSessionTurn(host, "first");
		// Synchronous reservation: isFusing is already true the instant the call suspends.
		expect(host.fusionAbort).toBeDefined();

		// A concurrent second turn arrives while the first is suspended in prepare().
		const img: ImageContent = { type: "image", data: "zzz", mimeType: "image/png" };
		const second = runFusionSessionTurn(host, "second", [img]);

		// It did NOT start a concurrent turn: prepare ran only for the first call.
		expect(prepareCalls).toBe(1);
		// The message is not lost — it was queued as a follow-up, images preserved.
		expect(agent.hasQueuedMessages()).toBe(true);
		const queued = agent.takeQueuedMessages();
		expect(queued).toHaveLength(1);
		expect(queued[0]?.role).toBe("user");
		const content = (queued[0] as { content?: unknown }).content as Array<{ type: string }>;
		expect(content.some((c) => c.type === "text")).toBe(true);
		expect(content.some((c) => c.type === "image")).toBe(true);
		expect(await second).toBe(true);

		// Release the first turn and let it finish; only ONE panel fan-out happened.
		releasePrepare();
		await first;
		expect(turn).toHaveBeenCalledTimes(1);
		expect(host.fusionAbort).toBeUndefined();
	});

	it("aborting during the writer stream finalizes cleanly without a duplicate user message", async () => {
		const { host, agent } = createHost();
		vi.spyOn(orchestrator, "runFusionTurn").mockImplementation(async (deps) => {
			// The writer already emitted the user message; aborting now must not make the
			// post-writer interrupt check append a second (duplicate) user message.
			await deps.writer("writer prompt", [], {
				consensus: [],
				contradictions: [],
				partialCoverage: [],
				uniqueInsights: [],
				blindSpots: [],
				unsupportedClaims: [],
			});
			host.fusionAbort?.abort();
			return { handled: true, text: "ok" };
		});

		const handled = await runFusionSessionTurn(host, "writer prompt");

		expect(handled).toBe(true);
		expect(agent.state.messages.filter((m) => m.role === "user")).toHaveLength(1);
		expect(agent.state.messages.some((m) => m.role === "assistant")).toBe(true);
		// The `finally` cleared the controller — the turn released its abort cleanly.
		expect(host.fusionAbort).toBeUndefined();
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

	it("charges all four usage components for an API-backed writer call", async () => {
		vi.spyOn(orchestrator, "runFusionTurn").mockImplementation(async (deps) => {
			await deps.writer("Q", [], {
				consensus: [],
				contradictions: [],
				partialCoverage: [],
				uniqueInsights: [],
				blindSpots: [],
				unsupportedClaims: [],
			});
			return { handled: true, text: "ok" };
		});
		const { host, fusionSpend } = createHost();

		await runFusionSessionTurn(host, "Q");

		expect(fusionSpend).toHaveBeenCalledWith(14);
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
