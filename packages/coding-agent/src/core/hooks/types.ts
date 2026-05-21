/**
 * Declarative hook system, settings-driven.
 *
 * Hook events:
 * - PreToolUse: fires before a tool call. Hook may block (decision: "deny") or
 *   mutate the tool args via a returned `inputOverride`.
 * - PostToolUse: fires after a tool call, with the result. Hook may transform
 *   the content via `outputOverride` or mark the result as error.
 * - UserPromptSubmit: fires after the user submits a prompt, before the agent
 *   loop starts. Hook may add additional context via `additionalContext` or
 *   block the turn entirely with `decision: "block"` (the prompt is discarded
 *   and a notification is shown when a UI is available).
 * - Stop: fires when the agent ends a turn (no more tool calls pending). Useful
 *   for auto-commit, lint runs, etc.
 *
 * Hook commands receive a JSON payload on stdin and respond with JSON on stdout.
 * Non-zero exit codes are treated as failures and the hook output is logged but
 * the agent loop continues — except for PreToolUse failures, which block.
 */

export type HookEventName = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop";

export const HOOK_EVENT_NAMES: readonly HookEventName[] = [
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"Stop",
] as const;

export function isHookEventName(value: unknown): value is HookEventName {
	return typeof value === "string" && (HOOK_EVENT_NAMES as readonly string[]).includes(value);
}

export interface HookCommand {
	/** Tool name regex (e.g. "bash|edit|write"); omit to match all. */
	matcher?: string;
	/** Shell command line executed via `bash -c` (POSIX) or `cmd /c` (Win) when shell=true. */
	command: string;
	/** Run via a shell. Default: true. When false, command is split on whitespace and exec'd directly. */
	shell?: boolean;
	/** Optional timeout (ms). Default 30000. */
	timeoutMs?: number;
	/** Working directory override. Default: session cwd. */
	cwd?: string;
	/** Human-readable label for logs. */
	name?: string;
}

export interface HooksSettings {
	PreToolUse?: HookCommand[];
	PostToolUse?: HookCommand[];
	UserPromptSubmit?: HookCommand[];
	Stop?: HookCommand[];
}

/** Stdin payload sent to PreToolUse hooks. */
export interface PreToolUsePayload {
	event: "PreToolUse";
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
	cwd: string;
}

/** Stdin payload sent to PostToolUse hooks. */
export interface PostToolUsePayload {
	event: "PostToolUse";
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
	output: string;
	isError: boolean;
	cwd: string;
}

/** Stdin payload sent to UserPromptSubmit hooks. */
export interface UserPromptSubmitPayload {
	event: "UserPromptSubmit";
	prompt: string;
	cwd: string;
}

/** Stdin payload sent to Stop hooks. */
export interface StopPayload {
	event: "Stop";
	turnIndex: number;
	cwd: string;
}

export type HookPayload = PreToolUsePayload | PostToolUsePayload | UserPromptSubmitPayload | StopPayload;

/**
 * Hook stdout JSON contract:
 *  { "decision": "block" | "allow", "reason": "...", "inputOverride": {...}, "additionalContext": "..." }
 *
 * Empty stdout / non-JSON stdout is treated as `{ decision: "allow" }`.
 */
export interface HookResult {
	decision?: "allow" | "block";
	reason?: string;
	/** PreToolUse only: replace tool input with this object before execution. */
	inputOverride?: Record<string, unknown>;
	/** PostToolUse only: replace tool output text with this string. */
	outputOverride?: string;
	/** UserPromptSubmit only: extra text appended to the user prompt before sending to LLM. */
	additionalContext?: string;
}

export interface HookExecutionResult {
	hook: HookCommand;
	parsed?: HookResult;
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
	rawError?: string;
}
