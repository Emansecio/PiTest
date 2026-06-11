import { basename, relative } from "node:path";
import { type Component, truncateToWidth, visibleWidth } from "@pit/tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { formatDisplayPath } from "../display-utils.ts";
import { CONTEXT_USAGE_WARN_PERCENT, theme } from "../theme/theme.ts";

/**
 * Hard cap on the rendered cwd label so a deep absolute path can never crowd out
 * the model name on the identity line. The mid-path ellipsis kicks in past this.
 */
const MAX_PWD_WIDTH = 40;

/**
 * Shorten a path by collapsing its MIDDLE, preserving the head (drive / leading
 * segments) and the tail (deepest dirs) — `C:\Users\…\interactive` reads far
 * better than a right-truncated `C:\Users\Use…`. Splits on both separators so it
 * works for Windows and POSIX paths; returns the input untouched when it already
 * fits or is too short to collapse meaningfully.
 */
function ellipsizePathMiddle(p: string, maxWidth: number): string {
	if (visibleWidth(p) <= maxWidth) return p;
	const segments = p.split(/[\\/]+/).filter((s) => s.length > 0);
	if (segments.length <= 2) {
		// No interior segment to drop — fall back to a tail-preserving cut.
		return `…${p.slice(p.length - (maxWidth - 1))}`;
	}
	const sep = p.includes("\\") ? "\\" : "/";
	const head = segments[0]!;
	let tailCount = 1;
	let candidate = `${head}${sep}…${sep}${segments.slice(segments.length - tailCount).join(sep)}`;
	// Grow the tail (deepest dirs are the most useful) until adding one more would
	// blow the budget — keeps as much context as fits without exceeding maxWidth.
	while (tailCount + 1 < segments.length) {
		const next = `${head}${sep}…${sep}${segments.slice(segments.length - (tailCount + 1)).join(sep)}`;
		if (visibleWidth(next) > maxWidth) break;
		candidate = next;
		tailCount += 1;
	}
	return candidate;
}

/**
 * Compact a cwd for the identity line. Prefers a path RELATIVE to the git repo
 * root (`coding-agent` instead of the full absolute path), labelling the repo by
 * its basename so the project stays identifiable. Outside a repo, falls back to
 * the home-relative form with a mid-path ellipsis so both ends survive.
 */
function compactCwd(cwd: string, repoDir: string | null): string {
	if (repoDir) {
		const rel = relative(repoDir, cwd);
		if (rel === "") return basename(repoDir);
		if (!rel.startsWith("..") && rel !== "." && !/^[A-Za-z]:/.test(rel)) {
			const normalized = rel.split(/[\\/]+/).join("/");
			return `${basename(repoDir)}/${normalized}`;
		}
	}
	return ellipsizePathMiddle(formatDisplayPath(cwd), MAX_PWD_WIDTH);
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
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[\u0000-\u001a\u001c-\u001f\u007f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
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
 *   2. Metrics: `CTX %·used/window` (left, state-colored) | `↑in ↓out $cost (sub) auto` (right, dim)
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
	private statsCacheLen = 0;
	private statsCacheTotals: CumulativeTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: AgentSession): void {
		if (this.session !== session) {
			this.resetStatsCache();
		}
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * Drops the cumulative-usage cache. Called by the interactive mode on
	 * session-info change; safe to call any time. Git branch is handled by the
	 * data provider (no-op here).
	 */
	invalidate(): void {
		this.resetStatsCache();
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
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

	private getPermissionMode(): string | null {
		// Coupled to the "permissions: <mode>" status string set by
		// permissions-extension.ts; a format change there silently drops the mode.
		const raw = this.footerData.getExtensionStatuses().get("permissions");
		if (!raw) return null;
		const m = /permissions:\s*(\S+)/.exec(raw);
		return m ? m[1] : null;
	}

	render(width: number): string[] {
		const state = this.session.state;
		const totals = this.getCumulativeTotals();

		// Context usage from session (handles compaction correctly).
		const contextUsage = this.session.getContextUsage();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// --- Identity (line 1) -----------------------------------------------
		// Left: cwd (branch) • session — `muted` (not dim) so it stays legible
		// without competing with the model name. The cwd is compacted (repo-relative
		// when inside a git repo, mid-path ellipsis otherwise) so a deep absolute
		// path never eats the model name on the right.
		let pwd = compactCwd(this.session.sessionManager.getCwd(), this.footerData.getRepoDir());
		const branch = this.footerData.getGitBranch();
		if (branch) pwd = `${pwd} (${branch})`;
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) pwd = `${pwd} • ${sessionName}`;
		// In the home dir with no project context (no branch, no session name) the
		// label is a lone "~" that orients nothing and reads like a leftover
		// glyph. Drop it — same rule the welcome box applies to its cwd row.
		if (pwd === "~") pwd = "";

		// Right: model • thinking-level — the model id is the single bright token
		// of the line; the provider is secondary metadata (muted, no parens) and
		// the thinking level renders as a small colored chip (`✦ high`).
		const modelName = state.model?.id || "no-model";
		const showProvider = this.footerData.getAvailableProviderCount() > 1 && state.model;
		const providerPrefix = showProvider ? theme.fg("muted", `${state.model!.provider} · `) : "";

		// The thinking chip (`• ✦ high`) is a PROTECTED suffix: on a narrow terminal
		// the model id is truncated (and the provider prefix dropped) before the
		// chip is ever touched, so the level never clips to a dangling `✦`.
		const identityRight = `${providerPrefix}${modelName}`;
		let thinkingChip: { text: string; width: number } | undefined;
		if (state.model?.reasoning) {
			const level = asKnownThinkingLevel(state.thinkingLevel);
			const levelLabel = level === "off" ? "thinking off" : `✦ ${level}`;
			const colorize = theme.getThinkingBorderColor(level);
			thinkingChip = {
				text: `${theme.fg("muted", " • ")}${colorize(levelLabel)}`,
				width: visibleWidth(` • ${levelLabel}`),
			};
		}

		const identityLine = composeLeftRight(pwd, identityRight, width, {
			leftColor: (text) => theme.fg("muted", text),
			// identityRight (provider + model) is the brightest row in the footer
			// block on purpose — leave it as foreground. The chip arrives pre-colored
			// via protectedSuffix.
			rightColor: (text) => text,
			ellipsis: theme.fg("muted", "…"),
			protectedSuffix: thinkingChip,
		});

		// --- Metrics (line 2) ------------------------------------------------
		// Context is the headline: flushed left, with COLOR carrying the state —
		// `CTX 23% · 47k/200k`. The label is a stable dim field-name; the percent
		// is the datum and escalates accent → warning → error as the window fills
		// (no bar: a 5-cell meter can only lie next to a precise percent). A
		// pristine session shows only the capacity (`CTX 1M`, dim) — three zeros
		// say nothing. Usage (input/output, cost, auto-compact) trails dim on the
		// right.
		const usedTokens = contextUsage?.tokens ?? 0;
		const pristine = usedTokens === 0 && contextPercentValue === 0 && contextWindow > 0;
		const ctxLabel = theme.fg("dim", "CTX");
		const ctxColorize = theme.getContextUsageColor(contextPercentValue);
		let ctxText: string;
		if (contextPercent === "?") {
			ctxText = `${ctxLabel} ${theme.fg("dim", `?/${formatTokens(contextWindow)}`)}`;
		} else if (pristine) {
			ctxText = `${ctxLabel} ${theme.fg("dim", formatTokens(contextWindow))}`;
		} else {
			const percentLabel = ctxColorize(formatContextPercent(contextPercentValue));
			const counts = `${theme.fg("muted", formatTokens(usedTokens))}${theme.fg("dim", `/${formatTokens(contextWindow)}`)}`;
			ctxText = `${ctxLabel} ${percentLabel} ${theme.fg("dim", "·")} ${counts}`;
		}

		// Group A — usage/cost: `↑in ↓out $cost` kept together on the right.
		const usageGroup: string[] = [];
		const io: string[] = [];
		if (totals.input) io.push(`↑${formatTokens(totals.input)}`);
		if (totals.output) io.push(`↓${formatTokens(totals.output)}`);
		if (io.length) usageGroup.push(io.join(" "));

		// Cost segment only when it rounds to a visible amount. Under a
		// subscription the cost is always $0.000 (flat plan), so `$0.000 (sub)`
		// is pure noise — drop it. 0.0005 is the threshold where toFixed(3)
		// stops rendering "0.000".
		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		if (totals.cost >= 0.0005) {
			usageGroup.push(`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
		}

		// Group B — session mode bits (permission / auto-compact).
		const mode = this.getPermissionMode();
		const modeBits: string[] = [];
		if (mode && mode !== "unsafe") modeBits.push(mode);
		// Auto-compact is on by default, so showing "compact" permanently is noise.
		// The signal worth surfacing is the ABNORMAL state — when it's OFF the
		// context can overflow without rescue — so flag only that, in warning.
		if (!this.autoCompactEnabled) modeBits.push(theme.fg("warning", "no-compact"));

		// Goal status is ephemeral and actionable: render it bright (accent), not
		// dim, so it stands out from the trailing usage metrics. Pre-colorized so it
		// survives the group's outer dim wrapper (its own reset re-opens dim after).
		const goalStatus = this.session.goalStatusLine();

		// Assemble groups. Intra-group items join with the light ` · `; the two
		// semantic groups (usage vs. mode) join with a stronger `  •  ` so the line
		// reads as two clusters instead of one undifferentiated run.
		const groups: string[] = [];
		if (usageGroup.length) groups.push(usageGroup.join(" · "));
		if (goalStatus) groups.push(theme.fg("accent", goalStatus));
		if (modeBits.length) groups.push(modeBits.join(" · "));
		let rightText = groups.join("  •  ");

		// #2 — context-pressure signal is COLOR-first: the ctx number already turns
		// warning/error past the threshold. Add a terse textual nudge only when
		// auto-compact is armed and we're past the warn band, colorized to match so
		// it escalates with the number rather than shouting in plain text.
		if (this.autoCompactEnabled && contextPercentValue > CONTEXT_USAGE_WARN_PERCENT) {
			rightText = rightText ? `${rightText} ${ctxColorize("⚠ compact soon")}` : ctxColorize("⚠ compact soon");
		}

		const metricsLine = composeLeftRight(ctxText, rightText, width, {
			// ctxText is pre-colorized per segment (dim label, state-colored
			// percent) — pass it through untouched.
			leftColor: (text) => text,
			rightColor: (text) => theme.fg("dim", text),
			ellipsis: theme.fg("dim", "…"),
		});

		const lines = [identityLine, metricsLine];

		// --- Unsafe alert ----------------------------------------------------
		// The no-rails permission state must never be silent: bold red, on its
		// own line. Fires whenever the built-in floor is off (unsafe mode, or
		// auto + disableBuiltinDefaults — both surface as "unsafe" in the status).
		if (mode === "unsafe") {
			lines.push(`\x1b[1m${theme.fg("error", "⚠ UNSAFE — built-in guard-rails off")}\x1b[22m`);
		}

		// --- Extension statuses (line 3, optional) ---------------------------
		// Exclude "permissions" — its mode is already surfaced on the metrics line.
		const extensionStatuses = this.footerData.getExtensionStatuses();
		const otherStatuses = Array.from(extensionStatuses.entries())
			.filter(([k]) => k !== "permissions")
			.sort(([a], [b]) => a.localeCompare(b));
		if (otherStatuses.length > 0) {
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
	const suffixWidth = suffix ? suffix.width : 0;
	const minPadding = rawLeft.length > 0 && (rawRight.length > 0 || suffixWidth > 0) ? 2 : 0;
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
	const fullRight = suffix ? styledRight + suffix.text : styledRight;
	const fullRightWidth = rightWidth + suffixWidth;
	const padding = " ".repeat(Math.max(0, width - leftWidth - fullRightWidth));
	const styledLeft = options.leftColor(left);
	return fullRightWidth > 0 ? styledLeft + padding + fullRight : styledLeft + padding;
}
