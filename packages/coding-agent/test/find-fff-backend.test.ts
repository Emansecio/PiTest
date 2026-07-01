/**
 * The optional `fff` backend (find.engine: "fff") must be behavior-identical to
 * fd on its supported subset, and must transparently fall back to fd when fff
 * returns null. These tests assert PARITY (same path set) on a fixture tree.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isFffAvailable } from "../src/core/tools/fff-search.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";

const fffReady = await isFffAvailable();
const ctx = {} as Parameters<ReturnType<typeof createFindToolDefinition>["execute"]>[4];

let root: string;

async function runFind(
	engine: "fd" | "fff",
	args: { pattern: string; path?: string; limit?: number },
): Promise<string> {
	const def = createFindToolDefinition(root, { engine });
	const res = (await def.execute("t", args, undefined, undefined, ctx)) as {
		content: Array<{ type: string; text?: string }>;
	};
	return res.content[0]?.text ?? "";
}

function plainList(output: string): string[] {
	if (output.startsWith("No files found")) return [];
	return output
		.split("\n")
		.map((l) => l.replace(/\\/g, "/").trim())
		.filter((l) => l && !l.startsWith("["))
		.sort();
}

beforeAll(() => {
	root = mkdtempSync(path.join(tmpdir(), "find-fff-"));
	mkdirSync(path.join(root, "sub"), { recursive: true });
	mkdirSync(path.join(root, "src", "nested"), { recursive: true });
	writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
	writeFileSync(path.join(root, "b.js"), "export const b = 1;\n");
	writeFileSync(path.join(root, ".hidden.ts"), "export const hidden = 1;\n");
	writeFileSync(path.join(root, "sub", "c.ts"), "export const c = 1;\n");
	writeFileSync(path.join(root, "src", "nested", "d.spec.ts"), "test();\n");
	execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
	writeFileSync(path.join(root, ".gitignore"), "ignored.ts\n");
	writeFileSync(path.join(root, "ignored.ts"), "ignored\n");
});

afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

describe("find fff backend", () => {
	it("fd engine finds basename glob matches", async () => {
		const fd = plainList(await runFind("fd", { pattern: "*.ts" }));
		expect(fd).toContain("a.ts");
		expect(fd).toContain(".hidden.ts");
		expect(fd).toContain("sub/c.ts");
	});

	it.skipIf(!fffReady)("fff engine matches fd exactly (basename glob parity)", async () => {
		const fd = plainList(await runFind("fd", { pattern: "*.ts" }));
		const fff = plainList(await runFind("fff", { pattern: "*.ts" }));
		expect(fff).toEqual(fd);
	});

	it.skipIf(!fffReady)("fff engine matches fd for path-containing glob", async () => {
		const fd = plainList(await runFind("fd", { pattern: "src/**/*.spec.ts" }));
		const fff = plainList(await runFind("fff", { pattern: "src/**/*.spec.ts" }));
		expect(fff).toEqual(fd);
	});

	it.skipIf(!fffReady)("fff engine matches fd in a subdir scope", async () => {
		const fd = plainList(await runFind("fd", { pattern: "*.ts", path: "sub" }));
		const fff = plainList(await runFind("fff", { pattern: "*.ts", path: "sub" }));
		expect(fff).toEqual(fd);
		expect(fff).toEqual(["c.ts"]);
	});

	it.skipIf(!fffReady)("fff engine excludes gitignored files like fd", async () => {
		const fd = plainList(await runFind("fd", { pattern: "ignored.ts" }));
		const fff = plainList(await runFind("fff", { pattern: "ignored.ts" }));
		expect(fff).toEqual(fd);
		expect(fff).toEqual([]);
	});

	it.skipIf(!fffReady)("fff engine matches fd when limit is reached", async () => {
		const fd = plainList(await runFind("fd", { pattern: "*.ts", limit: 2 }));
		const fff = plainList(await runFind("fff", { pattern: "*.ts", limit: 2 }));
		expect(fff.length).toBe(2);
		expect(fd.length).toBe(2);
		const all = plainList(await runFind("fd", { pattern: "*.ts", limit: 1000 }));
		for (const p of fff) expect(all).toContain(p);
		for (const p of fd) expect(all).toContain(p);
	});
});
