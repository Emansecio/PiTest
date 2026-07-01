import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { groundSummaryPaths } from "../src/core/compaction/summary-grounding.js";
import type { OperationLists } from "../src/core/compaction/utils.js";

function emptyLists(): OperationLists {
	return { readFiles: [], modifiedFiles: [], searches: [], shellCmds: [], mcpCalls: [] };
}

function lists(readFiles: string[], modifiedFiles: string[] = []): OperationLists {
	return { readFiles, modifiedFiles, searches: [], shellCmds: [], mcpCalls: [] };
}

describe("groundSummaryPaths", () => {
	let tmpCwd: string;

	beforeEach(() => {
		tmpCwd = mkdtempSync(join(tmpdir(), "pit-grounding-"));
	});
	afterEach(() => {
		rmSync(tmpCwd, { recursive: true, force: true });
		delete process.env.PIT_NO_SUMMARY_GROUNDING;
	});

	it("leaves prose with no path tokens byte-identical", () => {
		const prose = "## Goal\nFix the verify pass.\n\n## Progress\n- Done editing.";
		const result = groundSummaryPaths(prose, emptyLists(), undefined);
		expect(result.summary).toBe(prose);
		expect(result.ungroundedPaths).toEqual([]);
	});

	it("leaves a path present in the readFiles list untouched (relative form)", () => {
		const prose = "Read src/core/compaction/compaction.ts to understand the pipeline.";
		const result = groundSummaryPaths(prose, lists(["src/core/compaction/compaction.ts"]), undefined);
		expect(result.summary).toBe(prose);
		expect(result.ungroundedPaths).toEqual([]);
	});

	it("leaves a path present in the modifiedFiles list untouched", () => {
		const prose = "Edited packages/coding-agent/src/foo.ts and tests/foo.test.ts.";
		const result = groundSummaryPaths(
			prose,
			lists([], ["packages/coding-agent/src/foo.ts", "tests/foo.test.ts"]),
			undefined,
		);
		expect(result.summary).toBe(prose);
		expect(result.ungroundedPaths).toEqual([]);
	});

	it("grounds a relative path cited in prose against an absolute list entry via suffix match", () => {
		// The list (post cwd-strip) is relative; the prose cites a relative path that
		// is a suffix of nothing here — instead verify list-relative vs prose-relative equality.
		const prose = "Touched src/foo.ts again.";
		const result = groundSummaryPaths(prose, lists(["src/foo.ts"]), undefined);
		expect(result.summary).toBe(prose);
		expect(result.ungroundedPaths).toEqual([]);
	});

	it("grounds a path that exists on disk but is not in the lists (filesystem fallback)", () => {
		const rel = "src/real.ts";
		mkdirSync(join(tmpCwd, "src"), { recursive: true });
		writeFileSync(join(tmpCwd, "src/real.ts"), "export const x = 1;");
		const prose = `Edited ${rel} to export x.`;
		const result = groundSummaryPaths(prose, emptyLists(), tmpCwd);
		expect(result.summary).toBe(prose);
		expect(result.ungroundedPaths).toEqual([]);
	});

	it("annotates a fabricated path with (unverified) and reports it", () => {
		const prose = "We then edited src/fabricated/ghost.ts to add the handler.";
		const result = groundSummaryPaths(prose, emptyLists(), tmpCwd);
		expect(result.summary).toBe("We then edited src/fabricated/ghost.ts (unverified) to add the handler.");
		expect(result.ungroundedPaths).toEqual(["src/fabricated/ghost.ts"]);
	});

	it("annotates only the FIRST occurrence of a repeated ungrounded path", () => {
		const prose = "First src/fake/a.ts was touched. Then src/fake/a.ts was read again.";
		const result = groundSummaryPaths(prose, emptyLists(), tmpCwd);
		expect(result.summary).toBe("First src/fake/a.ts (unverified) was touched. Then src/fake/a.ts was read again.");
		expect(result.ungroundedPaths).toEqual(["src/fake/a.ts"]);
	});

	it("annotates each distinct fabricated path once", () => {
		const prose = "Touched src/fake/a.ts and src/fake/b.ts.";
		const result = groundSummaryPaths(prose, emptyLists(), tmpCwd);
		expect(result.summary).toBe("Touched src/fake/a.ts (unverified) and src/fake/b.ts (unverified).");
		expect(result.ungroundedPaths).toEqual(["src/fake/a.ts", "src/fake/b.ts"]);
	});

	it("normalizes Windows backslash paths before grounding against the lists", () => {
		const prose = "Edited src\\win\\file.ts during the pass.";
		const result = groundSummaryPaths(prose, lists(["src/win/file.ts"]), undefined);
		expect(result.summary).toBe(prose);
		expect(result.ungroundedPaths).toEqual([]);
	});

	it("handles a Windows drive-absolute path grounded via the filesystem fallback", () => {
		// Create a real file under tmpCwd and cite it with a drive-absolute form by
		// resolving against tmpCwd; use the absolute path the OS reports.
		mkdirSync(join(tmpCwd, "src"), { recursive: true });
		const abs = join(tmpCwd, "src/drive.ts").replace(/\//g, "\\");
		writeFileSync(join(tmpCwd, "src/drive.ts"), "x");
		expect(existsSync(abs.replace(/\\/g, "/"))).toBe(true);
		const prose = `Edited ${abs} on Windows.`;
		const result = groundSummaryPaths(prose, emptyLists(), tmpCwd);
		expect(result.summary).toBe(prose);
		expect(result.ungroundedPaths).toEqual([]);
	});

	it("is a no-op when PIT_NO_SUMMARY_GROUNDING is set", () => {
		process.env.PIT_NO_SUMMARY_GROUNDING = "1";
		const prose = "Edited src/fabricated/ghost.ts.";
		const result = groundSummaryPaths(prose, emptyLists(), tmpCwd);
		expect(result.summary).toBe(prose);
		expect(result.ungroundedPaths).toEqual([]);
	});

	it("does not flag bare filenames without a directory separator", () => {
		const prose = "Renamed foo.ts and updated bar.test.ts.";
		const result = groundSummaryPaths(prose, emptyLists(), tmpCwd);
		// `foo.ts` and `bar.test.ts` have no separator → not matched → not flagged.
		expect(result.summary).toBe(prose);
		expect(result.ungroundedPaths).toEqual([]);
	});

	it("does not flag a grounded path that appears alongside a fabricated one", () => {
		mkdirSync(join(tmpCwd, "src"), { recursive: true });
		writeFileSync(join(tmpCwd, "src/real.ts"), "x");
		const prose = "Edited src/real.ts and src/fabricated/ghost.ts.";
		const result = groundSummaryPaths(prose, emptyLists(), tmpCwd);
		expect(result.summary).toBe("Edited src/real.ts and src/fabricated/ghost.ts (unverified).");
		expect(result.ungroundedPaths).toEqual(["src/fabricated/ghost.ts"]);
	});
});
