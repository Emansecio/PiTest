import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error — launcher helper is a plain .mjs with no type declarations (bin/ is outside tsconfig).
import { superviseChildProcess } from "../../../bin/lib/child-lifecycle.mjs";
// @ts-expect-error — launcher helper is a plain .mjs with no type declarations (bin/ is outside tsconfig).
import { anyTsNewerThan, decideTarget } from "../../../bin/lib/resolve-launch.mjs";

describe("decideTarget", () => {
	const srcDirs = ["/a", "/b"];

	it("returns src when forceSrc is set", () => {
		const target = decideTarget({
			bundleMtimeMs: 1000,
			srcDirs,
			forceSrc: true,
			isNewer: () => false,
		});
		expect(target).toBe("src");
	});

	it("returns src when the bundle is missing (bundleMtimeMs null)", () => {
		const target = decideTarget({
			bundleMtimeMs: null,
			srcDirs,
			forceSrc: false,
			isNewer: () => false,
		});
		expect(target).toBe("src");
	});

	it("returns bundle when nothing is newer", () => {
		const target = decideTarget({
			bundleMtimeMs: 1000,
			srcDirs,
			forceSrc: false,
			isNewer: () => false,
		});
		expect(target).toBe("bundle");
	});

	it("returns src when one dir has a newer file", () => {
		const target = decideTarget({
			bundleMtimeMs: 1000,
			srcDirs,
			forceSrc: false,
			isNewer: (dir: string) => dir === "/b",
		});
		expect(target).toBe("src");
	});
});

describe("anyTsNewerThan", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
		dirs.length = 0;
	});

	function makeTempDir(): string {
		const d = mkdtempSync(join(tmpdir(), "launcher-resolve-"));
		dirs.push(d);
		return d;
	}

	it("detects a .ts file newer than an old threshold", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "x.ts"), "export const x = 1;");
		expect(anyTsNewerThan(dir, 0)).toBe(true);
	});

	it("does not flag a .ts file against a future threshold", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "x.ts"), "export const x = 1;");
		const future = Date.now() + 60_000;
		expect(anyTsNewerThan(dir, future)).toBe(false);
	});

	it("ignores non-.ts files", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "x.txt"), "not typescript");
		expect(anyTsNewerThan(dir, 0)).toBe(false);
	});

	it("returns false for a missing dir", () => {
		expect(anyTsNewerThan(join(tmpdir(), "does-not-exist-launcher-resolve"), 0)).toBe(false);
	});
});

describe("superviseChildProcess", () => {
	it("forwards termination through tree cleanup and returns the conventional signal exit code", async () => {
		const host = new EventEmitter() as EventEmitter & { exitCode?: number };
		const child = new EventEmitter() as EventEmitter & { pid: number };
		child.pid = 1234;
		const terminations: Array<{ pid: number; signal: NodeJS.Signals }> = [];

		const supervised = superviseChildProcess(child, {
			host,
			terminateTree: async (pid: number, signal: NodeJS.Signals) => {
				terminations.push({ pid, signal });
				return true;
			},
			killTreeSync: () => {},
			waitForGrace: async () => {},
		});
		host.emit("SIGINT");

		await expect(supervised).resolves.toBe(130);
		expect(terminations).toEqual([{ pid: 1234, signal: "SIGINT" }]);
		expect(host.listenerCount("SIGINT")).toBe(0);
	});

	it("lets the child finish graceful disposal before forcing its tree", async () => {
		const host = new EventEmitter() as EventEmitter & { exitCode?: number };
		const child = new EventEmitter() as EventEmitter & { pid: number };
		child.pid = 2468;
		let releaseGrace!: () => void;
		const grace = new Promise<void>((resolve) => {
			releaseGrace = resolve;
		});
		const terminateTree = vi.fn(async () => true);
		const supervised = superviseChildProcess(child, {
			host,
			terminateTree,
			killTreeSync: () => {},
			forwardSignal: () => {},
			waitForGrace: () => grace,
		});

		host.emit("SIGTERM");
		child.emit("exit", 0, null);
		releaseGrace();

		await expect(supervised).resolves.toBe(143);
		expect(terminateTree).not.toHaveBeenCalled();
	});

	it("returns the child exit code without killing an already-finished child", async () => {
		const host = new EventEmitter() as EventEmitter & { exitCode?: number };
		const child = new EventEmitter() as EventEmitter & { pid: number };
		child.pid = 4321;
		let killCalls = 0;
		const supervised = superviseChildProcess(child, {
			host,
			terminateTree: async () => {},
			killTreeSync: () => {
				killCalls++;
			},
		});
		child.emit("exit", 7, null);

		await expect(supervised).resolves.toBe(7);
		host.emit("exit");
		expect(killCalls).toBe(0);
	});

	it("performs synchronous best-effort tree cleanup if the launcher itself exits first", () => {
		const host = new EventEmitter() as EventEmitter & { exitCode?: number };
		const child = new EventEmitter() as EventEmitter & { pid: number };
		child.pid = 9876;
		const killed: number[] = [];
		void superviseChildProcess(child, {
			host,
			terminateTree: async () => {},
			killTreeSync: (pid: number) => killed.push(pid),
		});

		host.emit("exit");
		expect(killed).toEqual([9876]);
	});
});
