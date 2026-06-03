import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("SettingsManager.getToolFeedbackSettings", () => {
	it("returns sensible defaults when no toolFeedback key is set", () => {
		const sm = SettingsManager.inMemory();
		const cfg = sm.getToolFeedbackSettings();
		// errorReflection defaults OFF: its followUp delivery fires a stale phantom
		// turn (the model self-corrects inline before it lands) and the useful
		// inline feedback is already covered by tool-results + Tier-4 hints.
		// doomLoopReminder stays ON: caps wasted tokens in identical-call loops.
		expect(cfg.errorReflection.enabled).toBe(false);
		expect(cfg.doomLoopReminder.enabled).toBe(true);
		// PiTuned tightened the default threshold to 2 (catches identical-call
		// loops sooner). cooldownMs unchanged.
		expect(cfg.doomLoopReminder.threshold).toBe(2);
		expect(cfg.doomLoopReminder.cooldownMs).toBe(30000);
	});

	it("honors explicit opt-out for both features", () => {
		const sm = SettingsManager.inMemory({
			toolFeedback: {
				errorReflection: { enabled: false },
				doomLoopReminder: { enabled: false },
			},
		});
		const cfg = sm.getToolFeedbackSettings();
		expect(cfg.errorReflection.enabled).toBe(false);
		expect(cfg.doomLoopReminder.enabled).toBe(false);
	});

	it("respects opt-in error reflection", () => {
		const sm = SettingsManager.inMemory({
			toolFeedback: { errorReflection: { enabled: true } },
		});
		expect(sm.getToolFeedbackSettings().errorReflection.enabled).toBe(true);
	});

	it("respects opt-in doom-loop reminder with custom threshold and cooldown", () => {
		const sm = SettingsManager.inMemory({
			toolFeedback: { doomLoopReminder: { enabled: true, threshold: 6, cooldownMs: 5000 } },
		});
		const cfg = sm.getToolFeedbackSettings();
		expect(cfg.doomLoopReminder.enabled).toBe(true);
		expect(cfg.doomLoopReminder.threshold).toBe(6);
		expect(cfg.doomLoopReminder.cooldownMs).toBe(5000);
	});

	it("clamps invalid threshold to default", () => {
		const sm = SettingsManager.inMemory({
			toolFeedback: { doomLoopReminder: { enabled: true, threshold: 0 } },
		});
		expect(sm.getToolFeedbackSettings().doomLoopReminder.threshold).toBe(2);
	});

	it("clamps invalid cooldown to default", () => {
		const sm = SettingsManager.inMemory({
			toolFeedback: { doomLoopReminder: { enabled: true, cooldownMs: -100 } },
		});
		expect(sm.getToolFeedbackSettings().doomLoopReminder.cooldownMs).toBe(30000);
	});

	it("floors fractional threshold", () => {
		const sm = SettingsManager.inMemory({
			toolFeedback: { doomLoopReminder: { enabled: true, threshold: 5.9 } },
		});
		expect(sm.getToolFeedbackSettings().doomLoopReminder.threshold).toBe(5);
	});

	it("treats undefined errorReflection.enabled as the default (off, opt-in)", () => {
		const sm = SettingsManager.inMemory({
			toolFeedback: { errorReflection: { enabled: undefined as unknown as boolean } },
		});
		expect(sm.getToolFeedbackSettings().errorReflection.enabled).toBe(false);
	});

	it("defaults stagnationReminder to ON with 12/25/30000", () => {
		const cfg = SettingsManager.inMemory().getToolFeedbackSettings();
		expect(cfg.stagnationReminder.enabled).toBe(true);
		expect(cfg.stagnationReminder.softThreshold).toBe(12);
		expect(cfg.stagnationReminder.hardThreshold).toBe(25);
		expect(cfg.stagnationReminder.cooldownMs).toBe(30000);
	});

	it("honors explicit opt-out for stagnationReminder", () => {
		const sm = SettingsManager.inMemory({
			toolFeedback: { stagnationReminder: { enabled: false } },
		});
		expect(sm.getToolFeedbackSettings().stagnationReminder.enabled).toBe(false);
	});

	it("respects custom stagnationReminder thresholds", () => {
		const sm = SettingsManager.inMemory({
			toolFeedback: { stagnationReminder: { enabled: true, softThreshold: 6, hardThreshold: 15, cooldownMs: 5000 } },
		});
		const cfg = sm.getToolFeedbackSettings();
		expect(cfg.stagnationReminder).toEqual({ enabled: true, softThreshold: 6, hardThreshold: 15, cooldownMs: 5000 });
	});

	it("clamps a hard threshold below the soft threshold up to the soft floor", () => {
		const sm = SettingsManager.inMemory({
			toolFeedback: { stagnationReminder: { enabled: true, softThreshold: 12, hardThreshold: 3 } },
		});
		const cfg = sm.getToolFeedbackSettings();
		expect(cfg.stagnationReminder.softThreshold).toBe(12);
		expect(cfg.stagnationReminder.hardThreshold).toBe(12);
	});

	it("clamps invalid stagnation thresholds to defaults", () => {
		const sm = SettingsManager.inMemory({
			toolFeedback: { stagnationReminder: { enabled: true, softThreshold: 0, hardThreshold: -5, cooldownMs: -1 } },
		});
		const cfg = sm.getToolFeedbackSettings();
		expect(cfg.stagnationReminder.softThreshold).toBe(12);
		expect(cfg.stagnationReminder.hardThreshold).toBe(25);
		expect(cfg.stagnationReminder.cooldownMs).toBe(30000);
	});
});
