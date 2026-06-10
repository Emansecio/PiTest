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
 * Format token counts for compact footer display.
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
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
 *   2. Metrics: `ctx %·used/window` (left, colored) | `↑in ↓out $cost (sub) auto` (right, dim)
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

		// Right: model • thinking-level — foreground + thinking-colored level
		// so a glance at the bottom of the screen surfaces "what model am I on
		// and at which budget".
		const modelName = state.model?.id || "no-model";
		const showProvider = this.footerData.getAvailableProviderCount() > 1 && state.model;
		const providerPrefix = showProvider ? `(${state.model!.provider}) ` : "";

		let identityRight: string;
		if (state.model?.reasoning) {
			const level = asKnownThinkingLevel(state.thinkingLevel);
			const levelLabel = level === "off" ? "thinking off" : level;
			const colorize = theme.getThinkingBorderColor(level);
			identityRight = `${providerPrefix}${modelName} • ${colorize(levelLabel)}`;
		} else {
			identityRight = `${providerPrefix}${modelName}`;
		}

		const identityLine = composeLeftRight(pwd, identityRight, width, {
			leftColor: (text) => theme.fg("muted", text),
			// identityRight is already partly colored (the level token); apply
			// foreground to the rest by leaving it as-is — it's the brightest
			// row in the footer block on purpose.
			rightColor: (text) => text,
			ellipsis: theme.fg("muted", "…"),
		});

		// --- Metrics (line 2) ------------------------------------------------
		// Context is the headline: flushed left, brighter (`muted`, or warning/
		// error when filling up) so the most actionable number reads at a glance.
		// `ctx 4.9% · 49k/1.0M` = percent used · absolute tokens / window. Usage
		// (input/output, cost, auto-compact) trails dim on the right.
		const ctxText =
			contextPercent === "?"
				? `ctx ?/${formatTokens(contextWindow)}`
				: `ctx ${contextPercent}% · ${formatTokens(contextUsage?.tokens ?? 0)}/${formatTokens(contextWindow)}`;
		const ctxColorize = theme.getContextUsageColor(contextPercentValue);

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
		// Distinct label ("compact", not "auto") so it never collides with the
		// permission mode — "auto" mode + auto-compact would read "auto auto".
		if (this.autoCompactEnabled) modeBits.push(theme.fg("dim", "compact"));

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
			leftColor: ctxColorize,
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
			const statusLine = otherStatuses.map(([, text]) => sanitizeStatusText(text)).join(" ");
			lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "…")));
		}

		return lines;
	}
}

interface ComposeOptions {
	leftColor: (text: string) => string;
	rightColor: (text: string) => string;
	ellipsis: string;
}

/**
 * Render a single line with `left` flushed left and `right` flushed right,
 * padded with spaces in between, never exceeding `width`. Truncates the right
 * side first; if the left is itself too wide, truncate it as well.
 *
 * Color wrappers receive the truncated raw text (no width math inside the
 * wrappers) so callers don't need to worry about ANSI-escape-aware truncation.
 */
function composeLeftRight(rawLeft: string, rawRight: string, width: number, options: ComposeOptions): string {
	const minPadding = rawLeft.length > 0 && rawRight.length > 0 ? 2 : 0;
	let left = rawLeft;
	let right = rawRight;
	let leftWidth = visibleWidth(left);
	let rightWidth = visibleWidth(right);

	if (leftWidth > width) {
		left = truncateToWidth(left, width, options.ellipsis);
		leftWidth = visibleWidth(left);
		right = "";
		rightWidth = 0;
	} else if (leftWidth + minPadding + rightWidth > width) {
		const available = width - leftWidth - minPadding;
		if (available > 0) {
			right = truncateToWidth(right, available, "");
			rightWidth = visibleWidth(right);
		} else {
			right = "";
			rightWidth = 0;
		}
	}

	const padding = " ".repeat(Math.max(0, width - leftWidth - rightWidth));
	const styledLeft = options.leftColor(left);
	const styledRight = options.rightColor(right);
	return rightWidth > 0 ? styledLeft + padding + styledRight : styledLeft + padding;
}
