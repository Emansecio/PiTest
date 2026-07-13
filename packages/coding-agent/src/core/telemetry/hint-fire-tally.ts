/**
 * Per-rule tally of tool-error-hint fires.
 *
 * The Tier-4 hint registry appends recovery hints to failed tool results; each
 * fire emits a `hint.fired` diagnostic carrying the rule id + tool name (see
 * `agent-loop.applyToolErrorHints`). This aggregator subscribes to that channel
 * and keeps a running count per rule id so the session summary can surface which
 * hint rules actually fire — the signal needed to find dead (never-firing) or
 * noisy rules. Mirrors the {@link GuardEfficacyCorrelator} wiring pattern.
 *
 * Bounded and fail-open: at most {@link DEFAULT_MAX_RULES} distinct ids are held
 * (further ids fold into one overflow bucket that keeps the total honest), and it
 * never throws into the guard/tool path that emitted the event.
 */

import type { RecordedDiagnosticEvent } from "@pit/ai";

/** Cap on distinct rule ids tracked at once (anti-OOM; further ids fold into one bucket). */
const DEFAULT_MAX_RULES = 128;

/** Rule-id key that absorbs fires beyond the distinct-id cap. */
const OVERFLOW_RULE_ID = "…overflow";

export interface HintFireTallyEntry {
	ruleId: string;
	count: number;
}

export interface HintFireTallySnapshot {
	type: "hint-fires";
	/** Total hint fires observed this session. */
	total: number;
	/** Per-rule counts, sorted by count desc then rule id asc. Bounded. */
	byRule: HintFireTallyEntry[];
}

export class HintFireTally {
	private total = 0;
	private readonly counts = new Map<string, number>();
	private readonly maxRules: number;

	constructor(maxRules: number = DEFAULT_MAX_RULES) {
		this.maxRules = maxRules;
	}

	/** Observe a diagnostic; count it only when it is a `hint.fired` with a rule id. */
	onDiagnostic(event: RecordedDiagnosticEvent): void {
		if (event.category !== "hint.fired") return;
		const ruleId = event.context?.ruleId;
		if (!ruleId) return;
		this.total += 1;
		const existing = this.counts.get(ruleId);
		if (existing !== undefined) {
			this.counts.set(ruleId, existing + 1);
		} else if (this.counts.size < this.maxRules) {
			this.counts.set(ruleId, 1);
		} else {
			// Beyond the distinct-id cap: keep the running total honest without
			// growing the map unbounded on a pathological run of novel ids.
			this.counts.set(OVERFLOW_RULE_ID, (this.counts.get(OVERFLOW_RULE_ID) ?? 0) + 1);
		}
	}

	/** Snapshot for the session summary. Returns null when nothing fired (summary omits it). */
	snapshot(): HintFireTallySnapshot | null {
		if (this.total === 0) return null;
		const byRule = Array.from(this.counts, ([ruleId, count]) => ({ ruleId, count })).sort(
			(a, b) => b.count - a.count || a.ruleId.localeCompare(b.ruleId),
		);
		return { type: "hint-fires", total: this.total, byRule };
	}
}
