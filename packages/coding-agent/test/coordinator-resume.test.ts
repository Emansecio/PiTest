/**
 * Resume of an interrupted subagent (Tier 1, in-memory).
 *
 * When an op:"run" / op:"spawn" subagent is cut short — the user hits ESC, or a
 * long network drop exhausts provider retries — its partial transcript must not
 * be thrown away. The coordinator keeps the live Agent under its handle so
 * task({op:"resume", name}) re-opens it with the context intact and finishes the
 * job, instead of restarting from zero.
 *
 * Rig mirrors coordinator-async-reinject.test.ts: a scripted faux provider whose
 * FIRST step ends the turn with stopReason:"error" (the connection drop) and a
 * SECOND step that the resume turn consumes.
 */

import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createCoordinatorExtension } from "../src/core/built-ins/coordinator-extension.js";
import { slotStats } from "../src/core/coordinator/slots.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { TokenBudgetGovernor } from "../src/core/token-governor.js";

describe("coordinator op:resume", () => {
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
	const settleWithin = async <T>(promise: Promise<T>, ms = 500): Promise<T | undefined> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<undefined>((resolve) => {
					timer = setTimeout(() => resolve(undefined), ms);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	};
	const waitForNoActiveSlot = async (): Promise<void> => {
		const deadline = Date.now() + 1000;
		while (slotStats().active > 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(slotStats().active).toBe(0);
	};

	it("charges an in-memory resume once and merges its usage into the original record", async () => {
		const task = buildTask([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "network down" }),
			fauxAssistantMessage("RESUMED: task complete"),
		]);

		const runRes = await exec(task, { op: "run", name: "probe", prompt: "do the thing" });
		expect(isErr(runRes)).toBe(true);
		const baseline = governor.snapshot().subagentTokens;
		expect(baseline).toBeGreaterThan(0);

		const list = await exec(task, { op: "list" });
		expect(textOf(list)).toMatch(/[Rr]esumable[\s\S]*probe/);

		const resumed = await exec(task, { op: "resume", name: "probe" });
		expect(isErr(resumed)).toBe(false);
		expect(textOf(resumed)).toContain("RESUMED: task complete");
		const afterResume = governor.snapshot().subagentTokens;
		expect(afterResume).toBeGreaterThan(baseline);

		// Consumed: no longer offered as resumable; usage remains on the original run.
		const list2 = await exec(task, { op: "list" });
		expect(textOf(list2).split("\n\nContinuable")[0].split("\n\nResumable")[1] ?? "").not.toContain("- probe");
		expect(textOf(list2)).toContain(`probe [completed] turns=2 (${afterResume} tok)`);
		expect((list2 as { details?: { totalTokens?: number } }).details?.totalTokens).toBe(afterResume);
	});

	it.each([
		["error", "failed"],
		["aborted", "cancelled"],
	] as const)("charges usage and records %s resume settlement as %s", async (stopReason, expectedStatus) => {
		const task = buildTask([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "drop" }),
			fauxAssistantMessage("partial resumed work", {
				stopReason,
				errorMessage: stopReason === "error" ? "dropped again" : undefined,
			}),
		]);
		await exec(task, { op: "run", name: "retry", prompt: "start" });
		const baseline = governor.snapshot().subagentTokens;
		expect(baseline).toBeGreaterThan(0);

		const resumed = await exec(task, { op: "resume", name: "retry" });
		expect(isErr(resumed)).toBe(true);
		const afterResume = governor.snapshot().subagentTokens;
		expect(afterResume).toBeGreaterThan(baseline);

		const list = await exec(task, { op: "list" });
		expect(textOf(list)).toContain(`retry [${expectedStatus}] turns=2 (${afterResume} tok)`);
		expect(textOf(list)).toMatch(/[Rr]esumable[\s\S]*retry/);
	});

	it("deduplicates concurrent resumes onto one active lifecycle", async () => {
		const task = buildTask([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "drop" }),
			fauxAssistantMessage("resumed once"),
		]);
		await exec(task, { op: "run", name: "same", prompt: "start" });
		const first = exec(task, { op: "resume", name: "same" });
		const second = exec(task, { op: "resume", name: "same" });
		const [a, b] = await Promise.all([first, second]);
		expect(isErr(a)).toBe(false);
		expect(textOf(b)).toBe(textOf(a));
	});

	it("composes the caller signal with the coordinator-owned resume controller", async () => {
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const task = buildTask([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "drop" }),
			async (_context, options) => {
				markStarted?.();
				return await new Promise((resolve) => {
					const finish = () => resolve(fauxAssistantMessage("late resume output"));
					if (options?.signal?.aborted) finish();
					else options?.signal?.addEventListener("abort", finish, { once: true });
				});
			},
		]);
		await exec(task, { op: "run", name: "parent-abort", prompt: "start" });
		const controller = new AbortController();
		const resume = exec(task, { op: "resume", name: "parent-abort" }, controller.signal);
		await started;
		controller.abort(new Error("aborted: caller interrupted resume"));
		try {
			const result = await settleWithin(resume);
			expect(result).toBeDefined();
			if (result) {
				expect(isErr(result)).toBe(true);
				expect(textOf(result)).toMatch(/cancel|abort|did not complete|failed/i);
			}
		} finally {
			abortCoordinator?.();
			await settleWithin(resume);
		}
	});

	it("session-wide abort stops an in-memory resume promptly", async () => {
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const task = buildTask([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "drop" }),
			async (_context, options) => {
				markStarted?.();
				return await new Promise((resolve) => {
					const finish = () => resolve(fauxAssistantMessage("late resume output"));
					if (options?.signal?.aborted) finish();
					else options?.signal?.addEventListener("abort", finish, { once: true });
				});
			},
		]);
		await exec(task, { op: "run", name: "session-abort", prompt: "start" });
		const resume = exec(task, { op: "resume", name: "session-abort" });
		await started;
		abortCoordinator?.();
		const result = await settleWithin(resume);
		expect(result).toBeDefined();
		if (result) expect(isErr(result)).toBe(true);
	});

	it.each(["caller", "session"] as const)(
		"%s abort interrupts the pre-resume idle wait without starting another prompt",
		async (abortSource) => {
			let markStarted: (() => void) | undefined;
			const started = new Promise<void>((resolve) => {
				markStarted = resolve;
			});
			let releaseProvider: (() => void) | undefined;
			const task = buildTask([
				async () => {
					markStarted?.();
					return await new Promise((resolve) => {
						releaseProvider = () => resolve(fauxAssistantMessage("late original output"));
					});
				},
				fauxAssistantMessage("must not start"),
			]);
			const initialController = new AbortController();
			const initialRun = exec(
				task,
				{ op: "run", name: `idle-${abortSource}`, prompt: "start" },
				initialController.signal,
			);
			await started;
			initialController.abort(new Error("aborted: initial run"));
			expect(await settleWithin(initialRun)).toBeDefined();

			const resumeController = new AbortController();
			const resume = exec(
				task,
				{ op: "resume", name: `idle-${abortSource}` },
				abortSource === "caller" ? resumeController.signal : undefined,
			);
			await new Promise((resolve) => setTimeout(resolve, 10));
			if (abortSource === "caller") resumeController.abort(new Error("aborted: stop idle wait"));
			else abortCoordinator?.();
			try {
				const result = await settleWithin(resume);
				expect(result).toBeDefined();
				if (result) expect(isErr(result)).toBe(true);
				expect(faux?.state.callCount).toBe(1);
			} finally {
				releaseProvider?.();
				await settleWithin(resume, 1000);
				await waitForNoActiveSlot();
			}
		},
	);

	it("gives up the pre-resume idle wait at a finite deadline and does not start a new prompt", async () => {
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let releaseProvider: (() => void) | undefined;
		const task = buildTask([
			async () => {
				markStarted?.();
				return await new Promise((resolve) => {
					releaseProvider = () => resolve(fauxAssistantMessage("late original output"));
				});
			},
			fauxAssistantMessage("must not start"),
		]);
		const initialController = new AbortController();
		const initialRun = exec(task, { op: "run", name: "idle-deadline", prompt: "start" }, initialController.signal);
		await started;
		initialController.abort(new Error("aborted: initial run"));
		expect(await settleWithin(initialRun)).toBeDefined();

		const resume = exec(task, { op: "resume", name: "idle-deadline" });
		try {
			const result = await settleWithin(resume, 2000);
			expect(result).toBeDefined();
			if (result) {
				expect(isErr(result)).toBe(true);
				expect(textOf(result)).toMatch(/previous run.*idle|idle.*deadline/i);
			}
			expect(faux?.state.callCount).toBe(1);
		} finally {
			releaseProvider?.();
			await settleWithin(resume, 1000);
			await waitForNoActiveSlot();
		}
	});

	it("resume accepts a continuation prompt", async () => {
		const task = buildTask([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "drop" }),
			fauxAssistantMessage("CONTINUED with new instruction"),
			fauxAssistantMessage("FOLLOW-UP AFTER RESUME"),
		]);
		await exec(task, { op: "run", name: "p2", prompt: "start" });
		const resumed = await exec(task, { op: "resume", name: "p2", prompt: "now wrap it up" });
		expect(isErr(resumed)).toBe(false);
		expect(textOf(resumed)).toContain("CONTINUED with new instruction");
		const list = await exec(task, { op: "list" });
		expect(textOf(list).split("\n\nContinuable")[0].split("\n\nResumable")[1] ?? "").not.toContain("- p2");
		expect(textOf(list)).toMatch(/Continuable[\s\S]*p2/);
		const followedUp = await exec(task, { op: "continue", name: "p2", prompt: "one more thing" });
		expect(isErr(followedUp)).toBe(false);
		expect(textOf(followedUp)).toContain("FOLLOW-UP AFTER RESUME");
	});

	it("returns a clear error when resuming an unknown handle", async () => {
		const task = buildTask([fauxAssistantMessage("ok")]);
		const res = await exec(task, { op: "resume", name: "ghost" });
		expect(isErr(res)).toBe(true);
		expect(textOf(res)).toContain("no resumable");
	});

	it("a cleanly-completed op:run is not resumable", async () => {
		const task = buildTask([fauxAssistantMessage("done cleanly")]);
		const ok = await exec(task, { op: "run", name: "clean", prompt: "x" });
		expect(isErr(ok)).toBe(false);
		const res = await exec(task, { op: "resume", name: "clean" });
		expect(isErr(res)).toBe(true);
	});
});
