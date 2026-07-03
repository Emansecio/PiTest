import OpenAI from "openai";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { getEnvApiKey } from "../env-api-keys.ts";
import { clampThinkingLevel } from "../models.ts";
import type {
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	OpenAIResponsesCompat,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "../types.ts";
import { createClientCache } from "../utils/client-cache.ts";
import { type ConnectGuard, createConnectGuard } from "../utils/connect-guard.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { iterateWithIdleTimeout } from "../utils/idle-timeout.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { resolveStreamTimeouts } from "../utils/stream-timeouts.ts";
import { isCloudflareProvider, resolveCloudflareBaseUrl } from "./cloudflare.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
	applyDynamicPromptRelocation,
	applyServiceTierPricing,
	convertResponsesMessages,
	convertResponsesTools,
	createInitialAssistantMessage,
	processResponsesStream,
	RESPONSES_TOOL_CALL_PROVIDERS,
	stripStreamingScratch,
} from "./openai-responses-shared.ts";
import { buildBaseOptions, resolveCacheRetention } from "./simple-options.ts";

function getCompat(model: Model<"openai-responses">): Required<OpenAIResponsesCompat> {
	return {
		sendSessionIdHeader: model.compat?.sendSessionIdHeader ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
	};
}

function getPromptCacheRetention(
	compat: Required<OpenAIResponsesCompat>,
	cacheRetention: CacheRetention,
): "24h" | undefined {
	return cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : undefined;
}

function formatOpenAIResponsesError(error: unknown): string {
	if (error instanceof Error) {
		const status = (error as Error & { status?: unknown }).status;
		const statusCode = typeof status === "number" ? status : undefined;
		if (statusCode !== undefined) {
			return `OpenAI API error (${statusCode}): ${error.message}`;
		}
		return error.message;
	}
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
}

/**
 * Generate function for OpenAI Responses API
 */
export const streamOpenAIResponses: StreamFunction<"openai-responses", OpenAIResponsesOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// Start async processing
	(async () => {
		const output: AssistantMessage = createInitialAssistantMessage(model);
		let connectGuard: ConnectGuard | undefined;

		try {
			// Create OpenAI client
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const cacheRetention = resolveCacheRetention(options?.cacheRetention);
			const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;
			const client = createClient(model, apiKey, options?.headers, cacheSessionId);
			let params = buildParams(model, context, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as ResponseCreateParamsStreaming;
			}
			// Guard the connect-phase await (time-to-headers + SDK retry/backoff) so a
			// frozen connect can't wedge the turn past a user interrupt. See
			// connect-guard.ts; the body loop is covered by iterateWithIdleTimeout.
			const timeouts = resolveStreamTimeouts(options);
			connectGuard = createConnectGuard(options?.signal, timeouts.connectTimeoutMs);
			const requestOptions = {
				signal: connectGuard.signal,
				...(timeouts.requestTimeoutMs !== undefined ? { timeout: timeouts.requestTimeoutMs } : {}),
				...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
			};
			const { data: openaiStream, response } = await connectGuard.settle(
				client.responses.create(params, requestOptions).withResponse(),
			);
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			await processResponsesStream(
				iterateWithIdleTimeout(openaiStream, {
					idleMs: timeouts.idleTimeoutMs,
					signal: connectGuard.signal,
				}),
				output,
				stream,
				model,
				{
					serviceTier: options?.serviceTier,
					applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
				},
			);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				stripStreamingScratch(block);
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatOpenAIResponsesError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		} finally {
			connectGuard?.dispose();
		}
	})();

	return stream;
};

export const streamSimpleOpenAIResponses: StreamFunction<"openai-responses", SimpleStreamOptions> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return streamOpenAIResponses(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAIResponsesOptions);
};

// Reuse OpenAI SDK clients across turns to keep the HTTP connection pool alive.
// Keyed by full config (apiKey + baseURL + headers) so credentials/headers are never stale.
const clientCache = createClientCache<OpenAI>();

/** Test-only: clear the client cache so fetch mocks do not leak across cases. */
export function __resetOpenAIResponsesClientCacheForTests(): void {
	clientCache.clear();
}

function createClient(
	model: Model<"openai-responses">,
	apiKey?: string,
	optionsHeaders?: Record<string, string>,
	sessionId?: string,
) {
	if (!apiKey) {
		if (!process.env.OPENAI_API_KEY) {
			throw new Error(
				"OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = process.env.OPENAI_API_KEY;
	}

	const compat = getCompat(model);
	const headers = { ...model.headers };

	if (sessionId) {
		if (compat.sendSessionIdHeader) {
			headers.session_id = sessionId;
		}
		headers["x-client-request-id"] = sessionId;
	}

	// Merge options headers last so they can override defaults
	if (optionsHeaders) {
		Object.assign(headers, optionsHeaders);
	}

	const defaultHeaders =
		model.provider === "cloudflare-ai-gateway"
			? {
					...headers,
					Authorization: headers.Authorization ?? null,
					"cf-aig-authorization": `Bearer ${apiKey}`,
				}
			: headers;

	const config = {
		apiKey,
		baseURL: isCloudflareProvider(model.provider) ? resolveCloudflareBaseUrl(model) : model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders,
	};
	return clientCache.getOrCreate(config, () => new OpenAI(config));
}

function buildParams(model: Model<"openai-responses">, context: Context, options?: OpenAIResponsesOptions) {
	const messages = convertResponsesMessages(model, context, RESPONSES_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: false,
	});
	// Keep the system/developer message byte-stable across turns so the
	// automatic prefix cache covers it plus the whole replayed history; the
	// per-turn dynamic suffix rides the newest user message instead. See
	// applyDynamicPromptRelocation (M1).
	const { systemPromptText } = applyDynamicPromptRelocation(messages, context.systemPrompt);
	if (systemPromptText) {
		messages.unshift({
			role: model.reasoning ? "developer" : "system",
			content: sanitizeSurrogates(systemPromptText),
		});
	}

	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const compat = getCompat(model);
	const params: ResponseCreateParamsStreaming = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? undefined : clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
		store: false,
	};

	if (options?.maxTokens) {
		params.max_output_tokens = options?.maxTokens;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (options?.serviceTier !== undefined) {
		params.service_tier = options.serviceTier;
	}

	if (context.tools && context.tools.length > 0) {
		params.tools = convertResponsesTools(context.tools);
	}

	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary) {
			const effort = options?.reasoningEffort
				? (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort)
				: "medium";
			params.reasoning = {
				effort: effort as NonNullable<typeof params.reasoning>["effort"],
				summary: options?.reasoningSummary || "auto",
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.thinkingLevelMap?.off !== null) {
			params.reasoning = {
				effort: (model.thinkingLevelMap?.off ?? "none") as NonNullable<typeof params.reasoning>["effort"],
			};
		}
	}

	return params;
}
