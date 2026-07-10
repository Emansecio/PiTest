/**
 * Supervision Thermostat — Band P / P0a foundation (Fase 0: OBSERVE-ONLY).
 *
 * Tracks a per-session supervision level EARNED by the model's own behavior in
 * this session, never presumed from a model table. Future Band P pillars will
 * read `getLevel()` to dose their behavior (see docs/agents/conditioning-band-study.md
 * §4-P0a and §5). In Fase 0 NOTHING consumes the level — the thermostat only
 * (a) tracks it, (b) emits a `quality.supervision` diagnostic on every transition,
 * and (c) exposes `getLevel()`/`getSnapshot()` so we can watch the transitions in
 * real sessions before any pillar obeys them.
 *
 * Levels (tight -> loose): `assistido` (max protection) -> `padrao` -> `leve`.
 * Start level: `padrao` for every model; `leve` only when the ACTIVE model runs
 * on a native `anthropic`/`openai` provider (the fixed 2-entry light-start prior
 * from §4-P0a — proxies like `openrouter` keep `padrao`).
 *
 * Three anti-oscillation locks (all mandatory, from the study):
 *   1. Asymmetric — one qualifying signal tightens immediately (any time); the
 *      level only loosens after a long clean streak.
 *   2. Never loosen mid-task — a pending loosen is applied only at a task
 *      boundary (a new user prompt / `quality.rigor` diagnostic). Tightening is
 *      immediate regardless of boundaries.
 *   3. Per-session reset — no persistence; state dies with the instance.
 *
 * Kill-switch `PIT_NO_SUPERVISION_THERMOSTAT=1` is fail-open: the level stays at
 * the start level and NO diagnostics subscription is created.
 */

import { onDiagnostic, type RecordedDiagnosticEvent, recordDiagnostic } from "@pit/ai";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";

/** Supervision level, ASCII identifiers to avoid encoding issues. */
export type SupervisionLevel = "assistido" | "padrao" | "leve";

/** Minimal model shape the thermostat needs to pick a start level. */
export interface ThermostatModelInfo {
	provider: string;
}

export interface SupervisionSnapshot {
	level: SupervisionLevel;
	startLevel: SupervisionLevel;
	cleanStreak: number;
	/** True when a clean streak is long enough to loosen at the next boundary. */
	loosenPending: boolean;
}

export interface SupervisionThermostatOptions {
	/** Active model — decides the start level (`leve` for native anthropic/openai). */
	model?: ThermostatModelInfo;
	/**
	 * Whether to subscribe to the runtime-diagnostics channel for guard blocks and
	 * task-boundary signals. Defaults to true. Tests that drive the thermostat
	 * directly (via noteSignal/noteTaskBoundary) can pass false to stay isolated
	 * from the process-global diagnostics ring.
	 */
	subscribeDiagnostics?: boolean;
	/**
	 * Wave E15: guard categories whose cross-session efficacy marks them as nuisance
	 * tighten signals (high post-block success rate). Loaded from the diagnostics
	 * sink at session boot by `SessionRecoveryController`; blocked diagnostics for
	 * these guards do NOT call `noteSignal` (fail-open when unset).
	 */
	efficacySkipTightenGuards?: ReadonlySet<string>;
	onLevelChange?: (from: SupervisionLevel, to: SupervisionLevel, signal: string) => void;
}

/**
 * Native frontier providers that start `leve`. This mirrors repair-note-policy.ts's
 * technique of distinguishing NATIVE providers by exact provider-string match (so a
 * model routed via `openrouter`/a proxy does not qualify), but uses the fixed 2-entry
 * light-start prior from §4-P0a — deliberately narrower than repair-note-policy's
 * 4-entry `STRONG_NATIVE_PROVIDERS` (no `google`, no `openai-codex`), because the
 * study fixes exactly `anthropic` and `openai` as the models that earn a lighter start.
 */
const LIGHT_START_PROVIDERS = new Set<string>(["anthropic", "openai"]);

// Tight -> loose ordering. Index == supervision strength (higher = more supervision).
const LEVEL_ORDER: readonly SupervisionLevel[] = ["leve", "padrao", "assistido"];

/**
 * Clean tool-successes required before the level may loosen one step at the next
 * task boundary. Chosen as 5 to match SessionRecoveryController's single-step
 * de-escalation constant (`CLEAN_TO_LEAN_FROM_GUIDED` / `CLEAN_TO_GUIDED_FROM_STRICT`
 * are both 5). The thermostat never loosens two levels at once (unlike recovery's
 * 10-clean `strict->lean` jump) because loosening here is additionally gated behind
 * a task boundary — a double jump would be both unnecessary and riskier.
 */
const CLEAN_STREAK_TO_LOOSEN = 5;

export function isSupervisionThermostatDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(env.PIT_NO_SUPERVISION_THERMOSTAT);
}

function computeStartLevel(model: ThermostatModelInfo | undefined): SupervisionLevel {
	if (model && LIGHT_START_PROVIDERS.has(model.provider)) return "leve";
	return "padrao";
}

function tighter(level: SupervisionLevel): SupervisionLevel {
	const idx = LEVEL_ORDER.indexOf(level);
	return LEVEL_ORDER[Math.min(LEVEL_ORDER.length - 1, idx + 1)];
}

function looser(level: SupervisionLevel): SupervisionLevel {
	const idx = LEVEL_ORDER.indexOf(level);
	return LEVEL_ORDER[Math.max(0, idx - 1)];
}

export class SupervisionThermostat {
	private readonly _startLevel: SupervisionLevel;
	private _level: SupervisionLevel;
	private _cleanStreak = 0;
	private readonly _disabled: boolean;
	private readonly _efficacySkipTightenGuards: ReadonlySet<string>;
	private readonly _onLevelChange?: SupervisionThermostatOptions["onLevelChange"];
	private _unsubscribe?: () => void;

	constructor(options: SupervisionThermostatOptions = {}) {
		this._startLevel = computeStartLevel(options.model);
		this._level = this._startLevel;
		this._efficacySkipTightenGuards = options.efficacySkipTightenGuards ?? new Set();
		this._onLevelChange = options.onLevelChange;
		// Kill-switch is decided ONCE, at construction: fail-open means no
		// subscription and no state movement for the life of this instance.
		this._disabled = isSupervisionThermostatDisabled();
		if (!this._disabled && options.subscribeDiagnostics !== false) {
			this._unsubscribe = onDiagnostic((event) => this._onDiagnostic(event));
		}
	}

	getLevel(): SupervisionLevel {
		if (this._disabled) return this._startLevel;
		return this._level;
	}

	getSnapshot(): SupervisionSnapshot {
		return {
			level: this.getLevel(),
			startLevel: this._startLevel,
			cleanStreak: this._cleanStreak,
			loosenPending: !this._disabled && this._cleanStreak >= CLEAN_STREAK_TO_LOOSEN && this._level !== "leve",
		};
	}

	/**
	 * A qualifying bad signal (guard block, verification failure, recovery thrash).
	 * Lock #1: tightens ONE step immediately, any time, and resets the clean streak.
	 * `signal` is a free-form source tag (e.g. "guard.grounding", "verification_exhausted").
	 */
	noteSignal(signal: string): void {
		if (this._disabled) return;
		this._cleanStreak = 0;
		const prev = this._level;
		this._level = tighter(this._level);
		if (prev !== this._level) this._emitTransition(prev, signal);
	}

	/**
	 * A clean tool success. Lock #2: this only grows the streak — it NEVER loosens
	 * mid-task. Loosening is applied later, at a task boundary.
	 */
	noteCleanTool(): void {
		if (this._disabled) return;
		this._cleanStreak++;
	}

	/**
	 * A task boundary (new user prompt / prompt cycle). Lock #2: the only place a
	 * pending loosen is applied. Loosens at most ONE step, then resets the streak so
	 * another full streak + boundary is required for the next step.
	 */
	noteTaskBoundary(): void {
		if (this._disabled) return;
		if (this._cleanStreak < CLEAN_STREAK_TO_LOOSEN) return;
		const prev = this._level;
		this._level = looser(this._level);
		this._cleanStreak = 0;
		if (prev !== this._level) this._emitTransition(prev, "clean");
	}

	/** Drop the diagnostics subscription. Lock #3: no cross-session state survives. */
	dispose(): void {
		this._unsubscribe?.();
		this._unsubscribe = undefined;
	}

	private _onDiagnostic(event: RecordedDiagnosticEvent): void {
		// Guard blocks (grounding/import/path/patch-audit/edit-precondition/...) are
		// the primary tighten signal: a symbol/file the model invented or a stale
		// oldText. Only the BLOCKED outcome qualifies (an overridden one is inert).
		// Exception: the intent gate's "no plan yet" block is PROCEDURAL — the normal
		// first step of a risky cycle, not evidence of a weak output — so it must not
		// tighten (it would loop: gate blocks → tighten → stricter gate). Its
		// plan-findings block (a hallucinated path in the plan) IS a quality signal
		// and tightens like any other guard.
		if (event.category.startsWith("guard.") && event.context?.outcome === "blocked") {
			if (event.context?.ruleId === "intent-gate-no-plan") return;
			// E15: skip tighten for guards whose efficacy history shows mostly
			// successful retries after block — weak supervision evidence.
			if (this._efficacySkipTightenGuards.has(event.category)) return;
			this.noteSignal(event.category);
			return;
		}
		// `quality.rigor` is emitted once per user prompt at before_agent_start — the
		// existing per-prompt-cycle boundary signal on the channel. Gate loosening here
		// (lock #2) without touching agent-session.ts.
		if (event.category === "quality.rigor") {
			this.noteTaskBoundary();
		}
	}

	private _emitTransition(from: SupervisionLevel, signal: string): void {
		const to = this._level;
		recordDiagnostic({
			category: "quality.supervision",
			level: "info",
			source: "supervision-thermostat",
			context: {
				note: `${from}->${to} signal=${signal} streak=${this._cleanStreak}`,
			},
		});
		this._onLevelChange?.(from, to, signal);
	}
}

// ---------------------------------------------------------------------------
// Module-level "current session" registry, mirroring plan-manager / verification.
// Future Band P pillars reach the active thermostat through this without threading
// it through the session — see setCurrentPlanManager (plan-manager.ts) and
// setCurrentVerificationProbe (verification/verification.ts).
// ---------------------------------------------------------------------------

let currentSupervisionThermostat: SupervisionThermostat | undefined;

export function setCurrentSupervisionThermostat(thermostat: SupervisionThermostat | undefined): void {
	currentSupervisionThermostat = thermostat;
}

export function getCurrentSupervisionThermostat(): SupervisionThermostat | undefined {
	return currentSupervisionThermostat;
}
