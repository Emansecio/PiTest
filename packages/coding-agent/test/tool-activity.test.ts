import { describe, expect, it, test } from "vitest";
import { diffStat, nounFor, pluralizeNoun, verbFor } from "../src/modes/interactive/components/tool-activity.js";

describe("nounFor", () => {
	test("maps known tools (navigation and action), falls back to step", () => {
		expect(nounFor("read")).toBe("file");
		expect(nounFor("grep")).toBe("search");
		expect(nounFor("edit")).toBe("edit");
		expect(nounFor("bash")).toBe("command");
		expect(nounFor("unknown_tool")).toBe("step");
	});
});

describe("pluralizeNoun", () => {
	test("pluralizes by count, handling -h/-s endings", () => {
		expect(pluralizeNoun("file", 1)).toBe("file");
		expect(pluralizeNoun("file", 3)).toBe("files");
		expect(pluralizeNoun("search", 2)).toBe("searches");
		expect(pluralizeNoun("match", 2)).toBe("matches");
	});
});

describe("verbFor", () => {
	it("maps edit family to Edited/Editing", () => {
		expect(verbFor("edit", false)).toBe("Edited");
		expect(verbFor("edit_v2", false)).toBe("Edited");
		expect(verbFor("ast_edit", true)).toBe("Editing");
	});
	it("maps write/bash/web/eval", () => {
		expect(verbFor("write", false)).toBe("Wrote");
		expect(verbFor("write", true)).toBe("Writing");
		expect(verbFor("bash", false)).toBe("Ran");
		expect(verbFor("bash", true)).toBe("Running");
		expect(verbFor("web_search", false)).toBe("Searched");
		expect(verbFor("eval", false)).toBe("Evaluated");
	});
	it("falls back to a neutral verb for unknown action tools", () => {
		expect(verbFor("some_mcp_tool", false)).toBe("Ran");
		expect(verbFor("some_mcp_tool", true)).toBe("Running");
	});
});

describe("diffStat", () => {
	it("counts added/removed by first char, ignoring context and headers", () => {
		const diff = ["+  1 added line", "-  2 removed line", "   3 context", "+  4 another add"].join("\n");
		expect(diffStat(diff)).toEqual({ added: 2, removed: 1 });
	});
	it("returns zeros for empty/undefined", () => {
		expect(diffStat("")).toEqual({ added: 0, removed: 0 });
		expect(diffStat(undefined)).toEqual({ added: 0, removed: 0 });
	});
});
