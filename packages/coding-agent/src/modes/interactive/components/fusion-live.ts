import { performance } from "node:perf_hooks";
import { type Component, SPINNER_FRAME_MS, SPINNER_FRAMES, type TUI, truncateToWidth, visibleWidth } from "@pit/tui";
import { theme } from "../theme/theme.ts";

/**
 * One panel member in the live Fusion strip. The panel members are CLI
 * subprocesses run in BATCH (no incremental stream), so the only live signal
 * we can surface is a per-member spinner + elapsed clock while it runs, then a
 * frozen done/failed line with the byte count (or the error). `elapsedMs` is
 * the source of truth ONLY once the member is `done`/`failed` (frozen at that
 * instant); while `running`, the component derives elapsed live from the
 * captured start time so the clock keeps counting up between renders.
 */
export interface FusionLiveMember {
	/** Panel slot (0-based). Used as the registry key so two identical members in a
	 * self-fusion (e.g. claude-opus-4-8 ×2) render as two distinct rows instead of
	 * collapsing into one (the cli/model key collision that hid a member). */
	index: number;
	cli: string; // "codex" | "claude"
	model: string;
	status: "running" | "done" | "failed";
	elapsedMs: number; // congelado quando done/failed
	timeoutMs?: number; // hard wall-clock cap (backstop)
	idleTimeoutMs?: number; // idle cap → row shows an "idle Ns / Ts" countdown when the member goes quiet
	chars?: number; // quando done
	error?: string; // quando failed
}

/** Internal per-member record: the public shape plus a captured start instant
 * (Date.now() at first upsert) so the live "running" clock keeps rising across
 * renders, plus live-activity aggregates (what the advisor is doing now + a
 * per-tool tally) fed by stream-json events. */
interface MemberEntry {
	member: FusionLiveMember;
	startedAt: number;
	/** Last instant any activity (tool/text/thinking) was seen — drives the idle countdown. */
	lastActivityAt: number;
	/** What the advisor is doing right now: "thinking" / "writing" / a tool name. */
	action: string;
	/** Per-tool-name call tally (Read, Bash, Grep…) — the "which/how many" signal. */
	toolCounts: Map<string, number>;
	/** Total tool calls so far. */
	toolCount: number;
}

type FusionStage = "brief" | "panel" | "judge" | "verify" | "writer";

/** Pure: pick the glyph for a member's status. Kept branchy (no nested ternary)
 * so the gate (tsgo erasableSyntaxOnly + biome) stays happy and the mapping
 * reads as a table. */
function glyphFor(status: FusionLiveMember["status"], spinner: string): string {
	switch (status) {
		case "done":
			return theme.fg("success", "✓");
		case "failed":
			return theme.fg("error", "✗");
		default:
			return theme.fg("accent", spinner);
	}
}

/** Compact elapsed (whole seconds) for a member, live for "running" and frozen
 * from `elapsedMs` otherwise. */
function secsFor(entry: MemberEntry, now: number): number {
	if (entry.member.status === "running") {
		return Math.max(0, Math.floor((now - entry.startedAt) / 1000));
	}
	return Math.max(0, Math.floor(entry.member.elapsedMs / 1000));
}

/** Live-activity summary for a running advisor: the per-tool tally ("Read 2 · Bash 1")
 * once tools have run, else the current action ("thinking" / "writing" / "starting").
 * This is the "what is it actually doing" signal the opaque "running" clock lacked. */
function activitySummary(entry: MemberEntry): string {
	if (entry.toolCount > 0) {
		const parts: string[] = [];
		for (const [name, n] of entry.toolCounts) parts.push(`${name} ${n}`);
		return parts.join(" · ");
	}
	return entry.action || "starting";
}

/** The trailing status fragment for a member row. Uses if/return (no nested ternary).
 * Running rows show LIVE activity (tools/thinking) + an elapsed clock bounded by the
 * timeout (warning past 75%); done rows show the tool count + byte size. */
function statusTail(entry: MemberEntry, secs: number, now: number): string {
	const member = entry.member;
	if (member.status === "done") {
		const chars = member.chars ?? 0;
		const tools = entry.toolCount > 0 ? `${entry.toolCount} tools · ` : "";
		return theme.fg("muted", `done   ${secs}s · ${tools}${chars} chars`);
	}
	if (member.status === "failed") {
		return theme.fg("error", `failed ${secs}s · ${member.error ?? ""}`);
	}
	// running: live activity (accent) + clock. The member is killed by the IDLE cap
	// (reset on every chunk of output), NOT the wall-clock cap — so once it goes quiet
	// surface an "idle Ns / Ts" countdown in warning; while actively producing, show the
	// plain elapsed clock (the wall-clock cap is a far-off backstop, not worth the noise).
	const activity = theme.fg("accent", activitySummary(entry));
	const idleLimit = member.idleTimeoutMs ? Math.floor(member.idleTimeoutMs / 1000) : 0;
	const idleSecs = Math.max(0, Math.floor((now - entry.lastActivityAt) / 1000));
	if (idleLimit > 0 && idleSecs >= Math.max(1, Math.floor(idleLimit / 2))) {
		return `${activity}  ${theme.fg("warning", `idle ${idleSecs}s / ${idleLimit}s`)}`;
	}
	return `${activity}  ${theme.fg("muted", `${secs}s`)}`;
}

/**
 * Live, ephemeral feedback strip for Fusion Mode — rendered in the
 * `statusContainer` (the transient band above the editor). Shows the active
 * stage, the synthesizer id, and one row per panel member with a spinner +
 * count-up clock, flipping to ✓/✗ as each member finishes; then a single
 * "judging" line while the judge reconciles the perspectives. The writer stage
 * streams its own output to the transcript, so this strip carries no member
 * rows for it — it simply reports "synthesize".
 *
 * Animation rides the shared TUI ticker (see {@link Loader}): the spinner frame
 * and per-member elapsed are derived from the single monotonic clock, so this
 * strip stays phase-locked with every other spinner in the UI and never spins
 * up its own setInterval. The tick callback repaints only when the spinner
 * frame advances or some running member's whole-second clock turns over.
 */
export class FusionLiveComponent implements Component {
	private ui: TUI;
	private stage: FusionStage = "brief";
	private synthId = "";
	// Captured when the strip enters the "brief" stage, so the brief line counts up.
	private briefStartedAt = 0;
	// Member registry keyed by panel SLOT (index) — NOT cli/model, which collides
	// for identical members. Rows are rendered in slot order.
	private members = new Map<number, MemberEntry>();
	private animationUnsub: (() => void) | null = null;
	// Captured when the strip enters the "judge" stage (0 = not yet), so the
	// judge line can count up honestly from when reconciliation began rather
	// than from some arbitrary clock origin.
	private judgeStartedAt = 0;
	// Captured when the strip enters the "verify" stage (0 = not yet), so the verify
	// line counts up honestly from when the read-only fact-check began.
	private verifyStartedAt = 0;
	// Last spinner frame index + the elapsed-second snapshot we painted, so the
	// tick callback can report "nothing visible changed" and let the shared
	// ticker coalesce the frame away (mirrors Loader.refreshElapsed gating).
	private lastFrameIdx = -1;
	private lastElapsedKey = "";

	constructor(ui: TUI) {
		this.ui = ui;
		// The strip is created at the brief stage; stamp the brief clock now (setStage's
		// early-return would otherwise skip stamping the already-current default stage).
		this.briefStartedAt = Date.now();
		this.animationUnsub = this.ui.addAnimationCallback((now) => this.tick(now));
	}

	/** Set the synthesizer model id shown in the header (e.g. "opus 4.8"). */
	setSynth(synthId: string): void {
		if (synthId === this.synthId) return;
		this.synthId = synthId;
		this.ui.requestRender();
	}

	/** Switch the active stage. "panel" shows member rows; "judge" appends the
	 * reconciliation line; "writer" keeps the header (the writer streams its own
	 * output elsewhere). */
	setStage(stage: FusionStage): void {
		if (stage === this.stage) return;
		this.stage = stage;
		if (stage === "judge" && this.judgeStartedAt === 0) {
			this.judgeStartedAt = Date.now();
		}
		if (stage === "verify" && this.verifyStartedAt === 0) {
			this.verifyStartedAt = Date.now();
		}
		this.ui.requestRender();
	}

	/** Insert or update a member by panel slot. The start instant is captured on
	 * first insert and preserved across updates so the "running" clock keeps rising
	 * continuously instead of resetting on every upsert. */
	upsertMember(m: FusionLiveMember): void {
		const existing = this.members.get(m.index);
		if (existing) {
			existing.member = m;
		} else {
			this.members.set(m.index, {
				member: m,
				startedAt: Date.now(),
				lastActivityAt: Date.now(),
				action: "",
				toolCounts: new Map(),
				toolCount: 0,
			});
		}
		this.ui.requestRender();
	}

	/** Fold a live activity event into the advisor's running row: bump the tool tally
	 * (which/how many) and the current action so the panel shows real work, not just a
	 * clock. No-op if the slot hasn't been registered yet. */
	recordActivity(index: number, kind: "thinking" | "writing" | "tool" | "tool_result", tool?: string): void {
		const entry = this.members.get(index);
		if (!entry) return;
		// Any activity event pushes back the idle deadline shown in the row.
		entry.lastActivityAt = Date.now();
		if (kind === "tool") {
			const name = tool || "tool";
			entry.action = name;
			entry.toolCount += 1;
			entry.toolCounts.set(name, (entry.toolCounts.get(name) ?? 0) + 1);
		} else if (kind === "thinking") {
			entry.action = "thinking";
		} else if (kind === "writing") {
			entry.action = "writing";
		}
		this.ui.requestRender();
	}

	/**
	 * Current spinner glyph, phase-locked to the shared UI cadence via the same
	 * monotonic clock the Loader uses (`performance.now()` / SPINNER_FRAME_MS).
	 * Deriving from the clock (not an internal counter) keeps this strip in step
	 * with every other spinner on screen.
	 */
	private spinnerFrame(): string {
		const idx = Math.floor(performance.now() / SPINNER_FRAME_MS) % SPINNER_FRAMES.length;
		return SPINNER_FRAMES[idx]!;
	}

	/**
	 * One animation step on the shared ticker. Repaints only when something
	 * visible turned over: the spinner frame index advanced, or a running
	 * member's (or the judge's) whole-second clock ticked. Returning `false`
	 * otherwise lets the ticker drop the frame entirely (no wasted render).
	 */
	private tick(now: number): boolean {
		// Spinner frame rides the monotonic clock the ticker hands us (same basis
		// as spinnerFrame() → phase-locked with every other spinner). The elapsed
		// counters are anchored to wall-clock starts (Date.now()), so the
		// per-second fingerprint is computed against Date.now(), NOT the ticker's
		// performance.now() — mixing the two bases would yield a garbage delta.
		const frameIdx = Math.floor(now / SPINNER_FRAME_MS) % SPINNER_FRAMES.length;
		const elapsedKey = this.currentElapsedKey(Date.now());
		if (frameIdx === this.lastFrameIdx && elapsedKey === this.lastElapsedKey) {
			return false;
		}
		this.lastFrameIdx = frameIdx;
		this.lastElapsedKey = elapsedKey;
		return true;
	}

	/** A cheap fingerprint of every live (per-second) value on screen: the
	 * whole-second elapsed of each running member, plus the judge clock when the
	 * judge stage is active. `wallNow` is a Date.now() value (the member/judge
	 * starts are wall-clock). When this string is unchanged between ticks, no
	 * visible second turned over, so the frame can be coalesced. */
	private currentElapsedKey(wallNow: number): string {
		let key = "";
		for (const entry of this.members.values()) {
			if (entry.member.status === "running") {
				key += `${secsFor(entry, wallNow)},`;
			}
		}
		if (this.stage === "judge" && this.judgeStartedAt > 0) {
			// Per-second signal for the judge clock: turns over once a second, so an
			// unchanged value means no visible second elapsed and the frame can be
			// coalesced.
			key += `j${Math.floor((wallNow - this.judgeStartedAt) / 1000)}`;
		}
		if (this.stage === "verify" && this.verifyStartedAt > 0) {
			key += `v${Math.floor((wallNow - this.verifyStartedAt) / 1000)}`;
		}
		if (this.stage === "brief" && this.briefStartedAt > 0) {
			key += `b${Math.floor((wallNow - this.briefStartedAt) / 1000)}`;
		}
		return key;
	}

	/** Pad `s` with trailing spaces to a target VISIBLE column. Never use
	 * String.padEnd here: it counts UTF-16 code units, so any ANSI escape or
	 * wide/emoji glyph throws the column off. visibleWidth() strips ANSI and
	 * accounts for wide chars. */
	private padVisible(s: string, col: number): string {
		return s + " ".repeat(Math.max(0, col - visibleWidth(s)));
	}

	render(width: number): string[] {
		const now = Date.now();
		const spinner = this.spinnerFrame();
		const lines: string[] = [];

		// Render rows in SLOT order (Map insertion can race with the same-cli stagger).
		const entries = [...this.members.values()].sort((a, b) => a.member.index - b.member.index);
		const n = entries.length;

		// Header makes the ROLES + PHASE explicit — the line that answers "which model is
		// which / what's happening": brief (synth drafting), panel (read-only ADVISORS
		// working), or synthesizing (synth judging+writing). The synth = the active /model.
		let stageWord = "synthesizing";
		if (this.stage === "brief") stageWord = "preparing brief";
		else if (this.stage === "panel") stageWord = `${n} advisor${n === 1 ? "" : "s"} (read-only)`;
		else if (this.stage === "verify") stageWord = "verifying claims";
		let header = `  ${theme.fg("accent", "Fusion")}  ${theme.fg("muted", stageWord)}`;
		if (this.synthId) {
			header += `  ${theme.fg("dim", `→ synth ${this.synthId}`)}`;
		}
		lines.push(header);
		lines.push("");

		// Brief stage: the synth is drafting the advisor brief — no member rows yet.
		if (this.stage === "brief") {
			const bs = this.briefStartedAt > 0 ? Math.max(0, Math.floor((now - this.briefStartedAt) / 1000)) : 0;
			lines.push(
				`  ${theme.fg("accent", spinner)} ${theme.fg("muted", `synth ${this.synthId} · drafting the advisor brief`)}  ${theme.fg("dim", `${bs}s`)}`,
			);
			return lines.map((line) => truncateToWidth(line, width, theme.fg("dim", "…")));
		}

		// Name column width (visible) so the status tails line up. A leading slot
		// number disambiguates identical advisors (the whole point of the fix).
		let nameCol = 0;
		for (const entry of entries) {
			nameCol = Math.max(nameCol, visibleWidth(`${entry.member.cli}:${entry.member.model}`));
		}

		for (const entry of entries) {
			const m = entry.member;
			const secs = secsFor(entry, now);
			const glyph = glyphFor(m.status, spinner);
			const slot = theme.fg("dim", `${m.index + 1}`);
			const name = this.padVisible(theme.fg("muted", `${m.cli}:${m.model}`), nameCol);
			const tail = statusTail(entry, secs, now);
			lines.push(`  ${glyph} ${slot}  ${name}  ${tail}`);
		}

		// Judge stage: the synthesizer reconciles the advisors. Name the synth so it
		// reads as the principal model now working, distinct from the advisors above.
		if (this.stage === "judge") {
			const judgeSecs = this.judgeStartedAt > 0 ? Math.max(0, Math.floor((now - this.judgeStartedAt) / 1000)) : 0;
			lines.push("");
			lines.push(
				`  ${theme.fg("accent", spinner)} ${theme.fg("muted", `synth ${this.synthId} · judging ${n} advisors`)}  ${theme.fg("dim", `${judgeSecs}s`)}`,
			);
		}

		// Verify stage: the synthesizer fact-checks the surviving claims against the code
		// (read-only subagent). Same shape as the judge line so the phase reads clearly.
		if (this.stage === "verify") {
			const verifySecs = this.verifyStartedAt > 0 ? Math.max(0, Math.floor((now - this.verifyStartedAt) / 1000)) : 0;
			lines.push("");
			lines.push(
				`  ${theme.fg("accent", spinner)} ${theme.fg("muted", `synth ${this.synthId} · verifying claims against the code`)}  ${theme.fg("dim", `${verifySecs}s`)}`,
			);
		}

		// Every emitted line MUST be truncated to the viewport width with a dim
		// ellipsis — the TUI render guard rejects any component line wider than
		// `width`, and overflow would dangle an orphan ellipsis at the border.
		return lines.map((line) => truncateToWidth(line, width, theme.fg("dim", "…")));
	}

	/** Component contract: drop any cached render state. This component composes
	 * fresh lines every render() (no cache), so there is nothing to clear — but
	 * the method must exist to satisfy the Component interface. */
	invalidate(): void {}

	/** Unsubscribe from the shared animation ticker. Idempotent: safe to call
	 * more than once (the second call is a no-op). */
	dispose(): void {
		if (this.animationUnsub) {
			this.animationUnsub();
			this.animationUnsub = null;
		}
	}
}
