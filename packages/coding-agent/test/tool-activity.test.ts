import { describe, expect, test } from "vitest";
import { toolActivityFamily } from "../src/modes/interactive/components/tool-activity.js";

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
