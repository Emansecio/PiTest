import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionRecoveryController } from "../src/core/session-recovery.js";

describe("SessionRecoveryController", () => {
	const originalEnv = process.env.PIT_NO_SESSION_RECOVERY;

	beforeEach(() => {
		delete process.env.PIT_NO_SESSION_RECOVERY;
	});

	afterEach(() => {
		if (originalEnv === undefined) delete process.env.PIT_NO_SESSION_RECOVERY;
		else process.env.PIT_NO_SESSION_RECOVERY = originalEnv;
	});

	it("starts lean with baseline thresholds", () => {
		const ctrl = new SessionRecoveryController();
		expect(ctrl.getLevel()).toBe("lean");
		expect(ctrl.getEffectiveTier1Threshold(2)).toBe(2);
		expect(ctrl.getEffectiveResultLoopThreshold()).toBe(5);
		expect(ctrl.getEffectiveVerificationMaxAttempts(2)).toBe(2);
		expect(ctrl.shouldEmitErrorReflection(false)).toBe(false);
	});

	it("escalates lean to guided on a weight-2 signal", () => {
		const ctrl = new SessionRecoveryController();
		ctrl.noteSignal("result_loop");
		expect(ctrl.getLevel()).toBe("guided");
		expect(ctrl.getEffectiveTier1Threshold(2)).toBe(1);
		expect(ctrl.getEffectiveVerificationMaxAttempts(2)).toBe(3);
		expect(ctrl.shouldEmitErrorReflection(false)).toBe(true);
		expect(ctrl.deliverErrorReflectionAsSteer(false)).toBe(true);
	});

	it("escalates guided to strict when total thrash score reaches 4", () => {
		const ctrl = new SessionRecoveryController();
		ctrl.noteSignal("result_loop");
		ctrl.noteSignal("cross_error");
		ctrl.noteSignal("cross_error");
		expect(ctrl.getLevel()).toBe("strict");
		expect(ctrl.getEffectiveTier1Threshold(2)).toBe(1);
		expect(ctrl.getDoomRecoveryLimit()).toBe(2);
		expect(ctrl.getEffectiveVerificationMaxAttempts(2)).toBe(4);
	});

	it("de-escalates guided to lean after 5 clean tool successes", () => {
		const ctrl = new SessionRecoveryController();
		ctrl.noteSignal("result_loop");
		expect(ctrl.getLevel()).toBe("guided");
		for (let i = 0; i < 5; i++) ctrl.noteCleanTool();
		expect(ctrl.getLevel()).toBe("lean");
	});

	it("de-escalates strict to guided then lean on longer clean streaks", () => {
		const ctrl = new SessionRecoveryController();
		ctrl.noteSignal("result_loop");
		ctrl.noteSignal("verification_exhausted");
		expect(ctrl.getLevel()).toBe("strict");
		for (let i = 0; i < 5; i++) ctrl.noteCleanTool();
		expect(ctrl.getLevel()).toBe("guided");
		for (let i = 0; i < 5; i++) ctrl.noteCleanTool();
		expect(ctrl.getLevel()).toBe("lean");
	});

	it("sets narration steer pending only on lean to guided transition", () => {
		const ctrl = new SessionRecoveryController();
		expect(ctrl.consumeNarrationSteerPending()).toBe(false);
		ctrl.noteSignal("result_loop");
		expect(ctrl.consumeNarrationSteerPending()).toBe(true);
		expect(ctrl.consumeNarrationSteerPending()).toBe(false);
	});

	it("sets a distinct one-shot strict narration steer on guided to strict", () => {
		const ctrl = new SessionRecoveryController();
		expect(ctrl.consumeStrictNarrationSteerPending()).toBe(false);
		// lean -> guided: arms the guided narration only, not the strict one.
		ctrl.noteSignal("result_loop");
		expect(ctrl.getLevel()).toBe("guided");
		expect(ctrl.consumeStrictNarrationSteerPending()).toBe(false);
		expect(ctrl.consumeNarrationSteerPending()).toBe(true);
		// guided -> strict: arms the strict narration exactly once.
		ctrl.noteSignal("verification_exhausted");
		expect(ctrl.getLevel()).toBe("strict");
		expect(ctrl.consumeStrictNarrationSteerPending()).toBe(true);
		expect(ctrl.consumeStrictNarrationSteerPending()).toBe(false);
	});

	it("re-arms the strict narration on a fresh guided to strict escalation", () => {
		const ctrl = new SessionRecoveryController();
		ctrl.noteSignal("result_loop"); // -> guided
		ctrl.noteSignal("verification_exhausted"); // -> strict
		expect(ctrl.consumeStrictNarrationSteerPending()).toBe(true);
		// De-escalate strict -> guided (5 clean), then re-escalate to strict.
		for (let i = 0; i < 5; i++) ctrl.noteCleanTool();
		expect(ctrl.getLevel()).toBe("guided");
		expect(ctrl.consumeStrictNarrationSteerPending()).toBe(false);
		ctrl.noteSignal("verification_exhausted"); // guided -> strict again
		expect(ctrl.getLevel()).toBe("strict");
		expect(ctrl.consumeStrictNarrationSteerPending()).toBe(true);
	});

	it("PIT_NO_SESSION_RECOVERY keeps lean and ignores signals", () => {
		process.env.PIT_NO_SESSION_RECOVERY = "1";
		const ctrl = new SessionRecoveryController();
		ctrl.noteSignal("result_loop");
		ctrl.noteSignal("verification_exhausted");
		expect(ctrl.getLevel()).toBe("lean");
		expect(ctrl.getEffectiveVerificationMaxAttempts(2)).toBe(2);
	});
});
