/**
 * The optional in-process `@ast-grep/napi` backend (ast_grep engine: "napi")
 * must produce the same matches the ast-grep CLI does, and the tool must fall
 * back to the CLI for everything the napi backend can't serve (no/unsupported
 * lang, globs, context). Parity vs the CLI was validated in a benchmark; here we
 * assert the napi backend's results + the language gate hermetically (no CLI on
 * PATH required).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAstGrepToolDefinition } from "../src/core/tools/ast-grep.ts";
import { astGrepNapiSearch, isAstGrepNapiAvailable, isNapiSupportedLang } from "../src/core/tools/ast-grep-napi.ts";

const napiReady = await isAstGrepNapiAvailable();
const ctx = {} as Parameters<ReturnType<typeof createAstGrepToolDefinition>["execute"]>[4];

let root: string;

async function runAg(
	engine: "napi" | "cli",
	args: { pattern: string; lang?: string; path?: string },
): Promise<{ text: string; matchCount: number }> {
	const def = createAstGrepToolDefinition(root, { engine });
	const res = (await def.execute("t", args, undefined, undefined, ctx)) as {
		content: Array<{ type: string; text?: string }>;
		details?: { matchCount?: number };
	};
	return { text: res.content[0]?.text ?? "", matchCount: res.details?.matchCount ?? 0 };
}

beforeAll(() => {
	root = mkdtempSync(path.join(tmpdir(), "ag-napi-"));
	mkdirSync(path.join(root, "sub"), { recursive: true });
	writeFileSync(path.join(root, "a.ts"), ["arr.push(x);", "list.push(y);"].join("\n"));
	writeFileSync(path.join(root, "b.ts"), "foo.push(bar);\n");
	writeFileSync(path.join(root, "sub", "c.ts"), "q.push(z);\n");
});

afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

describe("ast_grep napi backend", () => {
	it("maps built-in languages and rejects non-bundled / missing lang", () => {
		expect(isNapiSupportedLang("ts")).toBe(true);
		expect(isNapiSupportedLang("TSX")).toBe(true);
		expect(isNapiSupportedLang("js")).toBe(true);
		expect(isNapiSupportedLang("py")).toBe(false);
		expect(isNapiSupportedLang("rs")).toBe(false);
		expect(isNapiSupportedLang(undefined)).toBe(false);
	});

	it.skipIf(!napiReady)("astGrepNapiSearch returns null for an unsupported language", async () => {
		const res = await astGrepNapiSearch({ pattern: "$A.push($B)", lang: "py", target: root });
		expect(res).toBeNull();
	});

	it.skipIf(!napiReady)("napi engine finds structural matches across the repo", async () => {
		const { text, matchCount } = await runAg("napi", { pattern: "$A.push($B)", lang: "ts" });
		expect(matchCount).toBe(4);
		// grouped by file with 1-based line:col locations.
		expect(text).toContain("a.ts");
		expect(text).toContain("b.ts");
		expect(text).toContain("sub/c.ts");
		expect(text).toContain("1:1: arr.push(x)");
		expect(text).toContain("2:1: list.push(y)");
	});

	it.skipIf(!napiReady)("napi engine scopes to a subdirectory", async () => {
		const { text, matchCount } = await runAg("napi", { pattern: "$A.push($B)", lang: "ts", path: "sub" });
		expect(matchCount).toBe(1);
		expect(text).toContain("c.ts");
		expect(text).not.toContain("a.ts");
	});

	it.skipIf(!napiReady)("napi engine reports no matches cleanly for an absent pattern", async () => {
		const { text, matchCount } = await runAg("napi", { pattern: "$A.nonexistentCall($B)", lang: "ts" });
		expect(matchCount).toBe(0);
		expect(text).toBe("No matches found");
	});
});
