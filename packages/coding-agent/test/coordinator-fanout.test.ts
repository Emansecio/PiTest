/**
 * Fanout orchestration — scout → N reviewers → worker.
 */

import type { AgentMessage } from "@pit/agent-core";
import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@pit/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { runFanout, substituteTarget } from "../src/core/coordinator/fanout.js";
import { SubagentRegistry } from "../src/core/coordinator/registry.js";
import type { SpawnSubagentDependencies } from "../src/core/coordinator/spawn.js";
import * as spawnModule from "../src/core/coordinator/spawn.js";
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

describe("substituteTarget", () => {
	it("replaces {{target}} with string targets", () => {
		expect(substituteTarget("Review {{target}} please", "foo.ts")).toBe("Review foo.ts please");
	});

	it("JSON-stringifies object targets", () => {
		expect(substituteTarget("Review {{target}}", { path: "a.ts" })).toBe('Review {"path":"a.ts"}');
	});

	it("treats `$` patterns in the target as literal text", () => {
		// Regression: with a replacement STRING, `String.replace` expands `$&`,
		// "$`", `$'` and `$$` — so a scout target carrying any of them rewrote
		// itself and the reviewer was pointed at something that never existed.
		expect(substituteTarget("Review {{target}} now", "src/a$&b.ts")).toBe("Review src/a$&b.ts now");
		expect(substituteTarget("Review {{target}} now", "cost is $'")).toBe("Review cost is $' now");
		expect(substituteTarget("Review {{target}} now", "a$`b")).toBe("Review a$`b now");
		expect(substituteTarget("Review {{target}} now", "a$$b")).toBe("Review a$$b now");
	});
});

describe("runFanout", () => {
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

	it("scout list → N reviewers → worker receives reviews", async () => {
		const { faux, deps } = rig();
		let workerPrompt = "";
		faux.setResponses([
			fauxAssistantMessage('```json\n{"targets":["alpha","beta"]}\n```'),
			fauxAssistantMessage("review-alpha"),
			fauxAssistantMessage("review-beta"),
			(context) => {
				workerPrompt = context.messages?.find((m) => m.role === "user")?.content?.toString() ?? "";
				// fallback: read from system if needed
				if (!workerPrompt && context.systemPrompt) workerPrompt = context.systemPrompt;
				return fauxAssistantMessage("worker-done");
			},
		]);
		const result = await runFanout(
			deps,
			{
				scout: { prompt: "find targets" },
				reviewer: { prompt_template: "Review {{target}}" },
				worker: { prompt: "Synthesize findings" },
				concurrency: 2,
			},
			{ depth: 0, cwd: process.cwd() },
		);
		expect(result.targets).toEqual(["alpha", "beta"]);
		expect(result.reviews).toHaveLength(2);
		expect(result.reviews.every((r) => r.ok)).toBe(true);
		expect(result.worker_output.text).toBe("worker-done");
	});

	it("dynamic N tracks scout output", async () => {
		const { faux, deps } = rig();
		faux.setResponses([
			fauxAssistantMessage('```json\n{"targets":["a","b","c"]}\n```'),
			fauxAssistantMessage("r1"),
			fauxAssistantMessage("r2"),
			fauxAssistantMessage("r3"),
			fauxAssistantMessage("w"),
		]);
		const result = await runFanout(
			deps,
			{
				scout: { prompt: "scout" },
				reviewer: { prompt_template: "check {{target}}" },
				worker: { prompt: "work" },
			},
			{ depth: 0, cwd: process.cwd() },
		);
		expect(result.targets).toHaveLength(3);
		expect(result.reviews).toHaveLength(3);
	});

	it("failed reviewer is flagged but fanout continues", async () => {
		const { faux, deps } = rig();
		const realSpawn = spawnModule.spawnSubagent;
		vi.spyOn(spawnModule, "spawnSubagent").mockImplementation(async (d, opts) => {
			if (opts.taskName === "fanout-reviewer-0") {
				throw new Error("reviewer blew up");
			}
			return realSpawn(d, opts);
		});
		faux.setResponses([
			fauxAssistantMessage('```json\n{"targets":["x","y"]}\n```'),
			fauxAssistantMessage("review-ok"),
			fauxAssistantMessage("worker-ok"),
		]);
		const result = await runFanout(
			deps,
			{
				scout: { prompt: "scout" },
				reviewer: { prompt_template: "rev {{target}}" },
				worker: { prompt: "work" },
			},
			{ depth: 0, cwd: process.cwd() },
		);
		expect(result.reviews.some((r) => !r.ok)).toBe(true);
		expect(result.reviews.some((r) => r.ok)).toBe(true);
		expect(result.worker_output.text).toBe("worker-ok");
	});

	it("settles the scout lifecycle row when its reservation blocks the pipeline", async () => {
		const { deps } = rig();
		const events: string[] = [];
		await expect(
			runFanout(
				deps,
				{
					scout: { prompt: "scout" },
					reviewer: { prompt_template: "rev {{target}}" },
					worker: { prompt: "work" },
				},
				{
					depth: 0,
					cwd: process.cwd(),
					onStageStart: (handle) => events.push(`start:${handle}`),
					onStageComplete: (handle, status) => events.push(`complete:${handle}:${status}`),
					onStageReserve: () => ({ allowed: false, reason: "budget exhausted", release: () => {} }),
				},
			),
		).rejects.toThrow("budget exhausted");
		expect(events).toEqual(["start:fanout-scout", "complete:fanout-scout:error"]);
	});
});
