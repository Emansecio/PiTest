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

import type { Agent, AgentMessage, AgentTool } from "@pit/agent-core";
import {
	type Context,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	registerFauxProvider,
} from "@pit/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { SubagentRegistry } from "../src/core/coordinator/registry.js";
import {
	DEFAULT_MAX_TURNS,
	evaluateSubagentToolPermission,
	isTransportRetryableError,
	type SpawnSubagentDependencies,
	spawnSubagent,
} from "../src/core/coordinator/spawn.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { PermissionChecker, type PermissionSettings } from "../src/core/permissions/index.js";
import type { Skill } from "../src/core/skills.js";

// Minimal Skill object — formatSkillsForPrompt only reads name/description/
// filePath/disableModelInvocation.
function makeSkill(name: string, description: string): Skill {
	return {
		name,
		description,
		filePath: `/skills/${name}/SKILL.md`,
		disableModelInvocation: false,
	} as unknown as Skill;
}

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

	it("streams with short cache retention by default (one-shot run, audit §3.1)", async () => {
		const rig = newRig();
		// Subagents never idle past the 5-minute short TTL, so the spawn streamFn
		// must pass "short" explicitly — otherwise the Anthropic provider default
		// ("long") pays 2.0× cache-write price for no additional hits.
		const seenRetentions: Array<string | undefined> = [];
		rig.faux.setResponses([
			(_context: Context, options) => {
				seenRetentions.push(options?.cacheRetention);
				return fauxAssistantMessage("done");
			},
		]);

		const result = await spawnSubagent(rig.deps, { prompt: "p", taskName: "retention" });

		expect(result.record.status).toBe("completed");
		expect(seenRetentions).toEqual(["short"]);
	});

	it("records the spawn depth on the registry record", async () => {
		const rig = newRig();
		rig.faux.setResponses([fauxAssistantMessage("done")]);
		const result = await spawnSubagent(rig.deps, { prompt: "p", taskName: "deep", depth: 3 });
		expect(result.record.depth).toBe(3);
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

	it("resultSchema: serializes the schema (property names) into the subagent system prompt", async () => {
		const rig = newRig();
		const schema = Type.Object({
			verdict: Type.String(),
			evidence: Type.String(),
		});
		let seenPrompt: string | undefined;
		rig.faux.setResponses([
			(context: Context) => {
				seenPrompt = context.systemPrompt;
				return fauxAssistantMessage(`\`\`\`json\n${JSON.stringify({ verdict: "x", evidence: "y" })}\n\`\`\``);
			},
		]);

		await spawnSubagent(rig.deps, { prompt: "p", taskName: "schema-in-prompt", resultSchema: schema });

		// The schema is serialized into the prompt so the model emits the EXACT field names
		// (not a guess like "status" for "verdict") — without this the Value.Check rejects it.
		expect(seenPrompt).toContain("JSON Schema");
		expect(seenPrompt).toContain("verdict");
		expect(seenPrompt).toContain("evidence");
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
			// The reason now names the trigger instead of a bare "aborted".
		).rejects.toThrow(/aborted: timeout after 10ms/);

		const record = rig.registry.list().find((r) => r.prompt === "slow");
		expect(record?.status).toBe("cancelled");
		expect(record?.error).toMatch(/timeout after 10ms/);
	});

	it("turn cap: aborts with an informative reason naming the cap and marks cancelled", async () => {
		const rig = newRig({ tools: [makeTool("read")] });
		// Every turn calls a tool and never finalizes, so the loop only ends when
		// the turn cap fires — exercising the turn-cap abort path (not timeout).
		rig.faux.setResponses(
			Array.from({ length: 6 }, () =>
				fauxAssistantMessage([fauxToolCall("read", { value: "x" })], { stopReason: "toolUse" }),
			),
		);

		await expect(spawnSubagent(rig.deps, { prompt: "loops forever", taskName: "cap", maxTurns: 2 })).rejects.toThrow(
			/aborted: turn cap \(2\) reached/,
		);

		const record = rig.registry.list().find((r) => r.prompt === "loops forever");
		expect(record?.status).toBe("cancelled");
		expect(record?.error).toMatch(/turn cap \(2\) reached/);
	});

	it("default turn cap is 50 (raised from 25 for long recon/mining tasks)", () => {
		expect(DEFAULT_MAX_TURNS).toBe(50);
	});

	it("returns aggregate token usage on the result and the registry record", async () => {
		const rig = newRig();
		rig.faux.setResponses([fauxAssistantMessage("done")]);
		const result = await spawnSubagent(rig.deps, { prompt: "p", taskName: "usage" });
		expect(result.usage).toBeDefined();
		expect(result.usage?.totalTokens).toBeGreaterThanOrEqual(0);
		expect(result.usage?.costUsd).toBeGreaterThanOrEqual(0);
		// The result usage matches what was written to the registry record.
		expect(result.record.usage).toEqual(result.usage);
	});

	it("invokes onSubagentEvent once per finished turn, carrying the turn number and last tool", async () => {
		const rig = newRig({ tools: [makeTool("read")] });
		rig.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { value: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const events: Array<{ turn: number; lastTool?: string }> = [];
		await spawnSubagent(rig.deps, {
			prompt: "p",
			taskName: "progress",
			onSubagentEvent: (info) => events.push(info),
		});
		expect(events.length).toBeGreaterThanOrEqual(2);
		expect(events[0].turn).toBe(1);
		// The turn that called `read` reports it as the last tool.
		expect(events.some((e) => e.lastTool === "read")).toBe(true);
	});

	it("inheritSkills: appends the parent's skills to the subagent system prompt", async () => {
		const rig = newRig();
		rig.deps.skills = [makeSkill("emansec-pentest", "web bug bounty engagement work")];

		let seenPrompt: string | undefined;
		rig.faux.setResponses([
			(context: Context) => {
				seenPrompt = context.systemPrompt;
				return fauxAssistantMessage("done");
			},
		]);

		await spawnSubagent(rig.deps, { prompt: "p", taskName: "skills-on", inheritSkills: true });

		expect(seenPrompt).toContain("<available_skills>");
		expect(seenPrompt).toContain("emansec-pentest");
	});

	it("inheritSkills off (default): the subagent prompt carries no skills section", async () => {
		const rig = newRig();
		rig.deps.skills = [makeSkill("emansec-pentest", "web bug bounty engagement work")];

		let seenPrompt: string | undefined;
		rig.faux.setResponses([
			(context: Context) => {
				seenPrompt = context.systemPrompt;
				return fauxAssistantMessage("done");
			},
		]);

		await spawnSubagent(rig.deps, { prompt: "p", taskName: "skills-off" });

		expect(seenPrompt).not.toContain("<available_skills>");
	});

	it("systemPromptSuffix is appended to the subagent system prompt", async () => {
		const rig = newRig();
		let seenPrompt: string | undefined;
		rig.faux.setResponses([
			(context) => {
				seenPrompt = context.systemPrompt;
				return fauxAssistantMessage("done");
			},
		]);
		await spawnSubagent(rig.deps, { prompt: "p", taskName: "suffix", systemPromptSuffix: "MSG-PREAMBLE-XYZ" });
		expect(seenPrompt).toContain("MSG-PREAMBLE-XYZ");
	});

	it("onAgentReady receives the live Agent before the run; onSettle fires on success", async () => {
		const rig = newRig();
		rig.faux.setResponses([fauxAssistantMessage("ok")]);
		let readyCalls = 0;
		let settleCalls = 0;
		await spawnSubagent(rig.deps, {
			prompt: "p",
			taskName: "hooks-ok",
			onAgentReady: (agent: Agent) => {
				readyCalls++;
				expect(agent.state.model).toBeDefined();
			},
			onSettle: () => {
				settleCalls++;
			},
		});
		expect(readyCalls).toBe(1);
		expect(settleCalls).toBeGreaterThanOrEqual(1);
	});

	it("onSettle fires even when the subagent is cancelled", async () => {
		const rig = newRig();
		rig.faux.setResponses([fauxAssistantMessage("should not matter")]);
		const controller = new AbortController();
		controller.abort();
		let settleCalls = 0;
		await expect(
			spawnSubagent(rig.deps, {
				prompt: "p",
				taskName: "hooks-cancel",
				signal: controller.signal,
				onSettle: () => {
					settleCalls++;
				},
			}),
		).rejects.toThrow(/aborted/);
		expect(settleCalls).toBeGreaterThanOrEqual(1);
	});

	it("records denied tool calls on the registry record (headless ask/deny visibility)", async () => {
		const rig = newRig({ tools: [makeTool("edit")] });
		// plan mode denies the mutating `edit` tool (see evaluateSubagentToolPermission).
		rig.deps.permissionChecker = new PermissionChecker({
			cwd: process.cwd(),
			mode: "plan",
			settings: { mode: "plan" },
		});
		// First turn calls the denied tool; second ends the loop.
		rig.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("edit", { value: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const result = await spawnSubagent(rig.deps, { prompt: "edit something", taskName: "denied" });

		expect(result.record.deniedToolCalls).toContain("edit");
		expect(rig.registry.get(result.record.id)?.deniedToolCalls).toContain("edit");
	});

	it("rejects worktree spawn under plan mode before creating a worktree", async () => {
		const rig = newRig();
		rig.deps.permissionChecker = new PermissionChecker({
			cwd: process.cwd(),
			mode: "plan",
			settings: { mode: "plan" },
		});
		await expect(spawnSubagent(rig.deps, { prompt: "p", taskName: "wt-plan", worktree: true })).rejects.toThrow(
			/worktree is blocked in plan mode/,
		);
		const records = [...rig.registry.list()];
		const failed = records.find((r) => r.taskName === "wt-plan");
		expect(failed?.status).toBe("failed");
		expect(failed?.error).toMatch(/worktree is blocked in plan mode/);
	});

	it("retries once on a transport 503 before the first successful turn (ADR #6)", async () => {
		const rig = newRig();
		rig.faux.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "provider returned error: 503 service unavailable",
			}),
			fauxAssistantMessage("recovered after retry"),
		]);
		const result = await spawnSubagent(rig.deps, { prompt: "p", taskName: "transport-retry" });
		expect(result.output).toContain("recovered after retry");
		expect(result.record.status).toBe("completed");
		expect(result.record.turnCount).toBeGreaterThanOrEqual(2);
	});

	it("does not classify abort/timeout as transport-retryable", () => {
		expect(isTransportRetryableError("aborted: parent signal")).toBe(false);
		expect(isTransportRetryableError("aborted: timeout after 100ms")).toBe(false);
		expect(isTransportRetryableError("aborted: turn cap (2) reached")).toBe(false);
		expect(isTransportRetryableError("provider returned error: 502")).toBe(true);
	});
});

describe("evaluateSubagentToolPermission (subagent permission gate)", () => {
	const checker = (settings: PermissionSettings, mode: "auto" | "plan") =>
		new PermissionChecker({ cwd: process.cwd(), mode, settings });

	it("blocks a mutating tool under plan mode", () => {
		const result = evaluateSubagentToolPermission(checker({ mode: "plan" }, "plan"), "edit", { file: "a.ts" });
		expect(result?.block).toBe(true);
	});

	it("allows a read-only tool under plan mode", () => {
		const result = evaluateSubagentToolPermission(checker({ mode: "plan" }, "plan"), "read", { file: "a.ts" });
		expect(result).toBeUndefined();
	});

	it("blocks builtin dangerous commands under auto mode", () => {
		// Prefer a deny-floor pattern that survives validateSafeRegex (the historic
		// `rm -rf /` rule is currently skipped as "nested quantifiers").
		const result = evaluateSubagentToolPermission(checker({ mode: "auto" }, "auto"), "bash", {
			command: "chmod -R 777 /",
		});
		expect(result?.block).toBe(true);
	});

	it("allows ordinary commands under auto mode", () => {
		const result = evaluateSubagentToolPermission(checker({ mode: "auto" }, "auto"), "bash", { command: "npm test" });
		expect(result).toBeUndefined();
	});

	it("allows everything with builtin defaults disabled (no-rails)", () => {
		const result = evaluateSubagentToolPermission(
			checker({ mode: "auto", disableBuiltinDefaults: true }, "auto"),
			"bash",
			{ command: "rm -rf /" },
		);
		expect(result).toBeUndefined();
	});

	it("blocks a denyTools entry and surfaces a reason", () => {
		const result = evaluateSubagentToolPermission(checker({ mode: "plan", denyTools: ["read"] }, "plan"), "read", {
			file: "a.ts",
		});
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/denyTools|denied/i);
	});
});
