import { describe, expect, test } from "vitest";
import { nounFor, pluralizeNoun } from "../src/modes/interactive/components/tool-activity.js";

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
