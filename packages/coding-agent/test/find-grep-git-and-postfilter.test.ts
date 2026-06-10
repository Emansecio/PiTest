import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFindToolDefinition } from "../src/core/tools/find.js";
import { createGrepToolDefinition } from "../src/core/tools/grep.js";

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
});
