/**
 * `code` tool (code-mode) — the model writes ONE JavaScript program that calls
 * the agent's tools as `await tools.read({ path })`, `await tools.grep({ ... })`,
 * etc. N tool calls collapse into a single turn: the program runs to completion
 * inside the persistent JS eval kernel, calling tools over the bidirectional
 * code-mode channel, and only the program's stdout returns to the model. This
 * cuts token + latency overhead for multi-tool workflows (read N files, filter,
 * compose) versus N separate model tool calls.
 *
 * ── HARNESS-FAITHFUL ─────────────────────────────────────────────────────────
 * Each `tools.x(args)` call is routed by the bridge through the SAME pipeline as
 * a normal model tool call (permission, rewrite, learned-error, loop detectors,
 * events). See core/code-mode/bridge.ts. This tool never touches
 * `ToolDefinition.execute` directly.
 *
 * ── WIRE (agent-session injects these via options) ───────────────────────────
 * The agent-session constructs this tool with:
 *   - `dispatcher`:          a `CodeModeDispatcher` bound to its per-tool-call
 *                            pipeline (anti-bypass).
 *   - `getActiveToolNames`:  `() => this.getActiveToolNames()`.
 * See `createCodeModeToolDefinition` below for the exact options shape and the
 * wiring comment.
 */

import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import { sliceSafe } from "../../utils/surrogate.ts";
import { type CodeModeDispatcher, createCodeModeBridge } from "../code-mode/bridge.ts";
import { getCurrentEvalKernelManager } from "../eval-kernel/index.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { EVAL_OUTPUT_CAP_BYTES, formatKernelResult } from "./eval.ts";
import { renderToolOutput, str } from "./render-utils.ts";
import { withOutputCap, wrapToolDefinition } from "./tool-definition-wrapper.ts";

const codeModeSchema = Type.Object(
	{
		code: Type.String({
			description:
				"A JavaScript program that calls the agent's tools as `await tools.<name>(args)` and prints results with console.log. Top-level await is supported. State does NOT persist across `code` calls.",
		}),
		timeout_ms: Type.Optional(
			Type.Number({
				description: "Kill the program after N ms (default 30000). The kernel is respawned on timeout.",
				minimum: 1,
			}),
		),
	},
	{ additionalProperties: false },
);

export type CodeModeToolInput = Static<typeof codeModeSchema>;

export interface CodeModeToolDetails {
	durationMs: number;
	hadError: boolean;
}

export interface CodeModeToolOptions {
	/** Default-on. Set false to remove the tool from the surface. */
	enabled?: boolean;
	/**
	 * Harness-routed dispatcher (anti-bypass). Injected by the agent-session.
	 * When absent, the tool reports that code-mode is not wired and is a no-op —
	 * so the registry can build the definition without the runtime dependency.
	 */
	dispatcher?: CodeModeDispatcher;
	/** Retained for API compatibility; active names are already listed by the system prompt. */
	getActiveToolNames?: () => string[];
	/** Override the per-tool-result byte cap re-injected into the vm. */
	maxToolResultBytes?: number;
}

/**
 * Build compact code-mode guidance. The system prompt already lists every
 * active tool, so repeating all names here wastes prefix tokens.
 */
function buildGuidelines(): string[] {
	return [
		"For multi-tool workflows, use one code-mode program with `await tools.<name>(args)`; active tools listed above are available except `code` itself.",
		"Tool results are strings: print the final result and catch failures. State does not persist between `code` calls.",
		"The JavaScript process is shared with `eval`; aborting or timing out either resets both tools' JS state.",
	];
}

export function createCodeModeToolDefinition(
	_cwd: string,
	options?: CodeModeToolOptions,
): ToolDefinition<typeof codeModeSchema, CodeModeToolDetails> {
	const dispatcher = options?.dispatcher;
	const getActiveToolNames = options?.getActiveToolNames ?? (() => []);
	const maxToolResultBytes = options?.maxToolResultBytes;
	const definition: ToolDefinition<typeof codeModeSchema, CodeModeToolDetails> = {
		name: "code",
		label: "code",
		description:
			"Run ONE JavaScript program that calls the agent's tools as `await tools.<name>(args)`. Use for multi-tool workflows (read/filter/compose over many results) to collapse N tool calls into a single turn — less latency and fewer tokens. Tool calls go through the same permission/safety pipeline as normal calls. Runs in the same persistent JavaScript kernel process as `eval` (lang=javascript) — aborting or timing out either tool tears down that shared kernel and wipes both tools' persisted JS state.",
		promptSnippet:
			"Write one JS program calling tools via `await tools.<name>(args)`; collapses N tool calls into one turn.",
		get promptGuidelines(): string[] {
			return buildGuidelines();
		},
		parameters: codeModeSchema,
		// Has observable effects (it runs tools); keep it on its own activity line.
		activity: "action",
		async execute(_toolCallId, input: CodeModeToolInput, signal) {
			if (!dispatcher) {
				return {
					content: [{ type: "text" as const, text: "code-mode is not wired in this session (no dispatcher)." }],
					isError: true,
					details: { durationMs: 0, hadError: true },
				};
			}
			const manager = getCurrentEvalKernelManager();
			if (!manager) {
				return {
					content: [{ type: "text" as const, text: "Eval kernel not available in this session." }],
					isError: true,
					details: { durationMs: 0, hadError: true },
				};
			}
			const kernel = manager.get("javascript");
			const channel = kernel.openCodeMode?.();
			if (!channel) {
				return {
					content: [{ type: "text" as const, text: "code-mode channel unavailable for this kernel." }],
					isError: true,
					details: { durationMs: 0, hadError: true },
				};
			}
			// Active tool names exposed to the program, minus `code` itself (no
			// recursion into code-mode). The bridge re-gates by active name too.
			const activeNames = getActiveToolNames().filter((n) => n !== "code");
			const activeSet = new Set(activeNames);
			const bridge = createCodeModeBridge(
				channel,
				dispatcher,
				(name) => activeSet.has(name),
				signal,
				maxToolResultBytes !== undefined ? { maxToolResultBytes } : undefined,
			);
			try {
				const result = await channel.runProgram(input.code, activeNames, input.timeout_ms, signal);
				const text = await formatKernelResult({
					label: "code-mode",
					stdout: result.stdout,
					stderr: result.stderr,
					error: result.error,
					durationMs: result.durationMs,
				});
				const hadError = Boolean(result.error);
				return {
					content: [{ type: "text" as const, text }],
					isError: hadError,
					details: { durationMs: result.durationMs, hadError },
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `code-mode error: ${msg}` }],
					isError: true,
					details: { durationMs: 0, hadError: true },
				};
			} finally {
				bridge.dispose();
			}
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const code = str(args?.code) || "";
			const firstLine = code.split(/\r?\n/, 1)[0] ?? "";
			const display = firstLine.length > 70 ? `${sliceSafe(firstLine, 0, 69)}…` : firstLine;
			text.setText(`${theme.fg("toolTitle", theme.bold("code"))} ${theme.fg("toolOutput", display)}`);
			return text;
		},
		renderResult: renderToolOutput,
	};
	return withOutputCap(definition, { maxBytes: EVAL_OUTPUT_CAP_BYTES, mode: "headTail" });
}

export function createCodeModeTool(cwd: string, options?: CodeModeToolOptions): AgentTool<typeof codeModeSchema> {
	return wrapToolDefinition(createCodeModeToolDefinition(cwd, options));
}
