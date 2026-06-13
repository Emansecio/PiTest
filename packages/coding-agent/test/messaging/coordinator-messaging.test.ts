import type { AgentMessage } from "@pit/agent-core";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { SubagentRegistry } from "../../src/core/coordinator/registry.ts";
import { type SpawnSubagentDependencies, spawnSubagent } from "../../src/core/coordinator/spawn.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { agentMessageBus, makeAgentResponder } from "../../src/core/messaging/index.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { createMessageTool } from "../../src/core/tools/message.ts";

describe("coordinator ↔ bus end-to-end (faux model)", () => {
	const reserved: string[] = [];
	const disposers: Array<() => void> = [];
	afterEach(() => {
		while (reserved.length) agentMessageBus.unregister(reserved.pop()!);
		while (disposers.length) disposers.pop()?.();
	});

	it("a running subagent messages Main and receives a reply via the tool", async () => {
		const mainId = agentMessageBus.reserve("Main", { kind: "main" });
		reserved.push(mainId);
		agentMessageBus.attachResponder(mainId, async (from, msg) => `Main says: heard "${msg}" from ${from}`);

		const faux = registerFauxProvider();
		disposers.push(() => faux.unregister());
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);

		const selfId = agentMessageBus.reserve("Worker", { kind: "sub", parentId: mainId });
		reserved.push(selfId);
		const messageTool = createMessageTool(process.cwd(), { selfId });

		const deps: SpawnSubagentDependencies = {
			registry: new SubagentRegistry(),
			model,
			modelRegistry,
			availableTools: [messageTool],
			convertToLlm: (m: AgentMessage[]) => convertToLlm(m),
		};

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("message", { op: "send", to: "Main", message: "where is auth?" })], {
				stopReason: "toolUse",
			}),
			(ctx) => {
				const seen = JSON.stringify(ctx.messages);
				expect(seen).toContain("Main says");
				return fauxAssistantMessage("done — Main answered");
			},
		]);

		let settled = false;
		const result = await spawnSubagent(deps, {
			prompt: "find auth, ask Main if unsure",
			taskName: "Worker",
			onAgentReady: (agent) => agentMessageBus.attachResponder(selfId, makeAgentResponder(agent)),
			onSettle: () => {
				settled = true;
			},
		});

		expect(result.output).toBe("done — Main answered");
		expect(settled).toBe(true);
	}, 60_000);
});
