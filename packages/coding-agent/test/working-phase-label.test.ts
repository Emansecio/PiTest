import { describe, expect, it } from "vitest";
import { workingPhaseLabel } from "../src/modes/interactive/components/tool-activity.ts";

describe("workingPhaseLabel", () => {
	it("uses verb + basename for edit", () => {
		const label = workingPhaseLabel("edit", { path: "src/core/footer.ts" }, true);
		expect(label).toContain("Editing");
		expect(label).toContain("footer.ts");
		expect(label.endsWith("…")).toBe(true);
	});

	it("uses command snippet for bash", () => {
		const label = workingPhaseLabel("bash", { command: "npm run check" }, true);
		expect(label).toContain("Running");
		expect(label).toContain("npm");
	});

	it("falls back to tool name for unknown tools", () => {
		expect(workingPhaseLabel("mcp_foo", {}, true)).toContain("mcp_foo");
	});
});
