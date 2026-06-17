/**
 * Todo cadence: keeps the agent's task list in sync with the work it is doing.
 *
 * Complements stagnation detection (which fires on read-only spinning). Cadence
 * fires when there is open work (an in_progress todo) but the agent keeps taking
 * turns — including file mutations — without touching the `todo` tool, so the
 * checklist drifts from reality. Pure builders + decision fn + a one-integer
 * tracker, mirroring `stagnation.ts` so the agent-session wiring stays thin.
 */

import type { AgentMessage } from "@pit/agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@pit/ai";
import { MUTATING_TOOL_NAMES } from "./stagnation.ts";
import type { TodoItem } from "./todo/todo-manager.ts";

/**
 * Classify one finished turn for todo cadence.
 *
 * - `touchedTodo` — the turn issued at least one `todo` tool call (any action).
 * - `mutated`     — a mutating tool call (see `MUTATING_TOOL_NAMES`) had no error
 *                   result. A mutation with no matching result counts as success,
 *                   leaning against false positives just like `classifyTurn`.
 */
export function classifyTodoTurn(
	message: AgentMessage,
	toolResults: ToolResultMessage[],
): { touchedTodo: boolean; mutated: boolean } {
	const toolCalls: ToolCall[] = [];
	if (message.role === "assistant") {
		for (const block of (message as AssistantMessage).content) {
			if (block.type === "toolCall") toolCalls.push(block);
		}
	}
	if (toolCalls.length === 0) return { touchedTodo: false, mutated: false };

	const errorIds = new Set<string>();
	for (const result of toolResults) {
		if (result.isError) errorIds.add(result.toolCallId);
	}

	let touchedTodo = false;
	let mutated = false;
	for (const call of toolCalls) {
		if (call.name === "todo") touchedTodo = true;
		if (MUTATING_TOOL_NAMES.has(call.name) && !errorIds.has(call.id)) mutated = true;
	}
	return { touchedTodo, mutated };
}

/**
 * Counts the trailing run of turns that had open work (an in_progress todo) but
 * did not touch the todo tool. A turn that touches the todo — or one with no open
 * work — resets the streak to zero. State only — the decision to fire lives in
 * `decideTodoCadenceReminder`.
 */
export class TodoCadenceTracker {
	private count = 0;

	/** Fold one turn into the streak; returns the new streak length. */
	observe(input: { hasInProgress: boolean; touchedTodo: boolean }): number {
		this.count = input.hasInProgress && !input.touchedTodo ? this.count + 1 : 0;
		return this.count;
	}

	get staleTurns(): number {
		return this.count;
	}

	reset(): void {
		this.count = 0;
	}
}

export interface TodoCadenceDecisionInput {
	enabled: boolean;
	/** K — number of stale turns that triggers a reminder on its own. */
	threshold: number;
	/** Current stale streak from the tracker. */
	staleTurns: number;
	/** This turn mutated a file but did not touch the todo while work was open. */
	mutatedWithoutTodo: boolean;
	/** When the reminder last fired (0 = never). */
	lastFiredAt: number;
	now: number;
	cooldownMs: number;
}

export interface TodoCadenceDecisionOutput {
	action: "none" | "remind";
	/** New value for `lastFiredAt`. Equals `now` when a message fires. */
	nextLastFiredAt: number;
}

/**
 * Decide whether to nudge the agent to sync its todo list. Pure — does not
 * mutate state.
 *
 * - `remind` iff enabled AND (`staleTurns >= threshold` OR `mutatedWithoutTodo`)
 *            AND (never fired before OR the cooldown has elapsed). `lastFiredAt
 *            === 0` means "never fired", so the first reminder is never throttled
 *            — the cooldown only spaces out repeats.
 * - `none`   otherwise.
 */
export function decideTodoCadenceReminder(input: TodoCadenceDecisionInput): TodoCadenceDecisionOutput {
	if (!input.enabled) {
		return { action: "none", nextLastFiredAt: input.lastFiredAt };
	}
	const triggered = input.staleTurns >= input.threshold || input.mutatedWithoutTodo;
	if (triggered) {
		const neverFired = input.lastFiredAt === 0;
		const cooldownElapsed = input.now - input.lastFiredAt >= input.cooldownMs;
		if (neverFired || cooldownElapsed) {
			return { action: "remind", nextLastFiredAt: input.now };
		}
	}
	return { action: "none", nextLastFiredAt: input.lastFiredAt };
}

const STATUS_GLYPH: Record<TodoItem["status"], string> = { completed: "✓", in_progress: "◐", pending: "○" };

/**
 * Build the markdown reminder injected when the todo list drifts. Enumerates the
 * current items and points at the open one. Never tells the agent to
 * auto-complete anything — only to keep the list honest.
 */
export function buildTodoCadenceReminder(input: {
	items: TodoItem[];
	staleItem?: TodoItem;
	reason: "stale" | "mutated";
}): string {
	const lines: string[] = [];
	lines.push("<todo-sync-reminder>");
	if (input.reason === "mutated") {
		lines.push(
			"You edited a file but did not update your todo list. Keep the checklist in sync with the " +
				"work you just did so it reflects reality.",
		);
	} else {
		lines.push(
			"Your todo list has not been touched for several turns while work is still open. Keep the " +
				"checklist in sync with what you are actually doing.",
		);
	}
	lines.push("");
	lines.push("Current todos:");
	for (const item of input.items) {
		lines.push(`- ${STATUS_GLYPH[item.status]} #${item.id} ${item.subject}`);
	}
	if (input.staleItem) {
		lines.push("");
		lines.push(
			`#${input.staleItem.id} (${input.staleItem.subject}) is in_progress — mark it completed if you ` +
				"finished it, or advance the list to the next item.",
		);
	}
	lines.push("</todo-sync-reminder>");
	return lines.join("\n");
}
