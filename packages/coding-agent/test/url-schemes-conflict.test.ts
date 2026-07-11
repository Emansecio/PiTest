import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	CONFLICT_SCAN_FILE_CAP,
	createConflictSchemeResolver,
	listConflictScanFiles,
} from "../src/core/url-schemes/conflict.js";
import { getUrlSchemeRegistry } from "../src/core/url-schemes/registry.js";
import { createReadTool } from "../src/index.js";

let workspace: string;
const resolver = createConflictSchemeResolver();

const fileA = "a.txt";
const fileB = "sub/b.txt";

const fileAContent = [
	"line 1",
	"<<<<<<< HEAD",
	"ours-a",
	"=======",
	"theirs-a",
	">>>>>>> branch",
	"line tail",
	"",
].join("\n");

const fileBContent = [
	"start",
	"<<<<<<< HEAD",
	"ours-b1",
	"|||||||  base",
	"base-b1",
	"=======",
	"theirs-b1",
	">>>>>>> branch",
	"middle",
	"<<<<<<< HEAD",
	"ours-b2",
	"=======",
	"theirs-b2",
	">>>>>>> branch",
	"end",
	"",
].join("\n");

beforeAll(() => {
	workspace = mkdtempSync(join(tmpdir(), "conflict-test-"));
	writeFileSync(join(workspace, fileA), fileAContent, "utf-8");
	mkdirSync(join(workspace, "sub"), { recursive: true });
	writeFileSync(join(workspace, fileB), fileBContent, "utf-8");
});

afterAll(() => {
	if (workspace) rmSync(workspace, { recursive: true, force: true });
});

describe("conflict:// scheme via registry", () => {
	test("registry parse() routes conflict://1 and conflict://* to the resolver", () => {
		const reg = getUrlSchemeRegistry();
		reg.register(resolver);
		const single = reg.parse("conflict://1");
		expect(single).toBeDefined();
		expect(single!.resolver.scheme).toBe("conflict");

		const all = reg.parse("conflict://*");
		expect(all).toBeDefined();
		expect(all!.resolver.scheme).toBe("conflict");
	});
});

describe("conflict:// scanner + read", () => {
	test("scanner picks up <<<<<<< blocks across the fixture", async () => {
		const out = await resolver.read(new URL("conflict://*"), { cwd: workspace });
		expect(out.kind).toBe("text");
		// a.txt (1 block) + b.txt (2 blocks) = 3 blocks total
		expect(out.content).toContain("conflict 1 of 3");
		expect(out.content).toContain("conflict 2 of 3");
		expect(out.content).toContain("conflict 3 of 3");
		expect(out.content).toContain(fileA);
		expect(out.content).toContain("sub/b.txt");
	});

	test("read conflict://1 returns formatted block text including markers", async () => {
		const out = await resolver.read(new URL("conflict://1"), { cwd: workspace });
		expect(out.kind).toBe("text");
		expect(out.content).toContain("<<<<<<<");
		expect(out.content).toContain("=======");
		expect(out.content).toContain(">>>>>>>");
		// a.txt sorts before sub/b.txt → conflict 1 should be from a.txt
		expect(out.content).toContain("ours-a");
		expect(out.content).toContain("theirs-a");
	});

	test("out-of-range index returns an error", async () => {
		const out = await resolver.read(new URL("conflict://99"), { cwd: workspace });
		expect(out.kind).toBe("error");
		expect(out.error).toMatch(/out of range/);
	});
});

describe("conflict:// write resolution", () => {
	function resetFixture(): void {
		writeFileSync(join(workspace, fileA), fileAContent, "utf-8");
		writeFileSync(join(workspace, fileB), fileBContent, "utf-8");
	}

	test("write conflict://1 with @ours resolves to the ours fragment", async () => {
		resetFixture();
		await resolver.write!(new URL("conflict://1"), "@ours", { cwd: workspace });
		const after = readFileSync(join(workspace, fileA), "utf-8");
		expect(after).toContain("ours-a");
		expect(after).not.toContain("theirs-a");
		expect(after).not.toContain("<<<<<<<");
	});

	test("write conflict://1 with @theirs resolves to the theirs fragment", async () => {
		resetFixture();
		await resolver.write!(new URL("conflict://1"), "@theirs", { cwd: workspace });
		const after = readFileSync(join(workspace, fileA), "utf-8");
		expect(after).toContain("theirs-a");
		expect(after).not.toContain("ours-a");
		expect(after).not.toContain("<<<<<<<");
	});

	test("write conflict://2 with @base resolves a diff3 conflict to base fragment", async () => {
		resetFixture();
		// Block 2 = first block in sub/b.txt (which has diff3 marker)
		await resolver.write!(new URL("conflict://2"), "@base", { cwd: workspace });
		const after = readFileSync(join(workspace, fileB), "utf-8");
		expect(after).toContain("base-b1");
		// Second conflict block in b.txt should still be present
		expect(after).toContain("<<<<<<<");
		expect(after).toContain("ours-b2");
	});

	test("bulk write conflict://* with @theirs resolves every block in the workspace", async () => {
		resetFixture();
		await resolver.write!(new URL("conflict://*"), "@theirs", { cwd: workspace });
		const afterA = readFileSync(join(workspace, fileA), "utf-8");
		const afterB = readFileSync(join(workspace, fileB), "utf-8");
		expect(afterA).not.toContain("<<<<<<<");
		expect(afterB).not.toContain("<<<<<<<");
		expect(afterA).toContain("theirs-a");
		expect(afterB).toContain("theirs-b1");
		expect(afterB).toContain("theirs-b2");
	});

	test("bulk write rejects custom content", async () => {
		resetFixture();
		await expect(resolver.write!(new URL("conflict://*"), "custom resolution", { cwd: workspace })).rejects.toThrow(
			/bulk/,
		);
	});
});

describe("conflict:// read via the read tool (URL-scheme truncation)", () => {
	test("a conflict block exceeding the read line budget is truncated with a continuation hint", async () => {
		const bigWorkspace = mkdtempSync(join(tmpdir(), "conflict-big-"));
		try {
			// 2500 "ours" lines pushes the formatted block past the read tool's
			// 2000-line default budget, exercising the truncateHead + continuation
			// hint path that URL-scheme reads previously bypassed entirely.
			const oursLines = Array.from({ length: 2500 }, (_, i) => `ours line ${i + 1}`);
			const bigContent = [
				"before",
				"<<<<<<< HEAD",
				...oursLines,
				"=======",
				"theirs line",
				">>>>>>> branch",
				"after",
				"",
			].join("\n");
			writeFileSync(join(bigWorkspace, "big.txt"), bigContent, "utf-8");

			getUrlSchemeRegistry().register(resolver);
			const readTool = createReadTool(bigWorkspace);
			const result = (await readTool.execute("t-conflict-trunc", { path: "conflict://1" })) as {
				content: Array<{ type: string; text?: string }>;
			};
			const text = result.content[0]?.text ?? "";

			expect(text).toContain("ours line 1");
			expect(text).not.toContain("ours line 2500");
			expect(text).toMatch(/\[Showing lines 1-\d+ of \d+.*Use offset=\d+ to continue\.\]/);
		} finally {
			rmSync(bigWorkspace, { recursive: true, force: true });
		}
	});
});

describe("conflict:// scan caps", () => {
	test("listConflictScanFiles stops at the hard file cap", async () => {
		const dir = mkdtempSync(join(tmpdir(), "conflict-cap-"));
		try {
			const cap = 25;
			for (let i = 0; i < cap + 40; i++) {
				writeFileSync(join(dir, `f${i}.txt`), "x\n", "utf-8");
			}
			const listed = await listConflictScanFiles(dir, cap);
			expect(listed.length).toBe(cap);
			expect(CONFLICT_SCAN_FILE_CAP).toBe(10_000);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
