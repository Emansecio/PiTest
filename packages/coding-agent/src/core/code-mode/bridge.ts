/**
 * Code-mode bridge — the MAIN-side half of the bidirectional tool-call channel.
 *
 * In code-mode the model writes a single JavaScript program that calls the
 * agent's tools as `await tools.read({ path })`, `await tools.grep({ ... })`,
 * etc. The program runs inside the persistent JS eval kernel (`node:vm`); each
 * `tools.x(args)` call emits a `{ toolCall: { callId, name, args } }` frame on
 * the kernel's stdout. This bridge receives those frames, routes them through
 * the SAME tool pipeline as a normal model tool call, and writes a matching
 * `{ toolResult: { callId, content, isError } }` frame back to the kernel's
 * stdin — which resolves the `tools.x()` promise inside the vm.
 *
 * ── ANTI-BYPASS (load-bearing) ──────────────────────────────────────────────
 * The bridge NEVER calls `ToolDefinition.execute` directly. It is constructed
 * with a `dispatcher` supplied by the agent-session that encapsulates the full
 * harness pipeline: permission-gate, tool-rewrite-rules, learned-error guard,
 * loop/doom detectors, tool_execution_start/tool_execution_end events (when an
 * event sink is wired — see `buildHarnessDispatcher`), and rendering.
 * Bypassing that pipeline would forfeit the harness — one of Pit's core
 * strengths — so the dispatcher is the only path a code-mode tool call takes.
 * The bridge's job is purely transport + safety caps (active-tool gating, result
 * size cap, abort, error isolation so one failed call doesn't wedge the pump).
 */

import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	BeforeToolCallContext,
	BeforeToolCallResult,
	ToolErrorHintRegistry,
	ToolRewriteRegistry,
} from "@pit/agent-core";
import { uuidv7 } from "@pit/agent-core";
import type { AssistantMessage, TextContent } from "@pit/ai";
import { recordDiagnostic } from "@pit/ai";
import type { CodeModeChannel } from "../eval-kernel/types.ts";

/**
 * Result of a single dispatched tool call, as the bridge needs it. This is a
 * deliberately narrow projection of `AgentToolResult` — the bridge only ships
 * text back into the vm (the model's program reads strings/JSON), so image
 * content blocks are flattened to a placeholder by `flattenContent`.
 */
export interface CodeModeDispatchResult {
	/** Tool result content blocks (text/image), as returned by the pipeline. */
	content: Array<{ type: string; text?: string }>;
	/** Whether the tool call errored. */
	isError?: boolean;
}

/**
 * The dispatcher the agent-session injects. It MUST run the call through the
 * normal tool pipeline (permission, rewrite, learned-error, detectors, events)
 * and resolve to the tool's result. Throwing is allowed — the bridge converts a
 * throw into an `isError` result for the vm so a single bad call cannot wedge
 * the pump.
 *
 * @param name  Active tool name, e.g. "read" / "grep".
 * @param args  Parsed argument object from the vm-side `tools.x(args)` call.
 * @param signal Abort signal for the whole code-mode run; the dispatcher should
 *               propagate it to the underlying tool.
 */
export type CodeModeDispatcher = (
	name: string,
	args: Record<string, unknown>,
	signal: AbortSignal | undefined,
) => Promise<CodeModeDispatchResult>;

/** Default cap on the bytes of a single tool result re-injected into the vm. */
const DEFAULT_MAX_TOOL_RESULT_BYTES = 256 * 1024; // 256KB

function resolveMaxToolResultBytes(): number {
	const raw = process.env.PIT_CODE_MODE_MAX_RESULT_BYTES;
	if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_TOOL_RESULT_BYTES;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_TOOL_RESULT_BYTES;
	return parsed;
}

export interface CodeModeBridgeOptions {
	/** Max bytes of a single tool result re-injected into the vm (default 256KB). */
	maxToolResultBytes?: number;
}

/**
 * Flatten tool-result content blocks into the single string the vm receives.
 * Text blocks are concatenated; non-text (e.g. images) become a short
 * placeholder so the model's program still gets a deterministic value instead
 * of a structured payload it cannot serialize.
 */
function flattenContent(content: Array<{ type: string; text?: string }>): string {
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		} else {
			parts.push(`[${block.type} content omitted in code-mode]`);
		}
	}
	return parts.join("\n");
}

/** Truncate a result string to the cap, appending a deterministic marker. */
function capResult(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (text.length <= maxBytes) return { text, truncated: false };
	const marker = `\n[code-mode: tool result truncated at ${maxBytes} bytes]`;
	const head = text.slice(0, Math.max(0, maxBytes - marker.length));
	return { text: head + marker, truncated: true };
}

/**
 * Live bridge bound to a kernel channel. Created per code-mode run by
 * {@link createCodeModeBridge}; `dispose()` detaches the channel handler so the
 * kernel can be reused (or closed) cleanly.
 */
export interface CodeModeBridge {
	/** Detach the toolCall handler from the channel. Idempotent. */
	dispose(): void;
}

/**
 * Wire a code-mode bridge onto a kernel channel.
 *
 * ── WHERE THE AGENT-SESSION CALLS THIS ──────────────────────────────────────
 * The `code` tool (core/tools/code-mode.ts) calls this for the duration of one
 * program run. The agent-session is responsible for supplying the two injected
 * pieces via the tool's options at construction time (see
 * `createCodeModeToolDefinition` in core/tools/code-mode.ts):
 *
 *   1. `dispatcher`  — bound to AgentSession's existing per-tool-call pipeline.
 *      Recommended wiring: reuse the same function the agent loop uses to run a
 *      model tool call (permission + rewrite + learned-error + detectors +
 *      tool_call/tool_result events), e.g. a thin adapter over
 *      `agent-session-runtime`'s tool execution path. Do NOT pass raw
 *      `ToolDefinition.execute` — that bypasses the harness.
 *
 *   2. `getActiveToolNames` — AgentSession already exposes this
 *      (`this.getActiveToolNames()`); the bridge only exposes those names on the
 *      vm-side `tools` proxy so the model cannot reach a deactivated/hidden tool.
 *
 * @param channel   The kernel's bidirectional code-mode channel.
 * @param dispatcher The harness-routed tool dispatcher (anti-bypass).
 * @param isToolActive Predicate: is this tool name currently active? Calls to
 *                     inactive/unknown tools resolve to an isError result.
 * @param signal    Abort signal for the whole run.
 * @param options   Caps/overrides.
 */
export function createCodeModeBridge(
	channel: CodeModeChannel,
	dispatcher: CodeModeDispatcher,
	isToolActive: (name: string) => boolean,
	signal: AbortSignal | undefined,
	options?: CodeModeBridgeOptions,
): CodeModeBridge {
	const maxBytes = options?.maxToolResultBytes ?? resolveMaxToolResultBytes();
	let disposed = false;

	const handle = async (call: { callId: string; name: string; args: unknown }): Promise<void> => {
		const { callId, name } = call;
		const reply = (text: string, isError: boolean): void => {
			if (disposed) return;
			channel.sendToolResult({ callId, content: [{ type: "text", text }], isError });
		};

		// Active-tool gating: the vm proxy only exposes active names, but a program
		// can still call `tools["whatever"]()` reflectively — gate here too.
		if (!isToolActive(name)) {
			reply(`Tool "${name}" is not active in this session.`, true);
			return;
		}

		const args = call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};

		try {
			const result = await dispatcher(name, args, signal);
			const flat = flattenContent(result.content ?? []);
			const { text } = capResult(flat, maxBytes);
			reply(text, Boolean(result.isError));
		} catch (err) {
			// Error isolation: a thrown dispatcher (permission denied, tool crash,
			// abort) becomes an isError result so the vm's `await tools.x()` rejects
			// for THIS call only — the pump keeps serving subsequent calls.
			const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
			recordDiagnostic({
				category: "error.isolated",
				level: "warn",
				source: "code-mode.bridge",
				context: { note: `tool=${name} callId=${callId}: ${err instanceof Error ? err.message : String(err)}` },
			});
			reply(`tool "${name}" error: ${msg}`, true);
		}
	};

	const detach = channel.onToolCall((call) => {
		// Fire-and-forget: each tool call is independent and replies by callId, so
		// concurrent in-flight calls from the same program are fine.
		void handle(call);
	});

	return {
		dispose(): void {
			if (disposed) return;
			disposed = true;
			detach();
		},
	};
}

// ── HARNESS DISPATCHER (reference wire) ──────────────────────────────────────
// The agent-session must supply a dispatcher that routes a code-mode tool call
// through the SAME pipeline as a normal model tool call. The single-tool
// executor inside `@pit/agent-core`'s agent-loop is module-private, so this
// helper reconstructs the identical pipeline ORDER from the harness primitives
// the agent-session already holds. Keep this in sync with agent-loop.ts's
// prepareToolCall → executePreparedToolCall → finalizeExecutedToolCall if that
// pipeline changes. Using this guarantees anti-bypass by construction.

/** Live harness primitives the agent-session owns, passed by reference. */
export interface HarnessDispatcherDeps {
	/** Resolve the active tool by name (the agent's tool map). */
	getTool: (name: string) => AgentTool<any> | undefined;
	/** Programmatic tool-rewrite registry (Tier 1 auto/suggest/block). */
	toolRewriteRegistry?: ToolRewriteRegistry;
	/** Post-hoc error-hint registry (Tier 4 learned-error hints). */
	toolErrorHintRegistry?: ToolErrorHintRegistry;
	/** Permission/loop gate. Block here to deny a code-mode tool call. */
	beforeToolCall?: (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
	/** Result-override hook (matches the agent loop's afterToolCall). */
	afterToolCall?: (ctx: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
	/** Current agent context (for the hook contexts). */
	getContext: () => AgentContext;
	/** The assistant message that requested the `code` call (for the hook contexts). */
	getAssistantMessage: () => AssistantMessage;
	/**
	 * Optional event sink, wired by the agent-session to the SAME handler the
	 * agent loop uses. When supplied, the dispatcher emits `tool_execution_start`
	 * before `tool.execute` and `tool_execution_end` after, mirroring the agent
	 * loop so a code-mode `tools.x()` call shows up in telemetry / extension
	 * events / the TUI exactly like a normal model tool call. Omitting it keeps
	 * the dispatcher silent (used by the bridge unit test).
	 */
	emitEvent?: (
		event: Extract<AgentEvent, { type: "tool_execution_start" | "tool_execution_end" }>,
	) => void | Promise<void>;
}

function textResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text } as TextContent], details: undefined };
}

/**
 * Build a {@link CodeModeDispatcher} that runs each code-mode tool call through
 * the harness pipeline (rewrite → permission/block → execute → error-hints →
 * afterToolCall), mirroring the agent loop. When `deps.emitEvent` is supplied it
 * also emits `tool_execution_start`/`tool_execution_end` around the call (the two
 * events the agent loop fires per tool), so code-mode's inner tool calls feed
 * telemetry, extension events and the TUI like normal calls. This is the
 * recommended value for the `code` tool's `options.code.dispatcher`.
 *
 * ── WHERE THE AGENT-SESSION CALLS THIS ──────────────────────────────────────
 * In agent-session, when assembling the coding tools' options (the `_buildRuntime`
 * path), set:
 *
 *   const dispatcher = buildHarnessDispatcher({
 *     getTool: (name) => this.agent.tools.find((t) => t.name === name),
 *     toolRewriteRegistry: this.agent.toolRewriteRegistry,
 *     toolErrorHintRegistry: this.agent.toolErrorHintRegistry,
 *     beforeToolCall: this.agent.beforeToolCall,
 *     afterToolCall: this.agent.afterToolCall,
 *     getContext: () => this.agent.state, // or the live AgentContext accessor
 *     getAssistantMessage: () => this._currentAssistantMessage, // synthetic ok
 *     emitEvent: (e) => this._handleAgentEvent(e), // same sink the agent loop uses
 *   });
 *   options.code = { dispatcher, getActiveToolNames: () => this.getActiveToolNames() };
 *
 * Also add "code" to `_defaultActiveToolNames()` so the tool is on the default
 * active surface (default-on).
 */
export function buildHarnessDispatcher(deps: HarnessDispatcherDeps): CodeModeDispatcher {
	return async (name, args, signal): Promise<CodeModeDispatchResult> => {
		const tool = deps.getTool(name);
		if (!tool) {
			return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
		}

		// Synthetic tool-call block. A fresh id per code-mode call keeps per-tool
		// abort controllers and detectors keyed correctly.
		let call: AgentToolCall = {
			type: "toolCall",
			id: `code_${uuidv7()}`,
			name,
			arguments: args,
		} as AgentToolCall;

		// Mirror the agent loop: announce the call BEFORE any gating runs, with the
		// original args. The session-wired sink records telemetry / fires extension
		// events / surfaces it in the TUI exactly like a normal model tool call.
		if (deps.emitEvent) {
			await deps.emitEvent({
				type: "tool_execution_start",
				toolCallId: call.id,
				toolName: call.name,
				args: call.arguments,
			});
		}

		// Track the result actually returned so we can mirror the agent loop's
		// `tool_execution_end` on EVERY exit path below (a gate rejection, a
		// prepareArguments throw, a block, abort, or a normal execute). Keeping
		// start/end balanced is load-bearing: the session handler records args by
		// callId on start and deletes them on end.
		let finalResult: AgentToolResult<unknown> = textResult("");
		let finalIsError = false;

		const dispatch = async (): Promise<CodeModeDispatchResult> => {
			// Tier 1: rewrite registry (auto rewrite / suggest-block).
			if (deps.toolRewriteRegistry) {
				const outcome = deps.toolRewriteRegistry.apply(call);
				if (outcome.kind === "rejected") {
					finalResult = textResult(outcome.error);
					finalIsError = true;
					return { content: [{ type: "text", text: outcome.error }], isError: true };
				}
				if (outcome.kind === "rewritten") {
					call = outcome.call;
				}
			}

			// prepareArguments shim + (validation happens inside the tool wrapper).
			let execArgs: unknown = call.arguments;
			if (tool.prepareArguments) {
				try {
					execArgs = tool.prepareArguments(call.arguments);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					finalResult = textResult(msg);
					finalIsError = true;
					return { content: [{ type: "text", text: msg }], isError: true };
				}
			}

			// Permission / loop gate.
			if (deps.beforeToolCall) {
				const before = await deps.beforeToolCall(
					{
						assistantMessage: deps.getAssistantMessage(),
						toolCall: call,
						args: execArgs,
						context: deps.getContext(),
					},
					signal,
				);
				if (signal?.aborted) {
					finalResult = textResult("Operation aborted");
					finalIsError = true;
					return { content: [{ type: "text", text: "Operation aborted" }], isError: true };
				}
				if (before?.block) {
					const reason = before.reason || "Tool execution was blocked";
					finalResult = textResult(reason);
					finalIsError = true;
					return { content: [{ type: "text", text: reason }], isError: true };
				}
			}

			// Execute the real tool.
			let result: AgentToolResult<unknown>;
			let isError = false;
			try {
				result = await tool.execute(call.id, execArgs as never, signal, undefined, undefined);
			} catch (err) {
				result = textResult(err instanceof Error ? err.message : String(err));
				isError = true;
			}

			// Tier 4: error hints (only on error, like the agent loop).
			if (isError && deps.toolErrorHintRegistry) {
				const outcome = deps.toolErrorHintRegistry.apply(call, result);
				if (outcome.hints.length > 0) {
					const hintLines = outcome.hints.map((h) => `[hint] ${h.hint}`).join("\n");
					const merged: Array<TextContent | { type: string; text?: string }> = [
						...result.content,
						{ type: "text", text: hintLines } as TextContent,
					];
					result = { ...result, content: merged as AgentToolResult<unknown>["content"] };
				}
			}

			// afterToolCall override hook.
			if (deps.afterToolCall) {
				try {
					const after = await deps.afterToolCall(
						{
							assistantMessage: deps.getAssistantMessage(),
							toolCall: call,
							args: execArgs,
							result,
							isError,
							context: deps.getContext(),
						},
						signal,
					);
					if (after) {
						if (after.content) result = { ...result, content: after.content };
						if (after.isError !== undefined) isError = after.isError;
					}
				} catch (err) {
					result = textResult(err instanceof Error ? err.message : String(err));
					isError = true;
				}
			}

			finalResult = result;
			finalIsError = isError;
			return {
				content: result.content as Array<{ type: string; text?: string }>,
				isError,
			};
		};

		try {
			return await dispatch();
		} finally {
			// Mirror the agent loop: always close with `tool_execution_end`, even on
			// an early gate rejection or abort, so every `start` is balanced.
			if (deps.emitEvent) {
				await deps.emitEvent({
					type: "tool_execution_end",
					toolCallId: call.id,
					toolName: call.name,
					result: finalResult,
					isError: finalIsError,
				});
			}
		}
	};
}
