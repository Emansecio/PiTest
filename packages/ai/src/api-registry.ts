import { type CredentialEntry, type CredentialPool, getCredentialPool } from "./credential-pool.ts";
import { getEnvApiKeys } from "./env-api-keys.ts";
import type {
	Api,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "./types.ts";

export type ApiStreamFunction = (
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
) => AssistantMessageEventStream;

export type ApiStreamSimpleFunction = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

export interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
	api: TApi;
	stream: StreamFunction<TApi, TOptions>;
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

interface ApiProviderInternal {
	api: Api;
	stream: ApiStreamFunction;
	streamSimple: ApiStreamSimpleFunction;
}

type RegisteredApiProvider = {
	provider: ApiProviderInternal;
	sourceId?: string;
};

const apiProviderRegistry = new Map<string, RegisteredApiProvider>();

function wrapStream<TApi extends Api, TOptions extends StreamOptions>(
	api: TApi,
	stream: StreamFunction<TApi, TOptions>,
): ApiStreamFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return stream(model as Model<TApi>, context, options as TOptions);
	};
}

function wrapStreamSimple<TApi extends Api>(
	api: TApi,
	streamSimple: StreamFunction<TApi, SimpleStreamOptions>,
): ApiStreamSimpleFunction {
	return (model, context, options) => {
		if (model.api !== api) {
			throw new Error(`Mismatched api: ${model.api} expected ${api}`);
		}
		return streamSimple(model as Model<TApi>, context, options);
	};
}

export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
	provider: ApiProvider<TApi, TOptions>,
	sourceId?: string,
): void {
	apiProviderRegistry.set(provider.api, {
		provider: {
			api: provider.api,
			stream: wrapStream(provider.api, provider.stream),
			streamSimple: wrapStreamSimple(provider.api, provider.streamSimple),
		},
		sourceId,
	});
}

export function getApiProvider(api: Api): ApiProviderInternal | undefined {
	return apiProviderRegistry.get(api)?.provider;
}

export function getApiProviders(): ApiProviderInternal[] {
	return Array.from(apiProviderRegistry.values(), (entry) => entry.provider);
}

export function unregisterApiProviders(sourceId: string): void {
	for (const [api, entry] of apiProviderRegistry.entries()) {
		if (entry.sourceId === sourceId) {
			apiProviderRegistry.delete(api);
		}
	}
}

export function clearApiProviders(): void {
	apiProviderRegistry.clear();
}

/**
 * Seed the credential pool for a provider from env vars (primary +
 * round-robin extensions). Settings-sourced keys can be passed in via
 * `extra` and are appended after env entries. Idempotent — replaces all
 * entries for that provider while preserving cooldown state of known keys.
 */
export function registerProviderCredentials(
	provider: string,
	extra: CredentialEntry[] = [],
	pool: CredentialPool = getCredentialPool(),
): void {
	const envKeys = getEnvApiKeys(provider);
	const entries: CredentialEntry[] = [];
	const seen = new Set<string>();
	for (const key of envKeys) {
		if (!seen.has(key)) {
			seen.add(key);
			entries.push({ key, source: "env" });
		}
	}
	for (const e of extra) {
		if (!seen.has(e.key)) {
			seen.add(e.key);
			entries.push(e);
		}
	}
	pool.register(provider, entries);
}

/**
 * Resolve which API key to use for a provider on this call. Falls back to
 * `getEnvApiKeys()[0]` when the pool is empty (e.g. registry not seeded).
 */
export function getApiKeyFor(provider: string, sessionId?: string): string | undefined {
	const pool = getCredentialPool();
	const picked = pool.pick(provider, sessionId);
	if (picked) return picked.entry.key;
	const envKeys = getEnvApiKeys(provider);
	return envKeys[0];
}
