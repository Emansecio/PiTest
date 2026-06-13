import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@pit/agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

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

describe("AgentSession listener isolation", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-listener-isolation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
		// 30s: dispose under full-suite contention on Windows can exceed the 10s default.
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

	it("a throwing listener does not abort the emit loop, crash the turn, or starve other listeners", async () => {
		const s = createSession();

		// Capture non-fatal reports routed through the established extension error channel.
		const reportedErrors: Array<{ extensionPath: string; event: string; error: string }> = [];
		s.extensionRunner.onError((e) => {
			reportedErrors.push({ extensionPath: e.extensionPath, event: e.event, error: e.error });
		});

		// A faulty subscriber (think: TUI renderer choking on a pathological tool
		// result) that throws synchronously the first time it sees any event.
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

		// Must not reject even though a listener throws on the very first event.
		await expect(s.prompt("Test")).resolves.toBeUndefined();

		// (b) The healthy listener kept receiving events after the faulty throw...
		expect(healthyTypes).toContain("message_start");
		expect(healthyTypes).toContain("message_end");
		// (c) ...including the turn-completion events that close out the turn.
		expect(healthyTypes).toContain("turn_end");
		expect(healthyTypes).toContain("agent_end");

		// The faulty listener was invoked for every event (not unsubscribed by the throw).
		expect(faultyCalls).toBe(healthyTypes.length);

		// The throw was reported via emitError (separate listener set), not swallowed silently.
		const emitReports = reportedErrors.filter((r) => r.event.startsWith("emit:"));
		expect(emitReports.length).toBeGreaterThan(0);
		expect(emitReports[0]?.extensionPath).toBe("<event-listener>");
		expect(emitReports[0]?.error).toContain("listener boom");

		// Session settled cleanly — no half-emitted streaming/verification state.
		expect(s.isStreaming).toBe(false);
	});
});
