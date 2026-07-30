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
 * Shell commands that write to the filesystem, for the `mutated` signal below.
 *
 * `MUTATING_TOOL_NAMES` only covers the structured edit tools, so a turn that
 * rewrites a file through the shell — `sed -i`, a heredoc, a plain `>` redirect —
 * used to read as "no mutation" and never triggered the cadence check. Agents do
 * write this way (the Terminal-Bench trial analyzer had to learn the same lesson).
 *
 * Redirects are matched only when the target is a real path: `2>&1` is excluded by
 * the leading-digit guard, `>&2` by the `&` exclusion in the target class, and
 * `> /dev/null` by the lookahead. Inclusive on purpose — a false match costs at
 * most one reminder that the bound below already caps.
 */
export const SHELL_WRITE_RE =
	/\b(?:sed\s+-i|tee|dd|patch|truncate|mkdir|touch|rmdir|mv|cp|rm)\b|<<[-~]?\s*['"]?\w|(?:^|[^0-9&])>>?\s*(?!\/dev\/null)[^\s|&;<>]/;

/** True when a `bash` tool call's command writes to the filesystem. */
export function isWritingBashCall(call: ToolCall): boolean {
	if (call.name !== "bash") return false;
	const args = call.arguments as { command?: unknown } | undefined;
	return typeof args?.command === "string" && SHELL_WRITE_RE.test(args.command);
}

/**
 * Classify one finished turn for todo cadence.
 *
 * - `touchedTodo` — the turn issued at least one `todo` tool call (any action).
 * - `mutated`     — a mutating tool call (a structured edit tool, or a `bash` call
 *                   that writes — see {@link SHELL_WRITE_RE}) had no error result.
 *                   A mutation with no matching result counts as success, leaning
 *                   against false positives just like `classifyTurn`.
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
		if (errorIds.has(call.id)) continue;
		if (MUTATING_TOOL_NAMES.has(call.name) || isWritingBashCall(call)) mutated = true;
	}
	return { touchedTodo, mutated };
}

/**
 * Counts the trailing run of turns that had open work but did not touch the todo
 * tool. A turn that touches the todo — or one with no open work — resets the
 * streak to zero. State only — the decision to fire lives in
 * `decideTodoCadenceReminder`.
 *
 * "Open work" means any todo that is not completed, NOT specifically an
 * in_progress one: across 42 measured sessions 38% of todos never pass through
 * in_progress, and gating on it left the detector blind on precisely the lists
 * that drift most.
 */
export class TodoCadenceTracker {
	private count = 0;

	/** Fold one turn into the streak; returns the new streak length. */
	observe(input: { hasOpenWork: boolean; touchedTodo: boolean }): number {
		this.count = input.hasOpenWork && !input.touchedTodo ? this.count + 1 : 0;
		return this.count;
	}

	get staleTurns(): number {
		return this.count;
	}

	reset(): void {
		this.count = 0;
	}
}

/**
 * How many reminders may go unheeded before the detector stops reminding for the
 * current list.
 *
 * Measured over 42 sessions: the reminder fired 312 times against 262 todos
 * created — up to 30 times in a single session — and the drift persisted anyway.
 * A steer the model has already ignored twice is not persuasion, it is rent paid
 * on every turn of a run, and a recurring ignored tag teaches the model to skip
 * the tag. So the nudge gives up and lets the diagnostic carry the signal instead.
 * The streak resets the moment the model touches the list, so a session that
 * recovers gets the reminder back.
 */
export const TODO_CADENCE_MAX_IGNORED = 2;

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
	/** Reminders fired since the model last touched the todo list. Absent = none. */
	ignoredStreak?: number;
	/** Give up after this many ignored reminders. Defaults to {@link TODO_CADENCE_MAX_IGNORED}. */
	maxIgnored?: number;
}

export interface TodoCadenceDecisionOutput {
	action: "none" | "remind" | "give-up";
	/** New value for `lastFiredAt`. Equals `now` when a message fires. */
	nextLastFiredAt: number;
}

/**
 * Decide whether to nudge the agent to sync its todo list. Pure — does not
 * mutate state.
 *
 * - `remind`  iff enabled AND (`staleTurns >= threshold` OR `mutatedWithoutTodo`)
 *             AND the reminder has not been ignored `maxIgnored` times AND
 *             (never fired before OR the cooldown has elapsed). `lastFiredAt === 0`
 *             means "never fired", so the first reminder is never throttled — the
 *             cooldown only spaces out repeats.
 * - `give-up` the trigger held but the reminder is spent for this list. Emitted
 *             (rather than folded into `none`) so the caller can record it once:
 *             a run that keeps drifting after being told twice is the signal worth
 *             measuring, and it is invisible if it looks like "nothing happened".
 * - `none`    otherwise.
 */
export function decideTodoCadenceReminder(input: TodoCadenceDecisionInput): TodoCadenceDecisionOutput {
	if (!input.enabled) {
		return { action: "none", nextLastFiredAt: input.lastFiredAt };
	}
	const triggered = input.staleTurns >= input.threshold || input.mutatedWithoutTodo;
	if (triggered) {
		const maxIgnored = input.maxIgnored ?? TODO_CADENCE_MAX_IGNORED;
		if ((input.ignoredStreak ?? 0) >= maxIgnored) {
			return { action: "give-up", nextLastFiredAt: input.lastFiredAt };
		}
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
	lines.push("");
	lines.push(
		'Do it with one `todo{action:"set", items:[...]}` call carrying the whole list — closing what is done ' +
			"and opening what is next is a single call, not one per item.",
	);
	lines.push("</todo-sync-reminder>");
	return lines.join("\n");
}
