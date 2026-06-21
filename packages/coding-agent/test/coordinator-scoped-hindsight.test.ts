/**
 * Integration test for agent-scoped hindsight at the coordinator seam.
 *
 * Drives the real `createCoordinatorExtension` → `spawnSubagent` path with a
 * scripted faux provider (no network) and a real on-disk hindsight bank. It
 * asserts that a `retain` executed INSIDE a typed subagent lands in the bank
 * stamped with the spawning agent type's scope, that a builtin `memory: true`
 * type (explore) gets recall/retain auto-added to the child catalog even though
 * its `tools` list omits them, and that `PIT_NO_SCOPED_HINDSIGHT=1` disables the
 * scoping so the same retain lands global (agentScope undefined).
 *
 * Mirrors the faux-provider + extension harness from `coordinator-resume-disk.test.ts`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@pit/agent-core";
import {
	type Context,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createCoordinatorExtension } from "../src/core/built-ins/coordinator-extension.js";
import { type HindsightBank, openBank, setCurrentHindsightBank } from "../src/core/hindsight/index.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { createRecallTool } from "../src/core/tools/recall.js";
import { createRetainTool } from "../src/core/tools/retain.js";

describe("coordinator agent-scoped hindsight", () => {
	const fauxes: FauxProviderRegistration[] = [];
	let root: string | undefined;

	afterEach(() => {
		for (const f of fauxes.splice(0)) f.unregister();
		setCurrentHindsightBank(undefined);
		delete process.env.PIT_NO_SCOPED_HINDSIGHT;
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	// A coordinator bound to `cwd`, with a real parent tool catalog (unscoped
	// hindsight tools) and the scoped-hindsight setting on by default.
	function makeCoordinator(
		cwd: string,
		responses: Parameters<FauxProviderRegistration["setResponses"]>[0],
		availableTools: AgentTool[],
	) {
		const faux = registerFauxProvider();
		fauxes.push(faux);
		faux.setResponses(responses);
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const ext = createCoordinatorExtension({
			modelRegistry,
			getParentModel: () => model,
			getAvailableTools: () => availableTools,
			convertToLlm: (messages) => convertToLlm(messages),
			getCwd: () => cwd,
			isScopedHindsightEnabled: () => true,
		});
		const tools: Record<string, { execute: (...a: unknown[]) => Promise<unknown> }> = {};
		ext({
			registerTool: (def: { name: string }) => {
				tools[def.name] = def as never;
			},
		} as never);
		return tools.task;
	}

	const exec = (task: { execute: (...a: unknown[]) => Promise<unknown> }, params: Record<string, unknown>) =>
		task.execute("call", params, undefined);

	function openTempBank(): HindsightBank {
		root = mkdtempSync(join(tmpdir(), "pit-csh-"));
		const bank = openBank(join(root, "bank.jsonl"));
		setCurrentHindsightBank(bank);
		return bank;
	}

	it("a retain inside a typed (review) subagent lands with agentScope 'review'", async () => {
		const bank = openTempBank();
		const cwd = root as string;
		// First turn: the subagent calls retain; second turn: it finalizes.
		const task = makeCoordinator(
			cwd,
			[
				fauxAssistantMessage([fauxToolCall("retain", { body: "review uses tsgo" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
			[createRetainTool(cwd), createRecallTool(cwd)],
		);

		const res = await exec(task, { op: "run", type: "review", name: "rev", prompt: "remember a fact" });
		expect((res as { isError: boolean }).isError).toBe(false);

		const entries = bank.all();
		const stored = entries.find((e) => e.body.includes("review uses tsgo"));
		expect(stored).toBeDefined();
		expect(stored?.agentScope).toBe("review");
	});

	it("a builtin memory:true type (explore) auto-adds recall+retain even though its tools omit them", async () => {
		const bank = openTempBank();
		const cwd = root as string;
		let seenToolNames: string[] | undefined;
		const task = makeCoordinator(
			cwd,
			[
				(context: Context) => {
					seenToolNames = (context.tools ?? []).map((t) => t.name).sort();
					return fauxAssistantMessage([fauxToolCall("retain", { body: "explore finding here" })], {
						stopReason: "toolUse",
					});
				},
				fauxAssistantMessage("done"),
			],
			// Parent catalog deliberately omits hindsight tools; explore's memory:true
			// must auto-add scoped recall/retain/reflect anyway.
			[],
		);

		const res = await exec(task, { op: "run", type: "explore", name: "exp", prompt: "find and remember" });
		expect((res as { isError: boolean }).isError).toBe(false);

		// The child saw the auto-added memory tools, despite the builtin `tools` list
		// (read/grep/find/ls/bash) omitting them.
		expect(seenToolNames).toContain("recall");
		expect(seenToolNames).toContain("retain");

		const stored = bank.all().find((e) => e.body.includes("explore finding here"));
		expect(stored?.agentScope).toBe("explore");
	});

	it("with PIT_NO_SCOPED_HINDSIGHT=1 a retain in a typed subagent lands global (agentScope undefined)", async () => {
		const bank = openTempBank();
		const cwd = root as string;
		process.env.PIT_NO_SCOPED_HINDSIGHT = "1";
		const task = makeCoordinator(
			cwd,
			[
				fauxAssistantMessage([fauxToolCall("retain", { body: "unscoped fact body" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
			[createRetainTool(cwd), createRecallTool(cwd)],
		);

		// allowed_tools must permit retain: scoping is off, so the auto-widening that
		// normally lets a memory type keep retain does not apply.
		const res = await exec(task, {
			op: "run",
			type: "review",
			name: "rev",
			prompt: "remember unscoped",
			allowed_tools: ["retain"],
		});
		expect((res as { isError: boolean }).isError).toBe(false);

		const stored = bank.all().find((e) => e.body.includes("unscoped fact body"));
		expect(stored).toBeDefined();
		expect(stored?.agentScope).toBeUndefined();
	});
});
