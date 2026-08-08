/**
 * Failed-worktree cleanup (H20).
 *
 * `createWorktree` used to run `git worktree add` with no failure handling: a
 * timed-out (SIGKILL via PIT_WORKTREE_GIT_TIMEOUT_MS) or otherwise-broken add
 * could leave a partial checkout dir and/or a dangling `.git/worktrees` admin
 * entry that accretes across retries. The fix cleans both, best-effort, without
 * masking the original error.
 *
 * `cleanupPartialWorktree` is exercised directly against real dangling state, and
 * the createWorktree failure path is exercised end-to-end through `spawnSubagent`.
 */

import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentMessage } from "@pit/agent-core";
import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@pit/ai";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { SubagentRegistry } from "../src/core/coordinator/registry.js";
import {
	cleanupPartialWorktree,
	type SpawnSubagentDependencies,
	spawnSubagent,
} from "../src/core/coordinator/spawn.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";

const execFileP = promisify(execFile);
const git = (cwd: string, ...args: string[]) => execFileP("git", args, { cwd });
const gitOut = async (cwd: string, ...args: string[]): Promise<string> => (await git(cwd, ...args)).stdout;

let templateRepo: string | undefined;

async function buildTemplateRepo(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "pit-wtc-template-"));
	await git(dir, "init");
	await git(dir, "config", "user.email", "test@test");
	await git(dir, "config", "user.name", "test");
	await git(dir, "config", "commit.gpgsign", "false");
	writeFileSync(join(dir, "README.md"), "hello");
	await git(dir, "add", ".");
	await git(dir, "commit", "-m", "init");
	return dir;
}

async function initRepo(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "pit-wtc-test-"));
	if (!templateRepo) throw new Error("template repo not initialized");
	cpSync(templateRepo, dir, { recursive: true });
	return dir;
}

beforeAll(async () => {
	templateRepo = await buildTemplateRepo();
});
afterAll(() => {
	if (templateRepo) rmSync(templateRepo, { recursive: true, force: true });
	templateRepo = undefined;
});

function createRig(): { faux: FauxProviderRegistration; deps: SpawnSubagentDependencies; dispose: () => void } {
	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage("done")]);
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	return {
		faux,
		deps: {
			registry: new SubagentRegistry(),
			model,
			modelRegistry,
			availableTools: [],
			convertToLlm: (messages: AgentMessage[]) => convertToLlm(messages),
		},
		dispose: () => faux.unregister(),
	};
}

describe("cleanupPartialWorktree (H20)", () => {
	const repos: string[] = [];
	afterEach(() => {
		while (repos.length > 0) {
			const r = repos.pop();
			if (r) rmSync(r, { recursive: true, force: true });
		}
	});

	it("clears a dangling admin entry left by a crashed worktree (dir already gone)", async () => {
		const repo = await initRepo();
		repos.push(repo);
		const dir = join(repo, ".pit", "worktrees", "crashed-aaaa1111");
		await git(repo, "worktree", "add", "--detach", "--", dir, "HEAD");
		// Simulate a crash after registration: the checkout dir is gone but the
		// `.git/worktrees` admin entry lingers (git reports it as "prunable").
		rmSync(dir, { recursive: true, force: true });
		expect(await gitOut(repo, "worktree", "list")).toContain("crashed-aaaa1111");

		await cleanupPartialWorktree(repo, dir);

		expect(await gitOut(repo, "worktree", "list")).not.toContain("crashed-aaaa1111");
		expect(existsSync(dir)).toBe(false);
	}, 30_000);

	it("removes a fully-present partial worktree (dir + admin entry)", async () => {
		const repo = await initRepo();
		repos.push(repo);
		const dir = join(repo, ".pit", "worktrees", "partial-bbbb2222");
		await git(repo, "worktree", "add", "--detach", "--", dir, "HEAD");
		expect(existsSync(dir)).toBe(true);

		await cleanupPartialWorktree(repo, dir);

		expect(await gitOut(repo, "worktree", "list")).not.toContain("partial-bbbb2222");
		expect(existsSync(dir)).toBe(false);
	}, 30_000);

	it("is a best-effort no-op on a path that was never created", async () => {
		const repo = await initRepo();
		repos.push(repo);
		const dir = join(repo, ".pit", "worktrees", "never-cccc3333");
		// Must not throw even though nothing exists to remove.
		await expect(cleanupPartialWorktree(repo, dir)).resolves.toBeUndefined();
		expect(existsSync(dir)).toBe(false);
	}, 30_000);
});

describe("createWorktree failure cleanup via spawnSubagent (H20)", () => {
	const repos: string[] = [];
	const rigs: Array<{ dispose: () => void }> = [];
	afterEach(() => {
		while (rigs.length > 0) rigs.pop()?.dispose();
		while (repos.length > 0) {
			const r = repos.pop();
			if (r) rmSync(r, { recursive: true, force: true });
		}
	});

	it("re-throws the original git error and leaves no worktree garbage behind", async () => {
		const repo = await initRepo();
		repos.push(repo);
		const rig = createRig();
		rigs.push(rig);

		// A bad branch ref makes `git worktree add` fail deterministically. The
		// ORIGINAL git error must survive the best-effort cleanup (not be masked).
		let thrown: unknown;
		try {
			await spawnSubagent(rig.deps, {
				prompt: "work",
				taskName: "wt-badref",
				cwd: repo,
				worktree: { branch: "this-ref-does-not-exist" },
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toMatch(/worktree setup failed/i);
		expect((thrown as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
		expect((thrown as Error & { cause: Error }).cause.message).toMatch(/this-ref-does-not-exist/i);

		// No partial dir left under .pit/worktrees, and no dangling git entry.
		const worktreeDir = join(repo, ".pit", "worktrees");
		if (existsSync(worktreeDir)) expect(readdirSync(worktreeDir)).toEqual([]);
		const list = (await execFileP("git", ["worktree", "list"], { cwd: repo })).stdout;
		expect(list).not.toContain("wt-badref");
	}, 30_000);
});
