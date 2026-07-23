/**
 * P8b — model gearbox state machine. Tests the private gearbox methods on
 * InteractiveMode in isolation via Reflect.get + a minimal mock `this` (the
 * established pattern for InteractiveMode internals, see
 * interactive-mode-loader-suffix.test.ts). The gearbox reads the live plan
 * through the module-level PlanManager registry, so tests set a real
 * PlanManager and drive it directly.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PlanManager, setCurrentPlanManager } from "../src/core/plan/plan-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

const GEARBOX_METHODS = [
	"gearboxEnabled",
	"gearboxReevaluate",
	"gearboxForceUpshift",
	"gearboxDownshift",
	"gearboxUpshift",
	"gearboxObserveToolEnd",
	"getSessionRecoveryLevel",
] as const;

interface GearboxCtx {
	activeRole: string;
	isPlanPermissionMode: boolean;
	gearboxActive: boolean;
	roleBeforeGearbox: string | undefined;
	gearboxStepId: string | undefined;
	gearboxPoisonedSteps: Set<string>;
	settingsManager: { getModelRoleSettings: () => { modelRoles?: Record<string, unknown> } };
	footer: { setGearboxRole: ReturnType<typeof vi.fn> };
	session: { getRecoveryLevel: () => string };
	applyModelRole: ReturnType<typeof vi.fn>;
	refreshModelIndicators: ReturnType<typeof vi.fn>;
	showStatus: ReturnType<typeof vi.fn>;
	// Bound gearbox methods.
	gearboxEnabled: () => boolean;
	gearboxReevaluate: () => void;
	gearboxForceUpshift: (reason: string) => void;
	gearboxDownshift: () => void;
	gearboxUpshift: () => void;
	gearboxObserveToolEnd: (toolName: string, result: unknown, isError: boolean) => void;
	getSessionRecoveryLevel: () => string;
}

function makeCtx(overrides: Partial<GearboxCtx> = {}): GearboxCtx {
	const ctx = {
		activeRole: "default",
		isPlanPermissionMode: false,
		gearboxActive: false,
		roleBeforeGearbox: undefined,
		gearboxStepId: undefined,
		gearboxPoisonedSteps: new Set<string>(),
		settingsManager: { getModelRoleSettings: () => ({ modelRoles: { smol: { model: "opencode/kimi-k2.6" } } }) },
		footer: { setGearboxRole: vi.fn() },
		session: { getRecoveryLevel: () => "lean" },
		refreshModelIndicators: vi.fn(),
		showStatus: vi.fn(),
		...overrides,
	} as GearboxCtx;
	// Mirror the real applyModelRole: it sets activeRole synchronously before any await.
	ctx.applyModelRole = vi.fn((role: string) => {
		ctx.activeRole = role;
		return Promise.resolve();
	});
	for (const name of GEARBOX_METHODS) {
		const fn = Reflect.get(InteractiveMode.prototype, name) as (...args: unknown[]) => unknown;
		(ctx as unknown as Record<string, unknown>)[name] = fn.bind(ctx);
	}
	return ctx;
}

/** Plan: s1 (judgement) → s2 (mechanical+verify) → s3 (judgement). */
function makeSequencedPlan(): PlanManager {
	const mgr = new PlanManager();
	mgr.propose([
		{ id: "s1", intent: "design" },
		{ id: "s2", intent: "rote edit", dependsOn: ["s1"], verifyCmd: "npm test", mechanical: true },
		{ id: "s3", intent: "review", dependsOn: ["s2"] },
	]);
	setCurrentPlanManager(mgr);
	return mgr;
}

afterEach(() => setCurrentPlanManager(undefined));

describe("model gearbox (P8b)", () => {
	describe("downshift/upshift by step sequence", () => {
		it("downshifts when the next ready step is mechanical+verify, upshifts when it is not", () => {
			const mgr = makeSequencedPlan();
			const ctx = makeCtx();

			// Ready = [s1] (judgement) → no downshift.
			ctx.gearboxReevaluate();
			expect(ctx.gearboxActive).toBe(false);
			expect(ctx.applyModelRole).not.toHaveBeenCalled();

			// s1 done → ready = [s2] (mechanical+verify) → downshift.
			mgr.stepDone("s1");
			ctx.gearboxReevaluate();
			expect(ctx.gearboxActive).toBe(true);
			expect(ctx.activeRole).toBe("smol");
			expect(ctx.roleBeforeGearbox).toBe("default");
			expect(ctx.gearboxStepId).toBe("s2");
			expect(ctx.footer.setGearboxRole).toHaveBeenLastCalledWith("smol");

			// s2 done → ready = [s3] (judgement) → upshift + restore.
			mgr.stepDone("s2");
			ctx.gearboxReevaluate();
			expect(ctx.gearboxActive).toBe(false);
			expect(ctx.activeRole).toBe("default");
			expect(ctx.footer.setGearboxRole).toHaveBeenLastCalledWith(null);
		});

		it("upshifts when the plan is complete (no ready steps left)", () => {
			const mgr = new PlanManager();
			mgr.propose([{ id: "s1", intent: "rote", verifyCmd: "t", mechanical: true }]);
			setCurrentPlanManager(mgr);
			const ctx = makeCtx();
			ctx.gearboxReevaluate();
			expect(ctx.gearboxActive).toBe(true);
			mgr.stepDone("s1"); // plan now archived, readySteps() === []
			ctx.gearboxReevaluate();
			expect(ctx.gearboxActive).toBe(false);
			expect(ctx.activeRole).toBe("default");
		});

		it("does not downshift a mechanical step that lacks a verify command", () => {
			const mgr = new PlanManager();
			mgr.propose([{ id: "s1", intent: "rote", mechanical: true }]); // mechanical but no verify
			setCurrentPlanManager(mgr);
			const ctx = makeCtx();
			ctx.gearboxReevaluate();
			expect(ctx.gearboxActive).toBe(false);
			expect(ctx.applyModelRole).not.toHaveBeenCalled();
		});
	});

	describe("anomaly upshift (immediate + irrevocable for the step)", () => {
		function downshifted(): { mgr: PlanManager; ctx: GearboxCtx } {
			const mgr = makeSequencedPlan();
			mgr.stepDone("s1");
			const ctx = makeCtx();
			ctx.gearboxReevaluate();
			expect(ctx.gearboxActive).toBe(true);
			expect(ctx.gearboxStepId).toBe("s2");
			return { mgr, ctx };
		}

		it("verify failure (plan step_done error) upshifts and poisons the step", () => {
			const { ctx } = downshifted();
			ctx.gearboxObserveToolEnd("plan", { details: { op: "step_done" }, content: [] }, true);
			expect(ctx.gearboxActive).toBe(false);
			expect(ctx.activeRole).toBe("default");
			expect(ctx.gearboxPoisonedSteps.has("s2")).toBe(true);
			// Irrevocable: re-evaluating with s2 still the ready mechanical step must NOT re-downshift.
			ctx.gearboxReevaluate();
			expect(ctx.gearboxActive).toBe(false);
		});

		it("retry-budget exhaustion (hint marker in a failing result) upshifts", () => {
			const { ctx } = downshifted();
			ctx.gearboxObserveToolEnd(
				"edit",
				{ content: [{ type: "text", text: "attempts on `edit`: 3/3 — retry budget exhausted. switch approach" }] },
				true,
			);
			expect(ctx.gearboxActive).toBe(false);
			expect(ctx.gearboxPoisonedSteps.has("s2")).toBe(true);
		});

		it("doom-loop recovery escalation (session recovery level off 'lean') upshifts", () => {
			const { ctx } = downshifted();
			ctx.session.getRecoveryLevel = () => "guided";
			ctx.gearboxObserveToolEnd("bash", { content: [] }, false);
			expect(ctx.gearboxActive).toBe(false);
			expect(ctx.gearboxPoisonedSteps.has("s2")).toBe(true);
		});

		it("an `ask` invocation upshifts for the step", () => {
			const { ctx } = downshifted();
			ctx.gearboxForceUpshift("ask"); // wired from tool_execution_start(toolName==="ask")
			expect(ctx.gearboxActive).toBe(false);
			expect(ctx.gearboxPoisonedSteps.has("s2")).toBe(true);
		});

		it("advances to the NEXT mechanical step after the poisoned one completes", () => {
			const mgr = new PlanManager();
			mgr.propose([
				{ id: "a", intent: "rote1", verifyCmd: "t", mechanical: true },
				{ id: "b", intent: "rote2", dependsOn: ["a"], verifyCmd: "t", mechanical: true },
			]);
			setCurrentPlanManager(mgr);
			const ctx = makeCtx();
			ctx.gearboxReevaluate(); // downshift for a
			ctx.gearboxForceUpshift("verify-failed"); // poison a, upshift
			expect(ctx.gearboxPoisonedSteps.has("a")).toBe(true);
			mgr.stepDone("a"); // retry succeeded; a done → ready = [b] (fresh, unpoisoned)
			ctx.gearboxReevaluate();
			expect(ctx.gearboxActive).toBe(true);
			expect(ctx.gearboxStepId).toBe("b");
		});
	});

	describe("no-op guards", () => {
		it("is a silent no-op when no `smol` role is configured", () => {
			const mgr = makeSequencedPlan();
			mgr.stepDone("s1"); // ready = [s2] mechanical+verify
			const ctx = makeCtx({
				settingsManager: { getModelRoleSettings: () => ({ modelRoles: { plan: { model: "x" } } }) },
			});
			expect(ctx.gearboxEnabled()).toBe(false);
			ctx.gearboxReevaluate();
			expect(ctx.gearboxActive).toBe(false);
			expect(ctx.applyModelRole).not.toHaveBeenCalled();
		});

		it("kill-switch PIT_NO_MODEL_GEARBOX disables downshift", () => {
			const original = process.env.PIT_NO_MODEL_GEARBOX;
			process.env.PIT_NO_MODEL_GEARBOX = "1";
			try {
				const mgr = makeSequencedPlan();
				mgr.stepDone("s1");
				const ctx = makeCtx();
				expect(ctx.gearboxEnabled()).toBe(false);
				ctx.gearboxReevaluate();
				expect(ctx.gearboxActive).toBe(false);
				expect(ctx.applyModelRole).not.toHaveBeenCalled();
			} finally {
				if (original === undefined) delete process.env.PIT_NO_MODEL_GEARBOX;
				else process.env.PIT_NO_MODEL_GEARBOX = original;
			}
		});

		it("does not downshift while in plan permission mode", () => {
			const mgr = makeSequencedPlan();
			mgr.stepDone("s1");
			const ctx = makeCtx({ isPlanPermissionMode: true });
			ctx.gearboxReevaluate();
			expect(ctx.gearboxActive).toBe(false);
		});
	});

	describe("no clobber of a manual mid-downshift role choice", () => {
		it("does not restore when the user switched roles while downshifted", () => {
			const mgr = makeSequencedPlan();
			mgr.stepDone("s1");
			const ctx = makeCtx();
			ctx.gearboxReevaluate(); // downshift → applyModelRole("smol")
			expect(ctx.applyModelRole).toHaveBeenCalledTimes(1);
			expect(ctx.applyModelRole).toHaveBeenLastCalledWith("smol", { silent: true });

			// User manually picks another role mid-downshift (activeRole no longer "smol").
			ctx.activeRole = "slow";
			mgr.stepDone("s2");
			ctx.gearboxReevaluate(); // wants upshift, but must NOT clobber the manual choice
			expect(ctx.applyModelRole).toHaveBeenCalledTimes(1); // no restore call
			expect(ctx.activeRole).toBe("slow");
			expect(ctx.gearboxActive).toBe(false);
			expect(ctx.footer.setGearboxRole).toHaveBeenLastCalledWith(null);
		});
	});
});
