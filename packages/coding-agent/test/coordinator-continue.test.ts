/**
 * Conversational continuation of a successfully-finished subagent (GAP #2,
 * ADR/uplift). Unlike op:resume (which only re-drives subagents interrupted with
 * an error/abort), op:continue sends a follow-up prompt to a subagent that
 * completed cleanly, reusing its live Agent so the transcript carries over —
 * the equivalent of Claude Code's SendMessage(agentId).
 *
 * Rig mirrors coordinator-resume.test.ts.
 */

import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createCoordinatorExtension } from "../src/core/built-ins/coordinator-extension.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { TokenBudgetGovernor } from "../src/core/token-governor.js";

describe("coordinator op:continue", () => {
	let faux: FauxProviderRegistration | undefined;
	let governor: TokenBudgetGovernor;
	let abortCoordinator: (() => void) | undefined;
	afterEach(() => {
		abortCoordinator?.();
		abortCoordinator = undefined;
		faux?.unregister();
	});

	function buildTask(responses: Parameters<FauxProviderRegistration["setResponses"]>[0]) {
		faux = registerFauxProvider();
		faux.setResponses(responses);
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		governor = new TokenBudgetGovernor();
		const ext = createCoordinatorExtension({
			modelRegistry,
			getParentModel: () => model,
			getAvailableTools: () => [],
			convertToLlm: (messages) => convertToLlm(messages),
			getTokenGovernor: () => governor,
			registerAbortDetached: (abort) => {
				abortCoordinator = abort;
			},
		});
		const tools: Record<string, { execute: (...a: unknown[]) => Promise<unknown> }> = {};
		ext({
			registerTool: (def: { name: string }) => {
				tools[def.name] = def as never;
			},
		} as never);
		return tools.task;
	}

	const exec = (
		task: { execute: (...a: unknown[]) => Promise<unknown> },
		params: Record<string, unknown>,
		signal?: AbortSignal,
	) => task.execute("call", params, signal, undefined, {});
	const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0].text;
	const isErr = (r: unknown): boolean => (r as { isError: boolean }).isError;
	const taskNameOf = (r: unknown): string => (r as { details: { taskName: string } }).details.taskName;
	const recordUsage = (listText: string, taskName: string): number => {
		const escaped = taskName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const match = new RegExp(`^- ${escaped} \\[.*?\\] turns=\\d+ \\((\\d+) tok\\)`, "m").exec(listText);
		if (!match) throw new Error(`missing registry line for ${taskName}: ${listText}`);
		return Number(match[1]);
	};

	it("sends a follow-up to a cleanly-finished op:run via op:continue", async () => {
		const task = buildTask([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("follow-up answer with prior context"),
		]);
		const run = await exec(task, { op: "run", name: "c1", prompt: "first task" });
		expect(isErr(run)).toBe(false);

		const cont = await exec(task, { op: "continue", name: "c1", prompt: "now go further" });
		expect(isErr(cont)).toBe(false);
		expect(textOf(cont)).toContain("follow-up answer with prior context");
	});

	it("composes the caller signal with a coordinator-owned continue controller", async () => {
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const task = buildTask([
			fauxAssistantMessage("first answer"),
			async (_context, options) => {
				markStarted?.();
				return await new Promise((resolve) => {
					const finish = () => resolve(fauxAssistantMessage("late follow-up"));
					if (options?.signal?.aborted) finish();
					else options?.signal?.addEventListener("abort", finish, { once: true });
				});
			},
		]);
		await exec(task, { op: "run", name: "continue-abort", prompt: "first" });
		const controller = new AbortController();
		const continued = exec(task, { op: "continue", name: "continue-abort", prompt: "more" }, controller.signal);
		await started;
		controller.abort(new Error("aborted: caller interrupted continue"));
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				continued,
				new Promise<undefined>((resolve) => {
					timer = setTimeout(() => resolve(undefined), 500);
				}),
			]);
			expect(result).toBeDefined();
			if (result) expect(isErr(result)).toBe(true);
		} finally {
			if (timer) clearTimeout(timer);
			abortCoordinator?.();
			await Promise.race([continued, new Promise((resolve) => setTimeout(resolve, 500))]);
		}
	});

	it("session-wide abort stops an in-flight continue promptly", async () => {
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const task = buildTask([
			fauxAssistantMessage("first answer"),
			async (_context, options) => {
				markStarted?.();
				return await new Promise((resolve) => {
					const finish = () => resolve(fauxAssistantMessage("late follow-up"));
					if (options?.signal?.aborted) finish();
					else options?.signal?.addEventListener("abort", finish, { once: true });
				});
			},
		]);
		await exec(task, { op: "run", name: "continue-session-abort", prompt: "first" });
		const continued = exec(task, { op: "continue", name: "continue-session-abort", prompt: "more" });
		await started;
		abortCoordinator?.();
		const result = await Promise.race([
			continued,
			new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 500)),
		]);
		expect(result).toBeDefined();
		if (result) expect(isErr(result)).toBe(true);
	});

	it("removes settled continue controllers before a later session-wide abort", async () => {
		const task = buildTask([
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
			fauxAssistantMessage("third"),
		]);
		await exec(task, { op: "run", name: "no-stale-controller", prompt: "first" });
		expect(isErr(await exec(task, { op: "continue", name: "no-stale-controller", prompt: "second" }))).toBe(false);
		abortCoordinator?.();
		const third = await exec(task, { op: "continue", name: "no-stale-controller", prompt: "third" });
		expect(isErr(third)).toBe(false);
		expect(textOf(third)).toContain("third");
	});

	it.each(["error", "aborted"] as const)(
		"reports isError when a follow-up resolves with stopReason %s",
		async (stopReason) => {
			const task = buildTask([
				fauxAssistantMessage("first answer"),
				fauxAssistantMessage("partial follow-up", {
					stopReason,
					errorMessage: stopReason === "error" ? "follow-up dropped" : undefined,
				}),
			]);
			await exec(task, { op: "run", name: "follow-up-failure", prompt: "first task" });

			const cont = await exec(task, { op: "continue", name: "follow-up-failure", prompt: "go further" });
			expect(isErr(cont)).toBe(true);
			expect(textOf(cont)).toMatch(/did not complete|remains resumable/i);
			const list = await exec(task, { op: "list" });
			expect(textOf(list)).toMatch(/Resumable[\s\S]*follow-up-failure/);
			expect(textOf(list)).not.toMatch(/Continuable[\s\S]*follow-up-failure/);
		},
	);

	it("charges each follow-up once and merges only its new usage into the original record", async () => {
		const task = buildTask([
			fauxAssistantMessage("answer 1"),
			fauxAssistantMessage("answer 2"),
			fauxAssistantMessage("answer 3"),
		]);
		await exec(task, { op: "run", name: "multi", prompt: "p1" });
		const baseline = governor.snapshot().subagentTokens;
		expect(baseline).toBeGreaterThan(0);

		const a2 = await exec(task, { op: "continue", name: "multi", prompt: "p2" });
		expect(textOf(a2)).toContain("answer 2");
		const afterFirstContinue = governor.snapshot().subagentTokens;
		expect(afterFirstContinue - baseline).toBe(69);

		const a3 = await exec(task, { op: "continue", name: "multi", prompt: "p3" });
		expect(textOf(a3)).toContain("answer 3");
		const afterSecondContinue = governor.snapshot().subagentTokens;
		expect(afterSecondContinue - afterFirstContinue).toBe(76);

		const list = await exec(task, { op: "list" });
		expect(textOf(list)).toContain(`multi [completed] turns=3 (${afterSecondContinue} tok)`);
		expect((list as { details?: { totalTokens?: number } }).details?.totalTokens).toBe(afterSecondContinue);
	});

	it("attributes a colliding raw handle's continuation to its canonical registry record", async () => {
		const task = buildTask([
			fauxAssistantMessage("first run"),
			fauxAssistantMessage("second run"),
			fauxAssistantMessage("continued second run"),
		]);
		const first = await exec(task, { op: "run", name: "duplicate", prompt: "p1" });
		const second = await exec(task, { op: "run", name: "duplicate", prompt: "p2" });
		const firstTaskName = taskNameOf(first);
		const secondTaskName = taskNameOf(second);
		expect(firstTaskName).toBe("duplicate");
		expect(secondTaskName).not.toBe(firstTaskName);

		const before = textOf(await exec(task, { op: "list" }));
		const firstBefore = recordUsage(before, firstTaskName);
		const secondBefore = recordUsage(before, secondTaskName);

		const continued = await exec(task, { op: "continue", name: "duplicate", prompt: "follow up" });
		expect(isErr(continued)).toBe(false);
		expect(textOf(continued)).toContain("continued second run");

		const after = textOf(await exec(task, { op: "list" }));
		expect(recordUsage(after, firstTaskName)).toBe(firstBefore);
		expect(recordUsage(after, secondTaskName)).toBeGreaterThan(secondBefore);
		expect(after).toContain(`- ${secondTaskName} [completed] turns=2`);
	});

	it("requires a prompt", async () => {
		const task = buildTask([fauxAssistantMessage("done")]);
		await exec(task, { op: "run", name: "needp", prompt: "x" });
		const res = await exec(task, { op: "continue", name: "needp" });
		expect(isErr(res)).toBe(true);
		expect(textOf(res)).toContain("needs `prompt`");
	});

	it("returns a clear error for an unknown / never-run handle", async () => {
		const task = buildTask([fauxAssistantMessage("ok")]);
		const res = await exec(task, { op: "continue", name: "ghost", prompt: "hi" });
		expect(isErr(res)).toBe(true);
		expect(textOf(res)).toContain("no continuable subagent");
	});

	it('op:"list" surfaces continuable handles after a successful run', async () => {
		const task = buildTask([fauxAssistantMessage("first answer"), fauxAssistantMessage("follow-up")]);
		await exec(task, { op: "run", name: "listed", prompt: "go" });
		const list = await exec(task, { op: "list" });
		expect(isErr(list)).toBe(false);
		expect(textOf(list)).toMatch(/Continuable[\s\S]*listed/);
		expect((list as { details?: { continuable?: number } }).details?.continuable).toBeGreaterThanOrEqual(1);
	});
});
