import { type Component, truncateToWidth, visibleWidth } from "@pit/tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { formatDisplayPath } from "../display-utils.ts";
import { theme } from "../theme/theme.ts";

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
	private cachedStatusVersion = -1;
	private cachedStatusLine: string | null = null;

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
		// without competing with the model name.
		let pwd = formatDisplayPath(this.session.sessionManager.getCwd());
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

		const rightParts: string[] = [];
		const io: string[] = [];
		if (totals.input) io.push(`↑${formatTokens(totals.input)}`);
		if (totals.output) io.push(`↓${formatTokens(totals.output)}`);
		if (io.length) rightParts.push(io.join(" "));

		const goalStatus = this.session.goalStatusLine();
		if (goalStatus) rightParts.push(goalStatus);

		const usingSubscription = state.model ? this.session.modelRegistry.isUsingOAuth(state.model) : false;
		if (totals.cost || usingSubscription) {
			rightParts.push(`$${totals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);
		}
		if (this.autoCompactEnabled) rightParts.push("auto");

		const metricsLine = composeLeftRight(ctxText, rightParts.join(" · "), width, {
			leftColor: ctxColorize,
			rightColor: (text) => theme.fg("dim", text),
			ellipsis: theme.fg("dim", "…"),
		});

		const lines = [identityLine, metricsLine];

		// --- Extension statuses (line 3, optional) ---------------------------
		const extensionStatuses = this.footerData.getExtensionStatuses();
		if (extensionStatuses.size > 0) {
			const currentVersion = this.footerData.getStatusVersion();
			if (currentVersion !== this.cachedStatusVersion) {
				this.cachedStatusLine = Array.from(extensionStatuses.entries())
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([, text]) => sanitizeStatusText(text))
					.join(" ");
				this.cachedStatusVersion = currentVersion;
			}
			lines.push(truncateToWidth(this.cachedStatusLine!, width, theme.fg("dim", "…")));
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
		left = truncateToWidth(left, width, "…");
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
