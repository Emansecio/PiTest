/**
 * Interactive `/goal` panel — the no-args entry point to autonomous goal mode.
 *
 * A bare `/goal` used to flash the status as a 3.5s ephemeral line and demand
 * typed subcommands for everything else, which read as "the command does
 * nothing". This mirrors the Claude Code `/goal` UI command instead: no goal →
 * a modal input to set the objective; existing goal → an action picker
 * (pause/resume, edit, budget, replace, clear). Every action stays reachable
 * through the typed subcommands too — this is the discoverable front door,
 * not a replacement.
 *
 * Pure control flow over an injected host (same pattern as
 * interactive-slash-commands.ts) so it is testable without booting the TUI.
 */

import { type GoalSnapshot, parseTokenBudget } from "../../core/goal/goal-manager.ts";
import type { AskOption } from "../../core/user-input-bus.ts";
import { sliceSafe } from "../../utils/surrogate.ts";

export interface GoalDialogHost {
	goalSnapshot(): GoalSnapshot | undefined;
	goalSummaryText(): string;
	goalShouldAutoContinue(): boolean;
	startGoal(objective: string, opts: { tokenBudget?: number }): void;
	editGoal(objective: string): void;
	pauseGoal(): void;
	resumeGoal(): void;
	clearGoal(): void;
	setGoalTokenBudget(tokenBudget: number): void;
	/** Modal text input replacing the editor; resolves undefined on Esc. */
	promptInput(title: string, placeholder?: string): Promise<string | undefined>;
	/** Single-select picker; resolves the picked label, undefined on Esc. */
	pickOption(question: string, options: AskOption[]): Promise<string | undefined>;
	showStatus(text: string): void;
	showWarning(text: string): void;
	/** Arm the footer goal spinner (idempotent, no-op when goal not active). */
	startGoalSpinner(): void;
	/** Dispatch a prompt to the agent (drives the goal turn). */
	prompt(text: string, opts?: { expandPromptTemplates?: boolean }): Promise<void>;
}

// Picker labels double as the switch keys — keep them as consts so the
// builder and the handler can never drift apart.
const ACTION_PAUSE = "Pause";
const ACTION_RESUME = "Resume";
const ACTION_EDIT = "Edit objective";
const ACTION_BUDGET = "Set token budget";
const ACTION_RAISE_BUDGET = "Raise token budget";
const ACTION_REPLACE = "Replace goal";
const ACTION_CLEAR = "Clear goal";

/** Same continuation prompt the typed `/goal resume` path uses. */
const RESUME_PROMPT = "Resume working toward the goal.";

/** Single-line placeholder from a possibly 4000-char objective. */
function objectivePlaceholder(objective: string): string {
	const flat = objective.replace(/\s+/g, " ").trim();
	return flat.length > 60 ? `${sliceSafe(flat, 0, 59)}…` : flat;
}

function buildActions(goal: GoalSnapshot): AskOption[] {
	const actions: AskOption[] = [];
	switch (goal.status) {
		case "active":
			actions.push({ label: ACTION_PAUSE, description: "Stop auto-continuation; resume any time" });
			break;
		case "paused":
			actions.push({ label: ACTION_RESUME, description: "Reactivate and keep working", recommended: true });
			break;
		case "budget_limited":
			// resume() alone cannot lift a budget_limited goal (see GoalManager),
			// so the raise action IS the resume path here.
			actions.push({
				label: ACTION_RAISE_BUDGET,
				description: "Token budget reached — raise it to continue",
				recommended: true,
			});
			break;
		case "complete":
			break; // unreachable: runGoalDialog routes complete to the new-goal input
	}
	actions.push({ label: ACTION_EDIT, description: "Rewrite the objective without losing progress" });
	if (goal.status !== "budget_limited") {
		actions.push({ label: ACTION_BUDGET, description: "Cap total token spend (e.g. 100k, 1.5m)" });
	}
	actions.push({ label: ACTION_REPLACE, description: "Discard this goal and set a new one" });
	actions.push({ label: ACTION_CLEAR, description: "Drop the goal entirely" });
	return actions;
}

async function startNewGoal(host: GoalDialogHost): Promise<void> {
	const objective = (
		await host.promptInput("🎯 Set a session goal", "Objective the agent should pursue autonomously — Esc to cancel")
	)?.trim();
	if (!objective) return;
	host.startGoal(objective, {});
	host.showStatus(`Goal started: ${objective}`);
	host.startGoalSpinner();
	await host.prompt(objective);
}

async function editObjective(host: GoalDialogHost, goal: GoalSnapshot): Promise<void> {
	const objective = (await host.promptInput("🎯 Edit goal objective", objectivePlaceholder(goal.objective)))?.trim();
	if (!objective) return;
	host.editGoal(objective);
	host.showStatus(host.goalSummaryText());
}

async function setBudget(host: GoalDialogHost): Promise<void> {
	const raw = (await host.promptInput("🎯 Token budget", "e.g. 100k or 1.5m — Esc to cancel"))?.trim();
	if (!raw) return;
	const parsed = parseTokenBudget(raw);
	if (parsed === undefined) {
		host.showWarning(`Invalid token budget: "${raw}". Use e.g. 100k or 1.5m.`);
		return;
	}
	host.setGoalTokenBudget(parsed);
	host.showStatus(host.goalSummaryText());
	// Raising the cap on a budget_limited goal reactivates it — drive the next
	// turn exactly like the typed `/goal --tokens <n>` path does.
	if (host.goalShouldAutoContinue()) {
		host.startGoalSpinner();
		await host.prompt(RESUME_PROMPT, { expandPromptTemplates: false });
	}
}

async function resumeGoal(host: GoalDialogHost): Promise<void> {
	host.resumeGoal();
	host.showStatus(host.goalSummaryText());
	if (host.goalShouldAutoContinue()) {
		host.startGoalSpinner();
		await host.prompt(RESUME_PROMPT, { expandPromptTemplates: false });
	}
}

/**
 * Entry point for a bare `/goal`. No goal (or a completed one) → objective
 * input; live goal → action picker. Esc anywhere closes without side effects.
 */
export async function runGoalDialog(host: GoalDialogHost): Promise<void> {
	const goal = host.goalSnapshot();
	if (!goal || goal.status === "complete") {
		await startNewGoal(host);
		return;
	}

	const picked = await host.pickOption(`🎯 ${goal.status}: ${goal.objective}`, buildActions(goal));
	switch (picked) {
		case ACTION_PAUSE:
			host.pauseGoal();
			host.showStatus(host.goalSummaryText());
			return;
		case ACTION_RESUME:
			await resumeGoal(host);
			return;
		case ACTION_EDIT:
			await editObjective(host, goal);
			return;
		case ACTION_BUDGET:
		case ACTION_RAISE_BUDGET:
			await setBudget(host);
			return;
		case ACTION_REPLACE:
			await startNewGoal(host);
			return;
		case ACTION_CLEAR:
			host.clearGoal();
			host.showStatus("Goal cleared");
			return;
		default:
			return; // Esc — panel closed, nothing changes
	}
}
