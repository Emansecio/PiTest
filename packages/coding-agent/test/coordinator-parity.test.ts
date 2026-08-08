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

import type { AgentMessage, AgentTool } from "@pit/agent-core";
import { type FauxProviderRegistration, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@pit/ai";
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
		availableTools: AgentTool[] = [],
		configureRegistry?: (
			registry: ModelRegistry,
			model: NonNullable<ReturnType<FauxProviderRegistration["getModel"]>>,
		) => void,
	) {
		faux = registerFauxProvider();
		faux.setResponses(responses);
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		configureRegistry?.(modelRegistry, model!);
		const started: string[] = [];
		const completed: string[] = [];
		const completionStatuses: Array<{ handle: string; status: string }> = [];
		let abortDetached: (() => void) | undefined;
		const ext = createCoordinatorExtension({
			modelRegistry,
			getParentModel: () => model,
			getAvailableTools: () => availableTools,
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
			registerAbortDetached: (abort) => {
				abortDetached = abort;
			},
		});
		const defs = new Map<string, { execute: (...a: unknown[]) => Promise<unknown>; parameters: TSchema }>();
		ext({
			registerTool: (def: { name: string }) => defs.set(def.name, def as never),
		} as never);
		return { defs, started, completed, completionStatuses, abortDetached: () => abortDetached?.() };
	}

	const exec = (tool: { execute: (...a: unknown[]) => Promise<unknown> }, params: Record<string, unknown>) =>
		tool.execute("call", params, undefined, undefined, {});
	const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0].text;
	const isErr = (r: unknown): boolean => (r as { isError: boolean }).isError;
	const configureRequestedModel =
		(id: string) =>
		(registry: ModelRegistry, model: NonNullable<ReturnType<FauxProviderRegistration["getModel"]>>) => {
			registry.registerProvider(model.provider, {
				apiKey: "faux-key",
				api: model.api,
				baseUrl: model.baseUrl,
				models: [
					{
						id,
						name: id,
						reasoning: model.reasoning,
						input: model.input,
						cost: model.cost,
						contextWindow: model.contextWindow,
						maxTokens: model.maxTokens,
					},
				],
			});
		};

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

	it("requires max_turns to be a positive integer without imposing an arbitrary maximum", () => {
		const { defs } = buildTools([]);
		const task = defs.get("task");
		if (!task) throw new Error("task not registered");
		for (const max_turns of [0, -1, -100, 0.5, 1.5]) {
			expect(Value.Check(task.parameters, { op: "run", prompt: "p", max_turns })).toBe(false);
		}
		for (const max_turns of [1, 50, 1_000_000]) {
			expect(Value.Check(task.parameters, { op: "run", prompt: "p", max_turns })).toBe(true);
		}
		expect(faux?.state.callCount).toBe(0);
	});

	it("rejects an unknown explicit model instead of silently using the parent", async () => {
		const { defs } = buildTools([]);
		const task = defs.get("task");
		if (!task) throw new Error("task not registered");
		const result = await exec(task, { op: "run", prompt: "p", model: "faux/does-not-exist" });
		expect(isErr(result)).toBe(true);
		expect(textOf(result)).toContain("not found");
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

	it("publishes detached cancellation immediately even when the provider ignores abort", async () => {
		let release: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { defs } = buildTools([
			async () => {
				markStarted?.();
				await blocked;
				return fauxAssistantMessage("late result");
			},
		]);
		const task = defs.get("task");
		if (!task) throw new Error("task not registered");

		await exec(task, { op: "spawn", name: "abort-lag", prompt: "p" });
		await started;
		const cancelled = await exec(task, { op: "cancel", handles: ["abort-lag"] });
		expect(isErr(cancelled)).toBe(false);

		const poll = await exec(task, { op: "poll", handles: ["abort-lag"] });
		expect(textOf(poll)).toContain("abort-lag: cancelled");
		const listed = await exec(task, { op: "list" });
		expect(textOf(listed)).toMatch(/abort-lag \[cancelled\]/);

		release?.();
		await exec(task, { op: "join", handles: ["abort-lag"] });
	});

	it("publishes detached cancellation immediately when the parent aborts the session", async () => {
		let release: (() => void) | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { defs, abortDetached } = buildTools([
			async () => {
				markStarted?.();
				await blocked;
				return fauxAssistantMessage("late session result");
			},
		]);
		const task = defs.get("task");
		if (!task) throw new Error("task not registered");

		await exec(task, { op: "spawn", name: "session-abort", prompt: "p" });
		await started;
		abortDetached();

		const poll = await exec(task, { op: "poll", handles: ["session-abort"] });
		expect(textOf(poll)).toContain("session-abort: cancelled");
		const listed = await exec(task, { op: "list" });
		expect(textOf(listed)).toMatch(/session-abort \[cancelled\]/);

		release?.();
		await exec(task, { op: "join", handles: ["session-abort"] });
	});

	it("cancels join promptly without stopping or consuming detached handles", async () => {
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let release: (() => void) | undefined;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { defs } = buildTools([
			async () => {
				markStarted?.();
				await released;
				return fauxAssistantMessage("detached result survived cancelled join");
			},
		]);
		const task = defs.get("task");
		if (!task) throw new Error("task not registered");
		await exec(task, { op: "spawn", name: "join-abort", prompt: "p" });
		await started;
		const controller = new AbortController();
		const joining = task.execute("call", { op: "join", handles: ["join-abort"] }, controller.signal);
		controller.abort(new Error("aborted: stop waiting only"));
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const cancelled = await Promise.race([
				joining,
				new Promise<undefined>((resolve) => {
					timer = setTimeout(() => resolve(undefined), 500);
				}),
			]);
			expect(cancelled).toBeDefined();
			if (cancelled) {
				expect(isErr(cancelled)).toBe(true);
				expect(textOf(cancelled)).toBe("task: join cancelled; detached subagents continue in the background.");
				expect((cancelled as { details?: unknown }).details).toEqual({ joined: 0, cancelled: true });
			}
			const poll = await exec(task, { op: "poll", handles: ["join-abort"] });
			expect(textOf(poll)).toContain("join-abort: running");
		} finally {
			if (timer) clearTimeout(timer);
			release?.();
			await joining;
		}
		const joined = await exec(task, { op: "join", handles: ["join-abort"] });
		expect(textOf(joined)).toContain("detached result survived cancelled join");
	});

	it("join only consumes the exact detached generation it awaited", async () => {
		let releaseOriginal: (() => void) | undefined;
		const originalGate = new Promise<void>((resolve) => {
			releaseOriginal = resolve;
		});
		let releaseBlocker: (() => void) | undefined;
		const blockerGate = new Promise<void>((resolve) => {
			releaseBlocker = resolve;
		});
		let markOriginalDelivered: (() => void) | undefined;
		const originalDelivered = new Promise<void>((resolve) => {
			markOriginalDelivered = resolve;
		});
		let markReplacementSettled: (() => void) | undefined;
		const replacementSettled = new Promise<void>((resolve) => {
			markReplacementSettled = resolve;
		});
		let generationCompletions = 0;
		const { defs } = buildTools(
			[
				async () => {
					await originalGate;
					return fauxAssistantMessage("original generation");
				},
				async () => {
					await blockerGate;
					return fauxAssistantMessage("blocker done");
				},
				fauxAssistantMessage("replacement generation"),
			],
			false,
			(handle) => {
				if (handle !== "generation-race") return false;
				generationCompletions++;
				if (generationCompletions === 1) {
					markOriginalDelivered?.();
					return true;
				}
				markReplacementSettled?.();
				return false;
			},
		);
		const task = defs.get("task");
		if (!task) throw new Error("task not registered");
		await exec(task, { op: "spawn", name: "generation-race", prompt: "old" });
		await exec(task, { op: "spawn", name: "join-blocker", prompt: "block" });
		const joining = exec(task, { op: "join", handles: ["generation-race", "join-blocker"] });

		releaseOriginal?.();
		await originalDelivered;
		const replacement = await exec(task, { op: "spawn", name: "generation-race", prompt: "new" });
		expect(isErr(replacement)).toBe(false);
		await replacementSettled;
		releaseBlocker?.();
		await joining;

		const poll = await exec(task, { op: "poll", handles: ["generation-race"] });
		expect(textOf(poll)).toContain('generation-race: done (collect with op:"join")');
		const joinedReplacement = await exec(task, { op: "join", handles: ["generation-race"] });
		expect(textOf(joinedReplacement)).toContain("replacement generation");
	});

	it("join only renders the detached generation captured before handle reuse", async () => {
		const fillerCount = 64;
		let releaseBlocker: (() => void) | undefined;
		const blockerGate = new Promise<void>((resolve) => {
			releaseBlocker = resolve;
		});
		let markOriginalDelivered: (() => void) | undefined;
		const originalDelivered = new Promise<void>((resolve) => {
			markOriginalDelivered = resolve;
		});
		let markFillersSettled: (() => void) | undefined;
		const fillersSettled = new Promise<void>((resolve) => {
			markFillersSettled = resolve;
		});
		let markReplacementSettled: (() => void) | undefined;
		const replacementSettled = new Promise<void>((resolve) => {
			markReplacementSettled = resolve;
		});
		let generationCompletions = 0;
		let fillerCompletions = 0;
		const { defs } = buildTools(
			[
				fauxAssistantMessage("original generation"),
				...Array.from({ length: fillerCount }, (_, i) => fauxAssistantMessage(`filler-${i}`)),
			],
			false,
			(handle) => {
				if (handle === "generation-render-race") {
					generationCompletions++;
					if (generationCompletions === 1) {
						markOriginalDelivered?.();
						return true;
					}
					markReplacementSettled?.();
					return false;
				}
				if (handle.startsWith("generation-filler-")) {
					fillerCompletions++;
					if (fillerCompletions === fillerCount) markFillersSettled?.();
				}
				return false;
			},
		);
		const task = defs.get("task");
		if (!task) throw new Error("task not registered");

		await exec(task, { op: "spawn", name: "generation-render-race", prompt: "old" });
		await originalDelivered;
		for (let i = 0; i < fillerCount; i += 1) {
			await exec(task, { op: "spawn", name: `generation-filler-${i}`, prompt: "fill" });
		}
		await fillersSettled;
		const evicted = await exec(task, { op: "poll", handles: ["generation-render-race"] });
		expect(textOf(evicted)).toContain("evicted (done)");
		faux?.setResponses([
			async () => {
				await blockerGate;
				return fauxAssistantMessage("blocker done");
			},
			fauxAssistantMessage("replacement generation"),
		]);

		await exec(task, { op: "spawn", name: "generation-render-blocker", prompt: "block" });
		const joining = exec(task, {
			op: "join",
			handles: ["generation-render-race", "generation-render-blocker"],
		});
		const replacement = await exec(task, { op: "spawn", name: "generation-render-race", prompt: "new" });
		expect(isErr(replacement)).toBe(false);
		await replacementSettled;
		releaseBlocker?.();

		const staleJoin = await joining;
		const staleText = textOf(staleJoin);
		expect(staleText).not.toContain("replacement generation");
		expect(staleText).toContain("already delivered to chat");
		expect(staleText).toContain('op:"read"');
		const poll = await exec(task, { op: "poll", handles: ["generation-render-race"] });
		expect(textOf(poll)).toContain('done (collect with op:"join")');
		const joinedReplacement = await exec(task, { op: "join", handles: ["generation-render-race"] });
		expect(textOf(joinedReplacement)).toContain("replacement generation");
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
		expect(
			(
				listed as {
					details?: {
						asyncHandles?: number;
						evictedAsyncHandles?: number;
						lifecycle?: { created: number; settled: number; evicted: number };
					};
				}
			).details,
		).toMatchObject({
			asyncHandles: 64,
			evictedAsyncHandles: 64,
			lifecycle: { created: count, settled: count, evicted: count - 64 },
		});
		expect(textOf(listed)).toContain("Lifecycle: created=130, settled=130, evicted=66");
		expect(textOf(listed)).toContain("more terminal records omitted");

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

	it("retains terminal fallback provenance in an evicted detached tombstone", async () => {
		const successful = 64;
		let resolveErrored!: () => void;
		const errored = new Promise<void>((resolve) => {
			resolveErrored = resolve;
		});
		let resolveSettled!: () => void;
		const settled = new Promise<void>((resolve) => {
			resolveSettled = resolve;
		});
		let completed = 0;
		const { defs } = buildTools(
			[
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized" }),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "evicted parent failure" }),
				...Array.from({ length: successful }, (_, i) => fauxAssistantMessage(`later-${i}`)),
			],
			false,
			(handle) => {
				completed += 1;
				if (handle === "evicted-fallback") resolveErrored();
				if (completed === successful + 1) resolveSettled();
				return false;
			},
			[],
			configureRequestedModel("evicted-terminal-child"),
		);
		const task = defs.get("task")!;
		await exec(task, {
			op: "spawn",
			name: "evicted-fallback",
			prompt: "p",
			model: "faux/evicted-terminal-child",
		});
		await errored;
		for (let i = 0; i < successful; i++) {
			await exec(task, { op: "spawn", name: `later-${i}`, prompt: "p" });
		}
		await settled;

		const joined = (await exec(task, { op: "join", handles: ["evicted-fallback"] })) as {
			details?: { results?: Array<{ handle: string; modelFallback?: { from: string; to: string } }> };
		};

		expect(textOf(joined)).toContain("[model fallback: faux/evicted-terminal-child -> faux/faux-1");
		expect(joined.details?.results).toContainEqual({
			handle: "evicted-fallback",
			modelFallback: {
				from: "faux/evicted-terminal-child",
				to: "faux/faux-1",
				reason: "401 Unauthorized",
			},
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

	it("exposes model fallback provenance in parallel output and details", async () => {
		const configureRegistry = (
			registry: ModelRegistry,
			model: NonNullable<ReturnType<FauxProviderRegistration["getModel"]>>,
		) => {
			registry.registerProvider(model.provider, {
				apiKey: "faux-key",
				api: model.api,
				baseUrl: model.baseUrl,
				models: [
					{
						id: "requested-child",
						name: "requested-child",
						reasoning: model.reasoning,
						input: model.input,
						cost: model.cost,
						contextWindow: model.contextWindow,
						maxTokens: model.maxTokens,
					},
				],
			});
		};
		const { defs } = buildTools(
			[
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "No API key for provider child" }),
				fauxAssistantMessage("parallel fallback worked"),
			],
			false,
			undefined,
			[],
			configureRegistry,
		);
		const parallel = defs.get("parallel")!;

		const result = (await exec(parallel, {
			tasks: [{ name: "fallback-child", prompt: "p", model: "faux/requested-child" }],
		})) as { content: Array<{ text: string }>; details?: { results?: Array<Record<string, unknown>> } };

		expect(textOf(result)).toContain("[model fallback: faux/requested-child -> faux/faux-1");
		expect(result.details?.results?.[0]?.modelFallback).toMatchObject({
			from: "faux/requested-child",
			to: "faux/faux-1",
		});
	});

	it("preserves model fallback provenance when a parallel child fails after fallback", async () => {
		const { defs } = buildTools(
			[
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized" }),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "parallel parent failure" }),
			],
			false,
			undefined,
			[],
			configureRequestedModel("parallel-terminal-child"),
		);
		const parallel = defs.get("parallel")!;

		const result = (await exec(parallel, {
			tasks: [{ name: "parallel-terminal", prompt: "p", model: "faux/parallel-terminal-child" }],
		})) as { details?: { results?: Array<Record<string, unknown>> } };

		expect(textOf(result)).toContain("[model fallback: faux/parallel-terminal-child -> faux/faux-1");
		expect(result.details?.results?.[0]?.modelFallback).toMatchObject({
			from: "faux/parallel-terminal-child",
			to: "faux/faux-1",
		});
	});

	it("exposes reviewer model fallback provenance in fanout output and details", async () => {
		const configureRegistry = (
			registry: ModelRegistry,
			model: NonNullable<ReturnType<FauxProviderRegistration["getModel"]>>,
		) => {
			registry.registerProvider(model.provider, {
				apiKey: "faux-key",
				api: model.api,
				baseUrl: model.baseUrl,
				models: [
					{
						id: "requested-reviewer",
						name: "requested-reviewer",
						reasoning: model.reasoning,
						input: model.input,
						cost: model.cost,
						contextWindow: model.contextWindow,
						maxTokens: model.maxTokens,
					},
				],
			});
		};
		const { defs } = buildTools(
			[
				fauxAssistantMessage('```json\n{"targets":["a"]}\n```'),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "403 Unauthorized" }),
				fauxAssistantMessage("review fallback worked"),
				fauxAssistantMessage("worker done"),
			],
			false,
			undefined,
			[],
			configureRegistry,
		);
		const fanout = defs.get("fanout")!;

		const result = (await exec(fanout, {
			scout: { prompt: "s" },
			reviewer: { prompt_template: "review {{target}}", model: "faux/requested-reviewer" },
			worker: { prompt: "w" },
		})) as { details?: { reviews?: Array<Record<string, unknown>> } };

		expect(textOf(result)).toContain("[model fallback: faux/requested-reviewer -> faux/faux-1");
		expect(result.details?.reviews?.[0]?.modelFallback).toMatchObject({
			from: "faux/requested-reviewer",
			to: "faux/faux-1",
		});
	});

	it("exposes final worker fallback provenance for an acceptance-gated blocking task", async () => {
		const { defs } = buildTools(
			[
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized" }),
				fauxAssistantMessage("gated fallback worker"),
			],
			false,
			undefined,
			[],
			configureRequestedModel("gated-child"),
		);
		const task = defs.get("task")!;

		const result = (await exec(task, {
			op: "run",
			name: "gated-blocking",
			prompt: "p",
			model: "faux/gated-child",
			acceptance: { check: 'node -e "process.exit(0)"', max_attempts: 1 },
		})) as { details?: { modelFallback?: { from: string; to: string } } };

		expect(textOf(result)).toContain("[model fallback: faux/gated-child -> faux/faux-1");
		expect(result.details?.modelFallback).toMatchObject({
			from: "faux/gated-child",
			to: "faux/faux-1",
		});
	});

	it("preserves model fallback provenance when the blocking parent attempt fails", async () => {
		const { defs } = buildTools(
			[
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized" }),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "parent terminal failure" }),
			],
			false,
			undefined,
			[],
			configureRequestedModel("terminal-child"),
		);
		const task = defs.get("task")!;

		const result = (await exec(task, {
			op: "run",
			name: "terminal-blocking",
			prompt: "p",
			model: "faux/terminal-child",
		})) as { details?: { modelFallback?: { from: string; to: string } } };

		expect(isErr(result)).toBe(true);
		expect(textOf(result)).toContain("[model fallback: faux/terminal-child -> faux/faux-1");
		expect(result.details?.modelFallback).toMatchObject({
			from: "faux/terminal-child",
			to: "faux/faux-1",
		});
	});

	it("exposes final worker fallback provenance when joining an acceptance-gated detached task", async () => {
		const { defs } = buildTools(
			[
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized" }),
				fauxAssistantMessage("detached gated fallback worker"),
			],
			false,
			undefined,
			[],
			configureRequestedModel("detached-gated-child"),
		);
		const task = defs.get("task")!;
		await exec(task, {
			op: "spawn",
			name: "gated-detached",
			prompt: "p",
			model: "faux/detached-gated-child",
			acceptance: { check: 'node -e "process.exit(0)"', max_attempts: 1 },
		});

		const joined = (await exec(task, { op: "join", handles: ["gated-detached"] })) as {
			details?: { results?: Array<{ handle: string; modelFallback?: { from: string; to: string } }> };
		};

		expect(textOf(joined)).toContain("[model fallback: faux/detached-gated-child -> faux/faux-1");
		expect(joined.details?.results).toContainEqual({
			handle: "gated-detached",
			modelFallback: {
				from: "faux/detached-gated-child",
				to: "faux/faux-1",
				reason: "401 Unauthorized",
			},
		});
	});

	it("preserves model fallback provenance when joining a detached terminal failure", async () => {
		const { defs } = buildTools(
			[
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized" }),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "detached parent failure" }),
			],
			false,
			undefined,
			[],
			configureRequestedModel("detached-terminal-child"),
		);
		const task = defs.get("task")!;
		await exec(task, {
			op: "spawn",
			name: "detached-terminal",
			prompt: "p",
			model: "faux/detached-terminal-child",
		});

		const joined = (await exec(task, { op: "join", handles: ["detached-terminal"] })) as {
			details?: { results?: Array<{ handle: string; modelFallback?: { from: string; to: string } }> };
		};

		expect(textOf(joined)).toContain("[model fallback: faux/detached-terminal-child -> faux/faux-1");
		expect(joined.details?.results).toContainEqual({
			handle: "detached-terminal",
			modelFallback: {
				from: "faux/detached-terminal-child",
				to: "faux/faux-1",
				reason: "401 Unauthorized",
			},
		});
	});

	it("attributes gated provenance only to the final worker attempt, not earlier workers or judges", async () => {
		const { defs } = buildTools(
			[
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized" }),
				fauxAssistantMessage("first worker used fallback"),
				fauxAssistantMessage('```json\n{"pass":false,"reasons":"retry"}\n```'),
				fauxAssistantMessage("final worker stayed requested"),
				fauxAssistantMessage('```json\n{"pass":true,"reasons":"ok"}\n```'),
			],
			false,
			undefined,
			[],
			configureRequestedModel("retry-gated-child"),
		);
		const task = defs.get("task")!;

		const result = (await exec(task, {
			op: "run",
			name: "gated-retry",
			prompt: "p",
			model: "faux/retry-gated-child",
			acceptance: { criteria: "must pass", max_attempts: 2 },
		})) as { details?: { modelFallback?: unknown } };

		expect(textOf(result)).toContain("final worker stayed requested");
		expect(textOf(result)).not.toContain("[model fallback:");
		expect(result.details?.modelFallback).toBeUndefined();
	});

	it("does not misattribute a terminal judge fallback to the successful worker", async () => {
		const { defs } = buildTools(
			[
				fauxAssistantMessage("worker stayed on requested model"),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized" }),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "judge parent failure" }),
			],
			false,
			undefined,
			[],
			configureRequestedModel("judge-terminal-child"),
		);
		const task = defs.get("task")!;

		const result = (await exec(task, {
			op: "run",
			name: "judge-terminal",
			prompt: "p",
			model: "faux/judge-terminal-child",
			acceptance: { criteria: "must pass", max_attempts: 1 },
		})) as { details?: { modelFallback?: unknown } };

		expect(isErr(result)).toBe(true);
		expect(textOf(result)).not.toContain("[model fallback:");
		expect(result.details?.modelFallback).toBeUndefined();
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

	it("keeps a turn-capped acceptance worker resumable", async () => {
		const readTool: AgentTool = {
			name: "read",
			label: "read",
			description: "read",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const { defs } = buildTools(
			[
				fauxAssistantMessage([fauxToolCall("read", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("finished after resume"),
			],
			false,
			undefined,
			[readTool],
		);
		const task = defs.get("task");
		if (!task) throw new Error("task not registered");
		const capped = await exec(task, {
			op: "run",
			name: "turn-capped-gate",
			prompt: "inspect",
			max_turns: 1,
			acceptance: { criteria: "must finish", max_attempts: 1 },
		});
		expect(isErr(capped)).toBe(true);
		expect(textOf(capped)).toContain('task({op:"resume", name:"turn-capped-gate"})');
		const listed = await exec(task, { op: "list" });
		expect(textOf(listed)).toMatch(/Resumable[\s\S]*turn-capped-gate/);
		const resumed = await exec(task, { op: "resume", name: "turn-capped-gate" });
		expect(isErr(resumed)).toBe(false);
		expect(textOf(resumed)).toContain("finished after resume");
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

	it("preserves final worker fallback provenance when fanout terminates in failure", async () => {
		const { defs } = buildTools(
			[
				fauxAssistantMessage('```json\n{"targets":[]}\n```'),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 Unauthorized" }),
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "fanout parent failure" }),
			],
			false,
			undefined,
			[],
			configureRequestedModel("fanout-terminal-child"),
		);
		const fanout = defs.get("fanout")!;

		const result = (await exec(fanout, {
			scout: { prompt: "find targets" },
			reviewer: { prompt_template: "review {{target}}" },
			worker: { prompt: "synthesize", model: "faux/fanout-terminal-child" },
		})) as { details?: { workerModelFallback?: { from: string; to: string } } };

		expect(isErr(result)).toBe(true);
		expect(textOf(result)).toContain("[model fallback: faux/fanout-terminal-child -> faux/faux-1");
		expect(result.details?.workerModelFallback).toMatchObject({
			from: "faux/fanout-terminal-child",
			to: "faux/faux-1",
		});
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
