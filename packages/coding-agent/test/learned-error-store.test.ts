import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	aggregateLearnedErrors,
	type LearnedErrorEntry,
	normalizeArgsForFingerprint,
	normalizeErrorFingerprint,
	persistSessionLearnedErrors,
	truncateErrorSample,
} from "../src/core/learned-error-store.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-learned-errors-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("normalizeErrorFingerprint", () => {
	it("collapses whitespace and digits", () => {
		const result = normalizeErrorFingerprint("ENOENT: no such file at line 42, col 7");
		expect(result).toBe("ENOENT: no such file at line N, col N");
	});

	it("returns undefined for empty or whitespace-only input", () => {
		expect(normalizeErrorFingerprint(undefined)).toBeUndefined();
		expect(normalizeErrorFingerprint("")).toBeUndefined();
		expect(normalizeErrorFingerprint("   \n  ")).toBeUndefined();
	});

	it("length-caps with ellipsis", () => {
		const long = "x".repeat(200);
		const result = normalizeErrorFingerprint(long, 50);
		expect(result?.length).toBe(51); // 50 + ellipsis char
		expect(result?.endsWith("\u2026")).toBe(true);
	});
});

describe("normalizeArgsForFingerprint", () => {
	it("collapses runs of whitespace and trims string values", () => {
		expect(normalizeArgsForFingerprint({ command: "  rg   foo    bar  " })).toEqual({ command: "rg foo bar" });
	});

	it("folds path-separator style and drive-letter case in path-like values", () => {
		expect(normalizeArgsForFingerprint({ path: "C:\\repo\\a.ts" })).toEqual({ path: "c:/repo/a.ts" });
		// Already forward-slash / lowercase drive normalises to the same key.
		expect(normalizeArgsForFingerprint({ path: "c:/repo/a.ts" })).toEqual({ path: "c:/repo/a.ts" });
	});

	it("is idempotent", () => {
		const once = normalizeArgsForFingerprint({ command: "rg  foo C:\\x" });
		expect(normalizeArgsForFingerprint(once)).toEqual(once);
	});

	it("does not fold non-formatting whitespace (x = 1 stays distinct from x=1)", () => {
		expect(normalizeArgsForFingerprint({ oldText: "const x = 1" })).toEqual({ oldText: "const x = 1" });
		expect(normalizeArgsForFingerprint({ oldText: "const x=1" })).toEqual({ oldText: "const x=1" });
	});

	it("keeps genuinely different paths distinct", () => {
		expect(normalizeArgsForFingerprint({ path: "C:\\repo\\a.ts" })).not.toEqual(
			normalizeArgsForFingerprint({ path: "C:\\repo\\b.ts" }),
		);
	});

	it("recurses into arrays and nested objects, leaving non-strings untouched", () => {
		expect(
			normalizeArgsForFingerprint({ edits: [{ path: "A:\\x\\y" }], count: 3, flag: true, missing: null }),
		).toEqual({ edits: [{ path: "a:/x/y" }], count: 3, flag: true, missing: null });
	});

	it("does not treat a plain drive-less string as a path", () => {
		expect(normalizeArgsForFingerprint({ note: "See section 4" })).toEqual({ note: "See section 4" });
	});
});

describe("truncateErrorSample", () => {
	it("keeps text under the cap unchanged", () => {
		expect(truncateErrorSample("short")).toBe("short");
	});

	it("truncates and appends ellipsis above the cap", () => {
		const long = "y".repeat(300);
		const result = truncateErrorSample(long);
		expect(result.endsWith("\u2026")).toBe(true);
		expect(result.length).toBeLessThanOrEqual(241);
	});
});

describe("persistSessionLearnedErrors + aggregateLearnedErrors", () => {
	function sampleEntry(overrides: Partial<LearnedErrorEntry> = {}): LearnedErrorEntry {
		return {
			tool: "bash",
			fingerprint: "Command exited with code N",
			count: 1,
			sampleErrorText: "Command exited with code 2",
			...overrides,
		};
	}

	it("writes one file per session and aggregates back correctly", async () => {
		persistSessionLearnedErrors(dir, { sessionId: "s1", timestamp: "2026-05-28T01:00:00.000Z", cwd: "/x" }, [
			sampleEntry({ count: 3, fingerprint: "fp-a" }),
			sampleEntry({ count: 1, fingerprint: "fp-b" }),
		]);
		persistSessionLearnedErrors(dir, { sessionId: "s2", timestamp: "2026-05-28T02:00:00.000Z", cwd: "/y" }, [
			sampleEntry({ count: 2, fingerprint: "fp-a" }),
		]);

		const aggregated = await aggregateLearnedErrors(dir);
		expect(aggregated.length).toBe(2);
		const a = aggregated.find((e) => e.fingerprint === "fp-a");
		expect(a?.totalCount).toBe(5); // 3 + 2
		expect(a?.sessionCount).toBe(2);
		const b = aggregated.find((e) => e.fingerprint === "fp-b");
		expect(b?.totalCount).toBe(1);
		expect(b?.sessionCount).toBe(1);
	});

	it("tracks matchedRuleIds across sessions", async () => {
		persistSessionLearnedErrors(dir, { sessionId: "s1", timestamp: "2026-05-28T01:00:00.000Z", cwd: "/x" }, [
			sampleEntry({ fingerprint: "fp", matchedRuleId: "rule-a" }),
		]);
		persistSessionLearnedErrors(dir, { sessionId: "s2", timestamp: "2026-05-28T02:00:00.000Z", cwd: "/x" }, [
			sampleEntry({ fingerprint: "fp", matchedRuleId: "rule-b" }),
		]);
		const aggregated = await aggregateLearnedErrors(dir);
		expect(aggregated[0].matchedRuleIds.sort()).toEqual(["rule-a", "rule-b"]);
	});

	it("uses the most recent session's sample text", async () => {
		persistSessionLearnedErrors(dir, { sessionId: "old", timestamp: "2026-05-01T00:00:00.000Z", cwd: "/x" }, [
			sampleEntry({ fingerprint: "fp", sampleErrorText: "OLD SAMPLE" }),
		]);
		persistSessionLearnedErrors(dir, { sessionId: "new", timestamp: "2026-05-28T00:00:00.000Z", cwd: "/x" }, [
			sampleEntry({ fingerprint: "fp", sampleErrorText: "NEW SAMPLE" }),
		]);
		const aggregated = await aggregateLearnedErrors(dir);
		expect(aggregated[0].sampleErrorText).toBe("NEW SAMPLE");
	});

	it("skips entries when there are none (no file is written)", () => {
		persistSessionLearnedErrors(dir, { sessionId: "s1", timestamp: "x", cwd: "/" }, []);
		const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
		expect(files.length).toBe(0);
	});

	it("survives a corrupt JSONL line", async () => {
		writeFileSync(
			join(dir, "corrupt.jsonl"),
			[
				JSON.stringify({ type: "manifest", sessionId: "c", timestamp: "t", cwd: "/" }),
				"not-json-at-all",
				JSON.stringify({ type: "entry", tool: "bash", fingerprint: "fp", count: 1, sampleErrorText: "ok" }),
			].join("\n"),
		);
		const aggregated = await aggregateLearnedErrors(dir);
		expect(aggregated.length).toBe(1);
		expect(aggregated[0].fingerprint).toBe("fp");
	});

	it("returns empty when the directory does not exist", async () => {
		const missing = join(dir, "does-not-exist");
		expect(await aggregateLearnedErrors(missing)).toEqual([]);
	});

	it("sorts aggregated results by descending totalCount", async () => {
		persistSessionLearnedErrors(dir, { sessionId: "s", timestamp: "t", cwd: "/" }, [
			sampleEntry({ fingerprint: "low", count: 1 }),
			sampleEntry({ fingerprint: "high", count: 10 }),
			sampleEntry({ fingerprint: "mid", count: 5 }),
		]);
		const aggregated = await aggregateLearnedErrors(dir);
		expect(aggregated.map((e) => e.fingerprint)).toEqual(["high", "mid", "low"]);
	});
});
