import type OpenAI from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseFunctionCallOutputItemList,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputText,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	StopReason,
	TextContent,
	TextSignatureV1,
	ThinkingContent,
	Tool,
	ToolCall,
	Usage,
} from "../types.ts";
import { formatDynamicPromptEnvBlock, splitSystemPromptOnDynamic, systemPromptWithoutDynamicMarker } from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { finalizeStreamingJson, parseStreamingJson } from "../utils/json-parse.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { NOOP_TOOL_NAME_GUARD, type ToolNameGuard } from "../utils/tool-name-guard.ts";
import { transformMessages } from "./transform-messages.ts";

// =============================================================================
// Utilities
// =============================================================================

/** Fresh zeroed {@link Usage} (all token counts and costs at 0). */
export function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * Build the initial assistant-message skeleton shared by every streaming
 * provider: empty content, zeroed usage, `stop` stop reason, current timestamp.
 * Pass {@link api} to override the API tag (defaults to `model.api`); providers
 * that hardcode a fixed api literal pass it explicitly.
 */
export function createInitialAssistantMessage<TApi extends Api>(
	model: Model<TApi>,
	api: Api = model.api,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * Strip transitory streaming scratch fields from a finalized content block so
 * replay never carries parser bookkeeping. Deletes the full set used across
 * providers (`index`, `partialJson`, `partialArgs`, `streamIndex`); absent
 * fields are no-ops, so this is safe to call on any block shape.
 */
export function stripStreamingScratch(block: object): void {
	delete (block as { index?: number }).index;
	delete (block as { partialJson?: string }).partialJson;
	delete (block as { partialArgs?: string }).partialArgs;
	delete (block as { streamIndex?: number }).streamIndex;
}

// Memoize parsed reasoning items per thinking block. The signature JSON is
// immutable once produced, so we can reuse the parsed object across requests
// instead of re-parsing every reasoning block on every turn. Keyed by the block
// object (WeakMap) so it never mutates the block shape / wire output and is
// reclaimed automatically when the block is GC'd.
const parsedReasoningCache = new WeakMap<ThinkingContent, ResponseReasoningItem>();

// Cache the serialized arguments string per tool-call block. Args are finalized
// during replay, so the JSON text is stable and need only be produced once.
// WeakMap (keyed by the block object) avoids adding fields to the block, so it
// can never leak into the wire payload.
const serializedToolArgsCache = new WeakMap<ToolCall, string>();

// Cache the data: URL per image block (see openai-completions.ts). base64 image
// payloads are large, immutable, and persist across turns, so build the
// concatenated data-URL once. WeakMap keyed by the block object keeps it off the
// wire shape and GC-reclaimable.
const imageDataUrlCache = new WeakMap<object, string>();

export function imageDataUrl(block: { mimeType: string; data: string }): string {
	let url = imageDataUrlCache.get(block);
	if (url === undefined) {
		url = `data:${block.mimeType};base64,${block.data}`;
		imageDataUrlCache.set(block, url);
	}
	return url;
}

function compactArgsDisabled(): boolean {
	const env = typeof process !== "undefined" ? process.env?.PIT_NO_COMPACT_ARGS : undefined;
	const flag = env?.toLowerCase();
	return flag === "1" || flag === "true" || flag === "yes";
}

/**
 * Serialize tool-call arguments for the wire. Object arguments (the common case)
 * already serialize compactly via `JSON.stringify`. Pre-serialized string
 * arguments — which can reach the wire when a tool call is replayed from a
 * persisted transcript — are re-serialized compact (whitespace dropped) when
 * they are valid JSON, and passed through untouched when they do not parse so a
 * malformed argument never breaks replay. Kill switch: `PIT_NO_COMPACT_ARGS=1`
 * restores the plain `JSON.stringify(arguments)` behavior.
 */
function compactToolArgs(args: unknown): string {
	if (typeof args === "string" && !compactArgsDisabled()) {
		try {
			return JSON.stringify(JSON.parse(args));
		} catch {
			return args;
		}
	}
	return JSON.stringify(args);
}

export function serializeToolArgs(toolCall: ToolCall): string {
	let serialized = serializedToolArgsCache.get(toolCall);
	if (serialized === undefined) {
		serialized = compactToolArgs(toolCall.arguments);
		serializedToolArgsCache.set(toolCall, serialized);
	}
	return serialized;
}

/** Providers whose tool-call ids follow the OpenAI Responses convention. */
export const RESPONSES_TOOL_CALL_PROVIDERS = new Set(["openai-codex", "opencode"]);

/** Cost multiplier applied to a response's usage based on its service tier. */
function getServiceTierCostMultiplier(
	model: Pick<Model<any>, "id">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

/**
 * Scale an already-computed {@link Usage} cost by the response's service-tier
 * multiplier in place. No-op when the multiplier is 1 (the common case).
 */
export function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Pick<Model<any>, "id">,
): void {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

/**
 * Sanitize a tool-call id to the provider-required charset and length: replace
 * any char outside `[a-zA-Z0-9_-]` with `_`, then truncate to {@link maxLen}.
 * With `stripTrailingUnderscores`, also drops trailing `_` left after truncation.
 */
export function sanitizeToolCallId(id: string, maxLen: number, opts?: { stripTrailingUnderscores?: boolean }): string {
	const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	const truncated = sanitized.length > maxLen ? sanitized.slice(0, maxLen) : sanitized;
	return opts?.stripTrailingUnderscores ? truncated.replace(/_+$/, "") : truncated;
}

function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

export interface OpenAIResponsesStreamOptions {
	/** Per-request tool-name remap; used to restore original names on tool calls. */
	toolNameGuard?: ToolNameGuard;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	resolveServiceTier?: (
		responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => ResponseCreateParamsStreaming["service_tier"] | undefined;
	applyServiceTierPricing?: (
		usage: Usage,
		serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => void;
}

export interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
}

export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
}

// =============================================================================
// Message conversion
// =============================================================================

/**
 * M1 — provider-aware prompt-cache relocation for the Responses APIs.
 *
 * The Responses APIs cache automatically by prompt prefix (with
 * prompt_cache_key/session affinity for routing). The system prompt — an
 * `input` system/developer message here, the `instructions` field on the codex
 * route — is the very first segment of that prefix, so a per-turn dynamic
 * suffix embedded in it diverges the prefix at position 0 and re-bills the
 * entire replayed history every turn. This helper moves the suffix into an
 * `<env>` block prepended to the most recent user message in `input`, keeping
 * system prompt + history a stable, cacheable prefix.
 *
 * Mutates only the freshly-built conversion output (never the caller's
 * Context) and returns the system text the caller should send: the static
 * prefix when relocation happened, otherwise the full marker-stripped prompt
 * (fallback when the payload has no user message to carry the block, or when
 * either half of the split is empty).
 */
export function applyDynamicPromptRelocation(
	input: ResponseInput,
	systemPrompt: string | undefined,
): { systemPromptText: string | undefined } {
	if (!systemPrompt) {
		return { systemPromptText: undefined };
	}
	const { staticPart, dynamicPart } = splitSystemPromptOnDynamic(systemPrompt);
	if (staticPart.length > 0 && dynamicPart.length > 0) {
		for (let i = input.length - 1; i >= 0; i--) {
			const item = input[i] as { role?: string; content?: unknown };
			// Real user messages only: tool results replay as `function_call_output`
			// items (no role) and assistant history as role "assistant"/reasoning
			// items, so role === "user" identifies exactly the user turns built by
			// convertResponsesMessages (their content is always a fresh parts array).
			if (item.role === "user" && Array.isArray(item.content)) {
				(item.content as ResponseInputContent[]).unshift({
					type: "input_text",
					text: sanitizeSurrogates(formatDynamicPromptEnvBlock(dynamicPart)),
				});
				return { systemPromptText: staticPart };
			}
		}
	}
	return { systemPromptText: systemPromptWithoutDynamicMarker(systemPrompt) };
}

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
	toolNameGuard: ToolNameGuard = NOOP_TOOL_NAME_GUARD,
): ResponseInput {
	const messages: ResponseInput = [];

	const normalizeIdPart = (part: string): string => sanitizeToolCallId(part, 64, { stripTrailingUnderscores: true });

	const buildForeignResponsesItemId = (itemId: string): string => {
		const normalized = `fc_${shortHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};

	const normalizeToolCallId = (id: string, _targetModel: Model<TApi>, source: AssistantMessage): string => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|");
		const normalizedCallId = normalizeIdPart(callId);
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
		// OpenAI Responses API requires item id to start with "fc"
		if (!normalizedItemId.startsWith("fc_")) {
			normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		}
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	const includeSystemPrompt = options?.includeSystemPrompt ?? true;
	if (includeSystemPrompt && context.systemPrompt) {
		const role = model.reasoning ? "developer" : "system";
		messages.push({
			role,
			content: sanitizeSurrogates(systemPromptWithoutDynamicMarker(context.systemPrompt)),
		});
	}

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push({
					role: "user",
					content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const content: ResponseInputContent[] = msg.content.map((item): ResponseInputContent => {
					if (item.type === "text") {
						return {
							type: "input_text",
							text: sanitizeSurrogates(item.text),
						} satisfies ResponseInputText;
					}
					return {
						type: "input_image",
						detail: "auto",
						image_url: imageDataUrl(item),
					} satisfies ResponseInputImage;
				});
				if (content.length === 0) continue;
				messages.push({
					role: "user",
					content,
				});
			}
		} else if (msg.role === "assistant") {
			const output: ResponseInput = [];
			const assistantMsg = msg as AssistantMessage;
			const isDifferentModel =
				assistantMsg.model !== model.id &&
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api;

			for (const block of msg.content) {
				if (block.type === "thinking") {
					if (block.thinkingSignature) {
						const thinkingBlock = block as ThinkingContent;
						let reasoningItem = parsedReasoningCache.get(thinkingBlock);
						if (reasoningItem === undefined) {
							reasoningItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
							parsedReasoningCache.set(thinkingBlock, reasoningItem);
						}
						output.push(reasoningItem);
					}
				} else if (block.type === "text") {
					const textBlock = block as TextContent;
					const parsedSignature = parseTextSignature(textBlock.textSignature);
					// OpenAI requires id to be max 64 characters
					let msgId = parsedSignature?.id;
					if (!msgId) {
						msgId = `msg_${msgIndex}`;
					} else if (msgId.length > 64) {
						msgId = `msg_${shortHash(msgId)}`;
					}
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
						status: "completed",
						id: msgId,
						phase: parsedSignature?.phase,
					} satisfies ResponseOutputMessage);
				} else if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					const [callId, itemIdRaw] = toolCall.id.split("|");
					let itemId: string | undefined = itemIdRaw;

					// For different-model messages, set id to undefined to avoid pairing validation.
					// OpenAI tracks which fc_xxx IDs were paired with rs_xxx reasoning items.
					// By omitting the id, we avoid triggering that validation (like cross-provider does).
					if (isDifferentModel && itemId?.startsWith("fc_")) {
						itemId = undefined;
					}

					output.push({
						type: "function_call",
						id: itemId,
						call_id: callId,
						// Replayed history: historical path keeps a removed/disconnected tool's
						// name wire-safe instead of passing it raw. See toWireHistorical.
						name: toolNameGuard.toWireHistorical(toolCall.name),
						arguments: serializeToolArgs(toolCall),
					});
				}
			}
			if (output.length === 0) continue;
			messages.push(...output);
		} else if (msg.role === "toolResult") {
			const textResult = msg.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const hasImages = msg.content.some((c): c is ImageContent => c.type === "image");
			const hasText = textResult.length > 0;
			const [callId] = msg.toolCallId.split("|");

			let output: string | ResponseFunctionCallOutputItemList;
			if (hasImages && model.input.includes("image")) {
				const contentParts: ResponseFunctionCallOutputItemList = [];

				if (hasText) {
					contentParts.push({
						type: "input_text",
						text: sanitizeSurrogates(textResult),
					});
				}

				for (const block of msg.content) {
					if (block.type === "image") {
						contentParts.push({
							type: "input_image",
							detail: "auto",
							image_url: imageDataUrl(block),
						});
					}
				}

				output = contentParts;
			} else {
				output = sanitizeSurrogates(hasText ? textResult : "(see attached image)");
			}

			messages.push({
				type: "function_call_output",
				call_id: callId,
				output,
			});
		}
		msgIndex++;
	}

	return messages;
}

// =============================================================================
// Tool conversion
// =============================================================================

export function convertResponsesTools(
	tools: Tool[],
	options?: ConvertResponsesToolsOptions,
	toolNameGuard: ToolNameGuard = NOOP_TOOL_NAME_GUARD,
): OpenAITool[] {
	const strict = options?.strict === undefined ? false : options.strict;
	return tools.map((tool) => ({
		type: "function",
		name: toolNameGuard.toWire(tool.name),
		description: tool.description,
		parameters: tool.parameters as any, // TypeBox already generates JSON Schema
		strict,
	}));
}

// =============================================================================
// Stream processing
// =============================================================================

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	let currentItem: ResponseReasoningItem | ResponseOutputMessage | ResponseFunctionToolCall | null = null;
	let currentBlock: ThinkingContent | TextContent | (ToolCall & { partialJson: string }) | null = null;
	const blocks = output.content;
	const blockIndex = () => blocks.length - 1;
	let sawTerminalEvent = false;

	for await (const event of openaiStream) {
		if (event.type === "response.created") {
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			const item = event.item;
			if (item.type === "reasoning") {
				currentItem = item;
				currentBlock = { type: "thinking", thinking: "" };
				output.content.push(currentBlock);
				stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
			} else if (item.type === "message") {
				currentItem = item;
				currentBlock = { type: "text", text: "" };
				output.content.push(currentBlock);
				stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
			} else if (item.type === "function_call") {
				currentItem = item;
				currentBlock = {
					type: "toolCall",
					id: `${item.call_id}|${item.id}`,
					name: item.name,
					arguments: {},
					partialJson: item.arguments || "",
				};
				output.content.push(currentBlock);
				stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
			}
		} else if (event.type === "response.reasoning_summary_part.added") {
			if (currentItem && currentItem.type === "reasoning") {
				currentItem.summary = currentItem.summary || [];
				currentItem.summary.push(event.part);
			}
		} else if (event.type === "response.reasoning_summary_text.delta") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
				currentItem.summary = currentItem.summary || [];
				const lastPart = currentItem.summary[currentItem.summary.length - 1];
				if (lastPart) {
					currentBlock.thinking += event.delta;
					lastPart.text += event.delta;
					stream.push({
						type: "thinking_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.reasoning_summary_part.done") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
				currentItem.summary = currentItem.summary || [];
				const lastPart = currentItem.summary[currentItem.summary.length - 1];
				if (lastPart) {
					currentBlock.thinking += "\n\n";
					lastPart.text += "\n\n";
					stream.push({
						type: "thinking_delta",
						contentIndex: blockIndex(),
						delta: "\n\n",
						partial: output,
					});
				}
			}
		} else if (event.type === "response.reasoning_text.delta") {
			if (currentItem?.type === "reasoning" && currentBlock?.type === "thinking") {
				currentBlock.thinking += event.delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: blockIndex(),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.content_part.added") {
			if (currentItem?.type === "message") {
				currentItem.content = currentItem.content || [];
				// Filter out ReasoningText, only accept output_text and refusal
				if (event.part.type === "output_text" || event.part.type === "refusal") {
					currentItem.content.push(event.part);
				}
			}
		} else if (event.type === "response.output_text.delta") {
			if (currentItem?.type === "message" && currentBlock?.type === "text") {
				if (!currentItem.content || currentItem.content.length === 0) {
					continue;
				}
				const lastPart = currentItem.content[currentItem.content.length - 1];
				if (lastPart?.type === "output_text") {
					currentBlock.text += event.delta;
					lastPart.text += event.delta;
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.refusal.delta") {
			if (currentItem?.type === "message" && currentBlock?.type === "text") {
				if (!currentItem.content || currentItem.content.length === 0) {
					continue;
				}
				const lastPart = currentItem.content[currentItem.content.length - 1];
				if (lastPart?.type === "refusal") {
					currentBlock.text += event.delta;
					lastPart.refusal += event.delta;
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta: event.delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.function_call_arguments.delta") {
			if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
				// Accumulate only — finalize once on response.function_call_arguments.done.
				// Per-delta parseStreamingJson over growing string is O(N²).
				currentBlock.partialJson += event.delta;
				stream.push({
					type: "toolcall_delta",
					contentIndex: blockIndex(),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.function_call_arguments.done") {
			if (currentItem?.type === "function_call" && currentBlock?.type === "toolCall") {
				const previousPartialJson = currentBlock.partialJson;
				currentBlock.partialJson = event.arguments;
				currentBlock.arguments = parseStreamingJson(currentBlock.partialJson);

				if (event.arguments.startsWith(previousPartialJson)) {
					const delta = event.arguments.slice(previousPartialJson.length);
					if (delta.length > 0) {
						stream.push({
							type: "toolcall_delta",
							contentIndex: blockIndex(),
							delta,
							partial: output,
						});
					}
				}
			}
		} else if (event.type === "response.output_item.done") {
			const item = event.item;

			if (item.type === "reasoning" && currentBlock?.type === "thinking") {
				const summaryText = item.summary?.map((s) => s.text).join("\n\n") || "";
				const contentText = item.content?.map((c) => c.text).join("\n\n") || "";
				currentBlock.thinking = summaryText || contentText || currentBlock.thinking;
				currentBlock.thinkingSignature = JSON.stringify(item);
				stream.push({
					type: "thinking_end",
					contentIndex: blockIndex(),
					content: currentBlock.thinking,
					partial: output,
				});
				currentBlock = null;
			} else if (item.type === "message" && currentBlock?.type === "text") {
				currentBlock.text = (item.content ?? [])
					.map((c) => (c.type === "output_text" ? c.text : c.refusal))
					.join("");
				currentBlock.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				stream.push({
					type: "text_end",
					contentIndex: blockIndex(),
					content: currentBlock.text,
					partial: output,
				});
				currentBlock = null;
			} else if (item.type === "function_call") {
				const finalizeSource =
					currentBlock?.type === "toolCall" && currentBlock.partialJson
						? currentBlock.partialJson
						: item.arguments || "{}";
				const finalized = finalizeStreamingJson(finalizeSource);
				const args = finalized.value;
				const guard = options?.toolNameGuard;

				let toolCall: ToolCall;
				if (currentBlock?.type === "toolCall") {
					// Finalize in-place and strip the scratch buffer so replay only
					// carries parsed arguments.
					currentBlock.arguments = args;
					if (finalized.parseError && finalizeSource.length > 2) {
						(currentBlock as any)._streamingParseError = true;
					}
					delete (currentBlock as { partialJson?: string }).partialJson;
					// Restore the caller's original tool name from the sanitized wire name.
					if (guard?.active) {
						currentBlock.name = guard.fromWire(currentBlock.name);
					}
					toolCall = currentBlock;
				} else {
					toolCall = {
						type: "toolCall",
						id: `${item.call_id}|${item.id}`,
						name: guard?.active ? guard.fromWire(item.name) : item.name,
						arguments: args,
					};
				}

				currentBlock = null;
				stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
			}
		} else if (event.type === "response.completed") {
			sawTerminalEvent = true;
			const response = event.response;
			if (response?.id) {
				output.responseId = response.id;
			}
			if (response?.usage) {
				const cachedTokens = response.usage.input_tokens_details?.cached_tokens || 0;
				output.usage = {
					// OpenAI includes cached tokens in input_tokens, so subtract to get non-cached input
					input: (response.usage.input_tokens || 0) - cachedTokens,
					output: response.usage.output_tokens || 0,
					cacheRead: cachedTokens,
					cacheWrite: 0,
					totalTokens: response.usage.total_tokens || 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
			}
			calculateCost(model, output.usage);
			if (options?.applyServiceTierPricing) {
				const serviceTier = options.resolveServiceTier
					? options.resolveServiceTier(response?.service_tier, options.serviceTier)
					: (response?.service_tier ?? options.serviceTier);
				options.applyServiceTierPricing(output.usage, serviceTier);
			}
			// Map status to stop reason
			output.stopReason = mapStopReason(response?.status);
			if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
				output.stopReason = "toolUse";
			}
		} else if (event.type === "error") {
			throw new Error(`Error Code ${event.code}: ${event.message}`);
		} else if (event.type === "response.failed") {
			sawTerminalEvent = true;
			const error = event.response?.error;
			const details = event.response?.incomplete_details;
			let msg: string;
			if (error) {
				msg = `${error.code || "unknown"}: ${error.message || "no message"}`;
			} else if (details?.reason) {
				msg = `incomplete: ${details.reason}`;
			} else {
				msg = "Unknown error (no error details in response)";
			}
			throw new Error(msg);
		}
	}

	if (!sawTerminalEvent) {
		throw new Error("Stream ended without response.completed");
	}
}

function mapStopReason(status: OpenAI.Responses.ResponseStatus | undefined): StopReason {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		// These two are wonky ...
		case "in_progress":
		case "queued":
			return "stop";
		// `status` is server-supplied at runtime; a forward-compat lifecycle
		// state outside the SDK union must degrade gracefully, not throw.
		default:
			return "stop";
	}
}
