/**
 * Canonical compact formatters for every number the TUI chrome shows.
 *
 * Before this module the repo had six divergent token formatters (footer,
 * loader chip, goal-manager with a lowercase `m`, /stats printing `1.0k`,
 * turn-done, export-html) and two `formatElapsed` implementations whose
 * outputs disagreed within a single turn (`9m14s` live vs `9m` settled).
 * Every UI call site must import from here; do not re-implement locally.
 */

/**
 * Coarse token count for resident chrome (footer, done lines, overlays):
 * `999` → `999`, `1234` → `1.2k`, `12345` → `12k`, `1234567` → `1.2M`,
 * `12345678` → `12M`. One decimal only below the next magnitude step, `.0`
 * stripped, uppercase `M`.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Fine-grained token count for live chips that must visibly move while
 * streaming (the working-loader `↑12.3k`): keeps one decimal all the way to
 * 1M so consecutive ticks differ. Same casing/strip rules as formatTokens.
 */
export function formatTokensPrecise(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1_000_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/**
 * Elapsed wall-clock in the live loader's dialect — the canonical one:
 * `47s`, `9m14s`, `1h05m`. Seconds are never dropped below the hour and the
 * subordinate unit is zero-padded, so a counter that settles into a done
 * line does not appear to lose time (`9m14s` must not become `9m`).
 */
export function formatElapsed(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	if (totalSec < 60) return `${totalSec}s`;
	if (totalSec < 3600) {
		const m = Math.floor(totalSec / 60);
		const s = totalSec % 60;
		return `${m}m${s.toString().padStart(2, "0")}s`;
	}
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	return `${h}h${m.toString().padStart(2, "0")}m`;
}

/**
 * Dollar cost: 4 decimals under a cent (`$0.0042`), 2 above (`$1.23`).
 * Callers decide whether a zero cost is shown at all.
 */
export function formatCost(cost: number): string {
	return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}
