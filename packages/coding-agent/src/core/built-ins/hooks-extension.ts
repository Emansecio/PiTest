/**
 * Built-in declarative-hooks extension.
 *
 * Reads `Settings.hooks` and binds spawned-shell hooks to:
 *   - tool_call (PreToolUse) — may block tool execution
 *   - tool_result (PostToolUse) — may transform tool output
 *   - input (UserPromptSubmit) — may block or augment the prompt
 *   - agent_end (Stop) — fires when a turn finishes
 *
 * Hook contract is documented in `core/hooks/types.ts`. Hooks run sequentially
 * within each event; the first hook to return `decision: "block"` short-circuits.
 */

import type { ExtensionAPI } from "../extensions/types.ts";
import type { HookExecutionResult, HooksSettings } from "../hooks/index.ts";
import { runHookChain, selectHooks } from "../hooks/index.ts";

export interface HooksExtensionOptions {
	settings: HooksSettings;
	cwd: string;
	/** Called for every hook execution (success or failure) for audit/logging. */
	onExecution?: (event: string, result: HookExecutionResult) => void;
}

function logErrors(
	executions: HookExecutionResult[],
	event: string,
	onExecution?: (e: string, r: HookExecutionResult) => void,
) {
	for (const exec of executions) {
		onExecution?.(event, exec);
		if (exec.exitCode !== 0 && !exec.parsed) {
			const name = exec.hook.name ?? exec.hook.command;
			const msg = (exec.stderr || exec.rawError || `exit ${exec.exitCode}`).trim().slice(0, 200);
			console.error(`[hook] ${event}/${name}: ${msg}`);
		}
	}
}

export function createHooksExtension(options: HooksExtensionOptions) {
	return (pi: ExtensionAPI) => {
		const { settings, cwd, onExecution } = options;
		const hasPre = (settings.PreToolUse?.length ?? 0) > 0;
		const hasPost = (settings.PostToolUse?.length ?? 0) > 0;
		const hasUps = (settings.UserPromptSubmit?.length ?? 0) > 0;
		const hasStop = (settings.Stop?.length ?? 0) > 0;

		if (!hasPre && !hasPost && !hasUps && !hasStop) {
			return; // No hooks configured — install no listeners.
		}

		if (hasPre) {
			pi.on("tool_call", async (event, ctx) => {
				const matched = selectHooks(settings.PreToolUse, event.toolName);
				if (matched.length === 0) return undefined;
				const payload = {
					event: "PreToolUse" as const,
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					input: event.input,
					cwd: ctx.cwd,
				};
				const { executions, blocked } = await runHookChain(matched, payload, {
					cwd,
					signal: ctx.signal,
				});
				logErrors(executions, "PreToolUse", onExecution);
				// Apply input overrides from non-blocking hooks.
				for (const exec of executions) {
					if (exec.parsed?.inputOverride && typeof exec.parsed.inputOverride === "object") {
						Object.assign(event.input, exec.parsed.inputOverride);
					}
				}
				if (blocked) {
					return {
						block: true,
						reason: blocked.parsed?.reason ?? "Blocked by PreToolUse hook.",
					};
				}
				return undefined;
			});
		}

		if (hasPost) {
			pi.on("tool_result", async (event, ctx) => {
				const matched = selectHooks(settings.PostToolUse, event.toolName);
				if (matched.length === 0) return undefined;
				const outputText = textOf(event.content);
				const payload = {
					event: "PostToolUse" as const,
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					input: event.input,
					output: outputText,
					isError: event.isError,
					cwd: ctx.cwd,
				};
				const { executions } = await runHookChain(matched, payload, {
					cwd,
					signal: ctx.signal,
				});
				logErrors(executions, "PostToolUse", onExecution);

				let newOutput: string | undefined;
				let isError = event.isError;
				for (const exec of executions) {
					if (exec.parsed?.outputOverride !== undefined) {
						newOutput = exec.parsed.outputOverride;
					}
					if (exec.parsed?.decision === "block") {
						isError = true;
					}
				}
				if (newOutput !== undefined || isError !== event.isError) {
					return {
						content: newOutput !== undefined ? [{ type: "text", text: newOutput }] : undefined,
						isError,
					};
				}
				return undefined;
			});
		}

		if (hasUps) {
			// We hook on `input` (not `before_agent_start`) so we can actually
			// short-circuit the turn when a hook returns `decision: "block"`.
			// `input` accepts `action: "handled"` which prevents the agent loop
			// from starting at all; `before_agent_start` has no equivalent.
			pi.on("input", async (event, ctx) => {
				const matched = selectHooks(settings.UserPromptSubmit, "*");
				if (matched.length === 0) return { action: "continue" } as const;
				const payload = {
					event: "UserPromptSubmit" as const,
					prompt: event.text,
					cwd: ctx.cwd,
				};
				const { executions, blocked } = await runHookChain(matched, payload, {
					cwd,
					signal: ctx.signal,
				});
				logErrors(executions, "UserPromptSubmit", onExecution);
				if (blocked) {
					if (ctx.hasUI) {
						ctx.ui.notify(`Prompt blocked by hook: ${blocked.parsed?.reason ?? "no reason"}`, "warning");
					}
					return { action: "handled" } as const;
				}
				const extras = executions
					.map((e) => e.parsed?.additionalContext?.trim())
					.filter((s): s is string => !!s && s.length > 0);
				if (extras.length === 0) return { action: "continue" } as const;
				return {
					action: "transform",
					text: `${event.text}\n\n<hook_context>\n${extras.join("\n\n")}\n</hook_context>`,
					images: event.images,
				} as const;
			});
		}

		if (hasStop) {
			let turnIndex = 0;
			pi.on("turn_end", () => {
				turnIndex++;
			});
			pi.on("agent_end", async (_event, ctx) => {
				const matched = selectHooks(settings.Stop, "*");
				if (matched.length === 0) return;
				const payload = {
					event: "Stop" as const,
					turnIndex,
					cwd: ctx.cwd,
				};
				const { executions } = await runHookChain(matched, payload, { cwd, signal: ctx.signal });
				logErrors(executions, "Stop", onExecution);
			});
		}
	};
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const out: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
			const text = (block as { text?: string }).text;
			if (typeof text === "string") out.push(text);
		}
	}
	return out.join("\n");
}
