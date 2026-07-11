/**
 * The optional `fff` backend (grep.engine: "fff") must be behavior-identical to
 * ripgrep on its supported subset, and must transparently fall back to ripgrep
 * for every unsupported case. These tests assert PARITY (same file:line set) on
 * a fixture repo, not just that fff returns quickly.
 *
 * The fff warm path requires a git work tree (outside git, fff drops dotfiles
 * and goes stale — Pit gates to rg). Fixtures below `git init` for that reason.
 *
 * The fff cases skip when the native binary is unavailable on this platform so
 * the suite stays green on machines without the optional dependency installed.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isFffAvailable, isGitWorkTree, makeGlobPathFilter } from "../src/core/tools/fff-search.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";

const fffReady = await isFffAvailable();
const ctx = {} as Parameters<ReturnType<typeof createGrepToolDefinition>["execute"]>[4];

let root: string;

async function runGrep(
	cwd: string,
	engine: "rg" | "fff",
	args: {
		pattern: string;
		path?: string;
		glob?: string;
		ignoreCase?: boolean;
		literal?: boolean;
		outputMode?: "content" | "files_with_matches" | "count";
	},
): Promise<string> {
	const def = createGrepToolDefinition(cwd, { engine });
	const res = (await def.execute("t", args, undefined, undefined, ctx)) as {
		content: Array<{ type: string; text?: string }>;
	};
	return res.content[0]?.text ?? "";
}

/** Parse locate-style output ("path" or "path:count") into a sorted list. */
function plainList(output: string): string[] {
	return output
		.split("\n")
		.map((l) => l.replace(/\\/g, "/").trim())
		.filter((l) => l && !l.startsWith("["))
		.sort();
}

/** Parse "path:line: text" output into a sorted "path:line" set. */
function lineSet(output: string): string[] {
	const out: string[] = [];
	for (const raw of output.split("\n")) {
		const m = /^(.+?):(\d+): /.exec(raw);
		if (m) out.push(`${m[1].replace(/\\/g, "/")}:${m[2]}`);
	}
	return out.sort();
}

beforeAll(() => {
	root = mkdtempSync(path.join(tmpdir(), "grep-fff-"));
	mkdirSync(path.join(root, "sub"), { recursive: true });
	mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
	// "FooBarBaz" appears on 4 lines (mixed positions); one line has the
	// lowercase "foobarbaz" which must NOT match a case-sensitive search.
	writeFileSync(
		path.join(root, "a.ts"),
		["const FooBarBaz = 1;", "// another FooBarBaz here", 'const lower = "foobarbaz";'].join("\n"),
	);
	writeFileSync(path.join(root, "b.ts"), "function FooBarBaz() { return 0; }\n");
	writeFileSync(path.join(root, "sub", "c.ts"), "export { FooBarBaz };\n");
	// Second subdir file with 2 matches, for count + multi-file subdir coverage.
	writeFileSync(path.join(root, "sub", "d.ts"), ["const FooBarBaz = 2;", "use(FooBarBaz);"].join("\n"));
	writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), "name: FooBarBaz\n");
	// fff warm path is gated on a git work tree (dotfile + watcher parity).
	execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
});

afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

describe("grep fff backend", () => {
	it("isGitWorkTree detects the fixture repo and rejects a plain temp dir", () => {
		expect(isGitWorkTree(root)).toBe(true);
		const plain = mkdtempSync(path.join(tmpdir(), "grep-fff-nongit-"));
		try {
			expect(isGitWorkTree(plain)).toBe(false);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});

	it("rg engine (default) finds case-sensitive matches, excluding the lowercase line", async () => {
		const set = lineSet(await runGrep(root, "rg", { pattern: "FooBarBaz" }));
		expect(set).toEqual([
			".github/workflows/ci.yml:1",
			"a.ts:1",
			"a.ts:2",
			"b.ts:1",
			"sub/c.ts:1",
			"sub/d.ts:1",
			"sub/d.ts:2",
		]);
	});

	it.skipIf(!fffReady)("fff engine matches rg exactly (case-sensitive parity)", async () => {
		const rg = lineSet(await runGrep(root, "rg", { pattern: "FooBarBaz" }));
		const fff = lineSet(await runGrep(root, "fff", { pattern: "FooBarBaz" }));
		expect(fff).toEqual(rg);
		// smartCase:false parity — the lowercase line must NOT appear.
		expect(fff).not.toContain("a.ts:3");
	});

	it.skipIf(!fffReady)("fff engine matches rg on .github dot-dir content", async () => {
		const rg = lineSet(await runGrep(root, "rg", { pattern: "FooBarBaz", path: ".github" }));
		const fff = lineSet(await runGrep(root, "fff", { pattern: "FooBarBaz", path: ".github" }));
		expect(fff).toEqual(rg);
		expect(fff).toEqual(["workflows/ci.yml:1"]);
	});

	it.skipIf(!fffReady)("fff engine matches rg exactly (literal mode parity)", async () => {
		const rg = lineSet(await runGrep(root, "rg", { pattern: "FooBarBaz()", literal: true }));
		const fff = lineSet(await runGrep(root, "fff", { pattern: "FooBarBaz()", literal: true }));
		expect(fff).toEqual(rg);
		expect(fff).toEqual(["b.ts:1"]);
	});

	it.skipIf(!fffReady)("fff engine matches rg with ignoreCase via warm index", async () => {
		const rg = lineSet(await runGrep(root, "rg", { pattern: "FooBarBaz", ignoreCase: true }));
		const fff = lineSet(await runGrep(root, "fff", { pattern: "FooBarBaz", ignoreCase: true }));
		expect(fff).toEqual(rg);
		expect(fff).toContain("a.ts:3");
	});

	it.skipIf(!fffReady)("fff engine handles files_with_matches with parity", async () => {
		const rg = plainList(await runGrep(root, "rg", { pattern: "FooBarBaz", outputMode: "files_with_matches" }));
		const fff = plainList(await runGrep(root, "fff", { pattern: "FooBarBaz", outputMode: "files_with_matches" }));
		expect(fff).toEqual(rg);
		expect(fff).toEqual([".github/workflows/ci.yml", "a.ts", "b.ts", "sub/c.ts", "sub/d.ts"]);
	});

	it.skipIf(!fffReady)("fff engine handles count mode with parity", async () => {
		const rg = plainList(await runGrep(root, "rg", { pattern: "FooBarBaz", outputMode: "count" }));
		const fff = plainList(await runGrep(root, "fff", { pattern: "FooBarBaz", outputMode: "count" }));
		expect(fff).toEqual(rg);
		expect(fff).toEqual([".github/workflows/ci.yml:1", "a.ts:2", "b.ts:1", "sub/c.ts:1", "sub/d.ts:2"].sort());
	});

	it.skipIf(!fffReady)("fff engine scopes a subdir content search with parity", async () => {
		const rg = lineSet(await runGrep(root, "rg", { pattern: "FooBarBaz", path: "sub" }));
		const fff = lineSet(await runGrep(root, "fff", { pattern: "FooBarBaz", path: "sub" }));
		expect(fff).toEqual(rg);
		// paths are relative to the searched subdir; only sub/* files appear.
		expect(fff).toEqual(["c.ts:1", "d.ts:1", "d.ts:2"]);
	});

	it.skipIf(!fffReady)("fff engine scopes a subdir files_with_matches search with parity", async () => {
		const rg = plainList(
			await runGrep(root, "rg", { pattern: "FooBarBaz", path: "sub", outputMode: "files_with_matches" }),
		);
		const fff = plainList(
			await runGrep(root, "fff", { pattern: "FooBarBaz", path: "sub", outputMode: "files_with_matches" }),
		);
		expect(fff).toEqual(rg);
		expect(fff).toEqual(["c.ts", "d.ts"]);
	});

	it.skipIf(!fffReady)("fff engine matches rg with a simple glob filter", async () => {
		const rg = plainList(await runGrep(root, "rg", { pattern: "FooBarBaz", glob: "*.ts" }));
		const fff = plainList(await runGrep(root, "fff", { pattern: "FooBarBaz", glob: "*.ts" }));
		expect(fff).toEqual(rg);
	});

	it.skipIf(!fffReady)("fff engine matches rg when complex glob forces rg fallback", async () => {
		const complexGlob = "!*.js";
		const rg = plainList(await runGrep(root, "rg", { pattern: "FooBarBaz", glob: complexGlob }));
		const fff = plainList(await runGrep(root, "fff", { pattern: "FooBarBaz", glob: complexGlob }));
		expect(fff).toEqual(rg);
	});

	it.skipIf(!fffReady)("fff engine falls back to rg outside a git work tree (dotfile parity)", async () => {
		// Without git, raw fff would miss .hidden.ts; the gate must force rg so
		// engine:"fff" still matches engine:"rg" on hidden paths.
		const plain = mkdtempSync(path.join(tmpdir(), "grep-fff-nongit-"));
		try {
			writeFileSync(path.join(plain, "visible.ts"), 'const x = "HiddenMarker";\n');
			writeFileSync(path.join(plain, ".hidden.ts"), 'const x = "HiddenMarker";\n');
			expect(isGitWorkTree(plain)).toBe(false);
			const rg = lineSet(await runGrep(plain, "rg", { pattern: "HiddenMarker" }));
			const fff = lineSet(await runGrep(plain, "fff", { pattern: "HiddenMarker" }));
			expect(fff).toEqual(rg);
			expect(fff).toContain(".hidden.ts:1");
			expect(fff).toContain("visible.ts:1");
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});

	it("makeGlobPathFilter matches dot-dirs like rg's --hidden (dot:true parity)", () => {
		// Inside a git work tree fff indexes dot-dirs; the client-side glob filter
		// must still accept them so `**/*.yml` keeps `.github/workflows/` hits.
		const matches = makeGlobPathFilter("**/*.yml");
		expect(matches(".github/workflows/ci.yml")).toBe(true);
		expect(matches("readme.yml")).toBe(true);
		expect(matches(".github/workflows/ci.txt")).toBe(false);
	});
});
