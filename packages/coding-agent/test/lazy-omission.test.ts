import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.js";
import { detectCodeOmission, formatOmissionWarning, isOmissionCheckEnabled } from "../src/core/tools/lazy-omission.js";
import { createWriteToolDefinition } from "../src/core/tools/write.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-lazy-omission-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	delete process.env.PIT_NO_OMISSION_CHECK;
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("detectCodeOmission — positives (new placeholder vs empty original)", () => {
	const cases = [
		"// rest of the code remains unchanged",
		"// ... existing code ...",
		"  // previous implementation",
		"/* unchanged */",
		"/* ... unchanged ... */",
		"// unchanged",
		"# untouched",
		"<!-- elided -->",
		"# rest of the function",
		"<!-- ... existing ... -->",
		"    # ... existing code ...",
		"-- existing code here",
		"  * ... existing code ...",
		"// code goes here",
		"// (rest of the file omitted for brevity)",
		"<!-- previous content unchanged -->",
		"// same as before",
		"// keep the rest",
		"// keep rest",
		"// leave the rest unchanged",
		"# preserve the rest of the file",
		// Genuine "keep/preserve <existing|original|…> code" must still fire via the
		// "<existing|previous|…> <code|…>" alternative even though the bare
		// keep/leave/preserve targets were tightened to "rest" only.
		"// preserve existing code",
		"// keep existing implementation",
		"// leave remaining lines",
		"# keep original content",
	];
	for (const line of cases) {
		it(`flags ${JSON.stringify(line)}`, () => {
			expect(detectCodeOmission("", line).detected).toBe(true);
		});
	}
});

describe("detectCodeOmission — negatives (must not fire)", () => {
	const cases = [
		"// TODO: refactor",
		"// NOTE: this is important",
		"const existing = getExisting();",
		"let rest = arr.slice(1);",
		"function previousValue() {}",
		"# load the config from disk",
		"x = 1; // increment",
		"const code = compile();",
		"// returns unchanged data when the input matches",
		"// the value remains the same object reference",
		"// this is the same logic we use elsewhere",
		"return unchanged;",
		"// existingUser is fetched above",
		// keep/leave/preserve + a NON-elision noun must NOT fire: these are ordinary
		// comments with no actual elision (regression for the tightened alternative
		// that previously matched "keep existing X" / "preserve original X" on any noun).
		"// keep existing behavior in mind",
		"// preserve original timestamps on copy",
		"// keep existing connections alive",
		"// leave remaining slots empty",
		"// keep previous selection highlighted",
		"// preserve original order of the items",
		"",
	];
	for (const line of cases) {
		it(`does not flag ${JSON.stringify(line)}`, () => {
			expect(detectCodeOmission("", line).detected).toBe(false);
		});
	}
});

describe("detectCodeOmission — original-aware behaviour", () => {
	it("does not fire when the placeholder already existed in the original", () => {
		const original = "function f() {\n  // ... existing code ...\n  return 1;\n}";
		const result = detectCodeOmission(original, original);
		expect(result.detected).toBe(false);
	});

	it("fires when an edit introduces a NEW placeholder", () => {
		const oldContent = "function f() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}";
		const newContent = "function f() {\n  const a = 1;\n  // rest of the code remains unchanged\n}";
		const result = detectCodeOmission(oldContent, newContent);
		expect(result.detected).toBe(true);
		expect(result.markers).toEqual(["// rest of the code remains unchanged"]);
	});

	it("treats a brand-new file (empty original) placeholder as suspect", () => {
		const file = 'import x from "y";\n\nexport function g() {\n  // ... existing code ...\n}\n';
		const result = detectCodeOmission("", file);
		expect(result.detected).toBe(true);
	});

	it("dedupes repeated placeholder lines and caps the marker list", () => {
		const many = Array.from({ length: 30 }, () => "// ... existing code ...").join("\n");
		const result = detectCodeOmission("", many);
		expect(result.markers).toHaveLength(1);
	});

	it("reports multiple distinct placeholders", () => {
		const content = "// ... existing code ...\nfoo();\n// rest of the function unchanged\n";
		const result = detectCodeOmission("", content);
		expect(result.markers.length).toBeGreaterThanOrEqual(2);
	});
});

describe("isOmissionCheckEnabled", () => {
	it("is enabled by default", () => {
		delete process.env.PIT_NO_OMISSION_CHECK;
		expect(isOmissionCheckEnabled()).toBe(true);
	});

	it("is disabled when PIT_NO_OMISSION_CHECK is set", () => {
		process.env.PIT_NO_OMISSION_CHECK = "1";
		expect(isOmissionCheckEnabled()).toBe(false);
	});
});

describe("formatOmissionWarning", () => {
	it("returns empty string when nothing detected", () => {
		expect(formatOmissionWarning({ detected: false, markers: [] }, "src/foo.ts")).toBe("");
	});

	it("includes the relative path and each marker", () => {
		const text = formatOmissionWarning({ detected: true, markers: ["// ... existing code ..."] }, "src/foo.ts");
		expect(text).toContain("src/foo.ts");
		expect(text).toContain("// ... existing code ...");
		expect(text).toContain("Possible truncated edit");
	});
});

describe("edit tool integration", () => {
	it("appends an omission warning when an edit introduces a placeholder", async () => {
		const dir = await createTempDir();
		await writeFile(
			join(dir, "a.ts"),
			"export function f() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n",
			"utf-8",
		);
		const edit = createEditToolDefinition(dir);
		const ctx = {} as Parameters<typeof edit.execute>[4];
		const result = (await edit.execute(
			"id",
			{
				path: "a.ts",
				edits: [{ oldText: "const b = 2;\n  return a + b;", newText: "// rest of the code remains unchanged" }],
			},
			undefined,
			undefined,
			ctx,
		)) as { content: Array<{ type: string; text?: string }> };
		expect(result.content[0]?.text).toContain("Possible truncated edit");
	});

	it("does not append a warning on a clean edit", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "a.ts"), "export const x = 1;\n", "utf-8");
		const edit = createEditToolDefinition(dir);
		const ctx = {} as Parameters<typeof edit.execute>[4];
		const result = (await edit.execute(
			"id",
			{
				path: "a.ts",
				edits: [{ oldText: "export const x = 1;", newText: "export const x = 2;" }],
			},
			undefined,
			undefined,
			ctx,
		)) as { content: Array<{ type: string; text?: string }> };
		expect(result.content[0]?.text).not.toContain("Possible truncated edit");
	});

	it("respects PIT_NO_OMISSION_CHECK", async () => {
		process.env.PIT_NO_OMISSION_CHECK = "1";
		const dir = await createTempDir();
		await writeFile(join(dir, "a.ts"), "export const x = 1;\n", "utf-8");
		const edit = createEditToolDefinition(dir);
		const ctx = {} as Parameters<typeof edit.execute>[4];
		const result = (await edit.execute(
			"id",
			{
				path: "a.ts",
				edits: [{ oldText: "export const x = 1;", newText: "// ... existing code ..." }],
			},
			undefined,
			undefined,
			ctx,
		)) as { content: Array<{ type: string; text?: string }> };
		expect(result.content[0]?.text).not.toContain("Possible truncated edit");
	});
});

describe("write tool integration", () => {
	it("appends an omission warning when a new file contains a placeholder", async () => {
		const dir = await createTempDir();
		const write = createWriteToolDefinition(dir);
		const ctx = {} as Parameters<typeof write.execute>[4];
		const result = (await write.execute(
			"id",
			{
				path: "b.ts",
				content: "export function g() {\n  // ... existing code ...\n}\n",
			},
			undefined,
			undefined,
			ctx,
		)) as { content: Array<{ type: string; text?: string }> };
		expect(result.content[0]?.text).toContain("Possible truncated edit");
	});

	it("does not append a warning on a clean write", async () => {
		const dir = await createTempDir();
		const write = createWriteToolDefinition(dir);
		const ctx = {} as Parameters<typeof write.execute>[4];
		const result = (await write.execute(
			"id",
			{ path: "c.ts", content: "export const y = 3;\n" },
			undefined,
			undefined,
			ctx,
		)) as { content: Array<{ type: string; text?: string }> };
		expect(result.content[0]?.text).not.toContain("Possible truncated edit");
	});

	it("respects PIT_NO_OMISSION_CHECK", async () => {
		process.env.PIT_NO_OMISSION_CHECK = "1";
		const dir = await createTempDir();
		const write = createWriteToolDefinition(dir);
		const ctx = {} as Parameters<typeof write.execute>[4];
		const result = (await write.execute(
			"id",
			{ path: "d.ts", content: "// ... existing code ...\n" },
			undefined,
			undefined,
			ctx,
		)) as { content: Array<{ type: string; text?: string }> };
		expect(result.content[0]?.text).not.toContain("Possible truncated edit");
	});
});
