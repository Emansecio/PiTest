import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
