import { describe, expect, it } from "vitest";
import { formatPermissionBlockedContent, humanModeNotifyLabel } from "../src/core/permissions/mode-labels.ts";

describe("humanModeNotifyLabel", () => {
	it("labels plan and auto in solo", () => {
		expect(humanModeNotifyLabel("solo", "plan")).toBe("Plan · research only — won't edit files");
		expect(humanModeNotifyLabel("solo", "auto")).toBe("Auto · can edit with built-in guard-rails");
	});

	it("labels fusion regardless of mode", () => {
		expect(humanModeNotifyLabel("fusion", "plan")).toBe("Fusion · multi-model plan (read-only)");
		expect(humanModeNotifyLabel("fusion", "auto")).toBe("Fusion · multi-model plan (read-only)");
	});
});

describe("formatPermissionBlockedContent", () => {
	it("includes tool and plan mode hint when no reason", () => {
		const s = formatPermissionBlockedContent("edit", undefined, "plan");
		expect(s).toContain("blocked: edit");
		expect(s).toContain("plan mode");
	});

	it("prefers a short reason when provided", () => {
		const s = formatPermissionBlockedContent("bash", 'Command matches deny rule "rm -rf"', "auto");
		expect(s).toContain("blocked: bash");
		expect(s).toContain("deny rule");
	});
});
