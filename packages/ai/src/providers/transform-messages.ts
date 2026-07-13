import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	if (model.input.includes("image")) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}

		return msg;
	});
}

function transformAssistantMessage<TApi extends Api>(
	msg: AssistantMessage,
	model: Model<TApi>,
	toolCallIdMap: Map<string, string>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): AssistantMessage {
	const isSameModel = msg.provider === model.provider && msg.api === model.api && msg.model === model.id;

	const transformedContent = msg.content.flatMap((block) => {
		if (block.type === "thinking") {
			if (block.redacted) {
				return isSameModel ? block : [];
			}
			if (isSameModel && block.thinkingSignature) {
				return block;
			}
			if (!block.thinking || block.thinking.trim() === "") {
				return [];
			}
			return isSameModel ? block : { type: "text" as const, text: block.thinking };
		}

		if (block.type === "text") {
			return isSameModel ? block : { type: "text" as const, text: block.text };
		}

		if (block.type === "toolCall") {
			const toolCall = block as ToolCall;
			let normalizedToolCall = toolCall;

			if (!isSameModel && toolCall.thoughtSignature) {
				normalizedToolCall = { ...toolCall };
				delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
			}

			if (!isSameModel && normalizeToolCallId) {
				const normalizedId = normalizeToolCallId(toolCall.id, model, msg);
				if (normalizedId !== toolCall.id) {
					toolCallIdMap.set(toolCall.id, normalizedId);
					normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
				}
			}

			return normalizedToolCall;
		}

		return block;
	});

	return {
		...msg,
		content: transformedContent,
	};
}

function transformToolResultMessage(msg: Message, toolCallIdMap: Map<string, string>): Message {
	if (msg.role !== "toolResult") {
		return msg;
	}
	const normalizedId = toolCallIdMap.get(msg.toolCallId);
	if (normalizedId && normalizedId !== msg.toolCallId) {
		return { ...msg, toolCallId: normalizedId };
	}
	return msg;
}

/**
 * Quick scan: return true if any first/second pass transformation would change
 * the input. When this returns false the caller can return `messages` verbatim,
 * skipping the per-message array/object spreads in the common same-model case.
 */
function needsTransformation<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId: ((id: string, model: Model<TApi>, source: AssistantMessage) => string) | undefined,
): boolean {
	const supportsImages = model.input.includes("image");
	let pendingTcIds: Set<string> | undefined;
	let resolvedIds: Set<string> | undefined;

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		if (!supportsImages) {
			if (msg.role === "user" && Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "image") return true;
				}
			} else if (msg.role === "toolResult") {
				for (const block of msg.content) {
					if (block.type === "image") return true;
				}
			}
		}

		if (msg.role === "assistant") {
			const a = msg as AssistantMessage;
			if (a.stopReason === "error" || a.stopReason === "aborted") return true;

			const isSameModel = a.provider === model.provider && a.api === model.api && a.model === model.id;

			if (pendingTcIds && resolvedIds) {
				for (const tid of pendingTcIds) {
					if (!resolvedIds.has(tid)) return true;
				}
			}

			let nextPending: Set<string> | undefined;
			for (const block of a.content) {
				if (block.type === "toolCall") {
					const tc = block as ToolCall;
					if (!isSameModel) {
						if (tc.thoughtSignature) return true;
						if (normalizeToolCallId) return true;
					}
					if (!nextPending) nextPending = new Set();
					nextPending.add(tc.id);
				} else if (block.type === "thinking") {
					if (!isSameModel) return true;
					if (!block.redacted && !block.thinkingSignature && (!block.thinking || block.thinking.trim() === "")) {
						return true;
					}
				}
			}

			pendingTcIds = nextPending;
			resolvedIds = nextPending ? new Set() : undefined;
		} else if (msg.role === "toolResult") {
			if (!pendingTcIds || !resolvedIds || !pendingTcIds.has(msg.toolCallId) || resolvedIds.has(msg.toolCallId)) {
				return true;
			}
			resolvedIds?.add(msg.toolCallId);
		} else if (msg.role === "user") {
			if (pendingTcIds && resolvedIds) {
				for (const tid of pendingTcIds) {
					if (!resolvedIds.has(tid)) return true;
				}
				pendingTcIds = undefined;
				resolvedIds = undefined;
			}
		}
	}

	if (pendingTcIds && resolvedIds) {
		for (const tid of pendingTcIds) {
			if (!resolvedIds.has(tid)) return true;
		}
	}

	return false;
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	// Fast path: same-model sessions with no orphans, errors, or images to downgrade
	// run for nearly every provider request. Skipping the two-pass allocation here
	// avoids O(N + sum(content blocks)) array/object spreads per request.
	if (!needsTransformation(messages, model, normalizeToolCallId)) {
		return messages;
	}

	// Build a map of original tool call IDs to normalized IDs
	const toolCallIdMap = new Map<string, string>();
	const imageAwareMessages = downgradeUnsupportedImages(messages, model);

	// First pass: transform messages (unsupported image downgrade, thinking blocks, tool call ID normalization)
	const transformed = imageAwareMessages.map((msg) => {
		if (msg.role === "user") {
			return msg;
		}
		if (msg.role === "toolResult") {
			return transformToolResultMessage(msg, toolCallIdMap);
		}
		if (msg.role === "assistant") {
			return transformAssistantMessage(msg as AssistantMessage, model, toolCallIdMap, normalizeToolCallId);
		}
		return msg;
	});

	// Second pass: restore valid tool-call/result batches. A live steer may have
	// been persisted while a tool was still running, between the assistant call
	// and its result. Hold such messages until matching real results arrive so the
	// provider sees the required assistant -> toolResult ordering. Only synthesize
	// results that are still missing when the batch closes.
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	let deferredMessages: Message[] = [];
	const flushPendingToolCalls = () => {
		if (pendingToolCalls.length > 0) {
			for (const tc of pendingToolCalls) {
				if (!existingToolResultIds.has(tc.id)) {
					result.push({
						role: "toolResult",
						toolCallId: tc.id,
						toolName: tc.name,
						content: [{ type: "text", text: "No result provided" }],
						isError: true,
						timestamp: Date.now(),
					} as ToolResultMessage);
				}
			}
			pendingToolCalls = [];
			existingToolResultIds = new Set();
		}
		if (deferredMessages.length > 0) {
			result.push(...deferredMessages);
			deferredMessages = [];
		}
	};

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];

		if (msg.role === "assistant") {
			// A new assistant response closes any interrupted prior tool batch.
			flushPendingToolCalls();

			// Skip errored/aborted assistant messages entirely.
			// These are incomplete turns that shouldn't be replayed:
			// - May have partial content (reasoning without message, incomplete tool calls)
			// - Replaying them can cause API errors (e.g., OpenAI "reasoning without following item")
			// - The model should retry from the last valid state
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				continue;
			}

			// Track tool calls from this assistant message
			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			const matchesPendingCall = pendingToolCalls.some((toolCall) => toolCall.id === msg.toolCallId);
			if (!matchesPendingCall || existingToolResultIds.has(msg.toolCallId)) {
				continue;
			}
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
			if (existingToolResultIds.size === pendingToolCalls.length) {
				flushPendingToolCalls();
			}
		} else if (msg.role === "user") {
			if (pendingToolCalls.length > 0) {
				deferredMessages.push(msg);
			} else {
				result.push(msg);
			}
		} else {
			if (pendingToolCalls.length > 0) {
				deferredMessages.push(msg);
			} else {
				result.push(msg);
			}
		}
	}

	// If the conversation ends with unresolved tool calls, synthesize results now.
	flushPendingToolCalls();

	return result;
}
