/**
 * Local-only package management: `update()` ignores force-pushed remotes and
 * never creates scope directories. See git-update-suite.ts for the full
 * background.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createCommit,
	getCurrentCommit,
	getFileContent,
	git,
	gitSource,
	registerGitUpdateSuite,
} from "./git-update-suite.js";

describe("DefaultPackageManager git sources (local-only mode)", () => {
	const suite = registerGitUpdateSuite();

	describe("update() ignores force-pushed remotes", () => {
		it("does not react when remote history is rewritten", async () => {
			suite.setupRemoteAndInstall();
			const initialCommit = getCurrentCommit(suite.remoteDir);
			const installedCommit = getCurrentCommit(suite.installedDir);

			// Remote advances then is force-pushed to a rewritten history.
			createCommit(suite.remoteDir, "extension.ts", "// v2", "Commit to keep");
			git(["reset", "--hard", initialCommit], suite.remoteDir);
			createCommit(suite.remoteDir, "extension.ts", "// v2-rewritten", "Rewritten commit");

			await suite.packageManager.update();

			// Installed checkout is unaffected by any remote rewrite.
			expect(getCurrentCommit(suite.installedDir)).toBe(installedCommit);
			expect(getFileContent(suite.installedDir, "extension.ts")).toBe("// v1");
		});

		it("does not react when remote drops the installed commit", async () => {
			suite.setupRemoteAndInstall();
			const installedCommit = getCurrentCommit(suite.installedDir);

			createCommit(suite.remoteDir, "extension.ts", "// v2", "Commit A");
			createCommit(suite.remoteDir, "extension.ts", "// v3", "Commit B");
			git(["reset", "--hard", "HEAD~2"], suite.remoteDir);
			createCommit(suite.remoteDir, "extension.ts", "// v2-new", "New commit replacing A and B");

			await suite.packageManager.update();

			expect(getCurrentCommit(suite.installedDir)).toBe(installedCommit);
			expect(getFileContent(suite.installedDir, "extension.ts")).toBe("// v1");
		});

		it("does not react to a complete history rewrite", async () => {
			suite.setupRemoteAndInstall();
			const installedCommit = getCurrentCommit(suite.installedDir);

			createCommit(suite.remoteDir, "extension.ts", "// v2", "v2");
			createCommit(suite.remoteDir, "extension.ts", "// v3", "v3");
			git(["reset", "--hard", "HEAD~2"], suite.remoteDir);
			createCommit(suite.remoteDir, "extension.ts", "// rewrite-a", "Rewrite A");
			createCommit(suite.remoteDir, "extension.ts", "// rewrite-b", "Rewrite B");

			await suite.packageManager.update();

			expect(getCurrentCommit(suite.installedDir)).toBe(installedCommit);
			expect(getFileContent(suite.installedDir, "extension.ts")).toBe("// v1");
		});
	});

	describe("scope-aware update", () => {
		it("does not create a project-scope install when source is only registered globally", async () => {
			suite.setupRemoteAndInstall();
			const installedCommit = getCurrentCommit(suite.installedDir);

			// Remote advances; local-only update must not pull it.
			createCommit(suite.remoteDir, "extension.ts", "// v2", "Second commit");

			// The project-scope install path should not exist before or after update
			const projectGitDir = join(suite.tempDir, ".pit", "git", "github.com", "test", "extension");
			expect(existsSync(projectGitDir)).toBe(false);

			await suite.packageManager.update(gitSource);

			// Global install is untouched (no network update).
			expect(getCurrentCommit(suite.installedDir)).toBe(installedCommit);
			expect(getFileContent(suite.installedDir, "extension.ts")).toBe("// v1");

			// Project-scope directory should NOT have been created
			expect(existsSync(projectGitDir)).toBe(false);
		});
	});
});
