/**
 * The optional `fff` backend (grep.engine: "fff") must be behavior-identical to
 * ripgrep on its supported subset, and must transparently fall back to ripgrep
 * for every unsupported case. These tests assert PARITY (same file:line set) on
 * a fixture repo, not just that fff returns quickly.
 *
 * The fff cases skip when the native binary is unavailable on this platform so
 * the suite stays green on machines without the optional dependency installed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isFffAvailable } from "../src/core/tools/fff-search.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";

const fffReady = await isFffAvailable();
const ctx = {} as Parameters<ReturnType<typeof createGrepToolDefinition>["execute"]>[4];

let root: string;

async function runGrep(
	engine: "rg" | "fff",
	args: {
		pattern: string;
		path?: string;
		ignoreCase?: boolean;
		literal?: boolean;
		outputMode?: "content" | "files_with_matches" | "count";
	},
): Promise<string> {
	const def = createGrepToolDefinition(root, { engine });
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
});

afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

describe("grep fff backend", () => {
	it("rg engine (default) finds case-sensitive matches, excluding the lowercase line", async () => {
		const set = lineSet(await runGrep("rg", { pattern: "FooBarBaz" }));
		expect(set).toEqual(["a.ts:1", "a.ts:2", "b.ts:1", "sub/c.ts:1", "sub/d.ts:1", "sub/d.ts:2"]);
	});

	it.skipIf(!fffReady)("fff engine matches rg exactly (case-sensitive parity)", async () => {
		const rg = lineSet(await runGrep("rg", { pattern: "FooBarBaz" }));
		const fff = lineSet(await runGrep("fff", { pattern: "FooBarBaz" }));
		expect(fff).toEqual(rg);
		// smartCase:false parity — the lowercase line must NOT appear.
		expect(fff).not.toContain("a.ts:3");
	});

	it.skipIf(!fffReady)("fff engine matches rg exactly (literal mode parity)", async () => {
		const rg = lineSet(await runGrep("rg", { pattern: "FooBarBaz()", literal: true }));
		const fff = lineSet(await runGrep("fff", { pattern: "FooBarBaz()", literal: true }));
		expect(fff).toEqual(rg);
		expect(fff).toEqual(["b.ts:1"]);
	});

	it.skipIf(!fffReady)("fff engine falls back to rg for ignoreCase (includes lowercase line)", async () => {
		// ignoreCase is unsupported by the fff path → rg fallback. Must include a.ts:3.
		const rg = lineSet(await runGrep("rg", { pattern: "FooBarBaz", ignoreCase: true }));
		const fff = lineSet(await runGrep("fff", { pattern: "FooBarBaz", ignoreCase: true }));
		expect(fff).toEqual(rg);
		expect(fff).toContain("a.ts:3");
	});

	it.skipIf(!fffReady)("fff engine handles files_with_matches with parity", async () => {
		const rg = plainList(await runGrep("rg", { pattern: "FooBarBaz", outputMode: "files_with_matches" }));
		const fff = plainList(await runGrep("fff", { pattern: "FooBarBaz", outputMode: "files_with_matches" }));
		expect(fff).toEqual(rg);
		expect(fff).toEqual(["a.ts", "b.ts", "sub/c.ts", "sub/d.ts"]);
	});

	it.skipIf(!fffReady)("fff engine handles count mode with parity", async () => {
		const rg = plainList(await runGrep("rg", { pattern: "FooBarBaz", outputMode: "count" }));
		const fff = plainList(await runGrep("fff", { pattern: "FooBarBaz", outputMode: "count" }));
		expect(fff).toEqual(rg);
		// a.ts:2, b.ts:1, c.ts:1, d.ts:2 (counts per file).
		expect(fff).toEqual(["a.ts:2", "b.ts:1", "sub/c.ts:1", "sub/d.ts:2"].sort());
	});

	it.skipIf(!fffReady)("fff engine scopes a subdir content search with parity", async () => {
		const rg = lineSet(await runGrep("rg", { pattern: "FooBarBaz", path: "sub" }));
		const fff = lineSet(await runGrep("fff", { pattern: "FooBarBaz", path: "sub" }));
		expect(fff).toEqual(rg);
		// paths are relative to the searched subdir; only sub/* files appear.
		expect(fff).toEqual(["c.ts:1", "d.ts:1", "d.ts:2"]);
	});

	it.skipIf(!fffReady)("fff engine scopes a subdir files_with_matches search with parity", async () => {
		const rg = plainList(
			await runGrep("rg", { pattern: "FooBarBaz", path: "sub", outputMode: "files_with_matches" }),
		);
		const fff = plainList(
			await runGrep("fff", { pattern: "FooBarBaz", path: "sub", outputMode: "files_with_matches" }),
		);
		expect(fff).toEqual(rg);
		expect(fff).toEqual(["c.ts", "d.ts"]);
	});
});
