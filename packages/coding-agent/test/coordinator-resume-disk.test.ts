/**
 * Resume Tier 2 — persistence across a Pit restart.
 *
 * When a subagent is interrupted, its transcript + spawn context are written to
 * `<cwd>/.pit/subagents/<handle>.json`. A brand-new coordinator (fresh in-memory
 * state, same cwd — i.e. the process was restarted) must be able to op:"resume"
 * that handle by reading the file, and the file is removed on success.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createCoordinatorExtension } from "../src/core/built-ins/coordinator-extension.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";

describe("coordinator op:resume from disk (Tier 2)", () => {
	const fauxes: FauxProviderRegistration[] = [];
	let root: string | undefined;
	afterEach(() => {
		for (const f of fauxes.splice(0)) f.unregister();
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	// A coordinator bound to `root` as cwd, with its OWN in-memory state — calling
	// this twice models two separate Pit processes sharing a working directory.
	function freshCoordinator(cwd: string, responses: Parameters<FauxProviderRegistration["setResponses"]>[0]) {
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
			getAvailableTools: () => [],
			convertToLlm: (messages) => convertToLlm(messages),
			getCwd: () => cwd,
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
		task.execute("call", params, undefined, undefined, {});
	const textOf = (r: unknown): string => (r as { content: { text: string }[] }).content[0].text;
	const isErr = (r: unknown): boolean => (r as { isError: boolean }).isError;

	it("persists an interrupted run and resumes it in a fresh coordinator, then cleans up", async () => {
		root = mkdtempSync(join(tmpdir(), "pit-rd-"));
		const stateFile = join(root, ".pit", "subagents", "probe.json");

		// Process #1: run is interrupted (network drop) → persisted to disk.
		const task1 = freshCoordinator(root, [fauxAssistantMessage("", { stopReason: "error", errorMessage: "drop" })]);
		const r1 = await exec(task1, { op: "run", name: "probe", prompt: "do the thing" });
		expect(isErr(r1)).toBe(true);
		expect(existsSync(stateFile)).toBe(true); // op:run awaits the save → durable the moment it returns

		// Process #2: brand-new coordinator (empty in-memory map), same cwd.
		const task2 = freshCoordinator(root, [fauxAssistantMessage("RESUMED FROM DISK")]);
		const list = await exec(task2, { op: "list" });
		expect(textOf(list)).toMatch(/[Rr]esumable[\s\S]*probe/);

		const r2 = await exec(task2, { op: "resume", name: "probe" });
		expect(isErr(r2)).toBe(false);
		expect(textOf(r2)).toContain("RESUMED FROM DISK");

		// File removed after a successful resume.
		expect(existsSync(stateFile)).toBe(false);
	});

	it("errors clearly when neither memory nor disk has the handle", async () => {
		root = mkdtempSync(join(tmpdir(), "pit-rd-"));
		const task = freshCoordinator(root, [fauxAssistantMessage("x")]);
		const res = await exec(task, { op: "resume", name: "ghost" });
		expect(isErr(res)).toBe(true);
		expect(textOf(res)).toContain("no resumable");
	});
});
