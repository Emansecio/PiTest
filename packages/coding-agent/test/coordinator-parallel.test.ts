/**
 * Parallel subagent orchestration — spawnAll, partial failures, concurrency cap.
 */

import type { AgentMessage } from "@pit/agent-core";
import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@pit/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { resolveMaxSubagentConcurrency, spawnAll } from "../src/core/coordinator/parallel.js";
import { SubagentRegistry } from "../src/core/coordinator/registry.js";
import type { SpawnSubagentDependencies } from "../src/core/coordinator/spawn.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";

interface Rig {
	faux: FauxProviderRegistration;
	deps: SpawnSubagentDependencies;
	dispose: () => void;
}

function createRig(): Rig {
	const faux = registerFauxProvider();
	faux.setResponses([]);
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const registry = new SubagentRegistry();
	return {
		faux,
		deps: {
			registry,
			model,
			modelRegistry,
			availableTools: [],
			convertToLlm: (messages: AgentMessage[]) => convertToLlm(messages),
		},
		dispose: () => faux.unregister(),
	};
}

describe("resolveMaxSubagentConcurrency", () => {
	it("defaults to 4", () => {
		expect(resolveMaxSubagentConcurrency({})).toBe(4);
	});

	it("honors PIT_SUBAGENT_MAX_CONCURRENCY", () => {
		expect(resolveMaxSubagentConcurrency({ PIT_SUBAGENT_MAX_CONCURRENCY: "2" })).toBe(2);
	});
});

describe("spawnAll", () => {
	const rigs: Rig[] = [];
	afterEach(() => {
		while (rigs.length > 0) rigs.pop()?.dispose();
		vi.restoreAllMocks();
	});

	function rig() {
		const r = createRig();
		rigs.push(r);
		return r;
	}

	it("collects N task results", async () => {
		const { faux, deps } = rig();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
		const results = await spawnAll(
			deps,
			[
				{ name: "a", prompt: "p1" },
				{ name: "b", prompt: "p2" },
				{ name: "c", prompt: "p3" },
			],
			{ concurrency: 3, base: { depth: 0 } },
		);
		expect(results).toHaveLength(3);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(results.map((r) => r.output)).toEqual(["one", "two", "three"]);
	});

	it("isolates partial failures (allSettled)", async () => {
		const { faux, deps } = rig();
		const schema = Type.Object({ ok: Type.Boolean() });
		faux.setResponses([
			fauxAssistantMessage("ok-one"),
			fauxAssistantMessage("not-valid-json-for-schema"),
			fauxAssistantMessage("ok-three"),
		]);
		const results = await spawnAll(
			deps,
			[
				{ name: "t1", prompt: "p1" },
				{ name: "t2", prompt: "p2", result_schema: schema },
				{ name: "t3", prompt: "p3" },
			],
			{ concurrency: 3, base: { depth: 0 } },
		);
		expect(results.filter((r) => r.ok)).toHaveLength(2);
		expect(results.find((r) => !r.ok)?.error).toMatch(/resultSchema|JSON/);
	});

	it("respects concurrency cap", async () => {
		const { faux, deps } = rig();
		let inFlight = 0;
		let maxInFlight = 0;
		faux.setResponses(
			Array.from({ length: 8 }, () => async () => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((r) => setTimeout(r, 10));
				inFlight--;
				return fauxAssistantMessage("done");
			}),
		);
		await spawnAll(
			deps,
			Array.from({ length: 8 }, (_, i) => ({ name: `t${i}`, prompt: `p${i}` })),
			{ concurrency: 2, base: { depth: 0 } },
		);
		expect(maxInFlight).toBeLessThanOrEqual(2);
	});
});
