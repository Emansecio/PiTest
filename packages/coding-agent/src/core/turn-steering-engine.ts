import type { AgentMessage } from "@pit/agent-core";
import type { ToolResultMessage } from "@pit/ai";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import { buildCrossErrorReminder, CrossErrorTracker, decideCrossErrorReminder } from "./cross-error.js";
import type { CustomMessage } from "./messages.js";
import type { SettingsManager } from "./settings-manager.js";
import { buildStagnationReminder, classifyTurn, decideStagnationReminder, StagnationTracker } from "./stagnation.js";
import type { TodoManager } from "./todo/todo-manager.ts";
import {
	buildTodoCadenceReminder,
	classifyTodoTurn,
	decideTodoCadenceReminder,
	TodoCadenceTracker,
} from "./todo-cadence.js";
import {
	buildDoomLoopReminder,
	buildFailureBudgetReminder,
	buildToolErrorReflection,
	decideErrorReflection,
} from "./tool-call-feedback.js";
import { extractErrorMessage, fingerprintToolArgsExact, type ToolCallStats } from "./tool-call-stats.js";

// Minimum back-to-back repetitions of a multi-tool cycle (e.g. [read,edit,bash])
// before the repeating-pattern detector steers. Three full cycles of >= 2 distinct
// tools is a strong "productive-looking loop" signal the same-call doom-loop misses.
const REPEATING_PATTERN_THRESHOLD = 3;

// Trailing run of identical ERROR results (args VARYING) before the result-only
// thrash detector steers. Deliberately HIGHER than the args-keyed doom-loop
// threshold (default 2) and error-only, so this softer no-abort signal stays
// conservative and rarely false-fires. See _maybeInjectResultLoop.
const RESULT_LOOP_THRESHOLD = 5;

/**
 * Delivery callback the engine uses to inject steers/follow-ups. Mirrors
 * `AgentSession.sendCustomMessage` so the engine never reaches back into the
 * session — it only knows how to post a custom message.
 */
type SendCustomMessage = (
	message: Pick<CustomMessage, "customType" | "content" | "display" | "details">,
	options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
) => Promise<void>;

/** Collaborators the steering engine reads from (owned by the AgentSession). */
export interface TurnSteeringDeps {
	settingsManager: SettingsManager;
	toolCallStats: ToolCallStats;
	todo: TodoManager;
	sendCustomMessage: SendCustomMessage;
}

/**
 * Per-session steering/reminder policy engine. Owns every "the model is looping /
 * flailing / stalling / skipping its todo" detector and the latches that keep each
 * reminder firing at most once per streak. Extracted verbatim from AgentSession so
 * the god class no longer carries ~12 nudge methods + ~15 throttle fields; behavior
 * is preserved by construction — the trackers it now owns were already standalone
 * objects, and it reads everything else through injected collaborators.
 *
 * Detectors are intentionally non-overlapping:
 * - doom-loop: same call+result repeated (owns the hard abort)
 * - result-loop: same error, varying args (never aborts)
 * - repeating-pattern: a multi-tool cycle [A,B,C] repeated
 * - cross-error: same error across ≥2 distinct approaches ("flailing")
 * - stagnation: many turns of tool calls with no file edit
 * - todo cadence / todo-first: the plan drifted from the work
 * - failure budget: one tool burned its per-turn allowance
 */
export class TurnSteeringEngine {
	// Highest doom-loop tier already fired in the current identical-call streak.
	// Lets each tier fire once while the sequence counter keeps climbing toward
	// the Tier-3 abort — replaces the old per-tier resetSequence() that capped the
	// count at 4 and made the abort unreachable. Reset when the streak breaks.
	private _doomLoopFiredTier = 0;
	// CR6: how many times the CURRENT identical-call streak has been given a
	// structured-recovery steer at the Tier-3 threshold instead of being aborted.
	// Caps recovery at RECOVERY_LIMIT so a model that ignores the steer and keeps
	// looping still hits the hard safety abort (the throw stays reachable). Reset
	// when the streak breaks (the model left the loop). See maybeInjectDoomLoop.
	private _doomLoopRecoveryAttempts = 0;
	// Signature of the last repeating multi-tool CYCLE we fired a reminder for
	// ("<patternLength>x<repetitions>"), so we steer once per detected pattern and
	// re-arm only when the pattern grows or a different cycle/break supersedes it.
	// Complements _doomLoopFiredTier, which tracks the SAME-call loop. Empty = none.
	private _repeatingPatternFiredKey = "";
	// Once-per-streak latch for the result-only thrash signal (same error, varying
	// args). Reset when the run of identical errors breaks (count <= 1). Separate
	// from the args-keyed _doomLoopFiredTier ladder. See _maybeInjectResultLoop.
	private _resultLoopFired = false;
	private readonly _stagnation = new StagnationTracker();
	// Cross-error ("flailing") detector: same normalised error in a row across
	// ≥2 distinct call shapes. Complements the doom-loop (which owns identical
	// repeats). See maybeInjectCrossError.
	private readonly _crossError = new CrossErrorTracker();
	private _crossErrorLastFiredAt = 0;
	private _lastStagnationReminderAt = 0;
	// Streak length at which the soft stagnation reminder last fired. Paired with
	// _lastStagnationReminderAt so a flat streak between soft and hard does not
	// re-inject the identical ~500-char reminder every cooldown window — a repeat
	// also requires the streak to have grown by `step` turns (see stagnation.ts).
	private _lastStagnationReminderCount = 0;
	// Todo cadence ("sync") detector: nudges when an in_progress todo drifts from the
	// real work (stale for K turns, or a file mutation without a todo update). See
	// maybeInjectTodoCadence + ADR-0007. Persists across the session like
	// _stagnation (NOT reset per prompt).
	private readonly _todoCadence = new TodoCadenceTracker();
	private _lastTodoCadenceReminderAt = 0;
	// Todo-first safety net: non-todo work actions taken in the current prompt, plus a
	// one-shot latch so the nudge fires at most once per prompt. Both reset in prompt().
	private _promptWorkActions = 0;
	private _todoFirstNudgeFired = false;
	// Per-turn, per-tool-NAME failure budget. Counts how many times each tool
	// failed in the CURRENT turn (keyed by tool name, not args), reset strictly at
	// the top of each prompt cycle. Complements the doom-loop (same identical call)
	// and cross-error (same error across ≥2 approaches) detectors: this trips purely
	// on the failure COUNT for one tool, catching an autonomous agent that burns a
	// turn flailing on one tool with varied args and varied errors.
	// `_turnFailureBudgetFired` marks the tools that already emitted the forceful
	// steer this turn so it fires once per tool/turn.
	private readonly _turnToolFailures = new Map<string, number>();
	private readonly _turnFailureBudgetFired = new Set<string>();

	private readonly deps: TurnSteeringDeps;

	constructor(deps: TurnSteeringDeps) {
		this.deps = deps;
	}

	private _fireReminder(
		customType: string,
		content: string,
		opts: { deliverAs: "steer" | "followUp"; display: boolean; label: string },
	): void {
		this.deps
			.sendCustomMessage({ customType, content, display: opts.display }, { deliverAs: opts.deliverAs })
			.catch((err: unknown) => {
				process.stderr.write(`[pi] ${opts.label} delivery failed: ${err}\n`);
			});
	}

	/**
	 * Conditionally inject a doom-loop reminder when consecutive identical tool
	 * calls reach the configured threshold. Settings-gated (off by default).
	 *
	 * Each escalation tier fires once per streak (tracked by `_doomLoopFiredTier`)
	 * while the sequence counter keeps climbing, so a persistent loop actually
	 * reaches the Tier-3 abort. The previous version reset the counter on Tiers 1
	 * and 2, which capped it at the Tier-2 threshold and left the Tier-3 abort
	 * permanently unreachable under the default config. The streak (and the fired
	 * marker) resets when a different call breaks it.
	 *
	 * Throws to abort the turn at the Tier-3 relapse — same propagation as the old
	 * start-time throw, now gated on "same call AND same result".
	 */
	maybeInjectDoomLoop(toolName: string, args: unknown, errorMessage: string | undefined): void {
		const cfg = this.deps.settingsManager.getToolFeedbackSettings().doomLoopReminder;
		if (!cfg.enabled) return;
		// Result-aware: only calls with identical name+args AND identical result count
		// as a loop. A successful call that returns new output each step (debugger
		// stepping, tailing a growing log) keeps producing fresh result hashes, so the
		// streak never climbs and the turn is never falsely aborted.
		const consecutiveCount = this.deps.toolCallStats.getConsecutiveSimilarResultCount();

		// Escalation tiers: TIER1 → soft reminder, TIER2 → urgent pause, TIER3 →
		// structured recovery once (CR6), then a safety abort on relapse.
		// Tier2/Tier3 clamp above Tier1 so a configured threshold > 3 cannot invert the
		// order (pause/abort firing before the soft reminder). Default (threshold=2) keeps
		// the historical 2/4/6 cadence.
		const TIER1_THRESHOLD = cfg.threshold ?? 2;
		const TIER2_THRESHOLD = Math.max(4, TIER1_THRESHOLD + 2);
		const TIER3_THRESHOLD = Math.max(6, TIER1_THRESHOLD + 4);
		// CR6: how many structured-recovery steers a single streak may receive at the
		// Tier-3 threshold before the hard abort. 1 = one chance to course-correct,
		// then the safety throw on relapse. Adjustable if recovery proves too eager.
		const RECOVERY_LIMIT = 1;

		// CR5: result-only thrash signal — SEPARATE from the args-keyed ladder below
		// and run on EVERY call (the ladder's early returns must not skip it). When the
		// args ARE identical the ladder owns this point, so defer (pass that as active)
		// to avoid a double-steer. Never aborts.
		this._maybeInjectResultLoop(toolName, errorMessage, consecutiveCount >= TIER1_THRESHOLD);

		// A fresh or broken streak (a different tool+args just ran) clears which
		// tiers have fired so the next genuine loop escalates from scratch.
		if (consecutiveCount <= 1) {
			this._doomLoopFiredTier = 0;
			// CR6: a genuinely different call broke the streak — the model left the loop,
			// so forgive its recovery budget. The next distinct loop gets a fresh recovery
			// attempt before the abort (not an immediate hard stop).
			this._doomLoopRecoveryAttempts = 0;
			return;
		}
		if (consecutiveCount < TIER1_THRESHOLD) return;

		// Tier 3: structured recovery, then a safety abort on relapse. The FIRST time a
		// streak reaches this threshold we inject a recovery steer (decompose the step,
		// switch approach) instead of killing the turn — a bare abort leaves the model
		// mid-task and it tends to reopen the same loop next turn. Only a RELAPSE (the
		// streak keeps climbing past Tier-3 because the model ignored the steer and
		// repeated the call) trips the hard abort. We do NOT resetSequence() on recovery:
		// that would restart the count at 1, hit the streak-break branch above, clear the
		// recovery budget, and let the loop inject recovery forever — the safety throw
		// must stay reachable, so the count is left climbing toward the relapse abort.
		if (consecutiveCount >= TIER3_THRESHOLD) {
			if (this._doomLoopRecoveryAttempts < RECOVERY_LIMIT) {
				this._doomLoopRecoveryAttempts++;
				this._doomLoopFiredTier = 0;
				const base = buildDoomLoopReminder({ toolName, args, consecutiveCount });
				const recovery =
					`${base}\n\n` +
					`You have repeated ${consecutiveCount} calls to \`${toolName}\` with no progress. ` +
					"STOP repeating this call. Rethink from scratch: " +
					"(1) restate the goal of the current step in one sentence; " +
					"(2) list the sub-steps; " +
					"(3) execute ONLY sub-step 1, with a DIFFERENT approach (another tool or different " +
					"arguments) — or ask the user. Repeating the same call again will abort the turn.";
				this._fireReminder("pi.doom-loop-recovery", recovery, {
					deliverAs: "steer",
					display: true,
					label: "doom-loop recovery",
				});
				return;
			}
			// Relapsed after recovery: hard safety abort. Reset the recovery budget so a
			// future loop (next turn) is once again offered recovery before aborting.
			this._doomLoopRecoveryAttempts = 0;
			this._doomLoopFiredTier = 0;
			this.deps.toolCallStats.resetSequence();
			throw new Error(
				`Doom loop abort: ${consecutiveCount} consecutive identical calls to "${toolName}". ` +
					`The model cannot make progress on this task. Aborting turn.`,
			);
		}

		// Tier 2: urgent escalation (visible to the user), once per streak.
		// Delivered as "steer" — not "followUp" — because follow-ups only drain
		// once the inner loop ends, and a doom-loop by definition keeps producing
		// tool calls; a steer is injected before the very next model turn while the
		// loop is still hot. Does NOT reset the sequence: the count must keep
		// climbing so a persistent loop reaches the Tier-3 abort instead of
		// oscillating here forever.
		if (consecutiveCount >= TIER2_THRESHOLD) {
			if (this._doomLoopFiredTier >= 2) return;
			this._doomLoopFiredTier = 2;
			const remaining = TIER3_THRESHOLD - consecutiveCount;
			const content = buildDoomLoopReminder({ toolName, args, consecutiveCount });
			const escalation =
				content +
				`\n\nYou have made ${consecutiveCount} identical calls without progress. ` +
				"Do NOT repeat this call again. State what you expected, what actually happened, " +
				"and switch strategy: different tool, different arguments, or ask the user for guidance. " +
				`${remaining} more identical call${remaining === 1 ? "" : "s"} will abort the turn.`;
			this._fireReminder("pi.doom-loop-pause", escalation, {
				deliverAs: "steer",
				display: true,
				label: "doom-loop pause",
			});
			return;
		}

		// Tier 1: soft reminder, once per streak. Also a steer (see Tier 2): a
		// followUp would sit queued behind the still-running tool-call loop it is
		// trying to break.
		if (this._doomLoopFiredTier >= 1) return;
		this._doomLoopFiredTier = 1;
		const content = buildDoomLoopReminder({ toolName, args, consecutiveCount });
		this._fireReminder("pi.doom-loop-reminder", content, {
			deliverAs: "steer",
			display: false,
			label: "doom-loop reminder",
		});
	}

	/**
	 * CR5 result-only doom-loop: the model keeps CHANGING the arguments but gets the
	 * SAME error every call. The args-keyed ladder in {@link maybeInjectDoomLoop}
	 * resets each call (args differ) and never climbs, so it never catches this
	 * thrash; this does. Higher threshold ({@link RESULT_LOOP_THRESHOLD}) and
	 * error-only by design (see {@link ToolCallStats.getConsecutiveSimilarResultOnlyCount})
	 * to keep false positives low. Fires ONE steer per streak and NEVER aborts (the
	 * Tier-3 abort stays exclusive to the args-keyed loop). Deferred to that ladder
	 * when args ARE identical (`argsLadderActive`) so a pure identical loop is not
	 * double-steered. The once-per-streak latch resets when the run breaks (count <= 1).
	 */
	private _maybeInjectResultLoop(toolName: string, errorMessage: string | undefined, argsLadderActive: boolean): void {
		const count = this.deps.toolCallStats.getConsecutiveSimilarResultOnlyCount();
		if (count <= 1) {
			this._resultLoopFired = false;
			return;
		}
		// The args-keyed ladder already owns an identical-call loop — don't stack two steers.
		if (argsLadderActive) return;
		if (count < RESULT_LOOP_THRESHOLD) return;
		if (this._resultLoopFired) return;
		this._resultLoopFired = true;
		const summary = (errorMessage ?? "(no error text)").trim();
		const cappedSummary = summary.length > 300 ? `${summary.slice(0, 300)}…` : summary;
		const content = [
			"<result-loop-reminder>",
			`You have called \`${toolName}\` ${count} times with DIFFERENT arguments but got the SAME error every time:`,
			"",
			"```",
			cappedSummary,
			"```",
			"",
			"Varying the arguments is not working — the failure is identical regardless. Stop tweaking the arguments and change approach: a different tool, a fundamentally different strategy, or ask the user for guidance. Do not retry another small variation.",
			"</result-loop-reminder>",
		].join("\n");
		this._fireReminder("pi.result-loop-reminder", content, {
			deliverAs: "steer",
			display: true,
			label: "result-loop reminder",
		});
	}

	/**
	 * Conditionally inject a reminder when the agent is cycling a repeating
	 * MULTI-tool pattern at the tail of the recent-call window — e.g.
	 * [read,edit,bash] run three times in a row. This is the "productive-looking"
	 * loop that the consecutive-identical doom-loop ({@link maybeInjectDoomLoop})
	 * cannot see, because each call within a cycle is a DIFFERENT tool. Complementary
	 * and non-overlapping: it requires patternLength >= 2 (cycles of distinct calls),
	 * so a single call repeated stays exclusively the doom-loop's job and never
	 * double-fires.
	 *
	 * Fires ONCE per detected pattern (tracked by `_repeatingPatternFiredKey`),
	 * re-arming only when the cycle/repetition signature changes or the pattern
	 * breaks. Default-on; disable with `PIT_NO_REPEATING_PATTERN=1`. Delivered as a
	 * steer (like the doom-loop) so it lands before the next turn while the loop is
	 * still hot.
	 */
	maybeInjectRepeatingPattern(): void {
		if (isTruthyEnvFlag(process.env.PIT_NO_REPEATING_PATTERN)) {
			this._repeatingPatternFiredKey = "";
			return;
		}
		const match = this.deps.toolCallStats.getRepeatingPatternCount();
		// patternLength >= 2 excludes the same-call loop (the doom-loop owns it), so
		// the two detectors never fire on the same condition.
		if (match.patternLength < 2 || match.repetitions < REPEATING_PATTERN_THRESHOLD) {
			// Pattern broke or never reached threshold — re-arm for the next cycle.
			this._repeatingPatternFiredKey = "";
			return;
		}
		// Fire-once signature is the CYCLE composition (the trailing block of tool
		// names), NOT the repetition count — so the same cycle repeating more times
		// does not re-spam every pass. Re-arms only when a different cycle takes over
		// or the pattern breaks (handled above). `getRepeatingPatternCount` keys on
		// args, so the displayed tool names alone suffice as the anti-respam key.
		const cycle = this.deps.toolCallStats
			.getSequence()
			.slice(-match.patternLength)
			.map((e) => e.toolName)
			.join(" → ");
		const key = `${match.patternLength}:${cycle}`;
		if (this._repeatingPatternFiredKey === key) return;
		this._repeatingPatternFiredKey = key;
		const content =
			"<repeating-pattern-reminder>\n" +
			`You have repeated the same ${match.patternLength}-step tool cycle ` +
			`(${cycle}) ${match.repetitions} times in a row without resolving the task. ` +
			"This pattern looks productive but is not converging.\n\n" +
			"Stop and reassess before running the cycle again:\n" +
			"- What is the cycle supposed to achieve, and why has it not finished after " +
			`${match.repetitions} passes?\n` +
			"- Is there a root cause you are working around instead of fixing?\n" +
			"- Would a different approach, a larger single change, or asking the user for " +
			"guidance break the loop?\n" +
			"</repeating-pattern-reminder>";
		this._fireReminder("pi.repeating-pattern-reminder", content, {
			deliverAs: "steer",
			display: false,
			label: "repeating-pattern reminder",
		});
	}

	/**
	 * Conditionally inject a "you keep hitting the same error" reminder when the
	 * agent fails repeatedly with one normalised error across ≥2 distinct call
	 * shapes. Unlike the doom-loop (identical repeats), this catches "flailing":
	 * the model reacts to a failure by switching tool or tweaking arguments yet
	 * keeps producing the same blocker — each call's args differ, so the doom-loop
	 * never trips. Settings-gated; delivered as a steer (like the doom-loop) so it
	 * lands before the next turn while the loop is still hot. `observeError` runs
	 * on every fingerprinted error to keep the streak current even when no reminder
	 * fires.
	 */
	maybeInjectCrossError(errorFingerprint: string | undefined, args: unknown, sampleError: string | undefined): void {
		if (!errorFingerprint) return;
		const cfg = this.deps.settingsManager.getToolFeedbackSettings().crossErrorReminder;
		const { count, distinctApproaches } = this._crossError.observeError(
			errorFingerprint,
			fingerprintToolArgsExact(args),
		);
		const decision = decideCrossErrorReminder({
			enabled: cfg.enabled,
			threshold: cfg.threshold,
			count,
			distinctApproaches,
			lastFiredAt: this._crossErrorLastFiredAt,
			now: Date.now(),
			cooldownMs: cfg.cooldownMs,
		});
		if (!decision.fire) return;
		this._crossErrorLastFiredAt = decision.nextLastFiredAt;
		const content = buildCrossErrorReminder({ count, distinctApproaches, sampleError });
		this._fireReminder("pi.cross-error-reminder", content, {
			deliverAs: "steer",
			display: false,
			label: "cross-error reminder",
		});
	}

	/** Record a successful (non-error) tool call so the cross-error streak resets. */
	observeToolSuccess(): void {
		this._crossError.observeSuccess();
	}

	/**
	 * Conditionally nudge (soft) — then pause (hard) — when the agent runs many
	 * consecutive turns that call tools but never edit a file. Settings-gated
	 * (on by default; opt out via toolFeedback.stagnationReminder.enabled: false)
	 * and cooldown-throttled for the soft tier; the hard tier
	 * always escalates and resets the streak. Complements the identical-call
	 * doom-loop detector, which this does not duplicate.
	 */
	maybeInjectStagnation(message: AgentMessage, toolResults: ToolResultMessage[]): void {
		const cfg = this.deps.settingsManager.getToolFeedbackSettings().stagnationReminder;
		if (!cfg.enabled) return;
		const count = this._stagnation.observe(classifyTurn(message, toolResults));
		const decision = decideStagnationReminder({
			enabled: cfg.enabled,
			softThreshold: cfg.softThreshold,
			hardThreshold: cfg.hardThreshold,
			count,
			lastFiredAt: this._lastStagnationReminderAt,
			now: Date.now(),
			cooldownMs: cfg.cooldownMs,
			lastFiredCount: this._lastStagnationReminderCount,
		});
		if (decision.action === "none") return;
		this._lastStagnationReminderAt = decision.nextLastFiredAt;
		this._lastStagnationReminderCount = decision.nextLastFiredCount;
		// Both tiers deliver as "steer", not "followUp" (same reason as the
		// doom-loop above): stagnation happens DURING the tool-call loop, and a
		// followUp would sit queued behind that loop — only draining once it ends,
		// which is exactly the stall we are trying to break. A steer lands before
		// the next model turn while the loop is still hot.
		if (decision.action === "pause") {
			this._stagnation.reset();
			// Streak is wiped: clear the soft-reminder memory too so a fresh streak
			// after the user resumes fires cleanly at the soft threshold again.
			this._lastStagnationReminderAt = 0;
			this._lastStagnationReminderCount = 0;
			const content = buildStagnationReminder({ count, paused: true });
			this._fireReminder("pi.stagnation-pause", content, {
				deliverAs: "steer",
				display: true,
				label: "stagnation pause",
			});
			return;
		}
		const content = buildStagnationReminder({ count, paused: false });
		this._fireReminder("pi.stagnation-reminder", content, {
			deliverAs: "steer",
			display: false,
			label: "stagnation reminder",
		});
	}

	/**
	 * Record a successful non-todo/plan work action this prompt and, at the 2nd one
	 * without a todo list, nudge once (the todo-first safety net). Counterpart of
	 * {@link resetPromptWorkActions}, called at the top of each prompt cycle.
	 */
	recordWorkAction(): void {
		this._promptWorkActions++;
		this._maybeFireTodoFirstNudge();
	}

	/**
	 * Todo-first safety net (ADR-0007): the triage protocol in the system prompt
	 * should make the agent create a todo before non-trivial work. This catches the
	 * miss — once the agent has taken ≥2 non-todo work actions in a prompt with an
	 * empty todo list, fire a single silent nudge. One-shot per prompt (latched),
	 * settings-gated via the shared todoCadenceReminder switch.
	 */
	private _maybeFireTodoFirstNudge(): void {
		if (this._todoFirstNudgeFired) return;
		if (this._promptWorkActions < 2) return;
		if (!this.deps.todo.isEmpty()) return;
		const cfg = this.deps.settingsManager.getToolFeedbackSettings().todoCadenceReminder;
		if (!cfg.enabled) return;
		this._todoFirstNudgeFired = true;
		const content = [
			"<todo-first-reminder>",
			"You have taken several actions without a todo list. If this task needs more than one step " +
				"or any investigation, create a todo now (even a single '1. Identify X') and mark one " +
				"in_progress so your progress stays tracked.",
			"</todo-first-reminder>",
		].join("\n");
		this._fireReminder("pi.todo-first-nudge", content, {
			deliverAs: "steer",
			display: false,
			label: "todo-first nudge",
		});
	}

	/**
	 * Todo cadence ("sync") reminder (ADR-0007): hand the enumerated todo list back
	 * to the model and ask it to update status when the list has drifted from the
	 * real work — an item sits in_progress for K turns with no todo update, or a file
	 * was mutated this turn without touching the todo. Reminds, never auto-completes.
	 * Delivered as a steer (lands before the next turn while the loop is hot, like
	 * stagnation). Settings-gated + cooldown-throttled.
	 */
	maybeInjectTodoCadence(message: AgentMessage, toolResults: ToolResultMessage[]): void {
		const cfg = this.deps.settingsManager.getToolFeedbackSettings().todoCadenceReminder;
		if (!cfg.enabled) return;
		const { touchedTodo, mutated } = classifyTodoTurn(message, toolResults);
		const hasInProgress = this.deps.todo.hasInProgress();
		const staleTurns = this._todoCadence.observe({ hasInProgress, touchedTodo });
		const mutatedWithoutTodo = mutated && !touchedTodo && !this.deps.todo.isEmpty();
		const decision = decideTodoCadenceReminder({
			enabled: cfg.enabled,
			threshold: cfg.threshold,
			staleTurns,
			mutatedWithoutTodo,
			lastFiredAt: this._lastTodoCadenceReminderAt,
			now: Date.now(),
			cooldownMs: cfg.cooldownMs,
		});
		if (decision.action === "none") return;
		this._lastTodoCadenceReminderAt = decision.nextLastFiredAt;
		const items = this.deps.todo.list();
		const staleItem = items.find((t) => t.status === "in_progress");
		const reason = mutatedWithoutTodo ? "mutated" : "stale";
		const content = buildTodoCadenceReminder({ items, staleItem, reason });
		this._fireReminder("pi.todo-cadence-reminder", content, {
			deliverAs: "steer",
			display: false,
			label: "todo cadence reminder",
		});
	}

	/**
	 * Conditionally inject a structured reflection prompt after a failing tool
	 * call. Settings-gated, OFF by default: delivered as a `followUp`, it fires a
	 * separate turn that runs after the model has already read the error inline
	 * and self-corrected, so it lands stale and leaks a phantom "stale reflection"
	 * reply to the user. Inline feedback (raw tool-result + Tier-4 hint rules)
	 * already covers this behind the scenes. Opt in via
	 * toolFeedback.errorReflection.enabled. Args captured at tool_execution_start
	 * name the exact failing invocation.
	 */
	maybeInjectToolErrorReflection(toolName: string, args: unknown, result: unknown, attemptsLeft?: number): void {
		const cfg = this.deps.settingsManager.getToolFeedbackSettings().errorReflection;
		if (!decideErrorReflection({ enabled: cfg.enabled, isError: true })) return;
		const resultContent = (result as { content?: Array<{ type: string; text?: string }> } | undefined)?.content;
		const errorMessage = extractErrorMessage(resultContent);
		const content = buildToolErrorReflection({ toolName, args, errorMessage, attemptsLeft });
		this.deps
			.sendCustomMessage(
				{ customType: "pi.tool-error-reflection", content, display: false },
				{ deliverAs: "followUp" },
			)
			.catch(() => {
				// Failure to inject a reflection must not break tool execution.
			});
	}

	/**
	 * Increment the per-turn failure counter for `toolName` (keyed by NAME, not
	 * args) and report the remaining budget. Called once per failing tool call.
	 * Returns the new count and the retries left under the configured per-turn
	 * cap (clamped at 0). When the budget is disabled, attemptsLeft is left
	 * undefined so the reflection prompt simply omits the line.
	 */
	recordTurnToolFailure(toolName: string): { count: number; attemptsLeft: number | undefined; max: number } {
		const cfg = this.deps.settingsManager.getToolFeedbackSettings().failureBudget;
		const count = (this._turnToolFailures.get(toolName) ?? 0) + 1;
		this._turnToolFailures.set(toolName, count);
		if (!cfg.enabled) return { count, attemptsLeft: undefined, max: cfg.maxPerTurn };
		return { count, attemptsLeft: Math.max(0, cfg.maxPerTurn - count), max: cfg.maxPerTurn };
	}

	/**
	 * Inject a forceful steer when a single tool exhausts its per-turn failure
	 * budget (count >= maxPerTurn). Fires once per tool per turn so a tool that
	 * keeps failing after exhaustion does not re-spam the reminder every call.
	 * Delivered as a "steer" (like the doom-loop/cross-error reminders) so it
	 * lands before the next model turn while the tool-call loop is still hot —
	 * a followUp would sit queued behind the loop it is trying to break.
	 * Complements, not duplicates: doom-loop owns identical repeats, cross-error
	 * owns one error across approaches, and this owns the raw per-tool failure
	 * count regardless of args or error text.
	 */
	maybeInjectFailureBudget(toolName: string, count: number, max: number): void {
		const cfg = this.deps.settingsManager.getToolFeedbackSettings().failureBudget;
		if (!cfg.enabled) return;
		if (count < max) return;
		if (this._turnFailureBudgetFired.has(toolName)) return;
		this._turnFailureBudgetFired.add(toolName);
		const content = buildFailureBudgetReminder({ toolName, failureCount: count, maxPerTurn: max });
		this._fireReminder("pi.tool-failure-budget", content, {
			deliverAs: "steer",
			display: false,
			label: "tool-failure-budget reminder",
		});
	}

	/**
	 * Reset the per-turn, per-tool failure budget so each tool starts the turn with
	 * a fresh allowance. Called at the top of each prompt cycle and re-armed before
	 * every goal continuation so the budget is per model-attempt, not per goal.
	 */
	resetTurnFailureBudget(): void {
		this._turnToolFailures.clear();
		this._turnFailureBudgetFired.clear();
	}

	/**
	 * Per-prompt reset for the todo-first safety net (the cadence tracker itself
	 * persists across the session, like _stagnation).
	 */
	resetPromptWorkActions(): void {
		this._promptWorkActions = 0;
		this._todoFirstNudgeFired = false;
	}
}
