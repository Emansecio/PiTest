import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error — launcher helper is a plain .mjs with no type declarations (bin/ is outside tsconfig).
import { killProcessTreeSync } from "../../../bin/lib/child-lifecycle.mjs";
import { killProcessTreeAndWait } from "../src/utils/shell.ts";

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(check: () => boolean, timeoutMs = 4_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return check();
}

describe.runIf(process.platform === "win32")("Windows process-tree fallback", () => {
	let grandchildPid: number | undefined;
	const cleanupPaths: string[] = [];

	afterEach(async () => {
		if (grandchildPid && isPidAlive(grandchildPid)) {
			try {
				process.kill(grandchildPid, "SIGKILL");
			} catch {}
			await waitUntil(() => !isPidAlive(grandchildPid!));
		}
		for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
		grandchildPid = undefined;
	});

	it("reaps a descendant after the root has already exited", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pit-tree-fallback-"));
		cleanupPaths.push(dir);
		const pidFile = join(dir, "grandchild.pid");
		const fixture = join(dir, "spawn-and-exit.cjs");
		writeFileSync(
			fixture,
			`const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
writeFileSync(process.argv[2], String(child.pid));
child.unref();`,
			"utf8",
		);

		const root = spawn(process.execPath, [fixture, pidFile], { stdio: "ignore", windowsHide: true });
		const rootPid = root.pid;
		expect(rootPid).toBeTypeOf("number");
		expect(await waitUntil(() => existsSync(pidFile))).toBe(true);
		grandchildPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
		expect(Number.isInteger(grandchildPid)).toBe(true);
		expect(await waitUntil(() => root.exitCode !== null)).toBe(true);
		expect(isPidAlive(grandchildPid)).toBe(true);

		expect(await killProcessTreeAndWait(rootPid!, 3_000)).toBe(true);
		expect(await waitUntil(() => !isPidAlive(grandchildPid!))).toBe(true);
	});

	it("reaps an orphaned descendant through the launcher fallback", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pit-launcher-tree-fallback-"));
		cleanupPaths.push(dir);
		const pidFile = join(dir, "grandchild.pid");
		const fixture = join(dir, "spawn-and-exit.cjs");
		writeFileSync(
			fixture,
			`const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
writeFileSync(process.argv[2], String(child.pid));
child.unref();`,
			"utf8",
		);

		const root = spawn(process.execPath, [fixture, pidFile], { stdio: "ignore", windowsHide: true });
		const rootPid = root.pid;
		expect(rootPid).toBeTypeOf("number");
		expect(await waitUntil(() => existsSync(pidFile))).toBe(true);
		grandchildPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
		expect(Number.isInteger(grandchildPid)).toBe(true);
		expect(await waitUntil(() => root.exitCode !== null)).toBe(true);
		expect(isPidAlive(grandchildPid)).toBe(true);

		killProcessTreeSync(rootPid!, "win32");
		expect(await waitUntil(() => !isPidAlive(grandchildPid!))).toBe(true);
	});
});
