/**
 * Local-only package management: `update()` never reaches out to git — it does
 * not fetch, does not modify an existing installed checkout, and does not
 * create scope directories. See git-update-suite.ts for the full background.
 */

import { describe, expect, it } from "vitest";
import { createCommit, getCurrentCommit, getFileContent, git, registerGitUpdateSuite } from "./git-update-suite.js";

describe("DefaultPackageManager git sources (local-only mode)", () => {
	const suite = registerGitUpdateSuite();

	describe("update() is a no-op for git sources", () => {
		it("does not run git or modify the checkout when already up to date", async () => {
			suite.setupRemoteAndInstall();
			const before = getCurrentCommit(suite.installedDir);

			// Spy on any internal command runners so we can assert none are invoked.
			// In local-only mode the seams may not even exist, so we install them
			// defensively and verify they are never called.
			const executedCommands: string[] = [];
			const managerWithInternals = suite.packageManager as unknown as {
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

			await suite.packageManager.update();

			// No git command ran, and the checkout is untouched.
			expect(executedCommands.filter((c) => c.startsWith("git "))).toEqual([]);
			expect(getCurrentCommit(suite.installedDir)).toBe(before);
			expect(getFileContent(suite.installedDir, "extension.ts")).toBe("// v1");
		});

		it("does not pull new remote commits into the installed checkout", async () => {
			suite.setupRemoteAndInstall();
			const installedCommit = getCurrentCommit(suite.installedDir);
			expect(getFileContent(suite.installedDir, "extension.ts")).toBe("// v1");

			// Remote advances, but local-only update must not pull it.
			createCommit(suite.remoteDir, "extension.ts", "// v2", "Second commit");

			await suite.packageManager.update();

			// Checkout stays exactly where it was installed.
			expect(getCurrentCommit(suite.installedDir)).toBe(installedCommit);
			expect(getFileContent(suite.installedDir, "extension.ts")).toBe("// v1");
		});

		it("does not advance past multiple remote commits", async () => {
			suite.setupRemoteAndInstall();
			const installedCommit = getCurrentCommit(suite.installedDir);

			createCommit(suite.remoteDir, "extension.ts", "// v2", "Second commit");
			createCommit(suite.remoteDir, "extension.ts", "// v3", "Third commit");
			createCommit(suite.remoteDir, "extension.ts", "// v4", "Fourth commit");

			await suite.packageManager.update();

			expect(getCurrentCommit(suite.installedDir)).toBe(installedCommit);
			expect(getFileContent(suite.installedDir, "extension.ts")).toBe("// v1");
		});

		it("leaves a detached checkout (no upstream) untouched", async () => {
			suite.setupRemoteAndInstall();
			createCommit(suite.remoteDir, "extension.ts", "// v2", "Second commit");
			createCommit(suite.remoteDir, "extension.ts", "// v3", "Third commit");

			const detachedCommit = getCurrentCommit(suite.installedDir);
			git(["checkout", detachedCommit], suite.installedDir);

			const executedCommands: string[] = [];
			const managerWithInternals = suite.packageManager as unknown as {
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

			await suite.packageManager.update();

			expect(executedCommands.filter((c) => c.startsWith("git "))).toEqual([]);
			expect(getCurrentCommit(suite.installedDir)).toBe(detachedCommit);
			expect(getFileContent(suite.installedDir, "extension.ts")).toBe("// v1");
		});
	});
});
