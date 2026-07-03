import type { AgentTool, AgentToolResult } from "@pit/agent-core";
import { estimateTextTokens, formatDeferredOutputPlaceholder } from "../compaction/compaction.ts";
import { getCurrentDeferredOutputStore } from "../deferred-output-store.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import {
	ERROR_TEXT_CAP_BYTES,
	formatSize,
	TOOL_OUTPUT_HARD_CAP_BYTES,
	truncateHead,
	truncateHeadTail,
} from "./truncate.ts";

/**
 * Per-definition override for the generic output cap.
 * - `maxBytes`: ceiling for this tool's text blocks (replaces the 64KB default).
 * - `mode`: "headTail" (the net default) keeps the first AND last bytes, eliding
 *   only the middle, so a recalled/deferred output never loses its tail
 *   (error/stack/final status); "head" opts back into first-bytes-only for tools
 *   that genuinely only care about the start.
 *
 * Opt-in is structural: a definition object may carry an `outputCap` field without
 * the shared `ToolDefinition` interface declaring it, so a tool can raise the
 * ceiling (recall's 256KB) without every other tool needing to know about it.
 */
export interface OutputCapConfig {
	maxBytes: number;
	mode: "head" | "headTail";
}

/** Definitions may opt into a custom output cap by carrying this field. */
type WithOutputCap = { outputCap?: OutputCapConfig };

/**
 * Fields `wrapToolDefinition` passes through onto the returned AgentTool, beyond
 * the formal AgentTool shape, purely so a later `createToolDefinitionFromAgentTool`
 * round-trip (the SDK's `baseToolsOverride` path, see agent-session.ts) can
 * recover them instead of silently reverting to the default 64KB head+tail cap
 * or the default "action" activity grouping. Not part of the public AgentTool
 * contract — read defensively, never assumed present.
 */
interface ToolPassthrough {
	outputCap?: OutputCapConfig;
	activity?: ToolDefinition["activity"];
}

/**
 * Attach a custom output cap to a tool definition (opt-in to {@link capToolOutputBytes}).
 * Returns the same definition typed with the extra field so call sites stay clean
 * and the shared ToolDefinition interface does not need to know about it.
 */
export function withOutputCap<T extends ToolDefinition<any, any>>(definition: T, cap: OutputCapConfig): T {
	return Object.assign(definition, { outputCap: cap });
}

/**
 * On a cut, persist the FULL original block text to the session's deferred-output
 * store and return the recall placeholder to append to the truncation marker — so
 * the elided middle/tail stays recoverable in full via `recall_tool_output`. This
 * unifies the recovery path for every tool with no spill of its own (extensions,
 * MCP returns, eval/debug tails): what the net drops is no longer lost.
 *
 * Uses the SAME store accessor and placeholder emitter as compaction's
 * `pruneOldToolOutputs`, so recall ids from the live net and from compaction share
 * one namespace. Returns "" (no placeholder) when there is no current store
 * (contexts outside a session, e.g. tests) or the store write threw — mirrors
 * pruneOldToolOutputs: a spill failure degrades to the inline excerpt, it never
 * aborts the tool.
 */
function deferFullOutput(fullText: string): string {
	const store = getCurrentDeferredOutputStore();
	if (!store) return "";
	let id: string | undefined;
	try {
		id = store.put(fullText);
	} catch {
		return "";
	}
	return `\n${formatDeferredOutputPlaceholder(estimateTextTokens(fullText, true), id)}`;
}

/**
 * Safety net: cap any text block in a tool result that exceeds the cap. By default
 * this is TOOL_OUTPUT_HARD_CAP_BYTES (64KB) applied HEAD+TAIL and uniformly to
 * every wrapped tool, so a tool with no truncation of its own (many extensions,
 * some MCP returns) can never flood the context AND never loses its decisive tail
 * (error/stack/final status) to a head-only cut. The default ceiling sits above
 * the 50KB per-tool cap, so tools that already truncate keep their own (more
 * specific) note untouched.
 *
 * Whenever a cut happens the full original text is spilled to the deferred-output
 * store and a `recall_tool_output` placeholder is appended (see
 * {@link deferFullOutput}), so nothing the net elides is unrecoverable.
 *
 * A definition may carry an `outputCap` override (see {@link withOutputCap}) to
 * raise the ceiling (recall's 256KB) or opt back into head-only truncation.
 */
function capToolOutputBytes<TDetails>(
	result: AgentToolResult<TDetails>,
	cap?: OutputCapConfig,
): AgentToolResult<TDetails> {
	const content = result?.content;
	if (!Array.isArray(content)) return result;
	const maxBytes = cap?.maxBytes ?? TOOL_OUTPUT_HARD_CAP_BYTES;
	const mode = cap?.mode ?? "headTail";
	let changed = false;
	const capped = content.map((block) => {
		if (block.type !== "text" || typeof block.text !== "string") return block;
		if (mode === "headTail") {
			// Keep head AND tail within the dedicated cap, eliding only the middle.
			const ht = truncateHeadTail(block.text, { maxBytes });
			if (!ht.truncated) return block;
			changed = true;
			const recall = deferFullOutput(block.text);
			return {
				...block,
				text: `${ht.content}\n\n[tool output exceeded ${formatSize(maxBytes)}; kept head + tail (${ht.totalLines} lines total)]${recall}`,
			};
		}
		// Byte-only head ceiling: pass maxLines=Infinity so tools that legitimately
		// return many lines (e.g. `read` showing its own 2000-line page) are never
		// re-cut by the default line limit — this net is purely about raw bytes.
		const truncation = truncateHead(block.text, {
			maxBytes,
			maxLines: Number.POSITIVE_INFINITY,
		});
		if (!truncation.truncated) return block;
		changed = true;
		const recall = deferFullOutput(block.text);
		return {
			...block,
			text: `${truncation.content}\n\n[tool output exceeded ${formatSize(maxBytes)} and was truncated (${truncation.totalLines} lines total)]${recall}`,
		};
	});
	return changed ? { ...result, content: capped } : result;
}

/**
 * Mirror of {@link capToolOutputBytes} for a THROWN error: the safety net above
 * only runs on a resolved result, so a tool whose `execute` throws instead of
 * returning `isError: true` bypassed every cap — an oversized error message
 * (huge stack, echoed input) reached the model completely uncapped.
 *
 * Unlike the result cap, errors get a dedicated, deliberately tight budget
 * (ERROR_TEXT_CAP_BYTES, 16KB) regardless of any per-tool `outputCap`: a
 * raised result ceiling (e.g. recall's 256KB) signals valuable OUTPUT, not
 * license for a 256KB error. Applied head+tail because an error's decisive
 * signal sits at both ends (the message's opening line, the final stack
 * frames). Only the agent loop's `err.message` read reaches the model, so the
 * message is capped IN PLACE on the original error — type (subclasses), extra
 * properties (`code`, …) and the stack all survive for local debugging.
 */
function capThrownError(err: unknown): Error {
	const original = err instanceof Error ? err : new Error(String(err));
	const ht = truncateHeadTail(original.message, { maxBytes: ERROR_TEXT_CAP_BYTES });
	if (!ht.truncated) return original;
	const capped = `${ht.content}\n\n[error text exceeded ${formatSize(ERROR_TEXT_CAP_BYTES)}; kept head + tail]`;
	try {
		original.message = capped;
		return original;
	} catch {
		// `message` can be a throwing setter on exotic custom errors — fall back
		// to a fresh Error carrying the capped text and the original stack.
		const fallback = new Error(capped);
		fallback.stack = original.stack;
		return fallback;
	}
}

/**
 * Wrap a ToolDefinition into an AgentTool for the core runtime.
 *
 * The declared return type stays `AgentTool<any, TDetails>` (not widened with
 * `& ToolPassthrough`) deliberately: every `create*Tool()` across the registry
 * assigns this call's result to a schema-specific `AgentTool<SomeSchema, ...>`,
 * which relies on TypeScript's "same generic reference, compare type arguments"
 * fast path to accept `TParams=any`. An intersection return type forces full
 * structural expansion instead, which breaks that assignability everywhere
 * (`prepareArguments`'s `Static<any>` resolves to a function returning
 * `unknown`, not `any`, once expanded). `outputCap`/`activity` are instead
 * attached to the returned object at runtime only, exactly like
 * {@link withOutputCap} does for a `ToolDefinition` — invisible to the type
 * checker, recoverable at runtime by `createToolDefinitionFromAgentTool`.
 */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: () => ExtensionContext,
): AgentTool<any, TDetails> {
	const outputCap = (definition as WithOutputCap).outputCap;
	const activity = definition.activity;
	const tool: AgentTool<any, TDetails> = {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => {
			try {
				return capToolOutputBytes(
					await definition.execute(toolCallId, params, signal, onUpdate, ctxFactory?.() as ExtensionContext),
					outputCap,
				);
			} catch (err) {
				throw capThrownError(err);
			}
		},
	};
	const passthrough: ToolPassthrough = {};
	if (outputCap) passthrough.outputCap = outputCap;
	if (activity !== undefined) passthrough.activity = activity;
	return Object.assign(tool, passthrough);
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: () => ExtensionContext,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	// `tool` may carry `outputCap`/`activity` passthrough fields attached by
	// wrapToolDefinition (see ToolPassthrough) even though the formal AgentTool
	// type does not declare them — recover them here so a base-tool override
	// round-tripped through this function keeps its cap/activity instead of
	// silently reverting to the 64KB head+tail / default-action behavior.
	const passthrough = tool as AgentTool<any> & ToolPassthrough;
	const definition: ToolDefinition<any, unknown> = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		activity: passthrough.activity,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
	return passthrough.outputCap ? withOutputCap(definition, passthrough.outputCap) : definition;
}
