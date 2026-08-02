/**
 * Pure view decisions for `InteractiveMode.handleEvent`.
 *
 * Everything here is a total function of (state snapshot, event) → typed effect
 * descriptors. Nothing in this module touches `chatContainer`, `ui`, `theme`,
 * timers, or any other live object: the caller (`handleEvent`) is a thin applier
 * that turns the descriptors below into widget-tree mutations.
 *
 * The split exists so the 29-case event switch can be exercised without a
 * terminal: the *decision* (what should the frame say?) is unit-testable here,
 * while the *application* (which widget receives it) stays in the mode class.
 *
 * Note on scope: this module owns the transient status band / loader / phase
 * label. Transcript grouping (ADR-0005 — navigation folds into an Activity
 * Group, action tools get their own line) is NOT decided here; it lives in
 * `ActivityStacker.placeCall` and is reached through `_ensureToolComponent`,
 * which the applier still calls directly.
 */

import type { AgentSessionEvent } from "../../core/agent-session-events.ts";
import { formatElapsed } from "../../core/goal/goal-manager.ts";
import { pluralCountLabel } from "./components/context-display.ts";
import type { FusionLiveMember } from "./components/fusion-live.ts";
import type { PetMoodState } from "./components/pet-mood.ts";
import { workingPhaseLabel } from "./components/tool-activity.ts";
import { classifyRetryReason } from "./retry-reason.ts";

/** Theme colour token used to paint an ephemeral status line. */
export type StatusTone = "dim" | "muted" | "success" | "warning";

/**
 * One colored span of a status line. `tone` LOCAL to the segment (`"text"` =
 * the primary text color); a segment WITHOUT a tone inherits the line's
 * `tone`. Keeping this declarative leaves the decisions pure — the terminal is
 * what maps tones to theme colors.
 */
export type StatusSegment = { text: string; tone?: StatusTone | "text" };

/** Fusion panel stage, mirrored from the `fusion_stage` event. */
export type FusionStageName = "brief" | "panel" | "judge" | "verify" | "writer";

/** Pet mood the turn view can ask for. The mascot's own state machine owns the
 * transitions; the view only names the mood a lifecycle event implies. */
export type PetMoodName = PetMoodState;

/**
 * A single thing the view should do. Deliberately data-only (no closures, no
 * component references) so a test can assert on the descriptor itself.
 */
export type TurnViewEffect =
	/** OSC progress indicator on the host terminal. */
	| { kind: "terminal-progress"; active: boolean }
	/** Rebuild the working loader when the turn wants one and none is live. */
	| { kind: "ensure-working-loader" }
	/** Retire the working loader (and the fusion strip it owns). */
	| { kind: "stop-working-loader" }
	/** Phase label shown next to the spinner. */
	| { kind: "working-phase"; text: string }
	/** Recompute the loader's trailing `esc interrupt` / token chips. */
	| { kind: "refresh-loader-suffix" }
	| { kind: "pet-mood"; mood: PetMoodName }
	/** Gearbox anomaly: leave the smol role for this step. */
	| { kind: "gearbox-upshift"; reason: string }
	/** Ephemeral status line. `level: "sticky"` keeps it until host-clear (work of
	 * unknown duration); `segments`, when present, render with per-span colors
	 * while `text` stays the plain concatenation. */
	| { kind: "status"; text: string; tone: StatusTone; level?: "info" | "sticky"; segments?: StatusSegment[] }
	/** Sticky error line. */
	| { kind: "error"; text: string }
	/** Permanent warning line appended to the transcript. */
	| { kind: "chat-warning-line"; text: string }
	/** Build (or reuse) the transcript block for a tool call and mark it running.
	 * The transcript grouping rules of ADR-0005 are applied by the callee. */
	| { kind: "tool-component-start"; toolName: string; toolCallId: string; args: unknown }
	/** Point the editor's Esc at `abortCompaction`, stashing the previous handler. */
	| { kind: "bind-compaction-escape" }
	/** Replace the status band with the compaction spinner. */
	| { kind: "compaction-loader"; label: string }
	/** Point the editor's Esc at `abortRetry`, stashing the previous handler. */
	| { kind: "bind-retry-escape" }
	/** Create the fusion strip if it is not up yet. */
	| { kind: "fusion-ensure" }
	| { kind: "fusion-member"; member: FusionLiveMember }
	| { kind: "fusion-synth"; synthId: string }
	| { kind: "fusion-stage"; stage: FusionStageName }
	/** Arm the "writer owns the frame" flag so `message_start` retires the strip. */
	| { kind: "fusion-writer-handoff" }
	/** Upsert one subagent's row on the live Agents strip. The component requests its own render. */
	| { kind: "subagents-start"; handle: string }
	| { kind: "subagents-progress"; handle: string; turn: number; lastTool?: string; totalTokens?: number }
	| { kind: "subagents-complete"; handle: string; status: "done" | "error"; turns?: number; totalTokens?: number }
	/** Replace the status band with the retry countdown spinner. */
	| { kind: "retry-loader"; attempt: number; maxAttempts: number; delayMs: number; reason: string | undefined }
	/** Tear down retry loader + countdown + escape handler. */
	| { kind: "cleanup-retry-ui" }
	| { kind: "render" };

/** Snapshot of the working-loader state the decisions need. */
export interface WorkingLoaderState {
	/** True while the turn wants a visible working loader. */
	workingVisible: boolean;
	/** True when a `Loader` instance is currently live. */
	hasWorkingLoader: boolean;
}

/** Emit `ensure-working-loader` only when the turn wants a loader and has none. */
function ensureLoaderEffects(state: WorkingLoaderState): TurnViewEffect[] {
	return state.workingVisible && !state.hasWorkingLoader ? [{ kind: "ensure-working-loader" }] : [];
}

type EventOf<T extends AgentSessionEvent["type"]> = Extract<AgentSessionEvent, { type: T }>;

// ---------------------------------------------------------------------------
// agent_start
// ---------------------------------------------------------------------------

/**
 * A new turn begins. The only real decision is whether the loader created at
 * submit time survived (gap-morto reuse) or has to be rebuilt; the rest is a
 * fixed opening frame. Bookkeeping resets (pending tools, token counters,
 * activity stacker) are not view state and stay with the caller.
 */
export function decideAgentStart(state: WorkingLoaderState): TurnViewEffect[] {
	return [
		{ kind: "terminal-progress", active: true },
		{ kind: "cleanup-retry-ui" },
		...ensureLoaderEffects(state),
		{ kind: "working-phase", text: "Thinking…" },
		{ kind: "pet-mood", mood: "thinking" },
		{ kind: "render" },
	];
}

// ---------------------------------------------------------------------------
// tool_execution_start
// ---------------------------------------------------------------------------

export interface ToolExecutionStartState {
	/** `tui.toolActivity` setting: "grouped" keeps the loader neutral. */
	toolActivity: string;
}

/**
 * A tool starts running. Grouped mode already shows verb+target on the activity
 * line, so the loader stays neutral instead of mirroring the same action twice.
 * `ask` is a gearbox anomaly: the model reached for judgement, so upshift.
 */
export function decideToolExecutionStart(
	event: Pick<EventOf<"tool_execution_start">, "toolName" | "toolCallId" | "args">,
	state: ToolExecutionStartState,
): TurnViewEffect[] {
	const effects: TurnViewEffect[] = [];
	if (event.toolName === "ask") effects.push({ kind: "gearbox-upshift", reason: "ask" });
	effects.push({
		kind: "tool-component-start",
		toolName: event.toolName,
		toolCallId: event.toolCallId,
		args: event.args,
	});
	effects.push({
		kind: "working-phase",
		text:
			state.toolActivity === "grouped"
				? "Working…"
				: workingPhaseLabel(event.toolName, event.args as Record<string, unknown>, true),
	});
	// Esc changes meaning while tools are cancellable — swap the loader hint at
	// the boundary, not on the next stream tick.
	effects.push({ kind: "refresh-loader-suffix" });
	effects.push({ kind: "pet-mood", mood: "working" });
	effects.push({ kind: "render" });
	return effects;
}

// ---------------------------------------------------------------------------
// compaction_start
// ---------------------------------------------------------------------------

/** Label for the compaction spinner, including the cancel hint. */
export function compactionLoaderLabel(reason: EventOf<"compaction_start">["reason"], interruptKey: string): string {
	const cancelHint = `(${interruptKey} cancel)`;
	if (reason === "manual") return `Compacting context… ${cancelHint}`;
	return `${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting… ${cancelHint}`;
}

export function decideCompactionStart(
	event: Pick<EventOf<"compaction_start">, "reason">,
	state: { interruptKey: string },
): TurnViewEffect[] {
	return [
		{ kind: "terminal-progress", active: true },
		// Keep editor active; submissions are queued during compaction.
		{ kind: "bind-compaction-escape" },
		{ kind: "compaction-loader", label: compactionLoaderLabel(event.reason, state.interruptKey) },
		// Compaction is neither thinking nor tool work — the pet chews on the
		// context with its own slow circular gaze so the wait reads as progress.
		{ kind: "pet-mood", mood: "digesting" },
		{ kind: "render" },
	];
}

// ---------------------------------------------------------------------------
// fusion_member / fusion_stage
// ---------------------------------------------------------------------------

/**
 * Project a `fusion_member` event onto the strip's row model.
 *
 * `idleTimeoutMs` is load-bearing: the row renders an `idle Ns / Ts` warning
 * countdown off it (`components/fusion-live.ts`), and the IDLE cap — not the
 * wall-clock one — is what actually kills a stuck member. The pre-refactor
 * handler dropped the field, so `idleLimit` was always 0 and that countdown
 * could never render; a member about to be reaped looked like a member working
 * normally. The emitter has always set it (`agent-session-fusion.ts`), so this
 * forwards it rather than deleting a field that both ends already speak.
 */
export function decideFusionMember(event: EventOf<"fusion_member">): TurnViewEffect[] {
	const member: FusionLiveMember = {
		index: event.index,
		cli: event.cli,
		model: event.model,
		status: event.status,
		elapsedMs: event.elapsedMs,
		timeoutMs: event.timeoutMs,
		idleTimeoutMs: event.idleTimeoutMs,
		chars: event.chars,
		error: event.error,
	};
	// `upsertMember` requests a render internally — no explicit render effect.
	return [{ kind: "fusion-ensure" }, { kind: "fusion-member", member }];
}

/**
 * Stage transitions keep the strip in place (no swap to a generic loader). The
 * explicit render is required because `setSynth`/`setStage` early-return when the
 * value is unchanged, which on a freshly created strip means neither paints.
 */
export function decideFusionStage(event: EventOf<"fusion_stage">): TurnViewEffect[] {
	const effects: TurnViewEffect[] = [
		{ kind: "fusion-ensure" },
		{ kind: "fusion-synth", synthId: event.synthId },
		{ kind: "fusion-stage", stage: event.stage },
	];
	if (event.stage === "writer") effects.push({ kind: "fusion-writer-handoff" });
	effects.push({ kind: "render" });
	return effects;
}

// ---------------------------------------------------------------------------
// subagent_*
// ---------------------------------------------------------------------------

/*
 * Subagent lifecycle feeds a MULTI-LINE live strip (Agents), not the single
 * status band. One line per agent means parallel delegations stop fighting over
 * a shared sticky line — each row settles in place as its own agent progresses
 * and reaches a terminal state, instead of the band flickering between whoever
 * emitted last. The decisions here are pure upserts keyed by `handle`; the strip
 * component requests its own render (same contract as `decideFusionMember`), so
 * no explicit `render` effect. Collapsing the strip into a one-line summary once
 * every agent has finished is the applier's call — it can ask the component
 * whether any row is still running — not something this module can know from a
 * single event.
 */
export function decideSubagentStart(event: Pick<EventOf<"subagent_start">, "handle">): TurnViewEffect[] {
	return [{ kind: "subagents-start", handle: event.handle }];
}

export function decideSubagentProgress(
	event: Pick<EventOf<"subagent_progress">, "handle" | "turn" | "lastTool" | "totalTokens">,
): TurnViewEffect[] {
	return [
		{
			kind: "subagents-progress",
			handle: event.handle,
			turn: event.turn,
			lastTool: event.lastTool,
			totalTokens: event.totalTokens,
		},
	];
}

export function decideSubagentComplete(
	event: Pick<EventOf<"subagent_complete">, "handle" | "status" | "turns" | "totalTokens">,
): TurnViewEffect[] {
	return [
		{
			kind: "subagents-complete",
			handle: event.handle,
			status: event.status,
			turns: event.turns,
			totalTokens: event.totalTokens,
		},
	];
}

// ---------------------------------------------------------------------------
// auto_retry_start / auto_retry_end
// ---------------------------------------------------------------------------

/**
 * Countdown message for the retry loader. Surfaces WHY we're retrying
 * (rate-limit / overload / network / …) so the paused countdown isn't an opaque
 * "is it stuck or just busy?"; an unclassifiable error keeps the wording
 * unchanged.
 */
export function retryLoaderMessage(
	descriptor: { attempt: number; maxAttempts: number; reason: string | undefined },
	seconds: number,
	interruptKey: string,
): string {
	const prefix = descriptor.reason ? `${descriptor.reason} — ` : "";
	return `${prefix}retry ${descriptor.attempt}/${descriptor.maxAttempts} in ${seconds}s·${interruptKey} cancel`;
}

export function decideAutoRetryStart(
	event: Pick<EventOf<"auto_retry_start">, "attempt" | "maxAttempts" | "delayMs" | "errorMessage">,
): TurnViewEffect[] {
	return [
		{ kind: "bind-retry-escape" },
		{
			kind: "retry-loader",
			attempt: event.attempt,
			maxAttempts: event.maxAttempts,
			delayMs: event.delayMs,
			reason: classifyRetryReason(event.errorMessage),
		},
		// Nothing is running during the backoff — the pet waits it out too.
		{ kind: "pet-mood", mood: "waiting" },
		{ kind: "render" },
	];
}

export function decideAutoRetryEnd(
	event: Pick<EventOf<"auto_retry_end">, "success" | "attempt" | "finalError" | "cancelled">,
): TurnViewEffect[] {
	const effects: TurnViewEffect[] = [{ kind: "cleanup-retry-ui" }];
	// The wait is over either way: back to reasoning when the retry took, or the
	// shake tell when it gave up for good (a user cancel gets neither).
	effects.push({ kind: "pet-mood", mood: event.success ? "thinking" : event.cancelled ? "idle" : "error" });
	if (!event.success) {
		if (event.cancelled) {
			// The user asked for this — muted status with normal TTL, not sticky
			// error red (mirrors "Compaction cancelled").
			effects.push({ kind: "status", text: "Retry cancelled", tone: "dim" });
		} else {
			const noun = event.attempt === 1 ? "attempt" : "attempts";
			effects.push({
				kind: "error",
				text: `Retry failed after ${event.attempt} ${noun}: ${event.finalError || "Unknown error"}`,
			});
		}
	}
	effects.push({ kind: "render" });
	return effects;
}

// ---------------------------------------------------------------------------
// fallback_warning
// ---------------------------------------------------------------------------

export function decideFallbackWarning(
	event: Pick<EventOf<"fallback_warning">, "from" | "to" | "reason">,
): TurnViewEffect[] {
	return [
		{ kind: "chat-warning-line", text: `[fallback] ${event.from} -> ${event.to}: ${event.reason}` },
		{ kind: "render" },
	];
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

/**
 * Post-turn verification gate. The running phase bridges the post-turn gap like
 * Fusion's "Synthesizing…" path: keep the working loader alive with an accurate
 * phase so the UI doesn't look frozen on "Thinking…" while npm test / tsc runs.
 */
export function decideVerification(
	event: Pick<EventOf<"verification">, "phase" | "command" | "attempt" | "maxAttempts" | "exitCode" | "willRetry">,
	state: WorkingLoaderState,
): TurnViewEffect[] {
	const effects: TurnViewEffect[] = [{ kind: "terminal-progress", active: event.phase === "running" }];
	if (event.phase === "running") {
		effects.push(...ensureLoaderEffects(state));
		effects.push({
			kind: "working-phase",
			text:
				event.attempt > 1
					? `Verifying (${event.command}) — attempt ${event.attempt}…`
					: `Verifying (${event.command})…`,
		});
	} else if (event.phase === "passed") {
		effects.push({ kind: "working-phase", text: `✓ Verified — ${event.command} passed` });
	} else if (event.phase === "timeout") {
		// Inconclusive, not red: don't show the scary "still failing" error.
		effects.push({ kind: "stop-working-loader" });
		effects.push({
			kind: "status",
			text: `⚠ ${event.command} timed out — result unknown (not treated as failure); auto-check off for this session`,
			tone: "warning",
		});
	} else if (event.willRetry) {
		effects.push({
			kind: "working-phase",
			text: `✗ ${event.command} failed (exit ${event.exitCode ?? "?"}) — fixing…`,
		});
	} else {
		effects.push({ kind: "stop-working-loader" });
		effects.push({
			kind: "error",
			text: `✗ ${event.command} still failing after ${pluralCountLabel(event.maxAttempts, "fix attempt", "fix attempts")} — reported unverified.`,
		});
	}
	effects.push({ kind: "render" });
	return effects;
}

// ---------------------------------------------------------------------------
// pending_check
// ---------------------------------------------------------------------------

export function decidePendingCheck(
	event: Pick<EventOf<"pending_check">, "phase" | "command" | "elapsedMs" | "exitCode">,
	state: WorkingLoaderState,
): TurnViewEffect[] {
	const effects: TurnViewEffect[] = [{ kind: "terminal-progress", active: event.phase === "waiting" }];
	if (event.phase === "waiting") {
		const elapsed = event.elapsedMs !== undefined ? ` (${formatElapsed(event.elapsedMs)})` : "";
		effects.push({ kind: "status", text: `Waiting for ${event.command}…${elapsed}`, tone: "dim" });
		effects.push(...ensureLoaderEffects(state));
	} else if (event.phase === "passed") {
		effects.push({ kind: "status", text: `✓ ${event.command} passed`, tone: "success" });
	} else if (event.phase === "timeout") {
		effects.push({ kind: "status", text: `⚠ ${event.command} still running after wait`, tone: "warning" });
	} else {
		effects.push({
			kind: "status",
			text: `✗ ${event.command} failed (exit ${event.exitCode ?? "?"})`,
			tone: "warning",
		});
	}
	effects.push({ kind: "render" });
	return effects;
}
