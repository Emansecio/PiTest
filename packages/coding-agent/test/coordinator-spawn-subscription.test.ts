/**
 * Lifecycle of a spawned subagent's turn_end subscription (H18).
 *
 * spawnSubagent subscribes to the Agent's `turn_end` to count turns, accumulate
 * usage, and enforce the run's `maxTurns` (aborting via an internal controller).
 * The coordinator keeps that SAME Agent alive for a later op:"continue"/"resume",
 * re-driving it OUTSIDE spawnSubagent. If the subscription (and the internal
 * controller's abort→agent.abort wiring) survived past settle, a reused Agent
 * would be:
 *   - double-counted into the ORIGINAL run's registry record, and
 *   - phantom-ABORTED once the cumulative turn count crossed the original run's
 *     maxTurns (the stale controller would fire agent.abort() on the live run).
 *
 * These tests re-drive the captured Agent after settle and pin that neither
 * happens.
 */

import type { Agent, AgentMessage, AgentTool } from "@pit/agent-core";
import { type FauxProviderRegistration, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@pit/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { SubagentRegistry } from "../src/core/coordinator/registry.js";
import { type SpawnSubagentDependencies, spawnSubagent } from "../src/core/coordinator/spawn.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";

interface Rig {
	faux: FauxProviderRegistration;
	deps: SpawnSubagentDependencies;
	registry: SubagentRegistry;
	dispose: () => void;
}

function createRig(tools: AgentTool[] = []): Rig {
	const faux = registerFauxProvider();
	faux.setResponses([]);
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const registry = new SubagentRegistry();
	return {
		faux,
		registry,
		deps: {
			registry,
			model,
			modelRegistry,
			availableTools: tools,
			convertToLlm: (messages: AgentMessage[]) => convertToLlm(messages),
		},
		dispose: () => faux.unregister(),
	};
}

const lastAssistantText = (agent: Agent): string => {
	const messages = agent.state.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		const text = m.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("");
		if (text.length > 0) return text;
	}
	return "";
};

describe("spawned subagent turn_end subscription lifecycle (H18)", () => {
	const rigs: Rig[] = [];
	afterEach(() => {
		while (rigs.length > 0) rigs.pop()?.dispose();
	});

	it("stops counting into the original registry record once the run has settled", async () => {
		const rig = createRig();
		rigs.push(rig);
		// Turn 1 = the original run; turn 2 = a later re-drive of the SAME Agent.
		rig.faux.setResponses([fauxAssistantMessage("original done"), fauxAssistantMessage("re-driven")]);

		let agent: Agent | undefined;
		const result = await spawnSubagent(rig.deps, {
			prompt: "do it",
			taskName: "sub-count",
			// High cap so the re-drive can't trip the turn budget — this isolates the
			// subscription-leak symptom from any abort.
			maxTurns: 50,
			onAgentReady: (a) => {
				agent = a;
			},
		});
		expect(result.output).toBe("original done");
		const recordId = result.record.id;
		expect(rig.registry.get(recordId)?.turnCount).toBe(1);

		// Re-drive the SAME Agent (mirrors what op:"continue" does with the live
		// Agent). The settled run's subscription must NOT fire, so the original
		// record's turnCount stays 1 (pre-fix the leaked listener bumped it to 2).
		await agent?.prompt("keep going");
		expect(lastAssistantText(agent as Agent)).toBe("re-driven");
		expect(rig.registry.get(recordId)?.turnCount).toBe(1);
	}, 30_000);

	it("does not phantom-abort a re-driven Agent when the cumulative turns cross the original maxTurns", async () => {
		const probe: AgentTool = {
			name: "probe",
			label: "probe",
			description: "returns a marker",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "probed" }], details: {} }),
		};
		const rig = createRig([probe]);
		rigs.push(rig);
		// Original run: 1 plain turn (cumulative count = 1, below maxTurns=2, no abort).
		// Re-drive: a tool-call turn THEN a final answer. Pre-fix, the leaked listener
		// pushes the cumulative count to 2 at the tool-call turn_end and the stale
		// controller aborts the run BEFORE the answer turn — truncating the re-drive.
		rig.faux.setResponses([
			fauxAssistantMessage("original done"),
			fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("final answer"),
		]);

		let agent: Agent | undefined;
		const result = await spawnSubagent(rig.deps, {
			prompt: "do it",
			taskName: "sub-abort",
			allowedTools: ["probe"],
			maxTurns: 2,
			onAgentReady: (a) => {
				agent = a;
			},
		});
		expect(result.output).toBe("original done");

		// Re-drive the settled Agent. Post-fix the run completes BOTH turns and
		// returns the final answer; pre-fix it is phantom-aborted after the tool call.
		await agent?.prompt("continue the work");
		expect(lastAssistantText(agent as Agent)).toBe("final answer");
	}, 30_000);
});
