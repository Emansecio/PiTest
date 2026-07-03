/**
 * Session Recovery — reactive scaffolding uplift without classifying models.
 *
 * Every session starts `lean` (identical to the historical harness). When
 * thrash signals fire (doom-loop, result-loop, verify exhausted, …) the level
 * rises to `guided` then `strict`, enabling extra recovery steers and tighter
 * loop thresholds. Clean tool-success streaks de-escalate. Opt out with
 * `PIT_NO_SESSION_RECOVERY=1`.
 */

import { recordDiagnostic } from "@pit/ai";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import {
	SupervisionThermostat,
	setCurrentSupervisionThermostat,
	type ThermostatModelInfo,
} from "./supervision-thermostat.ts";

export type RecoveryLevel = "lean" | "guided" | "strict";

export type RecoverySignal =
	| "doom_loop_tier1"
	| "doom_loop_tier2"
	| "doom_loop_tier3"
	| "result_loop"
	| "cross_error"
	| "failure_budget"
	| "repeating_pattern"
	| "verification_exhausted"
	| "stagnation_hard";

export interface RecoverySnapshot {
	level: RecoveryLevel;
	rollingScore: number;
	totalThrashScore: number;
	cleanStreak: number;
}

export interface SessionRecoveryControllerOptions {
	onLevelChange?: (from: RecoveryLevel, to: RecoveryLevel, signal?: RecoverySignal) => void;
	/**
	 * Active model, forwarded to the supervision thermostat so a native
	 * anthropic/openai provider earns a lighter start level. Optional and
	 * forward-compatible: the existing no-arg construction in agent-session keeps
	 * a `padrao` start (the thermostat is observe-only in Fase 0, so this is inert).
	 */
	model?: ThermostatModelInfo;
}

/** Weight of each thrash signal toward escalation. */
const SIGNAL_WEIGHT: Record<RecoverySignal, number> = {
	doom_loop_tier1: 1,
	doom_loop_tier2: 1,
	doom_loop_tier3: 2,
	result_loop: 2,
	cross_error: 1,
	failure_budget: 1,
	repeating_pattern: 2,
	verification_exhausted: 2,
	stagnation_hard: 1,
};

const ROLLING_WINDOW = 8;
const ESCALATE_TO_GUIDED_SCORE = 2;
const ESCALATE_TO_STRICT_TOTAL = 4;

const CLEAN_TO_LEAN_FROM_GUIDED = 5;
const CLEAN_TO_GUIDED_FROM_STRICT = 5;
const CLEAN_TO_LEAN_FROM_STRICT = 10;

export const BASE_RESULT_LOOP_THRESHOLD = 5;
const MAX_VERIFICATION_ATTEMPTS = 5;
const BASE_DOOM_RECOVERY_LIMIT = 1;

export function isSessionRecoveryDisabled(): boolean {
	return isTruthyEnvFlag(process.env.PIT_NO_SESSION_RECOVERY);
}

export function buildNarrationRecoverySteer(): string {
	return [
		"<session-recovery-narration>",
		"Between tool calls, briefly state what you learned and your next step (1–2 sentences).",
		"Do not leak internal reflection, goal bookkeeping, or guard internals to the user.",
		"</session-recovery-narration>",
	].join("\n");
}

export function buildStrictNarrationRecoverySteer(): string {
	return [
		"<session-recovery-narration>",
		"Recovery just tightened to strict: repeated thrash tripped the loop, verification, and failure-budget thresholds lower.",
		"Stop and re-plan before the next tool call — restate the goal and try a concretely different approach; do not repeat the last failing action.",
		"</session-recovery-narration>",
	].join("\n");
}

export class SessionRecoveryController {
	private _level: RecoveryLevel = "lean";
	private readonly _rollingWeights: number[] = [];
	private _totalThrashScore = 0;
	private _cleanStreak = 0;
	private _narrationSteerPending = false;
	private _strictNarrationSteerPending = false;
	private readonly _onLevelChange?: SessionRecoveryControllerOptions["onLevelChange"];
	// Band P / P0a supervision thermostat. Instantiated alongside recovery (which
	// already owns the session's hysteresis) so agent-session need not change. It is
	// OBSERVE-ONLY in Fase 0: recovery notes signals/clean-tools into it, and it also
	// subscribes to the diagnostics channel itself for guard blocks + task boundaries.
	private readonly _thermostat: SupervisionThermostat;

	constructor(options: SessionRecoveryControllerOptions = {}) {
		this._onLevelChange = options.onLevelChange;
		this._thermostat = new SupervisionThermostat({ model: options.model });
		setCurrentSupervisionThermostat(this._thermostat);
	}

	/** The supervision thermostat co-located with this controller (Band P / P0a). */
	getSupervisionThermostat(): SupervisionThermostat {
		return this._thermostat;
	}

	getLevel(): RecoveryLevel {
		if (isSessionRecoveryDisabled()) return "lean";
		return this._level;
	}

	getSnapshot(): RecoverySnapshot {
		return {
			level: this.getLevel(),
			rollingScore: this._rollingWeights.reduce((sum, w) => sum + w, 0),
			totalThrashScore: this._totalThrashScore,
			cleanStreak: this._cleanStreak,
		};
	}

	/** Thrash observed — resets the clean streak and may escalate the level. */
	noteSignal(signal: RecoverySignal): void {
		if (isSessionRecoveryDisabled()) return;
		// Couple the supervision thermostat: every recovery thrash signal is a
		// qualifying tighten signal (lock #1, tighten immediately). Guard blocks reach
		// the thermostat separately via its own onDiagnostic subscription.
		this._thermostat.noteSignal(signal);
		const weight = SIGNAL_WEIGHT[signal];
		this._cleanStreak = 0;
		this._totalThrashScore += weight;
		this._rollingWeights.push(weight);
		if (this._rollingWeights.length > ROLLING_WINDOW) {
			this._rollingWeights.shift();
		}
		const rollingSum = this._rollingWeights.reduce((sum, w) => sum + w, 0);
		const prev = this._level;
		this._applyEscalation(rollingSum, weight);
		if (prev !== this._level) {
			this._emitLevelChange(prev, signal);
		}
	}

	/** Successful tool call — may de-escalate after a clean streak. */
	noteCleanTool(): void {
		if (isSessionRecoveryDisabled()) return;
		// Feed the thermostat's clean streak too (it only loosens at a task boundary).
		this._thermostat.noteCleanTool();
		this._cleanStreak++;
		const prev = this._level;
		if (this._level === "strict") {
			if (this._cleanStreak >= CLEAN_TO_LEAN_FROM_STRICT) {
				this._level = "lean";
				this._cleanStreak = 0;
			} else if (this._cleanStreak >= CLEAN_TO_GUIDED_FROM_STRICT) {
				this._level = "guided";
			}
		} else if (this._level === "guided") {
			if (this._cleanStreak >= CLEAN_TO_LEAN_FROM_GUIDED) {
				this._level = "lean";
				this._cleanStreak = 0;
			}
		}
		if (prev !== this._level) {
			this._emitLevelChange(prev);
		}
	}

	consumeNarrationSteerPending(): boolean {
		if (!this._narrationSteerPending) return false;
		this._narrationSteerPending = false;
		return true;
	}

	consumeStrictNarrationSteerPending(): boolean {
		if (!this._strictNarrationSteerPending) return false;
		this._strictNarrationSteerPending = false;
		return true;
	}

	getThresholdReduction(): number {
		const level = this.getLevel();
		if (level === "strict") return 2;
		if (level === "guided") return 1;
		return 0;
	}

	getEffectiveResultLoopThreshold(): number {
		return Math.max(3, BASE_RESULT_LOOP_THRESHOLD - this.getThresholdReduction());
	}

	getEffectiveTier1Threshold(base: number): number {
		return Math.max(1, base - this.getThresholdReduction());
	}

	getEffectiveVerificationMaxAttempts(base: number): number {
		const level = this.getLevel();
		let bonus = 0;
		if (level === "guided") bonus = 1;
		if (level === "strict") bonus = 2;
		return Math.min(MAX_VERIFICATION_ATTEMPTS, Math.max(1, base + bonus));
	}

	getDoomRecoveryLimit(): number {
		const level = this.getLevel();
		if (level === "strict") return BASE_DOOM_RECOVERY_LIMIT + 1;
		return BASE_DOOM_RECOVERY_LIMIT;
	}

	/**
	 * Whether to inject structured error reflection after a failing tool call.
	 * Guided/strict enable it even when settings keep it off; settings ON always enables.
	 */
	shouldEmitErrorReflection(settingsEnabled: boolean): boolean {
		if (settingsEnabled) return true;
		const level = this.getLevel();
		return level === "guided" || level === "strict";
	}

	/** Guided/strict deliver reflection as steer; settings-only on lean keeps followUp. */
	deliverErrorReflectionAsSteer(_settingsEnabled: boolean): boolean {
		const level = this.getLevel();
		if (level === "guided" || level === "strict") return true;
		return false;
	}

	private _applyEscalation(rollingSum: number, latestWeight: number): void {
		if (this._level === "lean") {
			if (rollingSum >= ESCALATE_TO_GUIDED_SCORE || latestWeight >= 2) {
				this._level = "guided";
			}
			return;
		}
		if (this._level === "guided") {
			if (this._totalThrashScore >= ESCALATE_TO_STRICT_TOTAL || latestWeight >= 2) {
				this._level = "strict";
			}
			return;
		}
	}

	private _emitLevelChange(from: RecoveryLevel, signal?: RecoverySignal): void {
		const to = this._level;
		const snap = this.getSnapshot();
		recordDiagnostic({
			category: "quality.recovery",
			level: "info",
			source: "session-recovery",
			context: {
				note: `${from}->${to} signal=${signal ?? "clean"} rolling=${snap.rollingScore} total=${snap.totalThrashScore}`,
			},
		});
		if (from === "lean" && to === "guided") {
			this._narrationSteerPending = true;
		}
		// Escalations move one step at a time, so guided->strict is its own
		// transition and latches a distinct one-shot narration (mirrors the
		// lean->guided latch above): tell the model recovery tightened and why.
		if (from === "guided" && to === "strict") {
			this._strictNarrationSteerPending = true;
		}
		this._onLevelChange?.(from, to, signal);
	}
}
