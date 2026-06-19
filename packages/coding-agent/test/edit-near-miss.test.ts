import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.js";
import {
	applyEditsToNormalizedContent,
	buildCandidateMatches,
	buildNearMissHint,
	formatCandidateMatchesForError,
	indentTolerantFind,
	reindentText,
} from "../src/core/tools/edit-diff.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-edit-tier3-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("applyEditsToNormalizedContent replaceAll", () => {
	it("replaces every occurrence when replaceAll is true", () => {
		const content = "const x = old; foo(old); return old;\n";
		const { newContent } = applyEditsToNormalizedContent(
			content,
			[{ oldText: "old", newText: "neo", replaceAll: true }],
			"f.ts",
		);
		expect(newContent).toBe("const x = neo; foo(neo); return neo;\n");
	});

	it("still throws a duplicate error when replaceAll is absent and the text is not unique", () => {
		const content = "a old b old c\n";
		expect(() => applyEditsToNormalizedContent(content, [{ oldText: "old", newText: "neo" }], "f.ts")).toThrow(
			/occurrences/i,
		);
	});

	it("the duplicate error names the occurrence line numbers", () => {
		const content = "line one foo\nline two\nline three foo\nfoo again\n";
		try {
			applyEditsToNormalizedContent(content, [{ oldText: "foo", newText: "bar" }], "f.ts");
			throw new Error("should have thrown");
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toMatch(/Occurrences at line\(s\): 1, 3, 4/);
		}
	});

	it("replaceAll on a unique occurrence behaves like a normal single replace", () => {
		const content = "only one here\n";
		const { newContent } = applyEditsToNormalizedContent(
			content,
			[{ oldText: "one", newText: "1", replaceAll: true }],
			"f.ts",
		);
		expect(newContent).toBe("only 1 here\n");
	});
});

describe("buildNearMissHint", () => {
	it("returns null when content and oldText share no lines", () => {
		const hint = buildNearMissHint("alpha\nbeta\n", "totally\nunrelated\n");
		expect(hint).toBeNull();
	});

	it("returns null when oldText would match perfectly", () => {
		const hint = buildNearMissHint("alpha\nbeta\n", "alpha\nbeta\n");
		expect(hint).toBeNull();
	});

	it("locates the closest window and reports first divergence", () => {
		const content = ["function foo() {", "  return 1;", "  return 2;", "}"].join("\n");
		const oldText = ["function foo() {", "  return 999;", "  return 2;", "}"].join("\n");
		const hint = buildNearMissHint(content, oldText);
		expect(hint).not.toBeNull();
		expect(hint).toContain("First divergence at line 2");
		expect(hint).toContain("expected: ");
		expect(hint).toContain("found:    ");
	});

	it("reports the candidate line number 1-indexed", () => {
		const content = "header\nA\nB\nC\nD\n";
		const oldText = "A\nB\nX\nD\n"; // matches starting at line 2
		const hint = buildNearMissHint(content, oldText);
		expect(hint).not.toBeNull();
		expect(hint).toMatch(/Closest candidate starts at line 2/);
		expect(hint).toMatch(/First divergence at line 4/);
	});
});

describe("buildCandidateMatches", () => {
	it("returns empty when nothing in content lines up with oldText", () => {
		const candidates = buildCandidateMatches("alpha\nbeta\ngamma\n", "totally\nunrelated\nblock\n");
		expect(candidates).toEqual([]);
	});

	it("ships a copy-pasteable verbatim snippet covering the match window", () => {
		const content = ["function foo() {", "  return 1;", "  return 2;", "}"].join("\n");
		const oldText = ["function foo() {", "  return 999;", "  return 2;", "}"].join("\n");
		const candidates = buildCandidateMatches(content, oldText);
		expect(candidates.length).toBeGreaterThan(0);
		const top = candidates[0];
		expect(top.startLine).toBe(1);
		expect(top.endLine).toBe(4);
		expect(top.verbatimSnippet).toBe(content);
		expect(top.score).toBe(3);
		expect(top.windowSize).toBe(4);
		expect(top.divergenceLine).toBe(2);
	});

	it("formatCandidateMatchesForError renders each candidate block", () => {
		const content = ["function foo() {", "  return 1;", "  return 2;", "}"].join("\n");
		const oldText = ["function foo() {", "  return 999;", "  return 2;", "}"].join("\n");
		const formatted = formatCandidateMatchesForError(buildCandidateMatches(content, oldText));
		expect(formatted).not.toBeNull();
		expect(formatted ?? "").toContain("Candidate 1");
		expect(formatted ?? "").toContain("Paste this verbatim as oldText");
		expect(formatted ?? "").toContain("─────");
	});
});

describe("indentTolerantFind", () => {
	it("matches when only leading whitespace differs", () => {
		const content = ["function foo() {", "\treturn 1;", "}"].join("\n");
		const oldText = ["function foo() {", "    return 1;", "}"].join("\n");
		const match = indentTolerantFind(content, oldText);
		expect(match).not.toBeNull();
		// Transform is detected from the first non-blank line whose indent differs.
		expect(match?.fromIndent).toBe("    ");
		expect(match?.toIndent).toBe("\t");
		expect(content.slice(match!.index, match!.index + match!.matchLength)).toBe(content);
	});

	it("returns null on ambiguity", () => {
		const content = ["one", "two", "one", "two"].join("\n");
		const oldText = ["one", "two"].join("\n");
		expect(indentTolerantFind(content, oldText)).toBeNull();
	});

	it("returns null when there is no match", () => {
		expect(indentTolerantFind("alpha\nbeta\n", "gamma\n")).toBeNull();
	});

	it("requires blank-line alignment", () => {
		const content = "a\n\nb\n";
		const oldText = "a\nb\n"; // missing blank line
		expect(indentTolerantFind(content, oldText)).toBeNull();
	});
});

describe("reindentText", () => {
	it("rewrites leading whitespace per line", () => {
		const text = "    a\n    b\n";
		expect(reindentText(text, "    ", "\t")).toBe("\ta\n\tb\n");
	});

	it("preserves blank lines", () => {
		const text = "    a\n\n    b\n";
		expect(reindentText(text, "    ", "\t")).toBe("\ta\n\n\tb\n");
	});

	it("returns identical text when indents match", () => {
		const text = "  a\n  b\n";
		expect(reindentText(text, "  ", "  ")).toBe(text);
	});
});

describe("applyEditsToNormalizedContent: indent-tolerant tier", () => {
	it("applies edit when only leading indentation differs", async () => {
		const file = join(dir, "src.ts");
		writeFileSync(file, "function foo() {\n\treturn 1;\n}\n", "utf8");

		const def = createEditToolDefinition(dir);
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute(
			"c",
			{
				path: file,
				edits: [
					{
						oldText: "function foo() {\n    return 1;\n}",
						newText: "function foo() {\n    return 42;\n}",
					},
				],
			},
			undefined,
			undefined,
			ctx,
		)) as { content: Array<{ type: string; text?: string }> };
		expect(result.content[0]?.text).toMatch(/Successfully replaced 1 block/);
		expect(readFileSync(file, "utf8")).toBe("function foo() {\n\treturn 42;\n}\n");
	});

	it("emits near-miss hint when nothing matches", () => {
		const file = join(dir, "src.ts");
		writeFileSync(file, "function foo() {\n  return 1;\n}\n", "utf8");

		const def = createEditToolDefinition(dir);
		const ctx = {} as Parameters<typeof def.execute>[4];
		return expect(
			def.execute(
				"c",
				{
					path: file,
					edits: [
						{
							oldText: "function foo() {\n  return WRONG;\n}",
							newText: "function foo() {\n  return 2;\n}",
						},
					],
				},
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow(/first divergence at line 2/i);
	});
});

describe("applyEditsToNormalizedContent: helper smoke", () => {
	it("still applies exact matches without firing tier-3", () => {
		const out = applyEditsToNormalizedContent("alpha\nbeta\n", [{ oldText: "beta", newText: "gamma" }], "f.txt");
		expect(out.newContent).toBe("alpha\ngamma\n");
	});
});
