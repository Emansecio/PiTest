import { getRuntimeDiagnostics } from "@pit/ai";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@pit/tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ContextUsage } from "../../../core/extensions/index.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import type { RecoveryLevel } from "../../../core/session-recovery.ts";
import { isReducedMotion } from "../../../utils/env-flags.ts";
import { buildWorkspaceCwdLabels, formatGitBranchWithDiff, type WorkspaceCwdLabels } from "../display-utils.ts";
import { interpolateFg } from "../theme/color-interpolation.ts";
import { CONTEXT_USAGE_WARN_PERCENT, theme } from "../theme/theme.ts";
import { COLOR_EASE_MS } from "./color-ease.ts";
import { GAUGE_EMPTY, GAUGE_FILLED } from "./gauge-glyphs.ts";

/** Minimum terminal width for single-line identity (pwd + model). */
const FOOTER_IDENTITY_SINGLE_LINE_MIN = 48;

/** Minimum width before metrics (CTX + usage) compose on one line. */
const FOOTER_METRICS_COMPOSE_MIN = 72;

function identityLineWouldOverflow(pwd: string, identityRight: string, width: number, suffixWidth: number): boolean {
	const leftWidth = visibleWidth(pwd);
	const rightWidth = visibleWidth(identityRight);
	const minPadding = leftWidth > 0 && (rightWidth > 0 || suffixWidth > 0) ? 2 : 0;
	if (leftWidth > width) return true;
	return leftWidth + minPadding + rightWidth + suffixWidth > width;
}

function metricsLineWouldOverflow(ctxText: string, rightText: string, width: number): boolean {
	const leftWidth = visibleWidth(ctxText);
	const rightWidth = visibleWidth(rightText);
	const minPadding = leftWidth > 0 && rightWidth > 0 ? 2 : 0;
	if (leftWidth > width) return true;
	return leftWidth + minPadding + rightWidth > width;
}

/**
 * Sanitize text for display in a single-line status.
 *
 * Replaces line-break-ish whitespace with spaces, strips control characters
 * that would corrupt the single-line layout, and collapses runs of whitespace.
 *
 * Preserves ESC (0x1B) so ANSI colour / style sequences (`\x1b[…m`) survive
 * intact — extensions surface coloured spinners and progress glyphs through
 * this channel, and earlier sanitisers were stripping just the ESC byte and
 * leaving the `[…m` parameter strings as visible literal text in the footer.
 */
function sanitizeStatusText(text: string | undefined): string {
	return (text ?? "")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\u0000-\u001a\u001c-\u001f\u007f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Collapse runs of identical labels into `label ×N` so a self-fusion of two
 * identical members reads `claude-opus-4-8 ×2` instead of repeating the full id
 * twice. Distinct groups join with ` + `, preserving order.
 */
function collapseAdjacent(labels: string[]): string {
	const out: string[] = [];
	let i = 0;
	while (i < labels.length) {
		let n = 1;
		while (i + n < labels.length && labels[i + n] === labels[i]) n++;
		out.push(n > 1 ? `${labels[i]} ×${n}` : (labels[i] as string));
		i += n;
	}
	return out.join(" + ");
}

/**
 * Format token counts for compact footer display. A trailing `.0` is noise
 * (`1M`, not `1.0M`), so fractional steps only render when the decimal digit
 * is non-zero.
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Whole percent only — nobody acts on a 0.2% difference in a context gauge.
 * Any non-zero usage reads at least `<1%` so the gauge never claims
 * "untouched" while tokens are already accruing.
 */
function formatContextPercent(percent: number): string {
	const rounded = Math.round(percent);
	if (percent > 0 && rounded === 0) return "<1%";
	return `${rounded}%`;
}

/** Compact context-fill gauge for the footer metrics line (approximate; percent stays exact). */
const FOOTER_CTX_BAR_WIDTH = 6;

export type FooterDensity = "calm" | "full";
const FILL_EASE_EPSILON = 0.01;

function renderFooterContextBar(displayedFill: number, colorize: (text: string) => string): string {
	const clamped = Math.max(0, Math.min(FOOTER_CTX_BAR_WIDTH, displayedFill));
	const full = Math.floor(clamped);
	const frac = clamped - full;
	let result = colorize(GAUGE_FILLED.repeat(full));
	const hasPartial = frac > FILL_EASE_EPSILON && full < FOOTER_CTX_BAR_WIDTH;
	if (hasPartial) {
		const blend = interpolateFg("dim", "accent", frac);
		result += blend ? blend(GAUGE_FILLED) : colorize(GAUGE_FILLED);
	}
	const empty = FOOTER_CTX_BAR_WIDTH - full - (hasPartial ? 1 : 0);
	if (empty > 0) {
		result += theme.fg("dim", GAUGE_EMPTY.repeat(empty));
	}
	return result;
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const KNOWN_THINKING_LEVELS: ReadonlySet<ThinkingLevel> = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function asKnownThinkingLevel(value: unknown): ThinkingLevel {
	return typeof value === "string" && KNOWN_THINKING_LEVELS.has(value as ThinkingLevel)
		? (value as ThinkingLevel)
		: "off";
}

interface CumulativeTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 *
 * Layout (top to bottom; line 1 is the line closest to the editor):
 *   1. Identity: `cwd (branch) • session` (left, muted)  |  `model • thinking-level` (right, foreground + thinking color)
 *   2. Metrics: `CTX %·used/window` (left, state-colored) | `↑in ↓out auto` (right, dim)
 *   3. Optional: extension statuses, single line
 *
 * Cumulative usage stats are cached and updated incrementally (tail-only scan)
 * to keep render O(diff) instead of O(N) per keystroke. Reset on
 * `invalidate()`, on session swap, or when `entries.length` shrinks (fork,
 * compaction, /clear).
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	/** Launcher cwd — compared against session cwd for shell/session divergence. */
	private launchCwd: string;
	private statsCacheLen = 0;
	private statsCacheTotals: CumulativeTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
	private fusionLiveActive = false;
	private density: FooterDensity = "calm";
	private renderCacheKey = "";
	private renderCacheLines: string[] | null = null;
	// Per-frame memoization for buildRenderCacheKey()'s expensive-ish fields, so a
	// cache MISS doesn't redo the same work twice (once for the key, once in the
	// render() body) and a cache HIT doesn't redo it at all. Each is invalidated by
	// its own version/identity check rather than time, so staleness is impossible:
	// a stale version key simply recomputes on the next read.
	private cachedExtensionStatusesVersion = -1;
	private cachedExtensionStatusesSerialized = "";
	private cachedCwdLabelsKey = "";
	private cachedCwdLabels: WorkspaceCwdLabels | null = null;
	// Set at the end of buildRenderCacheKey() and read back by render() a few lines
	// later in the SAME call (render() always calls buildRenderCacheKey() first) —
	// never read across frames, so there is no staleness window.
	private lastContextUsageForRender: ContextUsage | undefined;
	private ui: TUI | undefined;
	private displayedFill = 0;
	private fillEaseFrom = 0;
	private fillEaseTarget = 0;
	private barTargetFill = -1;
	private fillEaseStartAt = 0;
	private fillEaseUnsub: (() => void) | null = null;
	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider, launchCwd?: string, ui?: TUI) {
		this.session = session;
		this.footerData = footerData;
		this.launchCwd = launchCwd ?? session.sessionManager.getCwd();
		this.ui = ui;
	}

	setSession(session: AgentSession): void {
		if (this.session !== session) {
			this.resetStatsCache();
			this.renderCacheLines = null;
			this.stopFillEase();
			this.displayedFill = 0;
			this.barTargetFill = -1;
		}
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	setFusionLiveActive(active: boolean): void {
		if (this.fusionLiveActive === active) return;
		this.fusionLiveActive = active;
		this.renderCacheLines = null;
	}

	setDensity(density: FooterDensity): void {
		if (this.density === density) return;
		this.density = density;
		this.renderCacheLines = null;
	}

	/**
	 * Drops the cumulative-usage cache. Called by the interactive mode on
	 * session-info change; safe to call any time. Git branch is handled by the
	 * data provider (no-op here).
	 */
	invalidate(): void {
		this.resetStatsCache();
		this.renderCacheLines = null;
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		this.stopFillEase();
		// Git watcher cleanup handled by provider
	}

	private fillEaseActive(): boolean {
		return this.fillEaseUnsub !== null;
	}

	private stopFillEase(): void {
		if (this.fillEaseUnsub) {
			this.fillEaseUnsub();
			this.fillEaseUnsub = null;
		}
	}

	private beginFillEase(target: number): void {
		const clampedTarget = Math.max(0, Math.min(FOOTER_CTX_BAR_WIDTH, target));
		if (!this.ui || isReducedMotion()) {
			this.displayedFill = clampedTarget;
			this.fillEaseTarget = clampedTarget;
			return;
		}
		if (Math.abs(this.displayedFill - clampedTarget) < FILL_EASE_EPSILON) {
			this.displayedFill = clampedTarget;
			this.fillEaseTarget = clampedTarget;
			return;
		}
		this.stopFillEase();
		this.fillEaseFrom = this.displayedFill;
		this.fillEaseTarget = clampedTarget;
		this.fillEaseStartAt = performance.now();
		this.renderCacheLines = null;
		this.fillEaseUnsub = this.ui.addAnimationCallback((now) => this.fillEaseTick(now));
	}

	private fillEaseTick(now: number): boolean {
		const raw = (now - this.fillEaseStartAt) / COLOR_EASE_MS;
		const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
		const eased = t * t * (3 - 2 * t);
		this.displayedFill = this.fillEaseFrom + (this.fillEaseTarget - this.fillEaseFrom) * eased;
		this.renderCacheLines = null;
		if (t >= 1) {
			this.displayedFill = this.fillEaseTarget;
			this.stopFillEase();
		}
		return true;
	}

	private resetStatsCache(): void {
		this.statsCacheLen = 0;
		this.statsCacheTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	}

	private getCumulativeTotals(): CumulativeTotals {
		const entries = this.session.sessionManager.getEntries();
		// Tail-incremental cache: only walk entries beyond the cached length.
		// If entries shrunk (fork/clear/compaction replace), reset and rescan.
		if (entries.length < this.statsCacheLen) {
			this.resetStatsCache();
		}
		for (let i = this.statsCacheLen; i < entries.length; i++) {
			const entry = entries[i];
			if (entry.type === "message" && entry.message.role === "assistant") {
				this.statsCacheTotals.input += entry.message.usage.input;
				this.statsCacheTotals.output += entry.message.usage.output;
				this.statsCacheTotals.cacheRead += entry.message.usage.cacheRead;
				this.statsCacheTotals.cacheWrite += entry.message.usage.cacheWrite;
				this.statsCacheTotals.cost += entry.message.usage.cost.total;
			}
		}
		this.statsCacheLen = entries.length;
		return this.statsCacheTotals;
	}

	private getOverthinkGuardCount(): number {
		return getRuntimeDiagnostics().counters["stream.overthink-guard"]?.count ?? 0;
	}

	private getRecoveryLevel(): RecoveryLevel {
		if (typeof this.session.getRecoveryLevel === "function") {
			return this.session.getRecoveryLevel();
		}
		return "lean";
	}

	private getRecoverySegment(): string | null {
		const level = this.getRecoveryLevel();
		if (level === "lean") return null;
		return `recovery:${level}`;
	}

	/**
	 * A session is "pristine" while the user has not yet submitted a turn. The
	 * system prompt + tool schema live in `agent.state.systemPrompt` / tools, NOT
	 * in `messages`, so `messages` is genuinely empty on a fresh launch even
	 * though `getContextUsage()` already reports ~18k wire tokens (system prompt
	 * + tools). Keying `pristine` on `usedTokens === 0` (the old check) made the
	 * footer empty-state collapse unreachable in real sessions — the system
	 * prompt always pushes tokens above zero before the first turn.
	 */
	private hasUserTurn(): boolean {
		const messages = this.session.messages;
		return Array.isArray(messages) && messages.some((m) => (m as { role?: string }).role === "user");
	}

	private getPermissionMode(): string | null {
		// Coupled to the "permissions: <mode>" status string set by
		// permissions-extension.ts; a format change there silently drops the mode.
		const raw = this.footerData.getExtensionStatuses().get("permissions");
		if (!raw) return null;
		const m = /permissions:\s*(\S+)/.exec(raw);
		return m ? m[1] : null;
	}

	/**
	 * Compact Fusion-mode indicator: the two panel members and the synthesizer
	 * that judges + writes the merged answer. Returns null in solo mode so the
	 * segment is absent entirely. Read straight off the session (orchestration
	 * facet + resolved fusion panel) — same source-of-truth pattern as the model
	 * and goal segments. The synthesizer is the session's active model id.
	 *
	 * Layout: `fusion: <member> + <member>` (identical members collapse to
	 * `<member> ×N`). With no panel bound it nudges toward the command:
	 * `fusion: (no panel — /fusion)`. The synthesizer is the active /model, already
	 * shown on the footer's first line, so it is NOT repeated here. The redundant
	 * `cli:` prefix is dropped when the model id already names the cli
	 * (`claude:claude-opus-4-8` → `claude-opus-4-8`), kept otherwise
	 * (`codex:gpt-5.5-codex`). The string is raw (uncolored); the caller colorizes
	 * and composeLeftRight width-bounds the line, so no clipping math here.
	 */
	private getFusionSegment(): string | null {
		if (this.fusionLiveActive) return null;
		if (this.session.orchestration !== "fusion") return null;
		const panel = this.session.settingsManager.getFusionSettings().panel;
		if (panel.length === 0) return "fusion: (no panel — /fusion)";
		const labels = panel.map((m) => (m.model.startsWith(m.cli) ? m.model : `${m.cli}:${m.model}`));
		return `fusion: ${collapseAdjacent(labels)}`;
	}

	/** Extension-status map serialized + sorted for the cache key, memoized by
	 * `getStatusVersion()` (bumped on every status mutation) so an unrelated
	 * render (no status change) skips the Array.from/sort/map/join every frame. */
	private getSerializedExtensionStatuses(): string {
		const version = this.footerData.getStatusVersion();
		if (version === this.cachedExtensionStatusesVersion) {
			return this.cachedExtensionStatusesSerialized;
		}
		const serialized = Array.from(this.footerData.getExtensionStatuses().entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([k, v]) => `${k}:${v}`)
			.join(";");
		this.cachedExtensionStatusesVersion = version;
		this.cachedExtensionStatusesSerialized = serialized;
		return serialized;
	}

	/** cwd/shell labels, memoized by the (cwd, launchCwd, repoDir) tuple that fully
	 * determines them — buildWorkspaceCwdLabels() does path.resolve/relative work
	 * that is pure waste to redo every frame while the session cwd hasn't moved.
	 * Shared by buildRenderCacheKey() and render() so a cache MISS computes it once. */
	private getCwdLabels(): WorkspaceCwdLabels {
		const cwd = this.session.sessionManager.getCwd();
		const repoDir = this.footerData.getRepoDir();
		const key = `${cwd}\u0000${this.launchCwd}\u0000${repoDir ?? ""}`;
		if (this.cachedCwdLabels !== null && key === this.cachedCwdLabelsKey) {
			return this.cachedCwdLabels;
		}
		const labels = buildWorkspaceCwdLabels(cwd, this.launchCwd, repoDir);
		this.cachedCwdLabelsKey = key;
		this.cachedCwdLabels = labels;
		return labels;
	}

	private buildRenderCacheKey(width: number): string {
		const state = this.session.state;
		const contextUsage = this.session.getContextUsage();
		this.lastContextUsageForRender = contextUsage;
		const entries = this.session.sessionManager.getEntries();
		const goalStatus = this.session.goalStatusLine() ?? "";
		const mode = this.getPermissionMode() ?? "";
		const extensionStatuses = this.getSerializedExtensionStatuses();
		const tokens = contextUsage?.tokens ?? 0;
		const percent = contextUsage?.percent ?? -1;
		const wireTokens = contextUsage?.wireTokens ?? tokens;
		const estimated = contextUsage?.estimated ? 1 : 0;
		const modelId = state.model?.id ?? "";
		const thinking = state.thinkingLevel;
		const branch = this.footerData.getGitBranch() ?? "";
		const diffStats = this.footerData.getGitDiffStats();
		const diffVersion = this.footerData.getGitDiffVersion();
		const diffKey =
			diffStats === null
				? "none"
				: `${diffStats.files}:${diffStats.insertions}:${diffStats.deletions}:${diffVersion}`;
		const cwd = this.session.sessionManager.getCwd();
		const cwdLabels = this.getCwdLabels();
		const sessionName = this.session.sessionManager.getSessionName() ?? "";
		const overthinkGuardCount = this.getOverthinkGuardCount();
		const recoveryLevel = this.getRecoveryLevel();
		return [
			width,
			this.density,

			entries.length,
			tokens,
			wireTokens,
			percent,
			estimated,
			goalStatus,
			this.session.orchestration,
			this.fusionLiveActive ? 1 : 0,
			mode,
			extensionStatuses,
			modelId,
			thinking,
			branch,
			diffKey,
			cwd,
			this.launchCwd,
			cwdLabels.session,
			cwdLabels.shellNote ?? "",
			sessionName,
			this.autoCompactEnabled ? 1 : 0,
			overthinkGuardCount,
			recoveryLevel,
			this.hasUserTurn() ? 1 : 0,
		].join("|");
	}

	render(width: number): string[] {
		const cacheKey = this.buildRenderCacheKey(width);
		if (!this.fillEaseActive() && this.renderCacheLines !== null && cacheKey === this.renderCacheKey) {
			return this.renderCacheLines;
		}

		const state = this.session.state;
		const totals = this.getCumulativeTotals();

		// Context usage from session (handles compaction correctly). Reuses the value
		// buildRenderCacheKey() just computed above (this render() call is always
		// preceded by that call, immediately, with no code in between).
		const contextUsage = this.lastContextUsageForRender;
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// --- Identity (line 1) -----------------------------------------------
		// Left: cwd (branch) • session — `muted` (not dim) so it stays legible
		// without competing with the model name. The cwd is compacted (repo-relative
		// when inside a git repo, mid-path ellipsis otherwise) so a deep absolute
		// path never eats the model name on the right.
		const cwdLabels = this.getCwdLabels();
		let pwd = theme.fg("muted", cwdLabels.session);
		const branch = this.footerData.getGitBranch();
		const diffStats = this.footerData.getGitDiffStats();
		if (branch) {
			const branchLabel = formatGitBranchWithDiff(branch, diffStats);
			pwd = `${pwd}${theme.fg("dim", " (")}${branchLabel}${theme.fg("dim", ")")}`;
		}
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) pwd = `${pwd}${theme.fg("dim", ` • ${sessionName}`)}`;
		if (cwdLabels.shellNote) pwd = `${pwd}${theme.fg("dim", ` · ${cwdLabels.shellNote}`)}`;

		// Right: model • thinking-level — the model id is the single bright token
		// of the line (no provider prefix; the provider lives in /model) and the
		// thinking level renders as a small colored chip (`✦ high`).
		const modelName = state.model?.id || "no-model";

		// The thinking chip (`• ✦ high`) is a PROTECTED suffix: on a narrow terminal
		// the model id is truncated before the chip is ever touched, so the level
		// never clips to a dangling `✦`.
		const identityRight = modelName;
		let thinkingChip: { text: string; width: number } | undefined;
		if (state.model?.reasoning) {
			const level = asKnownThinkingLevel(state.thinkingLevel);
			const levelLabel = level === "off" ? "Thinking off" : `✦ ${level[0].toUpperCase()}${level.slice(1)}`;
			const colorize = theme.getThinkingBorderColor(level);
			thinkingChip = {
				text: `${theme.fg("muted", " • ")}${colorize(levelLabel)}`,
				width: visibleWidth(` • ${levelLabel}`),
			};
		}

		const mode = this.getPermissionMode();
		const overthinkGuardCount = this.getOverthinkGuardCount();
		const recoverySegment = this.getRecoverySegment();
		const goalStatus = this.session.goalStatusLine();
		const fusionSegment = this.getFusionSegment();
		const extensionStatuses = this.footerData.getExtensionStatuses();
		const otherStatuses = Array.from(extensionStatuses.entries())
			.filter(([k]) => k !== "permissions")
			.sort(([a], [b]) => a.localeCompare(b));
		const calm = this.density === "calm";
		const messageTokens = contextUsage?.tokens ?? 0;
		const wireTokens = contextUsage?.wireTokens ?? messageTokens;
		const usedTokens = wireTokens;
		// Pristine = no user turn yet (system prompt + tools don't count). See
		// hasUserTurn() for why token-zero is the wrong proxy here.
		const pristine = !this.hasUserTurn() && contextWindow > 0;
		const modeIsAbnormal =
			mode === "no-rails" || !this.autoCompactEnabled || overthinkGuardCount > 0 || recoverySegment !== null;
		const collapseLine2 =
			pristine &&
			!modeIsAbnormal &&
			!fusionSegment &&
			!goalStatus &&
			otherStatuses.length === 0 &&
			mode !== null &&
			mode !== "no-rails";
		let modeSuffix: { text: string; width: number } | undefined;
		if (collapseLine2 && mode) {
			modeSuffix = {
				text: theme.fg("dim", ` • ${mode}`),
				width: visibleWidth(` • ${mode}`),
			};
		}

		const suffixWidth = (thinkingChip?.width ?? 0) + (modeSuffix?.width ?? 0);
		const identityComposeOptions = {
			leftColor: (text: string) => text,
			rightColor: (text: string) => text,
			ellipsis: theme.fg("muted", "…"),
			protectedSuffix: thinkingChip,
			protectedSuffix2: modeSuffix,
		};

		const splitIdentity =
			(!collapseLine2 && width < FOOTER_IDENTITY_SINGLE_LINE_MIN) ||
			identityLineWouldOverflow(pwd, identityRight, width, suffixWidth);

		const lines: string[] = [];
		if (splitIdentity) {
			lines.push(truncateToWidth(pwd, width, theme.fg("muted", "…")));
			lines.push(
				composeLeftRight("", identityRight, width, {
					...identityComposeOptions,
					leftColor: (text) => text,
				}),
			);
		} else {
			lines.push(composeLeftRight(pwd, identityRight, width, identityComposeOptions));
		}

		// --- Metrics (line 2) ------------------------------------------------
		// Context is the headline: flushed left, with COLOR carrying the state —
		// `CTX ███░░░ 23% · 47k/200k`. The 6-cell bar is approximate; the percent
		// beside it stays the exact datum and escalates accent → warning → error.
		// A pristine session shows only the capacity (`CTX 200k`, dim) — three
		// zeros say nothing. Usage (input/output, cost, auto-compact) trails dim.
		// When collapseLine2 is true the metrics row is omitted entirely — the
		// permission mode rides on the identity line as a protected suffix.
		if (collapseLine2) {
			if (!calm && otherStatuses.length > 0) {
				const statusLine = otherStatuses
					.map(([, text]) => {
						const sanitized = sanitizeStatusText(text);
						return sanitized.includes("") ? sanitized : theme.fg("dim", sanitized);
					})
					.join(" ");
				lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "…")));
			}
			this.renderCacheKey = cacheKey;
			this.renderCacheLines = lines;
			return lines;
		}

		const wireDiverges =
			!calm &&
			width >= FOOTER_IDENTITY_SINGLE_LINE_MIN &&
			messageTokens > 0 &&
			Math.abs(wireTokens - messageTokens) / messageTokens > 0.05;
		const ctxLabel = theme.fg("dim", "CTX");
		const ctxColorize = theme.getContextUsageColor(contextPercentValue);
		let ctxText: string;
		if (contextPercent === "?") {
			ctxText = `${ctxLabel} ${theme.fg("dim", `?/${formatTokens(contextWindow)}`)}`;
		} else if (pristine) {
			ctxText = `${ctxLabel} ${theme.fg("dim", formatTokens(contextWindow))}`;
		} else {
			const percentLabel = ctxColorize(formatContextPercent(contextPercentValue));
			const barTarget =
				contextPercentValue > 0 ? Math.max(1, Math.round((contextPercentValue / 100) * FOOTER_CTX_BAR_WIDTH)) : 0;
			if (barTarget !== this.barTargetFill) {
				this.barTargetFill = barTarget;
				this.beginFillEase(barTarget);
			}
			const bar = renderFooterContextBar(this.displayedFill, ctxColorize);
			// A `~` marks a structural ESTIMATE (right after compaction, before the next response
			// confirms the exact size) so it never reads as an authoritative figure.
			const est = contextUsage?.estimated ? "~" : "";
			let counts = `${theme.fg("muted", `${est}${formatTokens(usedTokens)}`)}${theme.fg("dim", `/${formatTokens(contextWindow)}`)}`;
			if (wireDiverges) {
				counts += `${theme.fg("dim", " · ")}${theme.fg("muted", `msgs ${est}${formatTokens(messageTokens)}`)}`;
			}
			ctxText = `${ctxLabel} ${bar} ${est ? theme.fg("dim", "~") : ""}${percentLabel} ${theme.fg("dim", "·")} ${counts}`;
		}

		// Group A — usage: `↑in ↓out` kept together on the right.
		const usageGroup: string[] = [];
		const io: string[] = [];
		if (totals.input) io.push(`↑${formatTokens(totals.input)}`);
		if (totals.output) io.push(`↓${formatTokens(totals.output)}`);
		if (io.length) usageGroup.push(io.join(" "));

		// Group B — session mode bits (permission / auto-compact).
		const modeBits: string[] = [];
		// In fusion the orchestration status is `fusion · plan`, which getPermissionMode
		// clips to just "fusion" — exactly what the `fusion: <members>` segment already
		// says. Fusion always rides plan-mode (read-only) in v1, so the bit carries no
		// extra signal; drop it to avoid the duplicate "fusion" on the metrics line.
		if (mode && mode !== "no-rails" && mode !== "auto" && this.session.orchestration !== "fusion") {
			modeBits.push(mode);
		}
		// Auto-compact is on by default, so showing "compact" permanently is noise.
		// The signal worth surfacing is the ABNORMAL state — when it's OFF the
		// context can overflow without rescue — so flag only that, in warning.
		if (!this.autoCompactEnabled) modeBits.push(theme.fg("warning", "no-compact"));
		if (overthinkGuardCount > 0) {
			modeBits.push(theme.fg("warning", `overthink ×${overthinkGuardCount}`));
		}
		if (recoverySegment) {
			modeBits.push(theme.fg("warning", recoverySegment));
		}

		// Assemble groups. Intra-group items join with the light ` · `; the two
		// semantic groups (usage vs. mode) join with a stronger `  •  ` so the line
		// reads as two clusters instead of one undifferentiated run.
		const groups: string[] = [];
		// Calm: skip long fusion: members string (still on identity mode chip when relevant).
		if (fusionSegment && !calm) groups.push(theme.fg("accent", fusionSegment));
		if (usageGroup.length) groups.push(usageGroup.join(" · "));
		if (goalStatus) groups.push(theme.fg("accent", goalStatus));
		if (modeBits.length) groups.push(modeBits.join(" · "));
		// Calm progressive disclosure: fusion + extension statuses stay hidden, but
		// a dim +N chip signals that more detail exists under footerDensity=full.
		if (calm) {
			const hiddenCount = (fusionSegment ? 1 : 0) + otherStatuses.length;
			if (hiddenCount > 0) groups.push(theme.fg("dim", `+${hiddenCount}`));
		}
		let rightText = groups.join("  •  ");

		// #2 — context-pressure signal is COLOR-first: the ctx number already turns
		// warning/error past the threshold. Add a terse textual nudge only when
		// auto-compact is armed and we're past the warn band, colorized to match so
		// it escalates with the number rather than shouting in plain text.
		if (this.autoCompactEnabled && contextPercentValue > CONTEXT_USAGE_WARN_PERCENT && width >= 48) {
			rightText = rightText ? `${rightText} ${ctxColorize("⚠ compact soon")}` : ctxColorize("⚠ compact soon");
		}

		lines.push(
			...layoutMetricsLines(ctxText, rightText, width, {
				leftColor: (text) => text,
				rightColor: (text) => theme.fg("dim", text),
				ellipsis: theme.fg("dim", "…"),
			}),
		);

		// --- No-rails alert --------------------------------------------------
		// The dropped-floor permission state must never be silent: bold red, on its
		// own line. Fires whenever the built-in floor is off (any mode with
		// disableBuiltinDefaults — surfaced as "no-rails" in the status).
		if (mode === "no-rails") {
			lines.push(`\x1b[1m${theme.fg("error", "⚠ NO-RAILS — built-in guard-rails off")}\x1b[22m`);
		}

		// --- Extension statuses (line 3, optional) ---------------------------
		// Exclude "permissions" — its mode is already surfaced on the metrics line.
		// Calm omits the extension status wall (power noise); full keeps it.
		if (!calm && otherStatuses.length > 0) {
			// A permanent "ready" must not outshine the model name: statuses with no
			// color of their own render dim. Pre-colorized ones (ESC present) pass
			// through untouched — the extension chose its emphasis deliberately.
			const statusLine = otherStatuses
				.map(([, text]) => {
					const sanitized = sanitizeStatusText(text);
					return sanitized.includes("") ? sanitized : theme.fg("dim", sanitized);
				})
				.join(" ");
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "…")));
		}

		this.renderCacheKey = cacheKey;
		this.renderCacheLines = lines;
		return lines;
	}
}

interface ComposeOptions {
	leftColor: (text: string) => string;
	rightColor: (text: string) => string;
	ellipsis: string;
	/**
	 * A pre-colored suffix glued to the end of `right` that must NEVER be
	 * truncated. When the line is tight, the truncatable part of `right` shrinks
	 * (and is ellipsized) while this suffix survives intact. Used to keep the
	 * `✦ <thinking-level>` chip on the identity line: otherwise a narrow terminal
	 * clips it to a meaningless dangling `✦`. The suffix is already styled, so its
	 * visible width is passed separately (ANSI is width-free).
	 */
	protectedSuffix?: { text: string; width: number };
	/** Second protected suffix appended after `protectedSuffix` (e.g. permission mode on idle collapse). */
	protectedSuffix2?: { text: string; width: number };
}

/**
 * Render a single line with `left` flushed left and `right` flushed right,
 * padded with spaces in between, never exceeding `width`. Truncates the right
 * side first; if the left is itself too wide, truncate it as well. A
 * `protectedSuffix` is held back from truncation and always appended to `right`.
 *
 * Color wrappers receive the truncated raw text (no width math inside the
 * wrappers) so callers don't need to worry about ANSI-escape-aware truncation.
 */
function composeLeftRight(rawLeft: string, rawRight: string, width: number, options: ComposeOptions): string {
	const suffix = options.protectedSuffix;
	const suffix2 = options.protectedSuffix2;
	const suffixWidth = (suffix ? suffix.width : 0) + (suffix2 ? suffix2.width : 0);
	const minPadding = visibleWidth(rawLeft) > 0 && (visibleWidth(rawRight) > 0 || suffixWidth > 0) ? 2 : 0;
	let left = rawLeft;
	let right = rawRight;
	let leftWidth = visibleWidth(left);
	let rightWidth = visibleWidth(right);

	// The suffix is part of the right cluster's footprint but is never trimmed.
	if (leftWidth > width) {
		left = truncateToWidth(left, width, options.ellipsis);
		leftWidth = visibleWidth(left);
		right = "";
		rightWidth = 0;
	} else if (leftWidth + minPadding + rightWidth + suffixWidth > width) {
		// Shrink only the truncatable part; the suffix keeps its full width.
		const available = width - leftWidth - minPadding - suffixWidth;
		if (available > 0) {
			right = truncateToWidth(right, available, options.ellipsis);
			rightWidth = visibleWidth(right);
		} else {
			right = "";
			rightWidth = 0;
		}
	}

	const styledRight = options.rightColor(right);
	let fullRight = styledRight;
	if (suffix) fullRight += suffix.text;
	if (suffix2) fullRight += suffix2.text;
	const fullRightWidth = rightWidth + suffixWidth;
	const padding = " ".repeat(Math.max(0, width - leftWidth - fullRightWidth));
	const styledLeft = options.leftColor(left);
	return fullRightWidth > 0 ? styledLeft + padding + fullRight : styledLeft + padding;
}

function layoutMetricsLines(
	ctxText: string,
	rightText: string,
	width: number,
	composeOptions: Pick<ComposeOptions, "leftColor" | "rightColor" | "ellipsis">,
): string[] {
	const shouldStack = width < FOOTER_METRICS_COMPOSE_MIN || metricsLineWouldOverflow(ctxText, rightText, width);
	if (shouldStack) {
		const stacked = [truncateToWidth(ctxText, width, composeOptions.ellipsis)];
		if (rightText) {
			stacked.push(truncateToWidth(rightText, width, composeOptions.ellipsis));
		}
		return stacked;
	}
	return [
		composeLeftRight(ctxText, rightText, width, {
			leftColor: composeOptions.leftColor,
			rightColor: composeOptions.rightColor,
			ellipsis: composeOptions.ellipsis,
		}),
	];
}
