/**
 * Non-interactive modes must keep stdout pristine for JSON/pipe consumers.
 *
 * The redirect is implemented by `takeOverStdout()` in output-guard.ts — we
 * test that mechanism in-process (fast). One E2E spawn verifies the full CLI
 * still routes help text to stderr after boot.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { restoreStdout, takeOverStdout } from "../src/core/output-guard.js";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");

const tempDirs: string[] = [];

afterEach(() => {
	restoreStdout();
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
		} catch {
			// EBUSY/EPERM under contention: orphan the temp dir.
		}
	}
});

describe("stdout cleanliness in non-interactive modes", () => {
	it("redirects process.stdout.write to stderr after takeOverStdout", () => {
		const stderrWrites: string[] = [];
		const originalStderrWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		): boolean => {
			stderrWrites.push(String(chunk));
			if (typeof encodingOrCallback === "function") {
				return originalStderrWrite(chunk, encodingOrCallback);
			}
			return originalStderrWrite(chunk, encodingOrCallback, callback);
		}) as typeof process.stderr.write;

		takeOverStdout();
		process.stdout.write("piped-json-payload\n");
		restoreStdout();
		process.stderr.write = originalStderrWrite;

		expect(stderrWrites.join("")).toContain("piped-json-payload");
	});
});

describe("stdout cleanliness E2E smoke", () => {
	async function runCliOnce(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-stdout-clean-"));
		tempDirs.push(tempRoot);
		const agentDir = join(tempRoot, "agent");
		const projectDir = join(tempRoot, "project");
		const projectConfigDir = join(projectDir, ".pit");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectConfigDir, { recursive: true });
		writeFileSync(
			join(projectConfigDir, "settings.json"),
			JSON.stringify({ packages: ["npm:fake-package"] }, null, 2),
			"utf-8",
		);

		return await new Promise((resolvePromise, reject) => {
			const child = spawn(process.execPath, [tsxPath, cliPath, ...args], {
				cwd: projectDir,
				env: {
					...process.env,
					[ENV_AGENT_DIR]: agentDir,
					TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
				},
				stdio: ["ignore", "pipe", "pipe"],
			});

			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			child.on("error", reject);
			child.on("close", (code) => {
				resolvePromise({ stdout, stderr, code });
			});
		});
	}

	it("keeps stdout empty for --mode json --help while routing help to stderr", async () => {
		const result = await runCliOnce(["--mode", "json", "--help"]);

		expect(result.code).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Usage:");
	});
});
