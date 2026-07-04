import { execFile, spawnSync } from "child_process";
import { existsSync, type FSWatcher, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let resolvedBranch = "main";
let diffNumstatStdout = "";
let statusPorcelainStdout = "";

vi.mock("child_process", () => ({
	execFile: vi.fn(
		(
			_command: string,
			args: readonly string[],
			_options: unknown,
			callback: (error: Error | null, stdout: string, stderr: string) => void,
		) => {
			if (args[1] === "symbolic-ref") {
				setTimeout(
					() =>
						callback(
							resolvedBranch ? null : new Error("detached"),
							resolvedBranch ? `${resolvedBranch}\n` : "",
							"",
						),
					0,
				);
				return;
			}
			if (args[1] === "diff" && args[2] === "--numstat") {
				setTimeout(() => callback(null, diffNumstatStdout, ""), 0);
				return;
			}
			if (args[1] === "status" && args[2] === "--porcelain") {
				setTimeout(() => callback(null, statusPorcelainStdout, ""), 0);
				return;
			}
			setTimeout(() => callback(new Error("unsupported"), "", ""), 0);
		},
	),
	spawnSync: vi.fn((_command: string, args: readonly string[]) => {
		if (args[1] === "symbolic-ref") {
			return { status: resolvedBranch ? 0 : 1, stdout: resolvedBranch ? `${resolvedBranch}\n` : "", stderr: "" };
		}
		if (args[1] === "diff" && args[2] === "--numstat") {
			return { status: 0, stdout: diffNumstatStdout, stderr: "" };
		}
		if (args[1] === "status" && args[2] === "--porcelain") {
			return { status: 0, stdout: statusPorcelainStdout, stderr: "" };
		}
		return { status: 1, stdout: "", stderr: "" };
	}),
}));

import {
	FooterDataProvider,
	parseGitDiffNumstat,
	parseGitStatusPorcelainFileCount,
} from "../src/core/footer-data-provider.js";

type WorktreeFixture = {
	worktreeDir: string;
	reftableDir: string;
};

function createPlainReftableRepo(tempDir: string): string {
	const repoDir = join(tempDir, "repo");
	mkdirSync(join(repoDir, ".git", "reftable"), { recursive: true });
	writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/.invalid\n");
	return repoDir;
}

function createPlainRepo(tempDir: string): string {
	const repoDir = join(tempDir, "repo");
	mkdirSync(join(repoDir, ".git"), { recursive: true });
	writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
	return repoDir;
}

function createReftableWorktree(tempDir: string): WorktreeFixture {
	const repoDir = join(tempDir, "repo");
	const commonGitDir = join(repoDir, ".git");
	const gitDir = join(commonGitDir, "worktrees", "src");
	const worktreeDir = join(tempDir, "worktree");
	const reftableDir = join(commonGitDir, "reftable");

	mkdirSync(gitDir, { recursive: true });
	mkdirSync(reftableDir, { recursive: true });
	mkdirSync(worktreeDir, { recursive: true });

	writeFileSync(join(worktreeDir, ".git"), `gitdir: ${gitDir}\n`);
	writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/.invalid\n");
	writeFileSync(join(gitDir, "commondir"), "../..\n");
	writeFileSync(join(reftableDir, "tables.list"), "0\n");

	return { worktreeDir, reftableDir };
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
	const startedAt = Date.now();
	while (!condition()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("FooterDataProvider reftable branch detection", () => {
	let originalCwd: string;
	let tempDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "footer-data-provider-"));
		resolvedBranch = "main";
		diffNumstatStdout = "";
		statusPorcelainStdout = "";
		vi.mocked(spawnSync).mockClear();
		vi.mocked(execFile).mockClear();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses HEAD directly in a regular repo from a nested directory", () => {
		const repoDir = createPlainRepo(tempDir);
		const nestedDir = join(repoDir, "src", "nested");
		mkdirSync(nestedDir, { recursive: true });
		process.chdir(nestedDir);

		const provider = new FooterDataProvider(nestedDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
		} finally {
			provider.dispose();
		}
	});

	it("resolves the branch via git when HEAD is .invalid in a reftable repo", () => {
		const repoDir = createPlainReftableRepo(tempDir);
		process.chdir(repoDir);

		const provider = new FooterDataProvider(repoDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
				"git",
				["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
				expect.objectContaining({
					cwd: expect.stringMatching(/repo$/),
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}),
			);
		} finally {
			provider.dispose();
		}
	});

	it("resolves the branch via git in a reftable-backed worktree", () => {
		const { worktreeDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
		} finally {
			provider.dispose();
		}
	});

	it("treats an unresolved .invalid reftable HEAD as detached", () => {
		const repoDir = createPlainReftableRepo(tempDir);
		process.chdir(repoDir);
		resolvedBranch = "";

		const provider = new FooterDataProvider(repoDir);
		try {
			expect(provider.getGitBranch()).toBe("detached");
		} finally {
			provider.dispose();
		}
	});

	it("does not notify listeners when reftable updates keep the same branch", async () => {
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			vi.mocked(spawnSync).mockClear();
			const onBranchChange = vi.fn();
			provider.onBranchChange(onBranchChange);

			writeFileSync(join(reftableDir, "tables.list"), "1\n");
			await waitFor(() => vi.mocked(execFile).mock.calls.length === 1);

			expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
			expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
			expect(provider.getGitBranch()).toBe("main");
			expect(onBranchChange).not.toHaveBeenCalled();
		} finally {
			provider.dispose();
		}
	});

	it("debounces rapid reftable updates into a single async refresh", async () => {
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			await new Promise((resolve) => setTimeout(resolve, 50));
			vi.mocked(execFile).mockClear();

			writeFileSync(join(reftableDir, "tables.list"), "1\n");
			writeFileSync(join(reftableDir, "tables.list"), "2\n");
			writeFileSync(join(reftableDir, "tables.list"), "3\n");
			await waitFor(() => vi.mocked(execFile).mock.calls.some((call) => call[1]?.[1] === "symbolic-ref"));
			await new Promise((resolve) => setTimeout(resolve, 650));

			const branchCalls = vi.mocked(execFile).mock.calls.filter((call) => call[1]?.[1] === "symbolic-ref");
			expect(branchCalls.length).toBe(1);
		} finally {
			provider.dispose();
		}
	});

	it("updates the cached branch when the reftable directory changes", async () => {
		const { worktreeDir, reftableDir } = createReftableWorktree(tempDir);
		process.chdir(worktreeDir);

		const provider = new FooterDataProvider(worktreeDir);
		try {
			expect(provider.getGitBranch()).toBe("main");
			resolvedBranch = "foo";
			const onBranchChange = vi.fn();
			provider.onBranchChange(onBranchChange);
			await new Promise((resolve) => setTimeout(resolve, 50));
			vi.mocked(execFile).mockClear();

			writeFileSync(join(reftableDir, "tables.list"), "1\n");
			await waitFor(() => vi.mocked(execFile).mock.calls.some((call) => call[1]?.[1] === "symbolic-ref"));
			await waitFor(() => provider.getGitBranch() === "foo");

			const branchCalls = vi.mocked(execFile).mock.calls.filter((call) => call[1]?.[1] === "symbolic-ref");
			expect(branchCalls.length).toBe(1);
			expect(provider.getGitBranch()).toBe("foo");
			expect(onBranchChange).toHaveBeenCalledTimes(1);
		} finally {
			provider.dispose();
		}
	});

	it("retries git watchers 5 seconds after an async fs.watch error", async () => {
		vi.useFakeTimers();
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);

		const provider = new FooterDataProvider(repoDir);
		try {
			const providerWithInternals = provider as unknown as {
				headWatcher: FSWatcher | null;
			};
			const originalWatcher = providerWithInternals.headWatcher;
			expect(originalWatcher).not.toBeNull();
			expect(originalWatcher?.listenerCount("error")).toBeGreaterThan(0);

			originalWatcher?.emit("error", new Error("simulated EMFILE"));
			expect(providerWithInternals.headWatcher).toBeNull();

			await vi.advanceTimersByTimeAsync(4999);
			expect(providerWithInternals.headWatcher).toBeNull();

			await vi.advanceTimersByTimeAsync(1);
			expect(providerWithInternals.headWatcher).not.toBeNull();
			expect(providerWithInternals.headWatcher).not.toBe(originalWatcher);
		} finally {
			provider.dispose();
			vi.useRealTimers();
		}
	});
});

describe("git diff stat parsing", () => {
	it("parseGitDiffNumstat sums add/del and skips binary lines", () => {
		const stdout = "12\t3\tfile.ts\n-\t-\tbinary.png\n5\t0\tother.ts\n";
		expect(parseGitDiffNumstat(stdout)).toEqual({ insertions: 17, deletions: 3 });
	});

	it("parseGitStatusPorcelainFileCount counts non-empty lines", () => {
		const stdout = " M file.ts\n?? new.ts\n\n";
		expect(parseGitStatusPorcelainFileCount(stdout)).toBe(2);
	});
});

describe("FooterDataProvider working-tree diff stats", () => {
	let originalCwd: string;
	let tempDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "footer-data-provider-diff-"));
		resolvedBranch = "main";
		diffNumstatStdout = "12\t3\tfile.ts\n";
		statusPorcelainStdout = " M file.ts\n";
		vi.mocked(spawnSync).mockClear();
		vi.mocked(execFile).mockClear();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("returns null outside a git repo", () => {
		const outsideDir = join(tempDir, "outside");
		mkdirSync(outsideDir, { recursive: true });
		const provider = new FooterDataProvider(outsideDir);
		try {
			expect(provider.getGitDiffStats()).toBeNull();
		} finally {
			provider.dispose();
		}
	});

	it("returns null on first synchronous read and resolves once the async refresh lands", async () => {
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);
		const provider = new FooterDataProvider(repoDir);
		try {
			// First read must never block on a sync git spawn — the async refresh
			// kicked off by the constructor hasn't resolved yet in the same tick.
			expect(provider.getGitDiffStats()).toBeNull();
			expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
			await waitFor(() => provider.getGitDiffStats() !== null);
			expect(provider.getGitDiffStats()).toEqual({ files: 1, insertions: 12, deletions: 3 });
		} finally {
			provider.dispose();
		}
	});

	it("nudges the async refresh instead of spawning sync git when read again before it resolves", async () => {
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);
		const provider = new FooterDataProvider(repoDir);
		try {
			// Reading it repeatedly before the constructor's async refresh resolves
			// must not spawn additional git processes (coalesces via diffRefreshInFlight).
			expect(provider.getGitDiffStats()).toBeNull();
			expect(provider.getGitDiffStats()).toBeNull();
			expect(provider.getGitDiffStats()).toBeNull();
			expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
			await waitFor(() => provider.getGitDiffStats() !== null);
			expect(provider.getGitDiffStats()).toEqual({ files: 1, insertions: 12, deletions: 3 });
		} finally {
			provider.dispose();
		}
	});

	it("notifies onWorkingTreeChange when async refresh detects a change", async () => {
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);
		const provider = new FooterDataProvider(repoDir);
		try {
			await waitFor(() => provider.getGitDiffStats() !== null);
			expect(provider.getGitDiffStats()).toEqual({ files: 1, insertions: 12, deletions: 3 });
			const onChange = vi.fn();
			provider.onWorkingTreeChange(onChange);
			diffNumstatStdout = "20\t1\tfile.ts\n";
			statusPorcelainStdout = " M file.ts\n?? extra.ts\n";
			provider.scheduleWorkingTreeRefresh();
			await waitFor(() => onChange.mock.calls.length === 1);
			expect(provider.getGitDiffStats()).toEqual({ files: 2, insertions: 20, deletions: 1 });
			expect(provider.getGitDiffVersion()).toBeGreaterThan(0);
		} finally {
			provider.dispose();
		}
	});

	it("debounces rapid scheduleWorkingTreeRefresh calls", async () => {
		const repoDir = createPlainRepo(tempDir);
		process.chdir(repoDir);
		const provider = new FooterDataProvider(repoDir);
		try {
			await new Promise((resolve) => setTimeout(resolve, 50));
			vi.mocked(execFile).mockClear();
			const onChange = vi.fn();
			provider.onWorkingTreeChange(onChange);
			diffNumstatStdout = "1\t0\ta.ts\n";
			provider.scheduleWorkingTreeRefresh();
			provider.scheduleWorkingTreeRefresh();
			provider.scheduleWorkingTreeRefresh();
			await waitFor(() => vi.mocked(execFile).mock.calls.some((call) => call[1]?.[1] === "diff"));
			await new Promise((resolve) => setTimeout(resolve, 650));
			const diffCalls = vi.mocked(execFile).mock.calls.filter((call) => call[1]?.[1] === "diff");
			expect(diffCalls.length).toBe(1);
		} finally {
			provider.dispose();
		}
	});
});

describe("FooterDataProvider adaptive diff poll backoff", () => {
	let originalCwd: string;
	let tempDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "footer-data-provider-poll-"));
		resolvedBranch = "main";
		diffNumstatStdout = "12\t3\tfile.ts\n";
		statusPorcelainStdout = " M file.ts\n";
		vi.mocked(spawnSync).mockClear();
		vi.mocked(execFile).mockClear();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("doubles the poll interval after 3 consecutive no-change polls, and again after 3 more", async () => {
		vi.useFakeTimers();
		try {
			const repoDir = createPlainRepo(tempDir);
			process.chdir(repoDir);
			const provider = new FooterDataProvider(repoDir);
			const internals = provider as unknown as { diffPollIntervalMs: number };
			try {
				// Let the constructor's initial async refresh settle before the poll chain starts.
				await vi.advanceTimersByTimeAsync(10);
				expect(internals.diffPollIntervalMs).toBe(5000);

				// 3 consecutive polls with unchanged stats double the interval once (5s -> 10s).
				// +50ms buffer per advance avoids exact-boundary flakiness in the fake-timer clock.
				for (let i = 0; i < 3; i++) {
					await vi.advanceTimersByTimeAsync(internals.diffPollIntervalMs + 50);
				}
				expect(internals.diffPollIntervalMs).toBe(10000);

				// Another 3 quiet polls (now at the doubled cadence) double it again (10s -> 20s).
				for (let i = 0; i < 3; i++) {
					await vi.advanceTimersByTimeAsync(internals.diffPollIntervalMs + 50);
				}
				expect(internals.diffPollIntervalMs).toBe(20000);
			} finally {
				provider.dispose();
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("resets the poll interval to the base cadence when scheduleWorkingTreeRefresh is called", async () => {
		vi.useFakeTimers();
		try {
			const repoDir = createPlainRepo(tempDir);
			process.chdir(repoDir);
			const provider = new FooterDataProvider(repoDir);
			const internals = provider as unknown as { diffPollIntervalMs: number };
			try {
				await vi.advanceTimersByTimeAsync(10);
				for (let i = 0; i < 3; i++) {
					await vi.advanceTimersByTimeAsync(internals.diffPollIntervalMs);
				}
				expect(internals.diffPollIntervalMs).toBe(10000);

				// A tool-triggered refresh means the working tree may be active again —
				// the cadence snaps back to the base interval synchronously.
				provider.scheduleWorkingTreeRefresh();
				expect(internals.diffPollIntervalMs).toBe(5000);
			} finally {
				provider.dispose();
			}
		} finally {
			vi.useRealTimers();
		}
	});

	it("resets the poll interval once a poll actually observes a change", async () => {
		vi.useFakeTimers();
		try {
			const repoDir = createPlainRepo(tempDir);
			process.chdir(repoDir);
			const provider = new FooterDataProvider(repoDir);
			const internals = provider as unknown as { diffPollIntervalMs: number };
			try {
				await vi.advanceTimersByTimeAsync(10);
				for (let i = 0; i < 3; i++) {
					await vi.advanceTimersByTimeAsync(internals.diffPollIntervalMs);
				}
				expect(internals.diffPollIntervalMs).toBe(10000);

				// The working tree changes right before the next poll fires.
				diffNumstatStdout = "99\t1\tfile.ts\n";
				statusPorcelainStdout = " M file.ts\n?? extra.ts\n";
				await vi.advanceTimersByTimeAsync(internals.diffPollIntervalMs);
				expect(internals.diffPollIntervalMs).toBe(5000);
			} finally {
				provider.dispose();
			}
		} finally {
			vi.useRealTimers();
		}
	});
});
