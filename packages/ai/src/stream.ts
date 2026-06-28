import { getApiProvider } from "./api-registry.ts";
import { type CredentialFailureReason, getCredentialPool } from "./credential-pool.ts";
import { registerBuiltInApiProviders } from "./providers/register-builtins.ts";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	ProviderStreamOptions,
	SimpleStreamOptions,
	StreamOptions,
} from "./types.ts";

export { getEnvApiKey } from "./env-api-keys.ts";

registerBuiltInApiProviders();

/**
 * Classify a provider error so the credential pool can cool down or
 * sideline the key that produced it. Returns `undefined` when the error
 * doesn't justify pool action (e.g. transport blip, validation error).
 *
 * Heuristic — providers vary, but most surface status / type fields.
 */
export function classifyCredentialError(err: unknown): CredentialFailureReason | undefined {
	if (!err || typeof err !== "object") return undefined;
	const e = err as Record<string, unknown>;
	const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : undefined;
	if (status === 429) return "rate-limit";
	if (status === 401 || status === 403) return "auth";
	const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
	if (message.includes("rate limit") || message.includes("rate_limit") || message.includes("too many requests")) {
		return "rate-limit";
	}
	if (message.includes("invalid api key") || message.includes("authentication") || message.includes("unauthorized")) {
		return "auth";
	}
	return undefined;
}

/**
 * Report a provider call failure tied to a specific API key so the pool
 * can rotate / cooldown. No-op when `apiKey` is missing or the error
 * doesn't classify as a credential issue.
 */
export function reportCredentialFailure(provider: string, apiKey: string | undefined, err: unknown): void {
	if (!apiKey) return;
	const reason = classifyCredentialError(err);
	if (!reason) return;
	getCredentialPool().markFailure(provider, apiKey, reason);
}

/**
 * Report a successful call so consecutive-failure tracking resets.
 */
export function reportCredentialSuccess(provider: string, apiKey: string | undefined): void {
	if (!apiKey) return;
	getCredentialPool().markSuccess(provider, apiKey);
}

function resolveApiProvider(api: Api) {
	const provider = getApiProvider(api);
	if (!provider) {
		throw new Error(`No API provider registered for api: ${api}`);
	}
	return provider;
}

export function stream<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	return provider.stream(model, context, options as StreamOptions);
}

export async function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
	const s = stream(model, context, options);
	return s.result();
}

export function streamSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const provider = resolveApiProvider(model.api);
	return provider.streamSimple(model, context, options);
}

export async function completeSimple<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const s = streamSimple(model, context, options);
	return s.result();
}
