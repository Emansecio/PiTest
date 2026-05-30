/**
 * Faux-model integration tests for the native subagent (coordinator) flow.
 *
 * Unlike `coordinator-registry.test.ts` (which exercises the registry in
 * isolation), this suite drives the real `spawnSubagent` path: it builds a
 * genuine `Agent` from `@pit/agent-core`, wires a scripted faux provider, and
 * asserts on the returned result + the registry record transitions.
 *
 * The faux provider (`registerFauxProvider` from `@pit/ai`) monkeypatches the
 * `streamSimple` dispatch that `spawn.ts` calls, so no network/API is touched.
 * Auth is satisfied by an in-memory `AuthStorage` + `ModelRegistry` with a
 * runtime key registered for the faux provider — the same shape the suite
 * harness (`test/suite/harness.ts`) uses.
 */

import type { AgentMessage, AgentTool } from "@pit/agent-core";
import {
	type Context,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@pit/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { _clearResultsForTesting } from "../src/core/coordinator/agent-url.js";
import { SubagentRegistry } from "../src/core/coordinator/registry.js";
import { type SpawnSubagentDependencies, spawnSubagent } from "../src/core/coordinator/spawn.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";

// ---------------------------------------------------------------------------
// Test rig: a registered faux provider + the dependency bundle spawnSubagent
// consumes. Each test gets its own provider registration so scripted responses
// never bleed between cases.
// ---------------------------------------------------------------------------

interface Rig {
	faux: FauxProviderRegistration;
	model: Model<string>;
	registry: SubagentRegistry;
	deps: SpawnSubagentDependencies;
	dispose: () => void;
}

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: Type.Object({ value: Type.String() }),
		execute: async () => ({
			content: [{ type: "text", text: `${name}:ok` }],
			details: {},
		}),
	};
}

function createRig(options: { tools?: AgentTool[] } = {}): Rig {
	const faux = registerFauxProvider();
	faux.setResponses([]);
	const model = faux.getModel();

	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);

	const registry = new SubagentRegistry();

	const deps: SpawnSubagentDependencies = {
		registry,
		model,
		modelRegistry,
		availableTools: options.tools ?? [],
		convertToLlm: (messages: AgentMessage[]) => convertToLlm(messages),
	};

	return {
		faux,
		model,
		registry,
		deps,
		dispose: () => faux.unregister(),
	};
}

describe("spawnSubagent (faux model)", () => {
	const rigs: Rig[] = [];

	afterEach(() => {
		while (rigs.length > 0) {
			rigs.pop()?.dispose();
		}
		_clearResultsForTesting();
	});

	function newRig(options?: { tools?: AgentTool[] }): Rig {
		const rig = createRig(options);
		rigs.push(rig);
		return rig;
	}

	it("happy path: captures final assistant text and marks the record completed", async () => {
		const rig = newRig();
		rig.faux.setResponses([fauxAssistantMessage("the answer is 42")]);

		const result = await spawnSubagent(rig.deps, {
			prompt: "what is the answer?",
			taskName: "happy",
		});

		expect(result.output).toBe("the answer is 42");
		expect(result.value).toBeUndefined();
		expect(result.record.status).toBe("completed");
		// The registry record returned matches the live registry entry.
		expect(rig.registry.get(result.record.id)?.status).toBe("completed");
		expect(result.record.output).toBe("the answer is 42");
		expect(result.record.turnCount).toBeGreaterThanOrEqual(1);
	});

	it("resultSchema valid: parses the fenced JSON block into result.value", async () => {
		const rig = newRig();
		const schema = Type.Object({
			ok: Type.Boolean(),
			count: Type.Number(),
		});
		const payload = { ok: true, count: 7 };
		rig.faux.setResponses([fauxAssistantMessage(`\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``)]);

		const result = await spawnSubagent(rig.deps, {
			prompt: "produce structured output",
			taskName: "schema-ok",
			resultSchema: schema,
		});

		expect(result.value).toEqual(payload);
		expect(result.record.status).toBe("completed");
	});

	it("resultSchema invalid: rejects with a schema-mismatch error and marks the record failed", async () => {
		const rig = newRig();
		const schema = Type.Object({
			ok: Type.Boolean(),
			count: Type.Number(),
		});
		// Valid JSON, but `count` is a string -> typebox validation fails.
		rig.faux.setResponses([fauxAssistantMessage('```json\n{"ok": true, "count": "lots"}\n```')]);

		await expect(
			spawnSubagent(rig.deps, {
				prompt: "produce structured output",
				taskName: "schema-bad",
				resultSchema: schema,
			}),
		).rejects.toThrow(/did not match resultSchema/);

		const failed = rig.registry.list().find((r) => r.prompt === "produce structured output");
		expect(failed?.status).toBe("failed");
		expect(failed?.error).toMatch(/did not match resultSchema/);
	});

	it("resultSchema invalid (non-JSON): rejects and marks the record failed", async () => {
		const rig = newRig();
		const schema = Type.Object({ ok: Type.Boolean() });
		rig.faux.setResponses([fauxAssistantMessage("just some prose, no json here")]);

		await expect(
			spawnSubagent(rig.deps, {
				prompt: "structured",
				taskName: "schema-nonjson",
				resultSchema: schema,
			}),
		).rejects.toThrow(/did not match resultSchema/);

		const failed = rig.registry.list().find((r) => r.prompt === "structured");
		expect(failed?.status).toBe("failed");
	});

	it("allowedTools filtering: only the permitted tools reach the provider context", async () => {
		const rig = newRig({ tools: [makeTool("read"), makeTool("bash"), makeTool("edit")] });

		let seenToolNames: string[] | undefined;
		rig.faux.setResponses([
			(context: Context) => {
				seenToolNames = (context.tools ?? []).map((t) => t.name).sort();
				return fauxAssistantMessage("done");
			},
		]);

		const result = await spawnSubagent(rig.deps, {
			prompt: "use a tool",
			taskName: "tools",
			allowedTools: ["read"],
		});

		expect(result.record.status).toBe("completed");
		expect(seenToolNames).toEqual(["read"]);
		expect(seenToolNames).not.toContain("bash");
		expect(seenToolNames).not.toContain("edit");
	});

	it("allowedTools undefined: all available tools reach the provider context", async () => {
		const rig = newRig({ tools: [makeTool("read"), makeTool("bash")] });

		let seenToolNames: string[] | undefined;
		rig.faux.setResponses([
			(context: Context) => {
				seenToolNames = (context.tools ?? []).map((t) => t.name).sort();
				return fauxAssistantMessage("done");
			},
		]);

		await spawnSubagent(rig.deps, { prompt: "go", taskName: "tools-all" });

		expect(seenToolNames).toEqual(["bash", "read"]);
	});

	it("cancellation via pre-aborted signal: settles as cancelled without hanging", async () => {
		const rig = newRig();
		// Provide a response so a hang would be on the abort path, not on a dry queue.
		rig.faux.setResponses([fauxAssistantMessage("should not matter")]);

		const controller = new AbortController();
		controller.abort();

		await expect(
			spawnSubagent(rig.deps, {
				prompt: "long task",
				taskName: "cancel-pre",
				signal: controller.signal,
			}),
		).rejects.toThrow(/aborted/);

		const record = rig.registry.list().find((r) => r.prompt === "long task");
		expect(record?.status).toBe("cancelled");
	});

	it("cancellation via signal aborted mid-flight: settles as cancelled", async () => {
		const rig = newRig();
		const controller = new AbortController();
		// Faux response factory aborts before producing output; the abort race in
		// spawnSubagent should win and reject with "aborted".
		rig.faux.setResponses([
			() => {
				controller.abort();
				return fauxAssistantMessage("late");
			},
		]);

		await expect(
			spawnSubagent(rig.deps, {
				prompt: "abortable",
				taskName: "cancel-mid",
				signal: controller.signal,
			}),
		).rejects.toThrow(/aborted/);

		const record = rig.registry.list().find((r) => r.prompt === "abortable");
		expect(record?.status).toBe("cancelled");
	});

	it("timeoutMs: a small timeout cancels a delayed subagent", async () => {
		const rig = newRig();
		// Factory schedules its result after the timeout fires; the timeout-driven
		// abort should win the race.
		rig.faux.setResponses([
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 200));
				return fauxAssistantMessage("too late");
			},
		]);

		await expect(
			spawnSubagent(rig.deps, {
				prompt: "slow",
				taskName: "timeout",
				timeoutMs: 10,
			}),
		).rejects.toThrow(/aborted/);

		const record = rig.registry.list().find((r) => r.prompt === "slow");
		expect(record?.status).toBe("cancelled");
	});
});
