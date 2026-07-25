import { createRequire } from "node:module";
import type { Api, KnownProvider, Model, ModelThinkingLevel, Usage } from "./types.ts";

type ModelsCatalog = typeof import("./models.generated.ts").MODELS;

const requireModels = createRequire(import.meta.url);
const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();
let registryReady = false;

function ensureRegistry(): void {
	if (registryReady) return;
	let MODELS: ModelsCatalog;
	try {
		MODELS = (requireModels("./models.generated.js") as { MODELS: ModelsCatalog }).MODELS;
	} catch {
		MODELS = (requireModels("./models.generated.ts") as { MODELS: ModelsCatalog }).MODELS;
	}
	for (const [provider, models] of Object.entries(MODELS)) {
		const providerModels = new Map<string, Model<Api>>();
		for (const [id, model] of Object.entries(models)) {
			providerModels.set(id, model as Model<Api>);
		}
		modelRegistry.set(provider, providerModels);
	}
	registryReady = true;
}

type ModelApi<
	TProvider extends KnownProvider,
	TModelId extends keyof ModelsCatalog[TProvider],
> = ModelsCatalog[TProvider][TModelId] extends { api: infer TApi } ? (TApi extends Api ? TApi : never) : never;

export function getModel<TProvider extends KnownProvider, TModelId extends keyof ModelsCatalog[TProvider]>(
	provider: TProvider,
	modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
	ensureRegistry();
	const providerModels = modelRegistry.get(provider);
	return providerModels?.get(modelId as string) as Model<ModelApi<TProvider, TModelId>>;
}

export function getProviders(): KnownProvider[] {
	ensureRegistry();
	return Array.from(modelRegistry.keys()) as KnownProvider[];
}

export function getModels<TProvider extends KnownProvider>(
	provider: TProvider,
): Model<ModelApi<TProvider, keyof ModelsCatalog[TProvider]>>[] {
	ensureRegistry();
	const models = modelRegistry.get(provider);
	return models ? (Array.from(models.values()) as Model<ModelApi<TProvider, keyof ModelsCatalog[TProvider]>>[]) : [];
}

/**
 * Price of a LONG-retention cache write relative to the model catalog's listed
 * `cost.cacheWrite`.
 *
 * Every catalog entry carries the SHORT (default-tier) write price — Anthropic
 * bills that at 1.25x base input, which is exactly what the generated table
 * holds (e.g. claude-opus-5: input 5, cacheWrite 6.25). A 1-hour write is billed
 * at 2.0x base input instead, i.e. 2.0 / 1.25 = 1.6x the listed rate.
 *
 * This matters because the long tier is the DEFAULT for the long-lived
 * interactive session (see coding-agent `sdk.ts`), so pricing every write at the
 * listed rate under-reports real spend by ~37% on the most common configuration.
 * Providers without a long tier never report {@link Usage.cacheWriteLong}, so the
 * multiplier is inert for them.
 */
export const LONG_CACHE_WRITE_MULTIPLIER = 1.6;

export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	usage.cost.input = (model.cost.input / 1000000) * usage.input;
	usage.cost.output = (model.cost.output / 1000000) * usage.output;
	usage.cost.cacheRead = (model.cost.cacheRead / 1000000) * usage.cacheRead;
	// Clamped: a provider reporting a long slice larger than the total would
	// otherwise inflate the bill. Missing/zero => everything at the listed rate,
	// byte-identical to the pre-split behavior.
	const longWrite = Math.min(Math.max(usage.cacheWriteLong ?? 0, 0), usage.cacheWrite);
	const shortWrite = usage.cacheWrite - longWrite;
	usage.cost.cacheWrite = ((shortWrite + longWrite * LONG_CACHE_WRITE_MULTIPLIER) * model.cost.cacheWrite) / 1000000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

const EXTENDED_THINKING_LEVELS: ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
	"ultra",
];

/** Levels that only appear when the model maps them explicitly. */
const OPT_IN_THINKING_LEVELS = new Set<ModelThinkingLevel>(["xhigh", "max", "ultra"]);

export function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];

	return EXTENDED_THINKING_LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (OPT_IN_THINKING_LEVELS.has(level)) return mapped !== undefined;
		return true;
	});
}

export function clampThinkingLevel<TApi extends Api>(
	model: Model<TApi>,
	level: ModelThinkingLevel,
): ModelThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";

	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = EXTENDED_THINKING_LEVELS[i];
		if (availableLevels.includes(candidate)) return candidate;
	}
	return availableLevels[0] ?? "off";
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
