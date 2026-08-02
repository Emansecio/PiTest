import { describe, expect, it } from "vitest";
import { nextFusionCycleState, reconcileFusionModeInvariant } from "../../src/core/built-ins/permissions-extension.ts";
import { PERMISSION_MODES, type PermissionMode } from "../../src/core/permissions/types.ts";

describe("4-stop fusion cycle", () => {
	it("walks Plan -> Ask -> Auto -> Fusion·Plan -> Plan", () => {
		expect(nextFusionCycleState("solo", "plan")).toEqual({ orchestration: "solo", mode: "ask" });
		expect(nextFusionCycleState("solo", "ask")).toEqual({ orchestration: "solo", mode: "auto" });
		expect(nextFusionCycleState("solo", "auto")).toEqual({ orchestration: "fusion", mode: "plan" });
		expect(nextFusionCycleState("fusion", "plan")).toEqual({ orchestration: "solo", mode: "plan" });
	});

	it("returns to the start in exactly 4 hops from any stop", () => {
		let state: { orchestration: "solo" | "fusion"; mode: PermissionMode } = {
			orchestration: "solo",
			mode: "plan",
		};
		const seen: string[] = [];
		for (let i = 0; i < 4; i++) {
			state = nextFusionCycleState(state.orchestration, state.mode);
			seen.push(`${state.orchestration}·${state.mode}`);
		}
		expect(seen).toEqual(["solo·ask", "solo·auto", "fusion·plan", "solo·plan"]);
	});

	it("never produces a fusion state paired with a non-plan mode", () => {
		// The invariant the cycle exists to protect: fusion implies plan in v1.
		for (const orchestration of ["solo", "fusion"] as const) {
			for (const mode of PERMISSION_MODES) {
				const next = nextFusionCycleState(orchestration, mode);
				if (next.orchestration === "fusion") expect(next.mode).toBe("plan");
			}
		}
	});

	it("never lands on confirm — it is off-cycle, reachable only by /permission-mode", () => {
		for (const orchestration of ["solo", "fusion"] as const) {
			for (const mode of PERMISSION_MODES) {
				expect(nextFusionCycleState(orchestration, mode).mode).not.toBe("confirm");
			}
		}
	});

	it("re-enters the loop at Plan from the off-cycle confirm stop (never more permissive)", () => {
		expect(nextFusionCycleState("solo", "confirm")).toEqual({ orchestration: "solo", mode: "plan" });
	});
});

describe("reconcileFusionModeInvariant", () => {
	it("keeps legal pairs untouched", () => {
		expect(reconcileFusionModeInvariant({ mode: "plan", orchestration: "fusion" }, "permission")).toEqual({
			mode: "plan",
			orchestration: "fusion",
		});
		expect(reconcileFusionModeInvariant({ mode: "ask", orchestration: "solo" }, "permission")).toEqual({
			mode: "ask",
			orchestration: "solo",
		});
	});

	it("permission authority drops fusion for EVERY illegal pair (ask, confirm, auto)", () => {
		for (const mode of ["auto", "ask", "confirm"] as const) {
			expect(reconcileFusionModeInvariant({ mode, orchestration: "fusion" }, "permission")).toEqual({
				mode,
				orchestration: "solo",
			});
		}
	});

	it("orchestration authority forces plan for EVERY illegal pair (ask, confirm, auto)", () => {
		for (const mode of ["auto", "ask", "confirm"] as const) {
			expect(reconcileFusionModeInvariant({ mode, orchestration: "fusion" }, "orchestration")).toEqual({
				mode: "plan",
				orchestration: "fusion",
			});
		}
	});
});
