/**
 * Per-turn (prompt-cycle) patch-risk aggregator — Band P / P4.
 *
 * `auditPatchResult` (core/patch-audit.ts) scores each write/edit in isolation, so
 * a turn made of many SMALL edits — each below the medium/high threshold — never
 * trips a high-risk directive even though, taken together, it rewrote a large slice
 * of the codebase. This accumulator closes that documented gap (study §3.2): it
 * sums the changed-line counts of every successful mutation in one prompt cycle and
 * classifies the aggregate against the SAME thresholds patch-audit uses.
 *
 * It records BOTH signals the self-review trigger needs (see core/self-review.ts):
 *   - `aggregateRisk`: the cycle total scored by `classifyChangedLinesRisk`;
 *   - `maxPatchRisk`: the highest risk any SINGLE patch reached on its own.
 * A high on either path triggers the review; the accumulator itself makes no
 * dosing decision — it only measures.
 *
 * Pure/stateful and session-agnostic: the session feeds it each successful
 * write/edit result and resets it at the prompt-cycle boundary.
 */

import {
	classifyChangedLinesRisk,
	measurePatch,
	type PatchAuditInput,
	type PatchAuditOptions,
	type PatchAuditRisk,
	resolvePatchAuditOptions,
} from "./patch-audit.ts";

/** A file touched this cycle, with its cumulative changed-line count. */
export interface TouchedFileRisk {
	path: string;
	changedLines: number;
	/** Last diff seen for the file, when the tool result carried one (for the review prompt). */
	diff?: string;
}

/** Snapshot of a prompt cycle's cumulative patch risk. */
export interface TurnRiskTotals {
	/** Number of successful, measurable mutations accumulated this cycle. */
	mutations: number;
	changedLines: number;
	/** Aggregate risk from the cycle's total changed lines (the gap-closing signal). */
	aggregateRisk: PatchAuditRisk;
	/** Highest risk any single patch reached on its own. */
	maxPatchRisk: PatchAuditRisk;
	/** Per-file changed-line totals, insertion-ordered, for the review payload. */
	touchedFiles: TouchedFileRisk[];
}

const RISK_ORDER: readonly PatchAuditRisk[] = ["low", "medium", "high"];

function maxRisk(a: PatchAuditRisk, b: PatchAuditRisk): PatchAuditRisk {
	return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

/** Cap the diff text retained per file so a big rewrite can't bloat the review prompt. */
const MAX_RETAINED_DIFF_CHARS = 8_000;

export class TurnRiskAccumulator {
	private readonly _options: Required<PatchAuditOptions>;
	private _mutations = 0;
	private _changedLines = 0;
	private _maxPatchRisk: PatchAuditRisk = "low";
	private readonly _byFile = new Map<string, TouchedFileRisk>();

	constructor(options?: PatchAuditOptions) {
		this._options = resolvePatchAuditOptions(options);
	}

	/**
	 * Fold one tool result into the cycle totals. No-op for non-mutating / errored /
	 * preview results (measurePatch returns undefined). Feed EVERY successful
	 * write/edit/edit_v2/ast_edit result — including sub-threshold ones — so the
	 * aggregate reflects the whole cycle.
	 */
	add(input: PatchAuditInput): void {
		const measurement = measurePatch(input);
		if (measurement === undefined) return;
		this._mutations++;
		this._changedLines += measurement.changedLines;
		// A single patch can be high on its own via the write-line rule (a large
		// full-file write with few "changed" diff lines), so classify per-patch too.
		const perPatchRisk = classifyChangedLinesRisk(measurement.changedLines, this._options);
		const writeHigh =
			input.toolName === "write" && measurement.writeLines >= this._options.highWriteLines ? "high" : "low";
		this._maxPatchRisk = maxRisk(this._maxPatchRisk, maxRisk(perPatchRisk, writeHigh));

		const path = measurement.path;
		if (path !== undefined) {
			const existing = this._byFile.get(path);
			const diff = measurement.diff ? measurement.diff.slice(0, MAX_RETAINED_DIFF_CHARS) : undefined;
			if (existing) {
				existing.changedLines += measurement.changedLines;
				if (diff) existing.diff = diff;
			} else {
				this._byFile.set(path, { path, changedLines: measurement.changedLines, diff });
			}
		}
	}

	/** Number of measurable mutations folded in so far. */
	get mutations(): number {
		return this._mutations;
	}

	getTotals(): TurnRiskTotals {
		return {
			mutations: this._mutations,
			changedLines: this._changedLines,
			aggregateRisk: classifyChangedLinesRisk(this._changedLines, this._options),
			maxPatchRisk: this._maxPatchRisk,
			touchedFiles: [...this._byFile.values()],
		};
	}

	/** Clear all cycle state. Called at the prompt-cycle boundary. */
	reset(): void {
		this._mutations = 0;
		this._changedLines = 0;
		this._maxPatchRisk = "low";
		this._byFile.clear();
	}
}
