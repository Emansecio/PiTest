/**
 * Resilience (fault-injection) — CRASH-ISOLATION layer.
 *
 * Two faults that must be CONTAINED, not propagated, and made observable:
 *
 *   Scenario 2 — a session event listener throws while processing an event
 *   (think: a TUI renderer choking on a pathological tool result). The
 *   AgentSession `_emit` loop must isolate the throw so (a) the turn still
 *   completes and every *other* listener keeps receiving the events that follow,
 *   and (b) the contained fault is recorded as `error.isolated` on the
 *   `runtime-diagnostics` channel.
 *
 *   Scenario 3 — the agent loop rejects on the synchronous path to its first
 *   await (`convertToLlm` throws). Instead of an unhandled rejection (fatal
 *   under Node's default) plus a hung for-await consumer, the loop must convert
 *   it into a terminal failure turn ending in `agent_end` with stopReason
 *   "error", and record that contained fault as `error.isolated`.
 *
 * Anti-flaky: both scenarios are driven by faux providers whose streams settle
 * via `queueMicrotask` (Scenario 2) or whose failure is a synchronous throw
 * (Scenario 3) — there is no real network, no real timer the test waits on, and
 * no polling. Scenario 3 races the drain against a 1s watchdog purely so a
 * regression (stream never ends) fails loudly instead of hanging the suite; the
 * happy path resolves on a microtask, well under that bound.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentContext, AgentEvent, AgentLoopConfig } from "@pit/agent-core";
import { Agent, agentLoop } from "@pit/agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	getRuntimeDiagnostics,
	type Model,
	resetRuntimeDiagnostics,
	type UserMessage,
} from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../../src/core/agent-session.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { createTestResourceLoader } from "../utilities.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

// ── Scenario 2 ──────────────────────────────────────────────────────────────

describe("resilience: a throwing session listener is isolated → turn survives + observable", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		resetRuntimeDiagnostics();
		tempDir = join(tmpdir(), `pi-resilience-listener-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true });
			} catch {
				/* ignore Windows handle race */
			}
		}
		// 60s: dispose under full-suite contention on Windows can exceed the 10s default.
	}, 60_000);

	function createSession(): AgentSession {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const msg = createAssistantMessage("Success");
					stream.push({ type: "start", partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		return session;
	}

	it("(2) a listener throwing on the first event does not crash the turn, starves no one, and records error.isolated", async () => {
		const s = createSession();

		// A faulty subscriber that throws synchronously the first time it sees any
		// event (e.g. a renderer choking on a pathological payload).
		let faultyCalls = 0;
		s.subscribe(() => {
			faultyCalls++;
			throw new Error("listener boom");
		});

		// A healthy subscriber registered AFTER the faulty one — it must still
		// receive every event, including the ones emitted after the throw.
		const healthyTypes: string[] = [];
		s.subscribe((event: AgentSessionEvent) => {
			healthyTypes.push(event.type);
		});

		// (a-recovery) must not reject even though a listener throws on event #1.
		await expect(s.prompt("Test")).resolves.toBeUndefined();

		// (a) the healthy listener kept receiving events after the faulty throw,
		// including the turn-completion events that close out the turn.
		expect(healthyTypes).toContain("message_start");
		expect(healthyTypes).toContain("message_end");
		expect(healthyTypes).toContain("turn_end");
		expect(healthyTypes).toContain("agent_end");
		// The faulty listener was invoked for EVERY event (not unsubscribed by the throw).
		expect(faultyCalls).toBe(healthyTypes.length);
		// The session settled cleanly — no half-emitted streaming state.
		expect(s.isStreaming).toBe(false);

		// (b) the contained fault is observable on the runtime-diagnostics channel.
		const snap = getRuntimeDiagnostics();
		expect(snap.counters["error.isolated"]?.count ?? 0).toBeGreaterThanOrEqual(1);
		expect(snap.counters["error.isolated"]?.level).toBe("error");
		// One isolation per delivered event the faulty listener threw on.
		expect(snap.counters["error.isolated"]?.count).toBe(faultyCalls);
		// Each recorded event carries the offending event type as its note.
		const isolated = snap.recent.filter((e) => e.category === "error.isolated");
		expect(isolated.length).toBe(faultyCalls);
		expect(isolated.every((e) => e.source === "agent-session._emit")).toBe(true);
		expect(isolated.some((e) => e.context?.note === "message_start")).toBe(true);
	});
});

// ── Scenario 3 ──────────────────────────────────────────────────────────────

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

describe("resilience: agent-loop rejection → terminal failure turn (no unhandled) + observable", () => {
	beforeEach(() => {
		resetRuntimeDiagnostics();
	});

	// A throw on the synchronous path to the first await (here: convertToLlm) must
	// NOT become an unhandled rejection (fatal under Node's default) and must NOT
	// hang the for-await consumer. The loop's `.then` rejection handler converts it
	// into a terminal failure turn ending in `agent_end`.
	async function consumeWithGuard(stream: ReturnType<typeof agentLoop>): Promise<{
		events: AgentEvent[];
		unhandled: unknown[];
	}> {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		const events: AgentEvent[] = [];
		try {
			// Race the drain against a watchdog so a regression (stream never ends)
			// fails loudly instead of hanging the whole suite. The happy path settles
			// on a microtask, far under the 1s bound — no wall-clock dependence.
			const drain = (async () => {
				for await (const event of stream) events.push(event);
			})();
			const timeout = new Promise<never>((_resolve, reject) => {
				setTimeout(() => reject(new Error("stream did not terminate (hung)")), 1000);
			});
			await Promise.race([drain, timeout]);
		} finally {
			// Give any queued microtask rejection a tick to surface before asserting.
			await new Promise((resolve) => setTimeout(resolve, 0));
			process.off("unhandledRejection", onUnhandled);
		}
		return { events, unhandled };
	}

	it("(3) convertToLlm throwing surfaces an agent_end failure turn, no unhandled rejection, and records error.isolated", async () => {
		const context: AgentContext = { systemPrompt: "s", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: () => {
				throw new Error("boom in convertToLlm");
			},
		};

		const stream = agentLoop([createUserMessage("hi")], context, config);
		const { events, unhandled } = await consumeWithGuard(stream);

		// (a-recovery) no unhandled rejection escaped the loop.
		expect(unhandled).toEqual([]);
		// (a) the consumer saw a terminal agent_end and the stream resolved as a
		// failure turn — the error reason is carried through, not swallowed.
		expect(events.map((e) => e.type)).toContain("agent_end");
		const messages = await stream.result();
		const last = messages[messages.length - 1] as AssistantMessage;
		expect(last.role).toBe("assistant");
		expect(last.stopReason).toBe("error");
		expect(last.errorMessage).toMatch(/boom in convertToLlm/);

		// (b) the contained fault is observable on the runtime-diagnostics channel.
		const snap = getRuntimeDiagnostics();
		expect(snap.counters["error.isolated"]?.count ?? 0).toBeGreaterThanOrEqual(1);
		expect(snap.counters["error.isolated"]?.level).toBe("error");
		const isolated = snap.recent.filter((e) => e.category === "error.isolated");
		expect(isolated.some((e) => e.source === "agent-loop.endStreamWithFailure")).toBe(true);
		// The failure note carries the original error message (truncated, observable).
		expect(isolated.some((e) => (e.context?.note ?? "").includes("boom in convertToLlm"))).toBe(true);
	});
});
