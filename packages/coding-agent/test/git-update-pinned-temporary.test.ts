/**
 * Local-only package management: pinned git sources are never updated, and
 * `resolveExtensionSources()` for a git: source runs no git command — it only
 * reads resources already present on disk. See git-update-suite.ts for the
 * full background.
 *
 * The two "temporary git sources" tests share a fixed cache path derived from
 * gitSource (hash of host+path under tmpdir()/pi-extensions), so they must stay
 * in the same file — parallel forks touching that path would race.
 */

import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

	describe("pinned sources", () => {
		it("never updates a pinned git source (with @ref)", async () => {
			suite.seedRemoteAndInstalledFromTemplate();
			git(["checkout", suite.templateInitialCommit], suite.installedDir);
			suite.settingsManager.setPackages([`${gitSource}@${suite.templateInitialCommit}`]);

			createCommit(suite.remoteDir, "extension.ts", "// v2", "Second commit");

			await suite.packageManager.update();

			expect(getCurrentCommit(suite.installedDir)).toBe(suite.templateInitialCommit);
			expect(getFileContent(suite.installedDir, "extension.ts")).toBe("// v1");
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

			const resolved = await suite.packageManager.resolveExtensionSources([gitSource], { temporary: true });

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
			const managerWithInternals = suite.packageManager as unknown as {
				runCommand?: (command: string, args: string[], options?: { cwd?: string }) => Promise<void>;
			};
			managerWithInternals.runCommand = async (command, args) => {
				executedCommands.push(`${command} ${args.join(" ")}`);
			};

			await suite.packageManager.resolveExtensionSources([`${gitSource}@main`], { temporary: true });

			expect(executedCommands).toEqual([]);
			expect(getFileContent(cachedDir, "pi-extensions/session-breakdown.ts")).toBe("// pinned");

			rmSync(cachedDir, { recursive: true, force: true });
		});
	});
});
