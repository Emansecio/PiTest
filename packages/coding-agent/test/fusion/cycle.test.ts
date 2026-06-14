import { describe, expect, it } from "vitest";
import { nextFusionCycleState } from "../../src/core/built-ins/permissions-extension.ts";

describe("3-stop fusion cycle", () => {
	it("walks Plan -> Auto -> Fusion·Plan -> Plan", () => {
		expect(nextFusionCycleState("solo", "plan")).toEqual({ orchestration: "solo", mode: "auto" });
		expect(nextFusionCycleState("solo", "auto")).toEqual({ orchestration: "fusion", mode: "plan" });
		expect(nextFusionCycleState("fusion", "plan")).toEqual({ orchestration: "solo", mode: "plan" });
	});
});
