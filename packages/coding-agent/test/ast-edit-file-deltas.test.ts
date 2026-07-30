/**
 * Per-file line deltas for an applied `ast_edit`.
 *
 * The turn's file rail asks "what did this turn change?", and `ast_edit` is the
 * one whitelisted tool whose ARGUMENTS cannot answer: `path` is optional,
 * defaults to the whole cwd, and `globs` can spread a single call across a
 * package. What it does have is the match set — every match names its file and
 * carries both sides of the rewrite, so the accounting below is exact where
 * reading `args.path` produced either nothing or a row for `.`.
 */

import path from "node:path";
import { describe, expect, test } from "vitest";
import { fileDeltas } from "../src/core/tools/ast-edit.ts";

const CWD = path.resolve("/repo");
const abs = (rel: string): string => path.join(CWD, rel);

describe("fileDeltas", () => {
	test("counts both sides of each rewrite, per file", () => {
		expect(
			fileDeltas(
				[
					{ file: abs("src/a.ts"), lines: "const a = 1;", replacement: "const a: number = 1;" },
					{ file: abs("src/b.ts"), lines: "x();\ny();", replacement: "z();" },
				],
				CWD,
			),
		).toEqual([
			{ path: "src/a.ts", added: 1, removed: 1 },
			{ path: "src/b.ts", added: 1, removed: 2 },
		]);
	});

	test("accumulates every match of the same file into one row", () => {
		expect(
			fileDeltas(
				[
					{ file: abs("src/a.ts"), lines: "one", replacement: "uno" },
					{ file: abs("src/a.ts"), lines: "two", replacement: "dos\ndoubled" },
				],
				CWD,
			),
		).toEqual([{ path: "src/a.ts", added: 3, removed: 2 }]);
	});

	test("reports paths cwd-relative with forward slashes, like every other tool", () => {
		const [entry] = fileDeltas([{ file: abs("packages/ui/src/index.ts"), lines: "a", replacement: "b" }], CWD);
		expect(entry!.path).toBe("packages/ui/src/index.ts");
	});

	test("falls back to `text` when a match carries no `lines`", () => {
		expect(fileDeltas([{ file: abs("a.ts"), text: "old", replacement: "new" }], CWD)).toEqual([
			{ path: "a.ts", added: 1, removed: 1 },
		]);
	});

	test("a deletion is removals with no additions", () => {
		expect(fileDeltas([{ file: abs("a.ts"), lines: "gone", replacement: "" }], CWD)).toEqual([
			{ path: "a.ts", added: 0, removed: 1 },
		]);
	});

	test("matches with no file are skipped rather than bucketed under a fake path", () => {
		expect(fileDeltas([{ lines: "a", replacement: "b" }, { file: "" }], CWD)).toEqual([]);
	});

	test("no matches, no rows", () => {
		expect(fileDeltas([], CWD)).toEqual([]);
	});
});
