/**
 * Per-turn, per-tool failure budget.
 *
 * Complements the doom-loop (identical name+args+result repeats) and the
 * cross-error reminder (one normalised error across ≥2 approaches): this budget
 * trips purely on the COUNT of failures for a single tool NAME within one turn,
 * regardless of args or error text. Once a tool exhausts `maxPerTurn` failures,
 * a forceful steer (`pi.tool-failure-budget`) fires once for that tool, and the
 * error-reflection prompt surfaces the descending `attemptsLeft` (2,1,0).
 */

import type { AgentTool } from "@pit/agent-core";
import { Agent } from "@pit/agent-core";
import { fauxAssistantMessage, fauxToolCall, getModel } from "@pit/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { type Settings, SettingsManager } from "../src/core/settings-manager.js";
import { createHarness, type Harness } from "./suite/harness.js";
import { createTestResourceLoader } from "./utilities.js";

const ANY_MODEL = getModel("anthropic", "claude-sonnet-4-5")!;

/** A tool that always fails (the agent loop marks a THROW as isError), with a
 * DISTINCT message per call so neither the doom-loop (needs identical result)
 * nor a single cross-error fingerprint can be confused with the by-name budget.
 * Accepts an arbitrary `n` so callers can also vary the ARGS between calls. */
function makeAlwaysFailTool(name = "flaky"): AgentTool {
	let calls = 0;
	return {
		name,
		label: name,
		description: "Always fails with a distinct error each call",
		parameters: Type.Object({ n: Type.Optional(Type.Number()) }),
		execute: async () => {
			calls += 1;
			throw new Error(`failure number ${calls} occurred`);
		},
	};
}

/** A tool that always succeeds — used to prove successes never consume budget. */
function makeAlwaysSucceedTool(name = "ok"): AgentTool {
	return {
		name,
		label: name,
		description: "Always succeeds",
		parameters: Type.Object({ n: Type.Optional(Type.Number()) }),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
	};
}

function customMessages(harness: Harness, customType: string) {
	return harness.session.messages.filter(
		(m) => (m as { role?: string }).role === "custom" && (m as { customType?: string }).customType === customType,
	) as Array<{ content: string }>;
}

/** A minimal AgentSession (no faux provider / streaming) for unit-checking the
 * per-turn budget helper directly. */
function makeBareSession(fb: NonNullable<Settings["toolFeedback"]>["failureBudget"]): AgentSession {
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	return new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model: ANY_MODEL, systemPrompt: "x", tools: [], thinkingLevel: "high" },
		}),
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory({ toolFeedback: { failureBudget: fb } }),
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});
}

describe("per-turn per-tool failure budget", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("fires a forceful steer once the budget is exhausted (3 failures of one tool, varied args)", async () => {
		const harness = await createHarness({
			settings: { toolFeedback: { failureBudget: { enabled: true, maxPerTurn: 3 } } },
			tools: [makeAlwaysFailTool("flaky")],
		});
		harnesses.push(harness);

		// Three failing calls with DIFFERENT args (so the doom-loop never trips),
		// then a normal reply.
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("flaky", { n: 1 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("flaky", { n: 2 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("flaky", { n: 3 })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("use the tool");

		const budgetMsgs = customMessages(harness, "pi.tool-failure-budget");
		// Exactly one steer for the tool, even though it kept failing.
		expect(budgetMsgs.length).toBe(1);
		expect(budgetMsgs[0]?.content).toContain("<tool-failure-budget>");
		expect(budgetMsgs[0]?.content).toContain("`flaky`");
		expect(budgetMsgs[0]?.content).toContain("failed 3 times in this turn");
	});

	it("computes descending attemptsLeft (2,1,0) across three failures of one tool", () => {
		// attemptsLeft is what the budget feeds into `buildToolErrorReflection`
		// (whose attemptsLeft line is unit-tested separately). Assert the source
		// progression directly — deterministic and independent of the opt-in
		// reflection's followUp delivery timing.
		const session = makeBareSession({ enabled: true, maxPerTurn: 3 });
		try {
			const internal = session as unknown as {
				_recordTurnToolFailure(name: string): { count: number; attemptsLeft: number | undefined };
			};
			expect(internal._recordTurnToolFailure("flaky").attemptsLeft).toBe(2);
			expect(internal._recordTurnToolFailure("flaky").attemptsLeft).toBe(1);
			expect(internal._recordTurnToolFailure("flaky").attemptsLeft).toBe(0);
			// A 4th failure stays clamped at 0 (never negative).
			expect(internal._recordTurnToolFailure("flaky").attemptsLeft).toBe(0);
		} finally {
			session.dispose();
		}
	});

	it("gives each tool its own budget (one tool's failures do not exhaust another's)", async () => {
		const harness = await createHarness({
			settings: { toolFeedback: { failureBudget: { enabled: true, maxPerTurn: 3 } } },
			tools: [makeAlwaysFailTool("alpha"), makeAlwaysFailTool("beta")],
		});
		harnesses.push(harness);

		// alpha fails 3x (exhausts), beta fails only 2x (under budget).
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("alpha", { n: 1 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("beta", { n: 1 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("alpha", { n: 2 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("beta", { n: 2 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("alpha", { n: 3 })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("use both tools");

		const budgetMsgs = customMessages(harness, "pi.tool-failure-budget");
		expect(budgetMsgs.length).toBe(1);
		expect(budgetMsgs[0]?.content).toContain("`alpha`");
		expect(budgetMsgs.some((m) => m.content.includes("`beta`"))).toBe(false);
	});

	it("does not fire when disabled", async () => {
		const harness = await createHarness({
			settings: { toolFeedback: { failureBudget: { enabled: false } } },
			tools: [makeAlwaysFailTool("flaky")],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("flaky", { n: 1 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("flaky", { n: 2 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("flaky", { n: 3 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("flaky", { n: 4 })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("use the tool");

		expect(customMessages(harness, "pi.tool-failure-budget").length).toBe(0);
	});

	it("resets the budget on a new turn", async () => {
		const harness = await createHarness({
			settings: { toolFeedback: { failureBudget: { enabled: true, maxPerTurn: 3 } } },
			tools: [makeAlwaysFailTool("flaky")],
		});
		harnesses.push(harness);

		// Turn 1: exhausts the budget (3 failures) → one steer.
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("flaky", { n: 1 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("flaky", { n: 2 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("flaky", { n: 3 })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done turn 1"),
		]);
		await harness.session.prompt("turn one");
		expect(customMessages(harness, "pi.tool-failure-budget").length).toBe(1);

		// Turn 2: only 2 failures — under budget, so NO new steer is added.
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("flaky", { n: 10 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("flaky", { n: 11 })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done turn 2"),
		]);
		await harness.session.prompt("turn two");
		// Still exactly one budget steer total (turn 2 stayed under the reset budget).
		expect(customMessages(harness, "pi.tool-failure-budget").length).toBe(1);
	});

	it("does not count a tool that succeeds (only failing calls increment the budget)", async () => {
		// A tool that succeeds never reaches `_recordTurnToolFailure`, so its name
		// never appears in the per-turn map and never consumes budget. Verified via
		// a real session run: `ok` succeeds, `flaky` fails — only `flaky` is counted.
		const harness = await createHarness({
			settings: { toolFeedback: { failureBudget: { enabled: true, maxPerTurn: 3 } } },
			tools: [makeAlwaysFailTool("flaky"), makeAlwaysSucceedTool("ok")],
		});
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ok", { n: 1 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("ok", { n: 2 })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("flaky", { n: 1 })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("use both tools");

		const failures = (harness.session as unknown as { _turnToolFailures: Map<string, number> })._turnToolFailures;
		// "ok" succeeded twice → never recorded; "flaky" failed once → counted once.
		expect(failures.get("ok")).toBeUndefined();
		expect(failures.get("flaky")).toBe(1);
		// One failure is under the budget of 3 → no steer.
		expect(customMessages(harness, "pi.tool-failure-budget").length).toBe(0);
	});
});
