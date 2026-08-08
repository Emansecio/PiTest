/**
 * Resume Tier 2 — persistence across a Pit restart.
 *
 * When a subagent is interrupted, its transcript + spawn context are written to
 * `<cwd>/.pit/subagents/<handle>.json`. A brand-new coordinator (fresh in-memory
 * state, same cwd — i.e. the process was restarted) must be able to op:"resume"
 * that handle by reading the file, and the file is removed on success.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@pit/agent-core";
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	registerFauxProvider,
} from "@pit/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createCoordinatorExtension } from "../src/core/built-ins/coordinator-extension.js";
import { loadResumeState, resumeStateStem, saveResumeState } from "../src/core/coordinator/resume-store.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";

describe("coordinator op:resume from disk (Tier 2)", () => {
	const fauxes: FauxProviderRegistration[] = [];
	let root: string | undefined;
	let abortCoordinator: (() => void) | undefined;
	afterEach(() => {
		abortCoordinator?.();
		abortCoordinator = undefined;
		for (const f of fauxes.splice(0)) f.unregister();
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	// A coordinator bound to `root` as cwd, with its OWN in-memory state — calling
	// this twice models two separate Pit processes sharing a working directory.
	function freshCoordinator(
		cwd: string,
		responses: Parameters<FauxProviderRegistration["setResponses"]>[0],
		retargetToolsForCwd?: (
			tools: import("@pit/agent-core").AgentTool[],
			cwd: string,
		) => import("@pit/agent-core").AgentTool[],
		configureRegistry?: (registry: ModelRegistry, model: Model<any>) => void,
		getSelectableModels?: (parent: Model<any>) => readonly Model<any>[],
		availableTools: AgentTool[] = [],
	) {
		const faux = registerFauxProvider();
		fauxes.push(faux);
		faux.setResponses(responses);
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		configureRegistry?.(modelRegistry, model);
		const ext = createCoordinatorExtension({
			modelRegistry,
			getParentModel: () => model,
			getSelectableModels: () => getSelectableModels?.(model) ?? [model],
			getAvailableTools: () => availableTools,
			retargetToolsForCwd,
			convertToLlm: (messages) => convertToLlm(messages),
			getCwd: () => cwd,
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

	function registerModels(registry: ModelRegistry, template: Model<any>, provider: string, ids: string[]): void {
		registry.authStorage.setRuntimeApiKey(provider, "faux-key");
		registry.registerProvider(provider, {
			apiKey: "faux-key",
			api: template.api,
			baseUrl: template.baseUrl,
			models: ids.map((id) => ({
				id,
				name: id,
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 16384,
			})),
		});
	}

	it("persists an interrupted run and resumes it in a fresh coordinator, then cleans up", async () => {
		root = mkdtempSync(join(tmpdir(), "pit-rd-"));
		const stateFile = join(root, ".pit", "subagents", `${resumeStateStem("probe")}.json`);

		// Process #1: run is interrupted (network drop) → persisted to disk.
		const task1 = freshCoordinator(root, [fauxAssistantMessage("", { stopReason: "error", errorMessage: "drop" })]);
		const r1 = await exec(task1, { op: "run", name: "probe", prompt: "do the thing" });
		expect(isErr(r1)).toBe(true);
		expect(existsSync(stateFile)).toBe(true); // op:run awaits the save → durable the moment it returns
		const persisted = await loadResumeState(root, "probe");
		expect(persisted?.modelProvider).toBeDefined();
		expect(persisted?.modelId).toBeDefined();

		// Process #2: brand-new coordinator (empty in-memory map), same cwd.
		const task2 = freshCoordinator(root, [
			fauxAssistantMessage("RESUMED FROM DISK"),
			fauxAssistantMessage("FOLLOW-UP AFTER DISK RESUME"),
		]);
		const list = await exec(task2, { op: "list" });
		expect(textOf(list)).toMatch(/[Rr]esumable[\s\S]*probe/);

		const r2 = await exec(task2, { op: "resume", name: "probe" });
		expect(isErr(r2)).toBe(false);
		expect(textOf(r2)).toContain("RESUMED FROM DISK");

		// File removed after a successful resume.
		expect(existsSync(stateFile)).toBe(false);
		const listAfterResume = await exec(task2, { op: "list" });
		expect(textOf(listAfterResume)).not.toMatch(/Resumable[\s\S]*probe/);
		expect(textOf(listAfterResume)).toMatch(/Continuable[\s\S]*probe/);
		const followedUp = await exec(task2, { op: "continue", name: "probe", prompt: "one more thing" });
		expect(isErr(followedUp)).toBe(false);
		expect(textOf(followedUp)).toContain("FOLLOW-UP AFTER DISK RESUME");
	});

	it("a disk resume that ENDS ON AN ERROR TURN keeps the state file and reports failure (still resumable)", async () => {
		// Regression for finding #3: resumeFromDisk used to delete the persisted
		// transcript unconditionally and return isError:false, even when the resumed
		// run ended on a stopReason:"error" turn WITHOUT throwing (a fresh network
		// drop). That destroyed the only resumable transcript and lied about success.
		root = mkdtempSync(join(tmpdir(), "pit-rd-"));
		const stateFile = join(root, ".pit", "subagents", `${resumeStateStem("probe")}.json`);

		// Process #1: interrupted run → persisted to disk.
		const task1 = freshCoordinator(root, [fauxAssistantMessage("", { stopReason: "error", errorMessage: "drop" })]);
		const r1 = await exec(task1, { op: "run", name: "probe", prompt: "do the thing" });
		expect(isErr(r1)).toBe(true);
		expect(existsSync(stateFile)).toBe(true);

		// Process #2: brand-new coordinator, same cwd. The resumed run drops AGAIN
		// (ends on an error turn without throwing).
		const task2 = freshCoordinator(root, [
			fauxAssistantMessage("partial progress", { stopReason: "error", errorMessage: "drop again" }),
		]);
		const r2 = await exec(task2, { op: "resume", name: "probe" });

		// Reports failure, not a false success.
		expect(isErr(r2)).toBe(true);
		expect(textOf(r2)).toMatch(/did not complete|remains resumable/i);
		// The state file is PRESERVED so another resume is possible.
		expect(existsSync(stateFile)).toBe(true);

		// Process #3: a fresh coordinator can still resume the same handle — and on a
		// clean turn it completes and removes the file.
		const task3 = freshCoordinator(root, [fauxAssistantMessage("FINALLY DONE")]);
		const r3 = await exec(task3, { op: "resume", name: "probe" });
		expect(isErr(r3)).toBe(false);
		expect(textOf(r3)).toContain("FINALLY DONE");
		expect(existsSync(stateFile)).toBe(false);
	});

	it("persists the effective parent model after fallback and resumes on it after restart", async () => {
		root = mkdtempSync(join(tmpdir(), "pit-rd-"));
		const task1 = freshCoordinator(
			root,
			[
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "No API key found for requested child" }),
				fauxAssistantMessage("fallback partial", {
					stopReason: "aborted",
					errorMessage: "aborted: interrupt after fallback",
				}),
			],
			undefined,
			(registry, model) => registerModels(registry, model, model.provider, [model.id, "requested-child"]),
		);

		const interrupted = await exec(task1, {
			op: "run",
			name: "fallback-resume",
			prompt: "work",
			model: "faux/requested-child",
		});
		expect(isErr(interrupted)).toBe(true);
		const persisted = await loadResumeState(root, "fallback-resume");
		expect(persisted?.modelProvider).toBe("faux");
		expect(persisted?.modelId).toBe("faux-1");

		const task2 = freshCoordinator(root, [
			(_context, _options, _state, requestModel) => {
				expect(requestModel.provider).toBe("faux");
				expect(requestModel.id).toBe("faux-1");
				return fauxAssistantMessage("resumed on working parent");
			},
		]);
		const resumed = await exec(task2, { op: "resume", name: "fallback-resume" });
		expect(isErr(resumed)).toBe(false);
		expect(textOf(resumed)).toContain("resumed on working parent");
	});

	it("reconstructs an SDK-scoped model absent from the registry after restart", async () => {
		root = mkdtempSync(join(tmpdir(), "pit-rd-"));
		const scopedProvider = registerFauxProvider({
			provider: "sdk-scoped-resume",
			models: [{ id: "sdk-only-model" }],
		});
		fauxes.push(scopedProvider);
		const scopedModel = scopedProvider.getModel();
		await saveResumeState(root, {
			handle: "sdk-scoped",
			messages: [{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() }] as never,
			modelProvider: scopedModel.provider,
			modelId: scopedModel.id,
			cwd: root,
			depth: 1,
			savedAt: Date.now(),
		});
		let receivedModel: Model<any> | undefined;
		scopedProvider.setResponses([
			(_context, _options, _state, model) => {
				receivedModel = model;
				return fauxAssistantMessage("SDK scoped resume complete");
			},
		]);
		const task = freshCoordinator(
			root,
			[],
			undefined,
			(registry) => registry.authStorage.setRuntimeApiKey(scopedModel.provider, "scoped-key"),
			(parent) => [scopedModel, parent],
		);

		const resumed = await exec(task, { op: "resume", name: "sdk-scoped" });

		expect(isErr(resumed)).toBe(false);
		expect(textOf(resumed)).toContain("SDK scoped resume complete");
		expect(receivedModel).toBe(scopedModel);
	});

	it("persists a resumable checkpoint after each turn while the detached run remains active", async () => {
		root = mkdtempSync(join(tmpdir(), "pit-rd-"));
		let markSecondTurnStarted: (() => void) | undefined;
		const secondTurnStarted = new Promise<void>((resolve) => {
			markSecondTurnStarted = resolve;
		});
		let releaseSecondTurn: (() => void) | undefined;
		const secondTurnRelease = new Promise<void>((resolve) => {
			releaseSecondTurn = resolve;
		});
		const readTool: AgentTool = {
			name: "read",
			label: "read",
			description: "read",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "observed" }], details: {} }),
		};
		const task = freshCoordinator(
			root,
			[
				fauxAssistantMessage([fauxToolCall("read", {})], { stopReason: "toolUse" }),
				async () => {
					markSecondTurnStarted?.();
					await secondTurnRelease;
					return fauxAssistantMessage("finished after checkpoint");
				},
			],
			undefined,
			undefined,
			undefined,
			[readTool],
		);
		await exec(task, { op: "spawn", name: "turn-checkpoint", prompt: "inspect" });

		try {
			await secondTurnStarted;
			let checkpoint = await loadResumeState(root, "turn-checkpoint");
			for (let attempt = 0; !checkpoint && attempt < 20; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				checkpoint = await loadResumeState(root, "turn-checkpoint");
			}
			expect(checkpoint).toBeDefined();
			expect(checkpoint?.messages.some((message) => message.role === "toolResult")).toBe(true);
			const poll = await exec(task, { op: "poll", handles: ["turn-checkpoint"] });
			expect(textOf(poll)).toContain("turn-checkpoint: running");
		} finally {
			releaseSecondTurn?.();
			await exec(task, { op: "join", handles: ["turn-checkpoint"] });
		}
		expect(await loadResumeState(root, "turn-checkpoint")).toBeUndefined();
	});

	it("caller abort stops a disk resume promptly and keeps it resumable", async () => {
		root = mkdtempSync(join(tmpdir(), "pit-rd-"));
		await saveResumeState(root, {
			handle: "disk-abort",
			messages: [{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() }] as never,
			cwd: root,
			depth: 1,
			savedAt: Date.now(),
		});
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const task = freshCoordinator(root, [
			async (_context, options) => {
				markStarted?.();
				return await new Promise((resolve) => {
					const finish = () => resolve(fauxAssistantMessage("late disk output"));
					if (options?.signal?.aborted) finish();
					else options?.signal?.addEventListener("abort", finish, { once: true });
				});
			},
		]);
		const controller = new AbortController();
		const resume = exec(task, { op: "resume", name: "disk-abort" }, controller.signal);
		await started;
		controller.abort(new Error("aborted: caller interrupted disk resume"));
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await Promise.race([
				resume,
				new Promise<undefined>((resolve) => {
					timer = setTimeout(() => resolve(undefined), 500);
				}),
			]);
			expect(result).toBeDefined();
			if (result) expect(isErr(result)).toBe(true);
			expect(await loadResumeState(root, "disk-abort")).toBeDefined();
		} finally {
			if (timer) clearTimeout(timer);
			abortCoordinator?.();
			await Promise.race([resume, new Promise((resolve) => setTimeout(resolve, 500))]);
		}
	});

	it("resumes a synthesized custom model on its persisted provider", async () => {
		root = mkdtempSync(join(tmpdir(), "pit-rd-"));
		await saveResumeState(root, {
			handle: "custom-model",
			messages: [{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() }] as never,
			modelProvider: "faux",
			modelId: "vendor/custom-model",
			thinkingLevel: "high",
			cwd: root,
			depth: 1,
			savedAt: Date.now(),
		});
		const task = freshCoordinator(
			root,
			[
				(_context, _options, _state, requestModel) => {
					expect(requestModel.provider).toBe("faux");
					expect(requestModel.id).toBe("vendor/custom-model");
					return fauxAssistantMessage("CUSTOM MODEL RESUMED");
				},
			],
			undefined,
			(registry, model) => registerModels(registry, model, "faux", ["seed-model"]),
		);

		const result = await exec(task, { op: "resume", name: "custom-model" });
		expect(isErr(result)).toBe(false);
		expect(textOf(result)).toContain("CUSTOM MODEL RESUMED");
	});

	it("uses persisted provider to disambiguate duplicate ids and rejects ambiguous legacy id-only state", async () => {
		root = mkdtempSync(join(tmpdir(), "pit-rd-"));
		const seedMessage = [
			{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() },
		] as never;
		await saveResumeState(root, {
			handle: "canonical-duplicate",
			messages: seedMessage,
			modelProvider: "chosen-provider",
			modelId: "shared-model",
			cwd: root,
			depth: 1,
			savedAt: Date.now(),
		});
		await saveResumeState(root, {
			handle: "legacy-duplicate",
			messages: seedMessage,
			modelId: "shared-model",
			cwd: root,
			depth: 1,
			savedAt: Date.now(),
		});
		const task = freshCoordinator(
			root,
			[
				(_context, _options, _state, requestModel) => {
					expect(requestModel.provider).toBe("chosen-provider");
					expect(requestModel.id).toBe("shared-model");
					return fauxAssistantMessage("RIGHT PROVIDER");
				},
			],
			undefined,
			(registry, model) => {
				registerModels(registry, model, "chosen-provider", ["shared-model"]);
				registerModels(registry, model, "other-provider", ["shared-model"]);
			},
		);

		const canonical = await exec(task, { op: "resume", name: "canonical-duplicate" });
		expect(isErr(canonical)).toBe(false);
		expect(textOf(canonical)).toContain("RIGHT PROVIDER");

		const ambiguousLegacy = await exec(task, { op: "resume", name: "legacy-duplicate" });
		expect(isErr(ambiguousLegacy)).toBe(true);
		expect(textOf(ambiguousLegacy)).toMatch(/legacy saved model id.*ambiguous across providers/i);
	});

	it("keeps legacy id-only resume files working when the model id is unambiguous", async () => {
		root = mkdtempSync(join(tmpdir(), "pit-rd-"));
		await saveResumeState(root, {
			handle: "legacy-unique",
			messages: [{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() }] as never,
			modelId: "legacy-unique-model",
			cwd: root,
			depth: 1,
			savedAt: Date.now(),
		});
		const task = freshCoordinator(
			root,
			[
				(_context, _options, _state, requestModel) => {
					expect(requestModel.provider).toBe("legacy-provider");
					return fauxAssistantMessage("LEGACY RESUMED");
				},
			],
			undefined,
			(registry, model) => registerModels(registry, model, "legacy-provider", ["legacy-unique-model"]),
		);

		const result = await exec(task, { op: "resume", name: "legacy-unique" });
		expect(isErr(result)).toBe(false);
		expect(textOf(result)).toContain("LEGACY RESUMED");
	});

	it("upgrades a legacy id-only state when a resolved resume is persisted again", async () => {
		root = mkdtempSync(join(tmpdir(), "pit-rd-"));
		await saveResumeState(root, {
			handle: "legacy-upgrade",
			messages: [{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() }] as never,
			modelId: "legacy-upgrade-model",
			cwd: root,
			depth: 1,
			savedAt: Date.now(),
		});
		const task = freshCoordinator(
			root,
			[fauxAssistantMessage("partial", { stopReason: "aborted", errorMessage: "interrupted again" })],
			undefined,
			(registry, model) => registerModels(registry, model, "resolved-provider", ["legacy-upgrade-model"]),
		);

		const result = await exec(task, { op: "resume", name: "legacy-upgrade" });
		expect(isErr(result)).toBe(true);
		const upgraded = await loadResumeState(root, "legacy-upgrade");
		expect(upgraded?.modelProvider).toBe("resolved-provider");
		expect(upgraded?.modelId).toBe("legacy-upgrade-model");
	});

	it("rebinds a kept-worktree Tier-2 resume to its persisted isolated cwd", async () => {
		root = mkdtempSync(join(tmpdir(), "pit-rd-"));
		const keptWorktree = join(root, ".pit", "worktrees", "kept-probe");
		mkdirSync(keptWorktree, { recursive: true });
		await saveResumeState(root, {
			handle: "kept-probe",
			messages: [{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() }] as never,
			cwd: keptWorktree,
			depth: 1,
			savedAt: Date.now(),
		});
		let reboundCwd: string | undefined;
		const task = freshCoordinator(root, [fauxAssistantMessage("DONE IN KEPT TREE")], (tools, cwd) => {
			reboundCwd = cwd;
			return tools;
		});
		const result = await exec(task, { op: "resume", name: "kept-probe" });
		expect(isErr(result)).toBe(false);
		expect(reboundCwd).toBe(keptWorktree);
		expect(textOf(result)).toContain("DONE IN KEPT TREE");
	});

	it("errors clearly when neither memory nor disk has the handle", async () => {
		root = mkdtempSync(join(tmpdir(), "pit-rd-"));
		const task = freshCoordinator(root, [fauxAssistantMessage("x")]);
		const res = await exec(task, { op: "resume", name: "ghost" });
		expect(isErr(res)).toBe(true);
		expect(textOf(res)).toContain("no resumable");
	});
});
