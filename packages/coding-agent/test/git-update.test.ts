/**
 * Tests for git-based extension sources under local-only mode.
 *
 * Background: package management was deliberately moved to a local-only model
 * (see DefaultPackageManager: `update()` is a no-op and git: sources are never
 * fetched/cloned/reset). External npm:/git: packages are no longer installed or
 * updated over the network. The package manager only *resolves* resources from
 * any pre-existing on-disk checkout.
 *
 * These tests verify that current contract:
 * - `update()` never reaches out to git: it does not fetch, does not modify an
 *   existing installed checkout, and does not create scope directories.
 * - `resolveExtensionSources()` for a git: source runs no git command and only
 *   reads resources already present on disk.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

// Helper to run git commands in a directory
function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
	});
	if (result.status !== 0) {
		throw new Error(`Command failed: git ${args.join(" ")}\n${result.stderr}`);
	}
	return result.stdout.trim();
}

function initGitRepo(repoDir: string): void {
	git(["init", "--initial-branch=main"], repoDir);
	git(["config", "--local", "user.email", "test@test.com"], repoDir);
	git(["config", "--local", "user.name", "Test"], repoDir);
}

// Helper to create a commit with a file
function createCommit(repoDir: string, filename: string, content: string, message: string): string {
	writeFileSync(join(repoDir, filename), content);
	git(["add", filename], repoDir);
	git(["commit", "-m", message], repoDir);
	return git(["rev-parse", "HEAD"], repoDir);
}

// Helper to get current commit hash
function getCurrentCommit(repoDir: string): string {
	return git(["rev-parse", "HEAD"], repoDir);
}

// Helper to get file content
function getFileContent(repoDir: string, filename: string): string {
	return readFileSync(join(repoDir, filename), "utf-8");
}

describe("DefaultPackageManager git sources (local-only mode)", () => {
	let tempDir: string;
	let remoteDir: string; // Simulates the "remote" repository
	let agentDir: string; // The agent directory where extensions are installed
	let installedDir: string; // The installed extension directory
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;

	// Git source that maps to our installed directory structure.
	// Must use "git:" prefix so parseSource() treats it as a git source
	// (bare "github.com/..." is not recognized as a git URL).
	const gitSource = "git:github.com/test/extension";

	beforeEach(() => {
		tempDir = join(tmpdir(), `git-update-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		remoteDir = join(tempDir, "remote");
		agentDir = join(tempDir, "agent");

		// This matches the path structure: agentDir/git/<host>/<path>
		installedDir = join(agentDir, "git", "github.com", "test", "extension");

		mkdirSync(agentDir, { recursive: true });

		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	/**
	 * Sets up a "remote" repository and clones it to the installed directory.
	 * This simulates a checkout that exists on disk from a previous install.
	 * @param sourceOverride Optional source string to use instead of gitSource (e.g., with @ref for pinned tests)
	 */
	function setupRemoteAndInstall(sourceOverride?: string): void {
		// Create "remote" repository
		mkdirSync(remoteDir, { recursive: true });
		initGitRepo(remoteDir);
		createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");

		// Clone to installed directory (simulating a prior install)
		mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
		git(["clone", remoteDir, installedDir], tempDir);
		git(["config", "--local", "user.email", "test@test.com"], installedDir);
		git(["config", "--local", "user.name", "Test"], installedDir);

		// Add to global packages so update() processes this source
		settingsManager.setPackages([sourceOverride ?? gitSource]);
	}

	describe("update() is a no-op for git sources", () => {
		it("does not run git or modify the checkout when already up to date", async () => {
			setupRemoteAndInstall();
			const before = getCurrentCommit(installedDir);

			// Spy on any internal command runners so we can assert none are invoked.
			// In local-only mode the seams may not even exist, so we install them
			// defensively and verify they are never called.
			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand?: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
				runCommandCapture?: (command: string, args: string[], options?: { cwd?: string }) => Promise<string>;
			};
			managerWithInternals.runCommand = async (command, args) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
			};
			managerWithInternals.runCommandCapture = async (command, args) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
				return "";
			};

			await packageManager.update();

			// No git command ran, and the checkout is untouched.
			expect(executedCommands.filter((c) => c.startsWith("git "))).toEqual([]);
			expect(getCurrentCommit(installedDir)).toBe(before);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");
		});

		it("does not pull new remote commits into the installed checkout", async () => {
			setupRemoteAndInstall();
			const installedCommit = getCurrentCommit(installedDir);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");

			// Remote advances, but local-only update must not pull it.
			createCommit(remoteDir, "extension.ts", "// v2", "Second commit");

			await packageManager.update();

			// Checkout stays exactly where it was installed.
			expect(getCurrentCommit(installedDir)).toBe(installedCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");
		});

		it("does not advance past multiple remote commits", async () => {
			setupRemoteAndInstall();
			const installedCommit = getCurrentCommit(installedDir);

			createCommit(remoteDir, "extension.ts", "// v2", "Second commit");
			createCommit(remoteDir, "extension.ts", "// v3", "Third commit");
			createCommit(remoteDir, "extension.ts", "// v4", "Fourth commit");

			await packageManager.update();

			expect(getCurrentCommit(installedDir)).toBe(installedCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");
		});

		it("leaves a detached checkout (no upstream) untouched", async () => {
			setupRemoteAndInstall();
			createCommit(remoteDir, "extension.ts", "// v2", "Second commit");
			createCommit(remoteDir, "extension.ts", "// v3", "Third commit");

			const detachedCommit = getCurrentCommit(installedDir);
			git(["checkout", detachedCommit], installedDir);

			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand?: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
				runCommandCapture?: (command: string, args: string[], options?: { cwd?: string }) => Promise<string>;
			};
			managerWithInternals.runCommand = async (command, args) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
			};
			managerWithInternals.runCommandCapture = async (command, args) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
				return "";
			};

			await packageManager.update();

			expect(executedCommands.filter((c) => c.startsWith("git "))).toEqual([]);
			expect(getCurrentCommit(installedDir)).toBe(detachedCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");
		});
	});

	describe("update() ignores force-pushed remotes", () => {
		it("does not react when remote history is rewritten", async () => {
			setupRemoteAndInstall();
			const initialCommit = getCurrentCommit(remoteDir);
			const installedCommit = getCurrentCommit(installedDir);

			// Remote advances then is force-pushed to a rewritten history.
			createCommit(remoteDir, "extension.ts", "// v2", "Commit to keep");
			git(["reset", "--hard", initialCommit], remoteDir);
			createCommit(remoteDir, "extension.ts", "// v2-rewritten", "Rewritten commit");

			await packageManager.update();

			// Installed checkout is unaffected by any remote rewrite.
			expect(getCurrentCommit(installedDir)).toBe(installedCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");
		});

		it("does not react when remote drops the installed commit", async () => {
			setupRemoteAndInstall();
			const installedCommit = getCurrentCommit(installedDir);

			createCommit(remoteDir, "extension.ts", "// v2", "Commit A");
			createCommit(remoteDir, "extension.ts", "// v3", "Commit B");
			git(["reset", "--hard", "HEAD~2"], remoteDir);
			createCommit(remoteDir, "extension.ts", "// v2-new", "New commit replacing A and B");

			await packageManager.update();

			expect(getCurrentCommit(installedDir)).toBe(installedCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");
		});

		it("does not react to a complete history rewrite", async () => {
			setupRemoteAndInstall();
			const installedCommit = getCurrentCommit(installedDir);

			createCommit(remoteDir, "extension.ts", "// v2", "v2");
			createCommit(remoteDir, "extension.ts", "// v3", "v3");
			git(["reset", "--hard", "HEAD~2"], remoteDir);
			createCommit(remoteDir, "extension.ts", "// rewrite-a", "Rewrite A");
			createCommit(remoteDir, "extension.ts", "// rewrite-b", "Rewrite B");

			await packageManager.update();

			expect(getCurrentCommit(installedDir)).toBe(installedCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");
		});
	});

	describe("pinned sources", () => {
		it("never updates a pinned git source (with @ref)", async () => {
			// Create remote repo first to get the initial commit
			mkdirSync(remoteDir, { recursive: true });
			initGitRepo(remoteDir);
			const initialCommit = createCommit(remoteDir, "extension.ts", "// v1", "Initial commit");

			// Install with pinned ref from the start - full clone to ensure commit is available
			mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
			git(["clone", remoteDir, installedDir], tempDir);
			git(["checkout", initialCommit], installedDir);
			git(["config", "--local", "user.email", "test@test.com"], installedDir);
			git(["config", "--local", "user.name", "Test"], installedDir);

			// Add to global packages with pinned ref
			settingsManager.setPackages([`${gitSource}@${initialCommit}`]);

			// Add new commit to remote
			createCommit(remoteDir, "extension.ts", "// v2", "Second commit");

			// Update should be skipped for pinned sources
			await packageManager.update();

			// Should still be on initial commit
			expect(getCurrentCommit(installedDir)).toBe(initialCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");
		});
	});

	describe("temporary git sources", () => {
		it("does not fetch or rewrite a cached temporary git source when resolving", async () => {
			const gitHost = "github.com";
			const gitPath = "test/extension";
			const hash = createHash("sha256").update(`git-${gitHost}-${gitPath}`).digest("hex").slice(0, 8);
			const cachedDir = join(tmpdir(), "pi-extensions", `git-${gitHost}`, hash, gitPath);
			const extensionFile = join(cachedDir, "pi-extensions", "session-breakdown.ts");

			rmSync(cachedDir, { recursive: true, force: true });
			mkdirSync(join(cachedDir, "pi-extensions"), { recursive: true });
			writeFileSync(
				join(cachedDir, "package.json"),
				JSON.stringify({ pi: { extensions: ["./pi-extensions"] } }, null, 2),
			);
			writeFileSync(extensionFile, "// cached");

			// Defensive spies on any command runner seam: none should be invoked.
			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand?: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
				runCommandCapture?: (command: string, args: string[], options?: { cwd?: string }) => Promise<string>;
			};
			managerWithInternals.runCommand = async (command, args) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
			};
			managerWithInternals.runCommandCapture = async (command, args) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
				return "";
			};

			const resolved = await packageManager.resolveExtensionSources([gitSource], { temporary: true });

			// No git command ran and the cached content is preserved verbatim.
			expect(executedCommands.filter((c) => c.startsWith("git "))).toEqual([]);
			expect(getFileContent(cachedDir, "pi-extensions/session-breakdown.ts")).toBe("// cached");

			// The existing on-disk extension is still resolved from cache.
			expect(resolved.extensions.some((r) => r.path.endsWith("session-breakdown.ts"))).toBe(true);

			rmSync(cachedDir, { recursive: true, force: true });
		});

		it("does not refresh pinned temporary git sources", async () => {
			const gitHost = "github.com";
			const gitPath = "test/extension";
			const hash = createHash("sha256").update(`git-${gitHost}-${gitPath}`).digest("hex").slice(0, 8);
			const cachedDir = join(tmpdir(), "pi-extensions", `git-${gitHost}`, hash, gitPath);
			const extensionFile = join(cachedDir, "pi-extensions", "session-breakdown.ts");

			rmSync(cachedDir, { recursive: true, force: true });
			mkdirSync(join(cachedDir, "pi-extensions"), { recursive: true });
			writeFileSync(
				join(cachedDir, "package.json"),
				JSON.stringify({ pi: { extensions: ["./pi-extensions"] } }, null, 2),
			);
			writeFileSync(extensionFile, "// pinned");

			const executedCommands: string[] = [];
			const managerWithInternals = packageManager as unknown as {
				runCommand?: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
			};
			managerWithInternals.runCommand = async (command, args) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
			};

			await packageManager.resolveExtensionSources([`${gitSource}@main`], { temporary: true });

			expect(executedCommands).toEqual([]);
			expect(getFileContent(cachedDir, "pi-extensions/session-breakdown.ts")).toBe("// pinned");

			rmSync(cachedDir, { recursive: true, force: true });
		});
	});

	describe("scope-aware update", () => {
		it("does not create a project-scope install when source is only registered globally", async () => {
			setupRemoteAndInstall();
			const installedCommit = getCurrentCommit(installedDir);

			// Remote advances; local-only update must not pull it.
			createCommit(remoteDir, "extension.ts", "// v2", "Second commit");

			// The project-scope install path should not exist before or after update
			const projectGitDir = join(tempDir, ".pit", "git", "github.com", "test", "extension");
			expect(existsSync(projectGitDir)).toBe(false);

			await packageManager.update(gitSource);

			// Global install is untouched (no network update).
			expect(getCurrentCommit(installedDir)).toBe(installedCommit);
			expect(getFileContent(installedDir, "extension.ts")).toBe("// v1");

			// Project-scope directory should NOT have been created
			expect(existsSync(projectGitDir)).toBe(false);
		});
	});
});
