/**
 * Resolution layer for the `confirm` permission decision.
 *
 * The checker is pure and synchronous: for a mutation that no allowlist covers it
 * returns `{ decision: "confirm", reason }` and stops. Turning that deferral into a
 * real verdict is this module's job, and it is deliberately the ONLY place that
 * does it — every consumer of a decision (`permissions-extension`, the
 * post-mutation re-check in `agent-session`) routes through
 * {@link resolveConfirmDecision} so the three options behave identically wherever
 * the prompt is raised.
 *
 * Interactive channel: a `UserInputBus` picker with three options —
 * Allow once / Allow for session / Deny.
 *
 * Headless channels (print/JSON, RPC, subagents): there is no human, and the bus
 * auto-answers with the first option. So the gate refuses BEFORE touching the bus
 * when no listener is bound, and — belt and braces — `Deny` is listed FIRST so any
 * auto-answer path that slips past that check still lands on the safe choice.
 * Cancel (Esc) and an empty answer deny too. (A parallel batch of mutations no
 * longer auto-answers: the interactive mode queues the extra prompts and presents
 * them one at a time. The fail-closed ordering stays as the headless guard.)
 *
 * "Allow for session" writes the approval into the checker's IN-MEMORY settings —
 * never into settings.json. The rule it records is the mirror of what the checker
 * consults in `checkConfirm`:
 *   - write → an `allowPaths` glob for the exact (absolute, normalized) path
 *   - exec  → an `allowCommands` prefix regex (`^git\s+push\b`)
 *   - tool  → the tool name in `allowTools`
 * The prompt shows that rule verbatim, so "for session" is never a blank cheque
 * the user cannot see.
 */

import { getCurrentUserInputBus } from "../user-input-bus.ts";
import type { PermissionChecker } from "./checker.ts";
import { normalizeTargetPath } from "./matcher.ts";
import type { CommandRule, PathRule, PermissionAction } from "./types.ts";

export const CONFIRM_DENY_LABEL = "Deny";
export const CONFIRM_ALLOW_ONCE_LABEL = "Allow once";
export const CONFIRM_ALLOW_SESSION_LABEL = "Allow for session";

/** Reason attached to every rule "Allow for session" adds, so /diagnostics can tell them apart. */
export const SESSION_RULE_REASON = "approved for this session (confirm mode)";

/** The verdict a confirm deferral collapses to. Never `confirm` again. */
export interface ConfirmResolution {
	decision: "allow" | "deny";
	reason?: string;
	/** True when the user chose "Allow for session" and a rule was recorded. */
	remembered?: boolean;
}

/** An in-memory allowlist entry that "Allow for session" would add. */
export type SessionRule =
	| { kind: "paths"; globs: string[] }
	| { kind: "command"; pattern: string }
	| { kind: "tool"; toolName: string };

/** Deny copy for channels that cannot raise a prompt (print/JSON, RPC, subagents). */
export function headlessConfirmDenyReason(what: string): string {
	return `confirm mode requires an interactive session to approve "${what}" — run interactively, or use auto (or allowlistOnly for CI).`;
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(value: string): string {
	return value.replace(REGEX_META, "\\$&");
}

/**
 * Prefix regex remembered for an approved command: the executable plus, when it
 * looks like one, its subcommand (`git push …` → `^git\s+push\b`). Anchored at the
 * start so it can never match mid-line, and the trailing `\b` is only appended when
 * the last character is a word character (`\b` after `)` or `/` would assert the
 * wrong boundary). Everything the user did NOT approve — flags, targets, a second
 * chained command — is outside the pattern, so the rule stays a prefix grant.
 */
export function commandPrefixPattern(command: string): string {
	const tokens = command.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return "";
	const parts = [tokens[0]];
	const second = tokens[1];
	// A subcommand is a bare word; a flag, path, or redirection is not.
	if (second && /^[a-z][a-z0-9_-]*$/i.test(second)) parts.push(second);
	const body = parts.map(escapeRegExp).join("\\s+");
	const boundary = /\w$/.test(parts[parts.length - 1]) ? "\\b" : "";
	return `^${body}${boundary}`;
}

/**
 * What "Allow for session" would record for this action, or undefined when there
 * is nothing matchable (a mutating tool that exposed no path, an empty command
 * line). In that case the prompt drops the "for session" option entirely rather
 * than offering a grant it cannot honor.
 */
export function sessionRuleForAction(cwd: string, action: PermissionAction): SessionRule | undefined {
	if (action.type === "write") {
		if (action.paths.length === 0) return undefined;
		const globs = Array.from(new Set(action.paths.map((p) => normalizeTargetPath(p, cwd))));
		return { kind: "paths", globs };
	}
	if (action.type === "exec") {
		const pattern = commandPrefixPattern(action.command);
		return pattern ? { kind: "command", pattern } : undefined;
	}
	if (action.type === "tool") return { kind: "tool", toolName: action.toolName };
	return undefined;
}

/** One-line description of a session rule, shown in the prompt before it is granted. */
export function describeSessionRule(rule: SessionRule): string {
	if (rule.kind === "paths") {
		return rule.globs.length === 1
			? `allowPaths += ${rule.globs[0]}`
			: `allowPaths += ${rule.globs.length} paths (${rule.globs[0]}, …)`;
	}
	if (rule.kind === "command") return `allowCommands += /${rule.pattern}/`;
	return `allowTools += ${rule.toolName}`;
}

/**
 * Append a session rule to the checker's live settings. Session-scoped by
 * construction: `PermissionChecker.updateSettings` only touches the in-memory
 * context, so nothing is persisted to settings.json.
 */
export function rememberSessionRule(checker: PermissionChecker, rule: SessionRule): void {
	const settings = checker.settings;
	if (rule.kind === "paths") {
		const added: PathRule[] = rule.globs.map((glob) => ({ glob, reason: SESSION_RULE_REASON }));
		checker.updateSettings({ ...settings, allowPaths: [...(settings.allowPaths ?? []), ...added] });
		return;
	}
	if (rule.kind === "command") {
		const added: CommandRule = { pattern: rule.pattern, reason: SESSION_RULE_REASON };
		checker.updateSettings({ ...settings, allowCommands: [...(settings.allowCommands ?? []), added] });
		return;
	}
	const allowTools = settings.allowTools ?? [];
	if (allowTools.includes(rule.toolName)) return;
	checker.updateSettings({ ...settings, allowTools: [...allowTools, rule.toolName] });
}

/**
 * Turn a `{ decision: "confirm" }` into allow/deny.
 *
 * `reason` is the checker's short description of the pending action ("write →
 * \"src/x.ts\"", "run `npm test`") and doubles as the prompt's subject line.
 */
export async function resolveConfirmDecision(
	checker: PermissionChecker,
	action: PermissionAction,
	reason: string,
): Promise<ConfirmResolution> {
	const bus = getCurrentUserInputBus();
	if (!bus || !bus.hasListener()) {
		return { decision: "deny", reason: headlessConfirmDenyReason(reason) };
	}

	const rule = sessionRuleForAction(checker.cwd, action);
	const options = [
		{ label: CONFIRM_DENY_LABEL, description: "Block this call and tell the model why" },
		{ label: CONFIRM_ALLOW_ONCE_LABEL, description: "Run it now; ask again next time", hotkey: "a" },
	];
	if (rule) {
		options.push({
			label: CONFIRM_ALLOW_SESSION_LABEL,
			description: `Run it and stop asking — ${describeSessionRule(rule)} (this session only)`,
			hotkey: "s",
		});
	}

	const answer = await bus.askOptions({
		question: `Approve: ${reason}?`,
		header: "confirm mode",
		options,
		allowComment: true,
		source: { toolName: action.toolName },
	});

	if (answer.cancelled) {
		return { decision: "deny", reason: `User cancelled the approval for ${reason}.` };
	}
	if (answer.picked.includes(CONFIRM_ALLOW_SESSION_LABEL) && rule) {
		rememberSessionRule(checker, rule);
		return { decision: "allow", remembered: true };
	}
	if (answer.picked.includes(CONFIRM_ALLOW_ONCE_LABEL)) {
		return { decision: "allow" };
	}
	// Deny, an empty pick, or anything unrecognized — fail closed.
	const note = answer.comment?.trim() || answer.freeformText?.trim();
	return {
		decision: "deny",
		reason: note ? `User denied ${reason}. Feedback: ${note}` : `User denied ${reason}.`,
	};
}
