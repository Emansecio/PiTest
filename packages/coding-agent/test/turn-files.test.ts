/**
 * The turn's file ledger: counting, labelling, drawing, and the mode-side
 * accumulation that feeds it.
 */

import { visibleWidth } from "@pit/tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import {
	countDiffLines,
	labelPaths,
	type TurnFileEntry,
	TurnFilesComponent,
} from "../src/modes/interactive/components/turn-files.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

/** The edit tool's diff format: sign + padded line number + text. */
const DIFF = ["+ 12 const a = 1;", "+ 13 const b = 2;", "  14 unchanged", "- 15 const old = 0;"].join("\n");

function proto<T>(name: string): T {
	return Reflect.get(InteractiveMode.prototype, name) as T;
}

describe("countDiffLines", () => {
	test("counts added and removed rows, ignoring context", () => {
		expect(countDiffLines(DIFF)).toEqual({ added: 2, removed: 1 });
	});

	test("a missing diff is zero, not a crash — `write` reports none", () => {
		expect(countDiffLines(undefined)).toEqual({ added: 0, removed: 0 });
		expect(countDiffLines("")).toEqual({ added: 0, removed: 0 });
	});
});

describe("labelPaths", () => {
	test("uses the basename when it is unambiguous", () => {
		expect(labelPaths(["src/a/MissionBar.tsx", "src/b/tokens.css"])).toEqual(["MissionBar.tsx", "tokens.css"]);
	});

	test("disambiguates colliding basenames with the parent directory", () => {
		expect(labelPaths(["src/a/notes.md", "src/b/notes.md", "other/app.tsx"])).toEqual([
			"a/notes.md",
			"b/notes.md",
			"app.tsx",
		]);
	});

	/**
	 * The monorepo case, which one parent level does NOT solve: these two share the
	 * parent too, so stopping there renders `src/index.ts` twice — two identical
	 * rows in a rail whose whole job is saying which files were touched.
	 */
	test("climbs past a shared parent until the labels are actually distinct", () => {
		expect(labelPaths(["packages/ui/src/index.ts", "packages/tui/src/index.ts", "other/app.tsx"])).toEqual([
			"ui/src/index.ts",
			"tui/src/index.ts",
			"app.tsx",
		]);
	});

	test("only the colliding rows pay for the extra path", () => {
		expect(labelPaths(["a/x/deep/index.ts", "b/y/deep/index.ts", "solo.ts"])).toEqual([
			"x/deep/index.ts",
			"y/deep/index.ts",
			"solo.ts",
		]);
	});

	test("identical paths settle at the full path instead of looping", () => {
		expect(labelPaths(["a/b.ts", "a/b.ts"])).toEqual(["a/b.ts", "a/b.ts"]);
	});

	test("handles windows separators", () => {
		expect(labelPaths(["packages\\ui\\App.tsx"])).toEqual(["App.tsx"]);
		expect(labelPaths(["packages\\ui\\src\\index.ts", "packages\\tui\\src\\index.ts"])).toEqual([
			"ui/src/index.ts",
			"tui/src/index.ts",
		]);
	});
});

describe("TurnFilesComponent", () => {
	function render(entries: TurnFileEntry[], width = 34): string[] {
		const c = new TurnFilesComponent();
		c.setEntries(entries);
		return c.render(width).map(stripAnsi);
	}

	test("renders nothing when the turn changed no files (auto-hide)", () => {
		expect(render([])).toEqual([]);
	});

	test("heads the list with a count and lists file + counters", () => {
		const lines = render([
			{ path: "packages/ui/MissionBar.tsx", added: 42, removed: 0 },
			{ path: "packages/ui/tokens.css", added: 3, removed: 61 },
		]);
		expect(lines[0]).toBe("2 files this turn");
		expect(lines[1]).toContain("MissionBar.tsx");
		expect(lines[1]).toContain("+42 −0");
		expect(lines[2]).toContain("+3 −61");
		// Counters line up in a column: every row ends at the same width.
		expect(lines[1]).toHaveLength(lines[2]!.length);
	});

	test("singular header for one file", () => {
		expect(render([{ path: "a.ts", added: 1, removed: 0 }])[0]).toBe("1 file this turn");
	});

	/**
	 * The cap is a layout guarantee, not a nicety: the rail shares a band with the
	 * live composer, so the band's WORST case is how far the editor can be pushed
	 * down while someone types into it.
	 */
	test("caps the list and reports the tail", () => {
		const entries = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, added: 1, removed: 0 }));
		const lines = render(entries);
		expect(lines[0]).toBe("10 files this turn");
		expect(lines).toHaveLength(1 + 5 + 1); // header + rows + tail
		expect(lines.at(-1)).toBe("+5 more");
	});

	test("no ledger can push the band past the capped height", () => {
		const entries = Array.from({ length: 400 }, (_, i) => ({ path: `f${i}.ts`, added: 1, removed: 0 }));
		expect(render(entries)).toHaveLength(7);
	});

	test("keeps the identifying end of a long name and never exceeds the width", () => {
		const lines = render([{ path: "src/AVeryLongComponentNameIndeed.tsx", added: 1, removed: 1 }]);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(34);
		expect(lines[1]).toContain("Indeed.tsx"); // tail survived, head elided
	});

	/**
	 * `slice(-n)` counts UTF-16 code units; the column budget is in display width.
	 * A CJK name is two columns per character, so the naive cut overshoots by up to
	 * 2× — the row then outgrows the rail and the counters fall off the end.
	 */
	test("a wide-character name is cut to the column budget, not the code-unit count", () => {
		const lines = render([{ path: "src/日本語のとても長いファイル名.ts", added: 1, removed: 1 }]);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(34);
		expect(lines[1]).toContain("+1 −1"); // counters survived, so the layout held
	});

	test("an astral-character name is never cut through a surrogate pair", () => {
		// A high surrogate with no low after it (or the mirror) is half a character:
		// what a code-unit slice leaves behind, and what the terminal renders as �.
		const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
		const lines = render([{ path: `src/${"🎉".repeat(30)}.ts`, added: 1, removed: 1 }]);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(34);
			expect(line).not.toMatch(LONE_SURROGATE);
		}
	});

	/** A label widened to break a collision loses its point if the cut eats the head. */
	test("a disambiguated label keeps both ends when it cannot fit whole", () => {
		const lines = render(
			[
				{ path: "packages/tui/src/components/a-rather-long-name.ts", added: 1, removed: 1 },
				{ path: "packages/ui/src/components/a-rather-long-name.ts", added: 1, removed: 1 },
			],
			34,
		);
		expect(lines[1]).toContain("tui/");
		expect(lines[2]).toContain("ui/");
		expect(lines[1]).toContain("a-rather-long-name.ts");
	});

	test("drops the counters before the name when the rail is very narrow", () => {
		const lines = render([{ path: "src/MissionBar.tsx", added: 1, removed: 1 }], 14);
		expect(lines[1]).not.toContain("+1");
		expect(lines[1]).toContain("MissionBar");
	});
});

describe("InteractiveMode turn ledger", () => {
	const recordTurnFile = proto<(this: any, toolName: string, component: any) => void>("recordTurnFile");
	const resetTurnFileLedger = proto<(this: any) => void>("resetTurnFileLedger");

	function fakeThis() {
		return {
			turnFiles: new TurnFilesComponent(),
			turnFileLedger: new Map<string, TurnFileEntry>(),
			ui: { requestRender: vi.fn() },
			// Collaborators recordTurnFile reaches through `this`.
			reportedTurnFiles: proto<(this: any, d: unknown) => unknown>("reportedTurnFiles"),
			argsTurnFile: proto<(this: any, c: unknown, d: unknown) => unknown>("argsTurnFile"),
		};
	}

	function exec(path: string, diff?: string) {
		return { getArgs: () => ({ path }), getResultDetails: () => (diff ? { diff } : undefined) };
	}

	/** A tool that reports its own per-file deltas (ast_edit's applied branch). */
	function multiFileExec(path: string | undefined, details: unknown) {
		return { getArgs: () => (path === undefined ? {} : { path }), getResultDetails: () => details };
	}

	test("records an edit with its diff counts", () => {
		const self = fakeThis();
		recordTurnFile.call(self, "edit", exec("src/a.ts", DIFF));
		expect([...self.turnFileLedger.values()]).toEqual([{ path: "src/a.ts", added: 2, removed: 1 }]);
	});

	test("re-editing a file accumulates in its original slot", () => {
		const self = fakeThis();
		recordTurnFile.call(self, "edit", exec("a.ts", DIFF));
		recordTurnFile.call(self, "edit", exec("b.ts", DIFF));
		recordTurnFile.call(self, "edit", exec("a.ts", "+ 30 more"));
		const entries = [...self.turnFileLedger.values()];
		expect(entries.map((e) => e.path)).toEqual(["a.ts", "b.ts"]); // order of first touch
		expect(entries[0]).toEqual({ path: "a.ts", added: 3, removed: 1 });
	});

	test("`write` lands as a touch with no counters rather than a guess", () => {
		const self = fakeThis();
		recordTurnFile.call(self, "write", exec("new.ts"));
		expect([...self.turnFileLedger.values()]).toEqual([{ path: "new.ts", added: 0, removed: 0 }]);
	});

	test("ignores tools that cannot be attributed to a path", () => {
		const self = fakeThis();
		recordTurnFile.call(self, "bash", exec("irrelevant"));
		recordTurnFile.call(self, "read", exec("a.ts", DIFF));
		recordTurnFile.call(self, "edit", exec("   ")); // blank path
		expect(self.turnFileLedger.size).toBe(0);
	});

	/**
	 * `ast_edit` rewrites a match set, not a path: its `path` is optional and
	 * defaults to the whole cwd, so reading the args gives either nothing or a row
	 * for `.`. Its applied branch reports per-file deltas instead — and ONLY its
	 * applied branch, so a dry-run cannot enter a ledger of what changed.
	 */
	describe("multi-file tools report their own files", () => {
		const FILES = [
			{ path: "packages/ui/src/index.ts", added: 4, removed: 2 },
			{ path: "packages/tui/src/index.ts", added: 1, removed: 1 },
		];

		test("records every file an ast_edit rewrote, with its own counts", () => {
			const self = fakeThis();
			recordTurnFile.call(self, "ast_edit", multiFileExec(undefined, { replacementCount: 5, files: FILES }));
			expect([...self.turnFileLedger.values()]).toEqual(FILES);
		});

		test("a second rewrite of the same file accumulates", () => {
			const self = fakeThis();
			recordTurnFile.call(self, "ast_edit", multiFileExec(".", { files: [FILES[0]] }));
			recordTurnFile.call(self, "ast_edit", multiFileExec(".", { files: [FILES[0]] }));
			expect([...self.turnFileLedger.values()]).toEqual([
				{ path: "packages/ui/src/index.ts", added: 8, removed: 4 },
			]);
		});

		test("a dry-run reports no files, and must not fall back to the `.` it searched", () => {
			const self = fakeThis();
			// Exactly what the dry-run branch returns: a diff, a count, no `files`.
			recordTurnFile.call(self, "ast_edit", multiFileExec(".", { replacementCount: 3, diff: DIFF }));
			expect(self.turnFileLedger.size).toBe(0);
		});

		test("malformed entries are skipped, not trusted", () => {
			const self = fakeThis();
			recordTurnFile.call(
				self,
				"ast_edit",
				multiFileExec(undefined, { files: [null, { path: "  " }, { path: "ok.ts" }, "nope"] }),
			);
			expect([...self.turnFileLedger.values()]).toEqual([{ path: "ok.ts", added: 0, removed: 0 }]);
		});
	});

	test("a new turn empties the ledger and the panel", () => {
		const self = fakeThis();
		recordTurnFile.call(self, "edit", exec("a.ts", DIFF));
		expect(self.turnFiles.render(34)).not.toEqual([]);
		resetTurnFileLedger.call(self);
		expect(self.turnFileLedger.size).toBe(0);
		expect(self.turnFiles.render(34)).toEqual([]);
	});
});
