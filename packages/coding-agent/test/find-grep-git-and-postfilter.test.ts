import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendCappedStderr as appendCappedFindStderr, createFindToolDefinition } from "../src/core/tools/find.js";
import { appendCappedStderr as appendCappedGrepStderr, createGrepToolDefinition } from "../src/core/tools/grep.js";

/**
 * Audit fixes (2026-06): search hygiene in the fd/rg-backed tools.
 *
 * 1. `--hidden` made both fd (find) and rg (grep) descend into `.git/`,
 *    flooding results with packed-refs/hooks/log noise. Both now exclude it.
 * 2. On the post-filter path (pattern contains `/`), fd's `--max-results`
 *    capped the ENUMERATION at the result limit, so in trees with more files
 *    than the limit the real matches could silently fall outside the window
 *    ("No files found" for a file that exists). The enumeration now uses a
 *    high internal ceiling and the result limit applies after minimatch.
 */

type ToolText = { content: Array<{ type: string; text?: string }> };

function textOf(result: unknown): string {
	return (result as ToolText).content[0]?.text ?? "";
}

describe("find/grep .git exclusion and post-filter enumeration", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-git-postfilter-"));
		mkdirSync(join(tempRoot, ".git", "hooks"), { recursive: true });
		mkdirSync(join(tempRoot, "src"), { recursive: true });
		writeFileSync(join(tempRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
		writeFileSync(join(tempRoot, ".git", "hooks", "pre-commit.sample"), "# ref hook\n");
		writeFileSync(join(tempRoot, "src", "app.ts"), 'export const ref = "ref: value";\n');
		writeFileSync(join(tempRoot, ".env.example"), "REF=1\n");
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	async function runFind(args: Record<string, unknown>): Promise<string[]> {
		const def = createFindToolDefinition(tempRoot);
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = await def.execute("call-1", args as never, undefined, undefined, ctx);
		const text = textOf(result);
		if (text === "No files found matching pattern") return [];
		return text
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith("["));
	}

	async function runGrep(args: Record<string, unknown>): Promise<string> {
		const def = createGrepToolDefinition(tempRoot);
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = await def.execute("call-1", args as never, undefined, undefined, ctx);
		return textOf(result);
	}

	it("find does not descend into .git but still sees other dotfiles", async () => {
		const files = await runFind({ pattern: "*" });
		expect(files).toContain("src/app.ts");
		expect(files).toContain(".env.example");
		expect(files.some((f) => f.includes(".git"))).toBe(false);
	});

	it("grep does not match inside .git but still matches dotfiles", async () => {
		const output = await runGrep({ pattern: "ref" });
		expect(output).toContain("src/app.ts");
		expect(output).not.toContain(".git");
	});

	it("grep rooted INSIDE .git still works (exclusion is search-root relative)", async () => {
		const output = await runGrep({ pattern: "ref", path: ".git" });
		expect(output).toContain("HEAD");
	});

	it("find post-filter pattern matches beyond the result-limit enumeration window", async () => {
		// 150 noise files at the root, one real match in a subdirectory. With the
		// old behavior (`--max-results=limit` pre-filter) fd enumerated only
		// `limit` arbitrary paths and the minimatch pass almost always came up
		// empty. Now enumeration is capped independently, so the single real
		// match must be found even with limit=1.
		mkdirSync(join(tempRoot, "sub"), { recursive: true });
		for (let i = 0; i < 150; i++) {
			writeFileSync(join(tempRoot, `noise-${String(i).padStart(3, "0")}.txt`), "");
		}
		writeFileSync(join(tempRoot, "sub", "target.spec.ts"), "");

		const files = await runFind({ pattern: "sub/*.spec.ts", limit: 1 });
		expect(files).toEqual(["sub/target.spec.ts"]);
	});

	it("grep surfaces a malformed regex as an actionable error, not a false 'No matches found'", async () => {
		// An unbalanced group is a regex-parse error. The old behavior swallowed it
		// as a success ("No matches found"), so the model could not tell a broken
		// pattern from a genuinely empty result. It must now reject with a hint to
		// set literal:true.
		await expect(runGrep({ pattern: "ref(" })).rejects.toThrow(/literal/i);
	});

	it("grep with literal:true matches text containing regex metacharacters", async () => {
		writeFileSync(join(tempRoot, "src", "call.ts"), "doThing(arg)\n");
		const output = await runGrep({ pattern: "doThing(", literal: true });
		expect(output).toContain("src/call.ts");
	});

	it("find with a backslash pattern and no matches hints at forward slashes", async () => {
		// `src\*.ts` has no "/", so the post-filter is skipped and the raw pattern
		// goes to fd --glob where "\" is an escape → zero matches. The empty message
		// must point at the forward-slash form so the model can self-correct.
		const def = createFindToolDefinition(tempRoot);
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = await def.execute("call-bs", { pattern: "src\\*.ts" } as never, undefined, undefined, ctx);
		const text = textOf(result);
		expect(text).toContain("No files found");
		expect(text).toContain("Glob patterns use forward slashes; try: src/*.ts");
	});

	it("grep with a backslash glob and no matches hints at forward slashes", async () => {
		// A backslash glob (`src\*.ts`) reaches rg --glob raw, where "\" is an escape
		// and "/" is the only separator → it filters everything out. The empty
		// message must suggest the forward-slash form.
		const output = await runGrep({ pattern: "ref", glob: "src\\*.ts" });
		expect(output).toContain("No matches found");
		expect(output).toContain("Glob patterns use forward slashes; try: src/*.ts");
	});

	it("grep with context produces unchanged before/after lines for a normal file", async () => {
		// Snapshot of the existing context formatting: match line uses `:`, context
		// lines use `-`. The OOM guard must not alter this for normal-sized files.
		// A single-file search path formats as basename (existing behavior).
		writeFileSync(join(tempRoot, "src", "ctx.ts"), `const a = 1;\nconst b = 2; // ref here\nconst c = 3;\n`);
		const output = await runGrep({ pattern: "ref here", path: "src/ctx.ts", context: 1 });
		expect(output).toContain("ctx.ts-1- const a = 1;");
		expect(output).toContain("ctx.ts:2: const b = 2; // ref here");
		expect(output).toContain("ctx.ts-3- const c = 3;");
	});
});

describe("grep OOM guard: oversized matched files are not buffered for context", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-grep-oom-"));
		mkdirSync(join(tempRoot, "src"), { recursive: true });
		// A small, real file so ripgrep produces a genuine match. The size guard is
		// driven by the injected fileSize op below, decoupling layer 2 from rg's own
		// --max-filesize so we exercise the defensive readFile bail in isolation.
		writeFileSync(join(tempRoot, "src", "huge.min.js"), "var x=/* ref */1;\n");
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("stat-guard falls back to '(unable to read file)' instead of readFile when size exceeds the ceiling", async () => {
		let readFileCalled = false;
		const def = createGrepToolDefinition(tempRoot, {
			operations: {
				isDirectory: async (p) => (await stat(p)).isDirectory(),
				// Report the matched file as far over the 10MB ceiling.
				fileSize: () => 50 * 1024 * 1024,
				readFile: () => {
					readFileCalled = true;
					throw new Error("readFile must not be called for an oversized file");
				},
			},
		});
		const ctx = {} as Parameters<typeof def.execute>[4];
		// context > 0 forces the getFileLines path that would otherwise readFile.
		const result = await def.execute("call-oom", { pattern: "ref", context: 2 } as never, undefined, undefined, ctx);
		const text = textOf(result);
		expect(readFileCalled).toBe(false);
		expect(text).toContain("(unable to read file)");
		expect(text).toContain("huge.min.js");
	});

	it("under-ceiling file still reads context normally (guard does not over-trigger)", async () => {
		const def = createGrepToolDefinition(tempRoot, {
			operations: {
				isDirectory: async (p) => (await stat(p)).isDirectory(),
				// Report a small size: well under the ceiling, so readFile runs.
				fileSize: () => 16,
				readFile: (p) => readFile(p, "utf-8"),
			},
		});
		const ctx = {} as Parameters<typeof def.execute>[4];
		// context > 0 routes through getFileLines, the path the guard protects.
		const result = await def.execute("call-ok", { pattern: "ref", context: 1 } as never, undefined, undefined, ctx);
		const text = textOf(result);
		expect(text).toContain("huge.min.js");
		expect(text).not.toContain("(unable to read file)");
	});
});

describe("grep/find stderr accumulation is capped (no unbounded growth)", () => {
	const MAX = 64 * 1024;

	// The stderr handler in both tools is an inline closure over a spawned child;
	// reliably driving a real rg/fd to emit >64KB of stderr in a unit test is
	// flaky and platform-specific. The capping logic is therefore extracted into
	// `appendCappedStderr` and exercised directly here, which is exactly what the
	// `data` handler calls per chunk.
	for (const [name, append] of [
		["grep", appendCappedGrepStderr],
		["find", appendCappedFindStderr],
	] as const) {
		it(`${name}: accumulation never exceeds the 64KB ceiling under a flood`, () => {
			let stderr = "";
			// 200 chunks of 1KB = ~200KB of incoming warnings — far over the cap.
			const chunk = "x".repeat(1024);
			for (let i = 0; i < 200; i++) {
				stderr = append(stderr, chunk);
			}
			expect(stderr.length).toBe(MAX);
		});

		it(`${name}: keeps the HEAD so the first error line survives`, () => {
			let stderr = "";
			// The first line carries the actionable failure (e.g. "regex parse error").
			stderr = append(stderr, "regex parse error: unclosed group\n");
			// Then a flood of trailing noise that must be dropped, not the head.
			for (let i = 0; i < 200; i++) {
				stderr = append(stderr, "y".repeat(1024));
			}
			expect(stderr.length).toBe(MAX);
			expect(stderr.startsWith("regex parse error: unclosed group")).toBe(true);
		});

		it(`${name}: small stderr is passed through byte-identical (no cap behavior)`, () => {
			const msg = "permission denied: /root/secret\n";
			const stderr = append("", msg);
			expect(stderr).toBe(msg);
		});
	}
});
