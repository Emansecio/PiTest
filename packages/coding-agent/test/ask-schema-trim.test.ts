import { describe, expect, it } from "vitest";
import { createAskToolDefinition } from "../src/core/tools/ask.js";

describe("ask schema trim", () => {
	it("drops pure-UI knobs from the cached schema", () => {
		const def = createAskToolDefinition("/tmp", {});
		const props = Object.keys((def.parameters as { properties: Record<string, unknown> }).properties);
		expect(props).not.toContain("displayMode");
		expect(props).not.toContain("overlayToggleKey");
		expect(props).not.toContain("commentToggleKey");
		// semantic knobs stay:
		expect(props).toContain("allowComment");
		expect(props).toContain("header");
	});
});
