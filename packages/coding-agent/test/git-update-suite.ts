/**
 * Shared harness for the git-update test files (git-update-*.test.ts).
 *
 * Background: package management was deliberately moved to a local-only model
 * (see DefaultPackageManager: `update()` is a no-op and git: sources are never
 * fetched/cloned/reset). External npm:/git: packages are no longer installed or
 * updated over the network. The package manager only *resolves* resources from
 * any pre-existing on-disk checkout.
 *
 * The suite was split across three files so vitest can run the git-heavy tests
 * on separate forks — as a single file it was the longest item in the run
 * (~16s of serial `git` spawns on Windows). Each file registers this harness:
 * a shared v1 remote + installed clone is built once per file (beforeAll) and
 * copied per test instead of init+commit+clone each time.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

// Helper to run git commands in a directory
export function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf-8",
	});
	if (result.status !== 0) {
		throw new Error(`Command failed: git ${args.join(" ")}\n${result.stderr}`);
	}
	return result.stdout.trim();
}

export function initGitRepo(repoDir: string): void {
	git(["init", "--initial-branch=main"], repoDir);
	git(["config", "--local", "user.email", "test@test.com"], repoDir);
	git(["config", "--local", "user.name", "Test"], repoDir);
}

// Helper to create a commit with a file
export function createCommit(repoDir: string, filename: string, content: string, message: string): string {
	writeFileSync(join(repoDir, filename), content);
	git(["add", filename], repoDir);
	git(["commit", "-m", message], repoDir);
	return git(["rev-parse", "HEAD"], repoDir);
}

// Helper to get current commit hash
export function getCurrentCommit(repoDir: string): string {
	return git(["rev-parse", "HEAD"], repoDir);
}

// Helper to get file content
export function getFileContent(repoDir: string, filename: string): string {
	return readFileSync(join(repoDir, filename), "utf-8");
}

// Git source that maps to the installed directory structure.
// Must use "git:" prefix so parseSource() treats it as a git source
// (bare "github.com/..." is not recognized as a git URL).
export const gitSource = "git:github.com/test/extension";

export interface GitUpdateSuite {
	readonly tempDir: string;
	readonly remoteDir: string; // Simulates the "remote" repository
	readonly agentDir: string; // The agent directory where extensions are installed
	readonly installedDir: string; // The installed extension directory
	readonly settingsManager: SettingsManager;
	readonly packageManager: DefaultPackageManager;
	readonly templateInitialCommit: string;
	/** Seeds a v1 remote + installed checkout from the suite template. */
	seedRemoteAndInstalledFromTemplate(): void;
	/**
	 * Seeds a v1 remote + installed checkout and registers it in settings.
	 * @param sourceOverride Optional source string to use instead of gitSource (e.g., with @ref for pinned tests)
	 */
	setupRemoteAndInstall(sourceOverride?: string): void;
}

/**
 * Registers the beforeAll/afterAll/beforeEach/afterEach hooks of the git-update
 * harness in the calling file and returns live accessors for the per-test state.
 */
export function registerGitUpdateSuite(): GitUpdateSuite {
	let tempDir: string;
	let remoteDir: string;
	let agentDir: string;
	let installedDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;

	// Shared v1 remote + installed clone — copied per test instead of init+commit+clone each time.
	let suiteTemplateDir: string;
	let templateRemoteDir: string;
	let templateInstalledDir: string;
	let templateInitialCommit: string;

	beforeAll(() => {
		suiteTemplateDir = mkdtempSync(join(tmpdir(), "git-update-suite-template-"));
		templateRemoteDir = join(suiteTemplateDir, "remote");
		templateInstalledDir = join(suiteTemplateDir, "installed");
		mkdirSync(templateRemoteDir, { recursive: true });
		initGitRepo(templateRemoteDir);
		templateInitialCommit = createCommit(templateRemoteDir, "extension.ts", "// v1", "Initial commit");
		git(["clone", templateRemoteDir, templateInstalledDir], suiteTemplateDir);
		git(["config", "--local", "user.email", "test@test.com"], templateInstalledDir);
		git(["config", "--local", "user.name", "Test"], templateInstalledDir);
	});

	afterAll(() => {
		if (suiteTemplateDir && existsSync(suiteTemplateDir)) {
			rmSync(suiteTemplateDir, { recursive: true, force: true });
		}
	});

	beforeEach(() => {
		tempDir = join(tmpdir(), `git-update-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		remoteDir = join(tempDir, "remote");
		agentDir = join(tempDir, "agent");
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

	function seedRemoteAndInstalledFromTemplate(): void {
		cpSync(templateRemoteDir, remoteDir, { recursive: true });
		mkdirSync(join(agentDir, "git", "github.com", "test"), { recursive: true });
		cpSync(templateInstalledDir, installedDir, { recursive: true });
	}

	function setupRemoteAndInstall(sourceOverride?: string): void {
		seedRemoteAndInstalledFromTemplate();
		settingsManager.setPackages([sourceOverride ?? gitSource]);
	}

	return {
		get tempDir() {
			return tempDir;
		},
		get remoteDir() {
			return remoteDir;
		},
		get agentDir() {
			return agentDir;
		},
		get installedDir() {
			return installedDir;
		},
		get settingsManager() {
			return settingsManager;
		},
		get packageManager() {
			return packageManager;
		},
		get templateInitialCommit() {
			return templateInitialCommit;
		},
		seedRemoteAndInstalledFromTemplate,
		setupRemoteAndInstall,
	};
}
