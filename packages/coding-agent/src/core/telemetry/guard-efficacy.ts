/**
 * Guard→next-call efficacy correlator.
 *
 * A guard blocking a tool call is only useful if the model's NEXT attempt at
 * that tool actually succeeds. This joins the two halves that already exist but
 * were never linked: a `guard.*` diagnostic firing with `outcome:"blocked"`
 * (or "overridden"), and the success/failure of the following call to the same
 * tool (recorded at tool_execution_end via ToolCallStats). It emits one
 * `{type:"efficacy", …}` record per resolved pair through the durable sink.
 *
 * Memory is bounded: at most one pending guard-fire per tool (a Map keyed by
 * tool name), and the map itself is capped so a pathological run of guard fires
 * on many tools cannot leak. Everything fails open — telemetry never throws into
 * the guard or tool path.
 */

import type { RecordedDiagnosticEvent } from "@pit/ai";

/** Default cap on distinct tools tracked at once (anti-OOM; oldest evicted). */
const DEFAULT_MAX_PENDING = 32;

/** A guard-fire awaiting the outcome of the tool's next call. */
interface PendingGuardFire {
	guard: string;
	ruleId?: string;
	outcome: "blocked" | "overridden";
	toolCallId: string;
	ts: number;
}

/** One resolved guard→next-call pair, written to the diagnostics sink. */
export interface GuardEfficacyRecord {
	type: "efficacy";
	guard: string;
	ruleId?: string;
	outcome: "blocked" | "overridden";
	/** Whether the tool's next call succeeded (isError === false). */
	nextCallOk: boolean;
	ts: number;
}

/**
 * Infer the tool a guard diagnostic refers to. Guards do not carry a structured
 * tool field, so scan the free-form `note` for a known tool token. Returns
 * undefined when no tool can be identified — the fire is then simply not
 * correlated (fail-open, never guessed).
 */
export function getToolCallFromDiagnostic(
	event: RecordedDiagnosticEvent,
): { toolName: string; toolCallId: string } | undefined {
	const toolName = event.context?.toolName;
	const toolCallId = event.context?.toolCallId;
	return toolName && toolCallId ? { toolName, toolCallId } : undefined;
}

export class GuardEfficacyCorrelator {
	private readonly pending = new Map<string, PendingGuardFire>();
	private readonly emit: (record: GuardEfficacyRecord) => void;
	private readonly maxPending: number;

	constructor(emit: (record: GuardEfficacyRecord) => void, maxPending: number = DEFAULT_MAX_PENDING) {
		this.emit = emit;
		this.maxPending = maxPending;
	}

	/** Observe a diagnostic; remember guard-fires that blocked/overrode a tool call. */
	onDiagnostic(event: RecordedDiagnosticEvent): void {
		if (!event.category.startsWith("guard.")) return;
		const outcome = event.context?.outcome;
		if (outcome !== "blocked" && outcome !== "overridden") return;
		const tool = getToolCallFromDiagnostic(event);
		if (!tool) return;
		// Keep only the most recent fire per tool; re-inserting refreshes recency.
		this.pending.delete(tool.toolName);
		this.pending.set(tool.toolName, {
			guard: event.category,
			ruleId: event.context?.ruleId,
			outcome,
			toolCallId: tool.toolCallId,
			ts: event.ts,
		});
		this.enforceCap();
	}

	/** Reconcile a finished tool call against any pending guard-fire for that tool. */
	onToolExecutionEnd(toolName: string, toolCallId: string, isError: boolean): void {
		const fire = this.pending.get(toolName);
		if (!fire) return;
		if (fire.toolCallId === toolCallId) return;
		this.pending.delete(toolName);
		try {
			this.emit({
				type: "efficacy",
				guard: fire.guard,
				ruleId: fire.ruleId,
				outcome: fire.outcome,
				nextCallOk: !isError,
				ts: Date.now(),
			});
		} catch {
			// Fail-open: a sink write must never break tool_execution_end.
		}
	}

	private enforceCap(): void {
		while (this.pending.size > this.maxPending) {
			const oldest = this.pending.keys().next().value;
			if (oldest === undefined) return;
			this.pending.delete(oldest);
		}
	}
}
