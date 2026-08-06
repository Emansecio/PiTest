/**
 * parallel/fanout parity with the single `task` op (auditoria items 4/5):
 *  - per-task overrides (system prompt via agent type, model pattern) reach the
 *    spawned child;
 *  - children report usage/turns and surface start/progress/complete callbacks
 *    (TUI visibility);
 *  - the `parallel` tool inlines DIGESTS (N7) with op:"read" pointers instead
 *    of the full JSON dump, and the integral output stays recoverable;
 *  - fanout emits stage callbacks for scout/reviewers/worker.
 */

import type { AgentMessage } from "@pit/agent-core";
import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@pit/ai";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createCoordinatorExtension, SUBAGENT_READ_OP } from "../src/core/built-ins/coordinator-extension.js";
import { runFanout } from "../src/core/coordinator/fanout.js";
import { spawnAll } from "../src/core/coordinator/parallel.js";
import { SubagentRegistry } from "../src/core/coordinator/registry.js";
import { getSubagentErrorUsage, type SpawnSubagentDependencies } from "../src/core/coordinator/spawn.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";

const MIDDLE_SENTINEL = "MIDDLE_SENTINEL_ELIDED_FROM_DIGEST";

function bigOutput(): string {
	const filler = "x".repeat(10_000);
	return `HEAD-START\n${filler}\n${MIDDLE_SENTINEL}\n${filler}\nTAIL-END`;
}

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

describe("spawnAll parity", () => {
	const rigs: Rig[] = [];
	afterEach(() => {
		while (rigs.length > 0) rigs.pop()?.dispose();
	});

	function rig(): Rig {
		const r = createRig();
		rigs.push(r);
		return r;
	}

	it("applies per-task system prompts and reports usage/turns + lifecycle callbacks", async () => {
		const { faux, deps } = rig();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const systemPrompts: string[] = [];
		const started: string[] = [];
		const completed: Array<{ handle: string; status: string }> = [];
		const progressed: string[] = [];
		const results = await spawnAll(
			deps,
			[
				{ name: "a", prompt: "p1", systemPrompt: "SYS-PROMPT-ALPHA" },
				{ prompt: "p2" }, // unnamed -> parallel-2
			],
			{
				concurrency: 1,
				base: {
					depth: 1,
					onAgentReady: (agent) => systemPrompts.push(agent.state.systemPrompt ?? ""),
				},
				onTaskStart: (h) => {
					started.push(h);
					throw new Error("broken start sink");
				},
				onTaskEvent: (h) => {
					progressed.push(h);
					throw new Error("broken progress sink");
				},
				onTaskComplete: (h, status) => {
					completed.push({ handle: h, status });
					throw new Error("broken complete sink");
				},
			},
		);

		expect(results).toHaveLength(2);
		expect(results.every((r) => r.ok)).toBe(true);
		// Per-task system prompt reached the child agent.
		expect(systemPrompts.some((p) => p.includes("SYS-PROMPT-ALPHA"))).toBe(true);
		// Usage/turns land on each result (token accounting for the governor).
		expect(results.every((r) => r.usage !== undefined)).toBe(true);
		expect(results.every((r) => (r.turns ?? 0) >= 1)).toBe(true);
		// Lifecycle callbacks fired exactly once with stable handles (unnamed ->
		// parallel-2). Their deliberate throws were isolated from task semantics.
		expect(started).toEqual(["a", "parallel-2"]);
		expect(completed.map((c) => c.handle)).toEqual(["a", "parallel-2"]);
		expect(completed.every((c) => c.status === "done")).toBe(true);
		expect(progressed.length).toBeGreaterThanOrEqual(2);
		// Unnamed task got the stable handle as its taskName.
		expect(results[1].taskName).toContain("parallel-2");
	});
});

describe("parallel tool parity (extension level)", () => {
	let faux: FauxProviderRegistration | undefined;
	afterEach(() => faux?.unregister());

	function buildTools(
		responses: Parameters<FauxProviderRegistration["setResponses"]>[0],
		throwLifecycle = false,
		onAsyncSettled?: (handle: string, text: string, status: "done" | "error" | "cancelled") => boolean,
	) {
		faux = registerFauxProvider();
		faux.setResponses(responses);
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const started: string[] = [];
		const completed: string[] = [];
		const completionStatuses: Array<{ handle: string; status: string }> = [];
		const ext = createCoordinatorExtension({
			modelRegistry,
			getParentModel: () => model,
			getAvailableTools: () => [],
			convertToLlm: (messages) => convertToLlm(messages),
			onSubagentStart: (h) => {
				started.push(h);
				if (throwLifecycle) throw new Error("broken direct start sink");
			},
			onSubagentComplete: (h, status) => {
				completed.push(h);
				completionStatuses.push({ handle: h, status });
				if (throwLifecycle) throw new Error("broken direct complete sink");
			},
			onAsyncComplete: (handle, text, status) => {
				if (throwLifecycle) throw new Error("broken async-complete sink");
				return onAsyncSettled?.(handle, text, status) ?? false;
			},
		});
		const defs = new Map<string, { execute: (...a: unknown[]) => Promise<unknown>; parameters: TSchema }>();
		ext({
			registerTool: (def: { name: string }) => defs.set(def.name, def as never),
		} as never);
		return { defs, started, completed, completionStatuses };
	}

	const exec = (tool: { execute: (...a: unknown[]) => Promise<unknown> }, params: Record<string, unknown>) =>
		tool.execute("call", params, undefined, undefined, {});
	const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0].text;
	const isErr = (r: unknown): boolean => (r as { isError: boolean }).isError;

	it.each([
		["task", { op: "run", prompt: "p", acceptance: { criteria: "x", max_attempts: 0 } }],
		["parallel", { tasks: [{ prompt: "p", acceptance: { criteria: "x", max_attempts: -1 } }] }],
		[
			"fanout",
			{
				scout: { prompt: "s" },
				reviewer: { prompt_template: "{{target}}" },
				worker: { prompt: "w", acceptance: { criteria: "x", max_attempts: 1.5 } },
			},
		],
	] as const)("%s schema rejects max_attempts values below the integer minimum", (toolName, params) => {
		const { defs } = buildTools([]);
		const tool = defs.get(toolName);
		if (!tool) throw new Error(`${toolName} not registered`);
		expect(Value.Check(tool.parameters, params)).toBe(false);
	});

	it("exposes and validates acceptance check timeout on task", () => {
		const { defs } = buildTools([]);
		const task = defs.get("task");
		if (!task) throw new Error("task not registered");
		expect(
			Value.Check(task.parameters, {
				op: "run",
				prompt: "p",
				acceptance: { check: "true", check_timeout_ms: 1000 },
			}),
		).toBe(true);
		expect(
			Value.Check(task.parameters, { op: "run", prompt: "p", acceptance: { check: "true", check_timeout_ms: 999 } }),
		).toBe(false);
	});

	it("cancels a detached subagent explicitly by handle", async () => {
		const { defs } = buildTools([
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 100));
				return fauxAssistantMessage("too late");
			},
		]);
		const task = defs.get("task");
		if (!task) throw new Error("task not registered");

		const spawned = await exec(task, { op: "spawn", name: "slow", prompt: "p" });
		expect(isErr(spawned)).toBe(false);
		const cancelled = await exec(task, { op: "cancel", handles: ["slow"] });
		expect(isErr(cancelled)).toBe(false);
		expect(textOf(cancelled)).toContain("slow: cancellation requested");
		const joined = await exec(task, { op: "join", handles: ["slow"] });
		expect(isErr(joined)).toBe(false);
		expect(textOf(joined)).toMatch(/slow[\s\S]*cancelled[\s\S]*cancelled by parent/);
	});

	it("bounds uncollected detached completions and exposes evictions without losing readable output", async () => {
		const count = 130;
		let resolveSettled!: () => void;
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		let completed = 0;
		const { defs } = buildTools(
			Array.from({ length: count }, (_, i) => fauxAssistantMessage(`detached-result-${i}`)),
			false,
			() => {
				completed += 1;
				if (completed === count) resolveSettled();
				return false;
			},
		);
		const task = defs.get("task");
		if (!task) throw new Error("task not registered");

		for (let i = 0; i < count; i += 1) {
			const spawned = await exec(task, { op: "spawn", name: `overflow-${i}`, prompt: "p" });
			expect(isErr(spawned)).toBe(false);
		}
		await settled;
		const listed = await exec(task, { op: "list" });
		expect((listed as { details?: { asyncHandles?: number; evictedAsyncHandles?: number } }).details).toMatchObject({
			asyncHandles: 64,
			evictedAsyncHandles: 64,
		});

		// The oldest completion has moved out of both the 64-entry pending cache and
		// the compact tombstone display cache. Its separate identity reservation keeps
		// poll/join honest and blocks name reuse until acknowledged.
		const poll = await exec(task, { op: "poll", handles: ["overflow-0"] });
		const pollText = textOf(poll);
		expect(pollText).toMatch(/(?:settled|done)/);
		if (pollText.includes("settled")) expect(pollText).toContain('op:"read"');
		expect((poll as { details?: { evicted?: number } }).details?.evicted).toBe(0);

		const duplicate = await exec(task, { op: "spawn", name: "overflow-0", prompt: "new" });
		expect(isErr(duplicate)).toBe(true);
		expect(textOf(duplicate)).toMatch(/(?:still reserved|already finished)/);

		const joined = await exec(task, { op: "join", handles: ["overflow-0"] });
		const joinedText = textOf(joined);
		expect(joinedText).toMatch(/(?:settled details were evicted|detached-result-0)/);
		if (joinedText.includes("settled details were evicted")) expect(joinedText).toContain('op:"read"');
		expect((joined as { details?: { evicted?: number } }).details?.evicted).toBe(0);

		const read = await exec(task, { op: SUBAGENT_READ_OP, name: "overflow-0" });
		expect(isErr(read)).toBe(false);
		expect(textOf(read)).toContain("detached-result-0");
	});

	it("preserves an errored detached status after its tombstone details are evicted", async () => {
		const successful = 129;
		let resolveErrored!: () => void;
		const errored = new Promise<void>((resolve) => {
			resolveErrored = resolve;
		});
		let resolveSettled!: () => void;
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		let completed = 0;
		const transportError = fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "provider returned error: 503 detached failure",
		});
		const { defs } = buildTools(
			[
				transportError,
				transportError,
				...Array.from({ length: successful }, (_, i) => fauxAssistantMessage(`ok-${i}`)),
			],
			false,
			(handle) => {
				completed += 1;
				if (handle === "evicted-error") resolveErrored();
				if (completed === successful + 1) resolveSettled();
				return false;
			},
		);
		const task = defs.get("task");
		if (!task) throw new Error("task not registered");

		expect(isErr(await exec(task, { op: "spawn", name: "evicted-error", prompt: "p" }))).toBe(false);
		await errored;
		for (let i = 0; i < successful; i += 1) {
			expect(isErr(await exec(task, { op: "spawn", name: `after-error-${i}`, prompt: "p" }))).toBe(false);
		}
		await settled;

		const poll = await exec(task, { op: "poll", handles: ["evicted-error"] });
		expect(textOf(poll)).toContain("settled (details evicted)");
		expect((poll as { details?: { anyDone?: boolean; allSettled?: boolean } }).details).toMatchObject({
			anyDone: false,
			allSettled: true,
		});
	});

	it("bounds identity reservations after detached tombstones are evicted", async () => {
		const count = 270;
		let resolveSettled!: () => void;
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		let completed = 0;
		const { defs } = buildTools(
			Array.from({ length: count }, (_, i) => fauxAssistantMessage(`reservation-result-${i}`)),
			false,
			() => {
				completed += 1;
				if (completed === count) resolveSettled();
				return false;
			},
		);
		const task = defs.get("task");
		if (!task) throw new Error("task not registered");
		for (let i = 0; i < count; i += 1) {
			const spawned = await exec(task, { op: "spawn", name: `reservation-${i}`, prompt: "p" });
			expect(isErr(spawned)).toBe(false);
		}
		await settled;
		const listed = await exec(task, { op: "list" });
		expect(
			(listed as { details?: { reservedAsyncHandles?: number } }).details?.reservedAsyncHandles,
		).toBeLessThanOrEqual(256);
	});

	it("inlines digests with read pointers and keeps the integral output recoverable", async () => {
		const { defs, started, completed } = buildTools([fauxAssistantMessage(bigOutput())]);
		const parallel = defs.get("parallel");
		const task = defs.get("task");
		if (!parallel || !task) throw new Error("tools not registered");

		const run = await exec(parallel, { tasks: [{ name: "big", prompt: "produce a lot" }] });
		expect(isErr(run)).toBe(false);
		const text = textOf(run);
		// Digest: head+tail survive, middle elided, pointer cites op:"read" + handle.
		expect(text).toContain("### big [ok]");
		expect(text).toContain("HEAD-START");
		expect(text).toContain("TAIL-END");
		expect(text).not.toContain(MIDDLE_SENTINEL);
		expect(text).toContain(`op:"${SUBAGENT_READ_OP}"`);
		expect(text).toContain('name:"big"');
		// TUI visibility: the child surfaced like any other subagent run.
		expect(started).toContain("big");
		expect(completed).toContain("big");
		// The integral output is recoverable without re-spawning.
		const read = await exec(task, { op: SUBAGENT_READ_OP, name: "big" });
		expect(isErr(read)).toBe(false);
		expect(textOf(read)).toContain(MIDDLE_SENTINEL);
	});

	it("isolates throwing lifecycle callbacks for direct and detached task runs", async () => {
		const { defs, started, completed } = buildTools(
			[fauxAssistantMessage("direct done"), fauxAssistantMessage("detached done")],
			true,
		);
		const task = defs.get("task");
		if (!task) throw new Error("task not registered");
		const direct = await exec(task, { op: "run", name: "direct-safe", prompt: "p" });
		expect(isErr(direct)).toBe(false);
		expect(textOf(direct)).toContain("direct done");
		expect(completed.filter((handle) => handle === "direct-safe")).toHaveLength(1);

		const spawned = await exec(task, { op: "spawn", name: "detached-safe", prompt: "p" });
		expect(isErr(spawned)).toBe(false);
		const joined = await exec(task, { op: "join", handles: ["detached-safe"] });
		expect(isErr(joined)).toBe(false);
		expect(textOf(joined)).toContain("detached done");
		expect(started).toEqual(expect.arrayContaining(["direct-safe", "detached-safe"]));
	});

	it("marks an exhausted acceptance gate as an errored root lifecycle", async () => {
		const { defs, started, completed, completionStatuses } = buildTools([
			fauxAssistantMessage("incomplete"),
			fauxAssistantMessage(`\`\`\`json\n${JSON.stringify({ pass: false, reasons: "missing" })}\n\`\`\``),
		]);
		const task = defs.get("task");
		if (!task) throw new Error("task not registered");

		const result = await exec(task, {
			op: "run",
			name: "gate-failed",
			prompt: "p",
			acceptance: { criteria: "must pass", max_attempts: 1 },
		});

		expect(isErr(result)).toBe(true);
		expect(textOf(result)).toContain("Acceptance gate not satisfied after 1 attempts");
		expect(started).toEqual(
			expect.arrayContaining(["gate-failed", "gate-failed [attempt 1 worker]", "gate-failed [attempt 1 judge]"]),
		);
		expect(completed).toContain("gate-failed");
		expect(completionStatuses).toContainEqual({ handle: "gate-failed", status: "error" });

		const continued = await exec(task, { op: "continue", name: "gate-failed", prompt: "try again" });
		expect(isErr(continued)).toBe(true);
		expect(textOf(continued)).toContain("no continuable");
	});

	it("applies acceptance gates to detached spawns and does not expose failed work as continuable", async () => {
		const { defs } = buildTools([
			fauxAssistantMessage("detached incomplete"),
			fauxAssistantMessage(`\`\`\`json\n${JSON.stringify({ pass: false, reasons: "missing" })}\n\`\`\``),
		]);
		const task = defs.get("task");
		if (!task) throw new Error("task not registered");

		const spawned = await exec(task, {
			op: "spawn",
			name: "gate-detached",
			prompt: "p",
			acceptance: { criteria: "must pass", max_attempts: 1 },
		});
		expect(isErr(spawned)).toBe(false);

		const joined = await exec(task, { op: "join", handles: ["gate-detached"] });
		expect(isErr(joined)).toBe(false);
		expect(textOf(joined)).toContain("acceptance gate failed after 1 attempt(s)");

		const continued = await exec(task, { op: "continue", name: "gate-detached", prompt: "try again" });
		expect(isErr(continued)).toBe(true);
		expect(textOf(continued)).toContain("no continuable");
	});

	it("digests the scout output and makes its integral target list readable", async () => {
		const hugeTarget = `HEAD-START${"x".repeat(10_000)}${MIDDLE_SENTINEL}${"x".repeat(10_000)}TAIL-END`;
		const scoutOutput = `\`\`\`json\n${JSON.stringify({ targets: [hugeTarget] })}\n\`\`\``;
		const { defs } = buildTools([
			fauxAssistantMessage(scoutOutput),
			fauxAssistantMessage("reviewed"),
			fauxAssistantMessage("worker done"),
		]);
		const fanout = defs.get("fanout");
		const task = defs.get("task");
		if (!fanout || !task) throw new Error("tools not registered");
		const run = await exec(fanout, {
			scout: { prompt: "find targets" },
			reviewer: { prompt_template: "review {{target}}" },
			worker: { prompt: "synthesize" },
			concurrency: 1,
		});
		expect(isErr(run)).toBe(false);
		const text = textOf(run);
		expect(text).toContain("## Scout targets (1) [fanout-scout]");
		expect(text).not.toContain(MIDDLE_SENTINEL);
		expect(text).toContain(`op:"${SUBAGENT_READ_OP}"`);
		expect(text).toContain('name:"fanout-scout"');
		const read = await exec(task, { op: SUBAGENT_READ_OP, name: "fanout-scout" });
		expect(textOf(read)).toContain(MIDDLE_SENTINEL);
	});

	it("rejects an unknown per-task agent type loudly", async () => {
		const { defs } = buildTools([]);
		const parallel = defs.get("parallel");
		if (!parallel) throw new Error("parallel not registered");
		const run = await exec(parallel, { tasks: [{ prompt: "p", type: "no-such-type" }] });
		expect(isErr(run)).toBe(true);
		expect(textOf(run)).toContain('unknown agent type "no-such-type"');
	});
});

describe("fanout stage callbacks", () => {
	const rigs: Rig[] = [];
	afterEach(() => {
		while (rigs.length > 0) rigs.pop()?.dispose();
	});

	it("preserves scout, reviewer, and worker usage when the worker fails", async () => {
		const r = createRig();
		rigs.push(r);
		r.faux.setResponses([
			fauxAssistantMessage('```json\n{"targets":["alpha"]}\n```'),
			fauxAssistantMessage("review-alpha"),
			fauxAssistantMessage("worker emitted invalid schema"),
		]);

		let thrown: unknown;
		try {
			await runFanout(
				r.deps,
				{
					scout: { prompt: "find targets" },
					reviewer: { prompt_template: "Review {{target}}" },
					worker: { prompt: "Synthesize", result_schema: Type.Object({ ok: Type.Boolean() }) },
					concurrency: 1,
				},
				{ depth: 0, cwd: process.cwd() },
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeDefined();
		const registryTotal = r.deps.registry
			.list()
			.reduce((total, record) => total + (record.usage?.totalTokens ?? 0), 0);
		expect(getSubagentErrorUsage(thrown)?.totalTokens).toBe(registryTotal);
	});

	it("emits start/complete for scout, reviewers, and worker + scout usage", async () => {
		const r = createRig();
		rigs.push(r);
		r.faux.setResponses([
			fauxAssistantMessage('```json\n{"targets":["alpha"]}\n```'),
			fauxAssistantMessage("review-alpha"),
			fauxAssistantMessage("worker-done"),
		]);
		const started: string[] = [];
		const completed: string[] = [];
		const result = await runFanout(
			r.deps,
			{
				scout: { prompt: "find targets" },
				reviewer: { prompt_template: "Review {{target}}" },
				worker: { prompt: "Synthesize" },
				concurrency: 1,
			},
			{
				depth: 0,
				cwd: process.cwd(),
				onStageStart: (h) => {
					started.push(h);
					throw new Error("broken stage-start sink");
				},
				onStageComplete: (h) => {
					completed.push(h);
					throw new Error("broken stage-complete sink");
				},
			},
		);
		expect(result.worker_output.text).toBe("worker-done");
		expect(started).toEqual(["fanout-scout", "fanout-reviewer-0", "fanout-worker"]);
		expect(completed).toEqual(["fanout-scout", "fanout-reviewer-0", "fanout-worker"]);
		expect(result.scout_usage).toBeDefined();
		expect(result.scout_output).toContain("alpha");
		expect(result.scout_task_name).toContain("fanout-scout");
		expect(result.worker_task_name).toContain("fanout-worker");
		// Reviewers carry usage for whole-pipeline spend recording.
		expect(result.reviews.every((rev) => rev.usage !== undefined)).toBe(true);
	});
});
