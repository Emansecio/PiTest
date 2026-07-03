/**
 * N10 — dynamic thinking level for subagents.
 *
 * `resolveSubagentThinking` buckets the default reasoning level by the model the
 * subagent runs on: small/fast tiers (haiku/mini/nano/flash/lite) get "low",
 * everything else keeps the historical "medium". An explicit per-task override
 * always wins. The repo invariant that subagents never think "off" is preserved
 * (the floor is "low").
 */

import type { AgentMessage } from "@pit/agent-core";
import { type FauxProviderRegistration, fauxAssistantMessage, type Model, registerFauxProvider } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { SubagentRegistry } from "../src/core/coordinator/registry.js";
import {
	resolveSubagentThinking,
	SMALL_CLASS_MODEL_MARKERS,
	type SpawnSubagentDependencies,
	spawnSubagent,
} from "../src/core/coordinator/spawn.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";

const asModel = (id: string): Model<any> => ({ id }) as unknown as Model<any>;

describe("resolveSubagentThinking (N10 model bucketing)", () => {
	it("returns 'low' for every small-class marker (case-insensitive)", () => {
		for (const marker of SMALL_CLASS_MODEL_MARKERS) {
			expect(resolveSubagentThinking(asModel(`anthropic/claude-${marker}-4`))).toBe("low");
			expect(resolveSubagentThinking(asModel(`SomeVendor/${marker.toUpperCase()}-Turbo`))).toBe("low");
		}
	});

	it("returns 'low' for representative small models", () => {
		expect(resolveSubagentThinking(asModel("anthropic/claude-haiku-4"))).toBe("low");
		expect(resolveSubagentThinking(asModel("openai/gpt-5-mini"))).toBe("low");
		expect(resolveSubagentThinking(asModel("google/gemini-2.5-flash"))).toBe("low");
	});

	it("returns 'medium' for large/frontier models and unknown ids", () => {
		expect(resolveSubagentThinking(asModel("anthropic/claude-sonnet-4"))).toBe("medium");
		expect(resolveSubagentThinking(asModel("anthropic/claude-opus-4"))).toBe("medium");
		expect(resolveSubagentThinking(asModel("openai/gpt-5"))).toBe("medium");
		expect(resolveSubagentThinking(asModel("faux-1"))).toBe("medium");
	});

	it("never returns 'off' and defaults to 'medium' for an undefined model", () => {
		expect(resolveSubagentThinking(undefined)).toBe("medium");
		expect(resolveSubagentThinking(asModel(""))).toBe("medium");
	});
});

describe("spawnSubagent thinking wiring (N10)", () => {
	let faux: FauxProviderRegistration | undefined;
	afterEach(() => faux?.unregister());

	function makeDeps(): { deps: SpawnSubagentDependencies; model: Model<string> } {
		faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("done")]);
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const deps: SpawnSubagentDependencies = {
			registry: new SubagentRegistry(),
			model,
			modelRegistry,
			availableTools: [],
			convertToLlm: (messages: AgentMessage[]) => convertToLlm(messages),
		};
		return { deps, model };
	}

	it("defaults the level to resolveSubagentThinking(model) when no override is passed", async () => {
		const { deps, model } = makeDeps();
		let seen: string | undefined;
		await spawnSubagent(deps, {
			prompt: "p",
			taskName: "default-think",
			onAgentReady: (agent) => {
				seen = agent.state.thinkingLevel;
			},
		});
		// faux-1 is not small-class → "medium", and it must equal the function's verdict.
		expect(seen).toBe(resolveSubagentThinking(model));
		expect(seen).toBe("medium");
	});

	it("buckets a small-class model to 'low' end-to-end (same api, cloned id)", async () => {
		const { deps, model } = makeDeps();
		// Clone the faux model with a haiku-flavored id; the faux provider dispatches
		// by `api` (unchanged), so the run still streams while the id drives the bucket.
		const haikuModel = { ...model, id: "faux-haiku-1" } as Model<any>;
		let seen: string | undefined;
		await spawnSubagent(deps, {
			prompt: "p",
			taskName: "small-think",
			model: haikuModel,
			onAgentReady: (agent) => {
				seen = agent.state.thinkingLevel;
			},
		});
		expect(seen).toBe("low");
	});

	it("an explicit thinking override wins over the model bucket", async () => {
		const { deps } = makeDeps();
		let seen: string | undefined;
		await spawnSubagent(deps, {
			prompt: "p",
			taskName: "override-think",
			thinkingLevel: "high",
			onAgentReady: (agent) => {
				seen = agent.state.thinkingLevel;
			},
		});
		expect(seen).toBe("high");
	});
});
