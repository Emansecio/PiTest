import { getRuntimeDiagnostics, recordDiagnostic, resetRuntimeDiagnostics } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getCurrentSupervisionThermostat,
	isSupervisionThermostatDisabled,
	SupervisionThermostat,
	setCurrentSupervisionThermostat,
} from "../src/core/supervision-thermostat.ts";

/** Drive the thermostat directly (no global diagnostics subscription) for isolation. */
function makeQuiet(model?: { provider: string }): SupervisionThermostat {
	return new SupervisionThermostat({ model, subscribeDiagnostics: false });
}

function blockedGuard(category: "guard.grounding" | "guard.import-grounding" = "guard.grounding"): void {
	recordDiagnostic({
		category,
		level: "warn",
		source: "test",
		context: { outcome: "blocked" },
	});
}

describe("SupervisionThermostat", () => {
	const originalEnv = process.env.PIT_NO_SUPERVISION_THERMOSTAT;

	beforeEach(() => {
		delete process.env.PIT_NO_SUPERVISION_THERMOSTAT;
		resetRuntimeDiagnostics();
	});

	afterEach(() => {
		if (originalEnv === undefined) delete process.env.PIT_NO_SUPERVISION_THERMOSTAT;
		else process.env.PIT_NO_SUPERVISION_THERMOSTAT = originalEnv;
		setCurrentSupervisionThermostat(undefined);
	});

	describe("start levels", () => {
		it("starts padrao for an unknown/no model", () => {
			expect(makeQuiet().getLevel()).toBe("padrao");
		});

		it("starts leve for the native anthropic provider", () => {
			expect(makeQuiet({ provider: "anthropic" }).getLevel()).toBe("leve");
		});

		it("keeps padrao for proxies and other native providers", () => {
			// Proxies / OpenAI-compat endpoints route Claude/GPT but are NOT native → no light start.
			expect(makeQuiet({ provider: "opencode" }).getLevel()).toBe("padrao");
			// openai-codex is deliberately outside the light-start prior.
			expect(makeQuiet({ provider: "openai-codex" }).getLevel()).toBe("padrao");
			expect(makeQuiet({ provider: "xai" }).getLevel()).toBe("padrao");
		});
	});

	describe("tightening", () => {
		it("tightens immediately on a blocked guard diagnostic", () => {
			const t = new SupervisionThermostat({});
			try {
				blockedGuard("guard.grounding");
				expect(t.getLevel()).toBe("assistido");
			} finally {
				t.dispose();
			}
		});

		it("ignores an overridden (non-blocked) guard diagnostic", () => {
			const t = new SupervisionThermostat({});
			try {
				recordDiagnostic({
					category: "guard.grounding",
					level: "warn",
					source: "test",
					context: { outcome: "overridden" },
				});
				expect(t.getLevel()).toBe("padrao");
			} finally {
				t.dispose();
			}
		});

		it("clamps at assistido after repeated signals", () => {
			const t = makeQuiet();
			t.noteSignal("guard.grounding");
			expect(t.getLevel()).toBe("assistido");
			t.noteSignal("verification_exhausted");
			expect(t.getLevel()).toBe("assistido");
		});
	});

	describe("anti-oscillation locks", () => {
		it("does NOT loosen mid-task despite a long clean streak (lock #2)", () => {
			const t = makeQuiet();
			t.noteSignal("guard.grounding"); // padrao -> assistido
			expect(t.getLevel()).toBe("assistido");
			for (let i = 0; i < 20; i++) t.noteCleanTool();
			// No task boundary yet: stays put even though the streak is far past threshold.
			expect(t.getLevel()).toBe("assistido");
			expect(t.getSnapshot().loosenPending).toBe(true);
		});

		it("loosens one step at a task boundary after a clean streak (lock #1 asymmetry)", () => {
			const t = makeQuiet();
			t.noteSignal("guard.grounding"); // -> assistido
			for (let i = 0; i < 5; i++) t.noteCleanTool();
			t.noteTaskBoundary();
			expect(t.getLevel()).toBe("padrao"); // one step only
			// A second full streak + boundary loosens one more step to leve.
			for (let i = 0; i < 5; i++) t.noteCleanTool();
			t.noteTaskBoundary();
			expect(t.getLevel()).toBe("leve");
			// Cannot loosen below leve.
			for (let i = 0; i < 5; i++) t.noteCleanTool();
			t.noteTaskBoundary();
			expect(t.getLevel()).toBe("leve");
		});

		it("does not loosen at a boundary without a long-enough streak", () => {
			const t = makeQuiet();
			t.noteSignal("guard.grounding"); // -> assistido
			for (let i = 0; i < 4; i++) t.noteCleanTool(); // streak 4 < 5
			t.noteTaskBoundary();
			expect(t.getLevel()).toBe("assistido");
		});

		it("re-tightens immediately and resets the clean streak (lock #1)", () => {
			const t = makeQuiet();
			for (let i = 0; i < 4; i++) t.noteCleanTool();
			expect(t.getSnapshot().cleanStreak).toBe(4);
			t.noteSignal("guard.import-grounding");
			expect(t.getLevel()).toBe("assistido");
			expect(t.getSnapshot().cleanStreak).toBe(0);
			// The reset means the very next boundary cannot loosen.
			t.noteTaskBoundary();
			expect(t.getLevel()).toBe("assistido");
		});

		it("keeps state per-session — a fresh instance is fresh (lock #3)", () => {
			const t1 = makeQuiet();
			t1.noteSignal("guard.grounding");
			expect(t1.getLevel()).toBe("assistido");
			const t2 = makeQuiet();
			expect(t2.getLevel()).toBe("padrao");
			expect(t2.getSnapshot().cleanStreak).toBe(0);
		});

		it("gates loosening on the quality.rigor boundary diagnostic", () => {
			const t = new SupervisionThermostat({});
			try {
				t.noteSignal("guard.grounding"); // -> assistido
				for (let i = 0; i < 5; i++) t.noteCleanTool();
				// A new user prompt fires quality.rigor: the existing per-cycle boundary.
				recordDiagnostic({
					category: "quality.rigor",
					level: "info",
					source: "task-rigor-extension",
					context: { note: "rigor=2 risk=medium" },
				});
				expect(t.getLevel()).toBe("padrao");
			} finally {
				t.dispose();
			}
		});
	});

	describe("transition diagnostics", () => {
		it("emits quality.supervision on tighten and on loosen", () => {
			const t = makeQuiet();
			t.noteSignal("guard.grounding");
			for (let i = 0; i < 5; i++) t.noteCleanTool();
			t.noteTaskBoundary();

			const supervisionEvents = getRuntimeDiagnostics().recent.filter((e) => e.category === "quality.supervision");
			expect(supervisionEvents).toHaveLength(2);
			expect(supervisionEvents[0].context?.note).toBe("padrao->assistido signal=guard.grounding streak=0");
			expect(supervisionEvents[1].context?.note).toBe("assistido->padrao signal=clean streak=0");
			expect(supervisionEvents[0].source).toBe("supervision-thermostat");
		});
	});

	describe("kill-switch", () => {
		it("is controlled by PIT_NO_SUPERVISION_THERMOSTAT", () => {
			expect(isSupervisionThermostatDisabled({})).toBe(false);
			expect(isSupervisionThermostatDisabled({ PIT_NO_SUPERVISION_THERMOSTAT: "1" })).toBe(true);
			expect(isSupervisionThermostatDisabled({ PIT_NO_SUPERVISION_THERMOSTAT: "0" })).toBe(false);
		});

		it("fails open: stays at start level, no subscription, no state movement", () => {
			process.env.PIT_NO_SUPERVISION_THERMOSTAT = "1";
			const t = new SupervisionThermostat({ model: { provider: "anthropic" } });
			try {
				// Start level still honored (leve for native anthropic) even when disabled.
				expect(t.getLevel()).toBe("leve");
				// No subscription: a blocked guard does not tighten.
				blockedGuard("guard.grounding");
				expect(t.getLevel()).toBe("leve");
				// Direct signals are no-ops too.
				t.noteSignal("guard.grounding");
				expect(t.getLevel()).toBe("leve");
				// No transition diagnostics emitted.
				expect(getRuntimeDiagnostics().recent.some((e) => e.category === "quality.supervision")).toBe(false);
			} finally {
				t.dispose();
			}
		});

		it("defaults a disabled unknown model to padrao", () => {
			process.env.PIT_NO_SUPERVISION_THERMOSTAT = "1";
			const t = new SupervisionThermostat({});
			expect(t.getLevel()).toBe("padrao");
			t.dispose();
		});
	});

	describe("module registry", () => {
		it("round-trips through setCurrent/getCurrent", () => {
			const t = makeQuiet();
			setCurrentSupervisionThermostat(t);
			expect(getCurrentSupervisionThermostat()).toBe(t);
			setCurrentSupervisionThermostat(undefined);
			expect(getCurrentSupervisionThermostat()).toBeUndefined();
		});
	});
});
