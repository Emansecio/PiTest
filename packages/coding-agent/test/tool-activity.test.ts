import { describe, expect, test } from "vitest";
import {
	computeDiffStat,
	formatActionSummary,
	navNounFor,
	toolActivityFamily,
} from "../src/modes/interactive/components/tool-activity.js";

describe("toolActivityFamily", () => {
	test("returns the explicit family when set", () => {
		expect(toolActivityFamily({ activity: "navigation" } as any)).toBe("navigation");
		expect(toolActivityFamily({ activity: "action" } as any)).toBe("action");
	});

	test("defaults to action when undefined or no definition", () => {
		expect(toolActivityFamily({} as any)).toBe("action");
		expect(toolActivityFamily(undefined)).toBe("action");
	});
});

describe("computeDiffStat", () => {
	test("counts added/removed by the first char of each line", () => {
		// edit-diff.ts custom format: prefix +/-/space at char[0], then line number.
		const diff = ["+  5 added line", "-  4 removed line", "   3 context", "+  6 another add"].join("\n");
		expect(computeDiffStat(diff)).toEqual({ added: 2, removed: 1 });
	});

	test("does not mistake content starting with +/- (prefix is always char[0])", () => {
		const diff = ["   3 -not removed", "+  4 +really added"].join("\n");
		expect(computeDiffStat(diff)).toEqual({ added: 1, removed: 0 });
	});

	test("empty diff is zero", () => {
		expect(computeDiffStat("")).toEqual({ added: 0, removed: 0 });
	});
});

describe("navNounFor", () => {
	test("maps known tools, falls back to step", () => {
		expect(navNounFor("read")).toBe("file");
		expect(navNounFor("grep")).toBe("search");
		expect(navNounFor("unknown_tool")).toBe("step");
	});
});

describe("formatActionSummary", () => {
	test("edit yields verb Edited + path + diffstat", () => {
		const r = formatActionSummary("edit", { path: "a/b.ts" }, { diff: "+  1 x\n-  2 y" });
		expect(r.verb).toBe("Edited");
		expect(r.identifier).toBe("a/b.ts");
		expect(r.diffstat).toEqual({ added: 1, removed: 1 });
	});

	test("write yields Wrote + path, no diffstat", () => {
		const r = formatActionSummary("write", { file_path: "n.ts" }, undefined);
		expect(r).toEqual({ verb: "Wrote", identifier: "n.ts", diffstat: undefined });
	});

	test("bash yields Ran + $ command", () => {
		const r = formatActionSummary("bash", { command: "npm test" }, undefined);
		expect(r.verb).toBe("Ran");
		expect(r.identifier).toBe("$ npm test");
	});

	test("unknown tool capitalizes the name and summarizes args", () => {
		const r = formatActionSummary("render_mermaid", { code: "graph" }, undefined);
		expect(r.verb).toBe("Render_mermaid");
		expect(r.identifier).toContain("code: graph");
	});
});
