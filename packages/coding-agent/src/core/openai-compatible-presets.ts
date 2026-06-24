/**
 * Built-in presets and helpers for logging in to OpenAI-compatible providers
 * (custom base URL + API key), alongside the native Anthropic OAuth / Codex flows.
 *
 * Presets are injected into the model registry as extra built-in models (see
 * ModelRegistry.buildModels). The API key is stored in auth.json via the normal
 * `/login` → "Use an API key" path; the baseUrl/api/model definitions live here
 * so the providers show up in `/login` and `/model` with zero config.
 *
 * Users can also add an arbitrary OpenAI-compatible endpoint at runtime via the
 * "Add OpenAI-compatible endpoint" option, which persists the provider to
 * models.json (with `login: true`, so the key is resolved from auth.json).
 */

import { existsSync, readFileSync } from "node:fs";
import type { Api, Model } from "@pit/ai";
import { writeFileAtomicSync } from "../utils/atomic-write.ts";
import { truncateWithEllipsis } from "../utils/surrogate.ts";

/** OpenAI-completions compat flags for a preset model. */
type PresetCompat = Model<Api>["compat"];

export interface OpenAICompatiblePresetModel {
	id: string;
	name: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	compat?: PresetCompat;
}

export interface OpenAICompatiblePreset {
	/** Provider id (used as the auth.json key and in `provider/model` refs). */
	id: string;
	/** Display name shown in `/login` and `/model`. */
	name: string;
	/** OpenAI-compatible base URL (no trailing slash; `/chat/completions` is appended). */
	baseUrl: string;
	/** Streaming API. Almost always "openai-completions". */
	api: Api;
	/** Documentation URL surfaced in the login dialog. */
	docsUrl?: string;
	/** Provider-level compat flags merged into every model. */
	compat?: PresetCompat;
	models: OpenAICompatiblePresetModel[];
}

/**
 * Curated, ready-to-use OpenAI-compatible providers.
 *
 * Z.ai GLM Coding Plan endpoint and model ids are confirmed from
 * https://docs.z.ai/devpack/tool/others (base URL https://api.z.ai/api/coding/paas/v4).
 * GLM reasoning models use the deepseek-style `thinking: { type }` toggle, which Zhipu's
 * OpenAI-compatible endpoint accepts; override via models.json if your plan differs.
 *
 * Verboo Code's exact base URL is not publicly documented — the value below is the
 * conventional `/v1` path. If it is wrong for your account, use "Add OpenAI-compatible
 * endpoint" with the URL from your Verboo dashboard (the probe will tell you).
 */
export const OPENAI_COMPATIBLE_PRESETS: readonly OpenAICompatiblePreset[] = [
	{
		id: "zai",
		name: "Z.ai GLM (Coding Plan)",
		baseUrl: "https://api.z.ai/api/coding/paas/v4",
		api: "openai-completions",
		docsUrl: "https://docs.z.ai/devpack/tool/others",
		models: [
			{
				id: "glm-5.2",
				name: "GLM-5.2",
				reasoning: true,
				contextWindow: 1_000_000,
				maxTokens: 65_536,
				compat: { thinkingFormat: "deepseek" } as PresetCompat,
			},
			{
				id: "glm-4.7",
				name: "GLM-4.7",
				reasoning: true,
				contextWindow: 200_000,
				maxTokens: 32_768,
				compat: { thinkingFormat: "deepseek" } as PresetCompat,
			},
			{
				id: "glm-5-turbo",
				name: "GLM-5-Turbo",
				reasoning: false,
				contextWindow: 200_000,
				maxTokens: 32_768,
			},
		],
	},
	{
		id: "verboo",
		name: "Verboo Code",
		baseUrl: "https://code.verboo.ai/v1",
		api: "openai-completions",
		docsUrl: "https://code.verboo.ai/en",
		models: [
			{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", contextWindow: 1_000_000, maxTokens: 32_768 },
			{ id: "qwen3.6-27b", name: "Qwen 3.6 27B", contextWindow: 262_000, maxTokens: 32_768 },
			{ id: "@preset/glm4-7-flash", name: "GLM-4.7 Flash", contextWindow: 202_000, maxTokens: 32_768 },
		],
	},
];

/** Provider id → display name for every preset (used by getProviderDisplayName). */
export const PRESET_PROVIDER_DISPLAY_NAMES: Record<string, string> = Object.fromEntries(
	OPENAI_COMPATIBLE_PRESETS.map((preset) => [preset.id, preset.name]),
);

const PRESET_PROVIDER_IDS: ReadonlySet<string> = new Set(OPENAI_COMPATIBLE_PRESETS.map((preset) => preset.id));

export function isPresetProviderId(providerId: string): boolean {
	return PRESET_PROVIDER_IDS.has(providerId);
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function presetModelToModel(preset: OpenAICompatiblePreset, model: OpenAICompatiblePresetModel): Model<Api> {
	return {
		id: model.id,
		name: model.name,
		api: preset.api,
		provider: preset.id,
		baseUrl: preset.baseUrl,
		reasoning: model.reasoning ?? false,
		thinkingLevelMap: undefined,
		input: model.input ?? ["text"],
		cost: ZERO_COST,
		contextWindow: model.contextWindow ?? 128_000,
		maxTokens: model.maxTokens ?? 16_384,
		headers: undefined,
		compat: mergePresetCompat(preset.compat, model.compat),
	} as Model<Api>;
}

function mergePresetCompat(providerCompat: PresetCompat, modelCompat: PresetCompat): PresetCompat {
	if (!providerCompat && !modelCompat) return undefined;
	return { ...providerCompat, ...modelCompat } as PresetCompat;
}

/**
 * Materialize every preset provider's models. Injected into the registry as
 * additional built-in models; models.json entries with the same provider/id win.
 */
export function getPresetProviderModels(): Model<Api>[] {
	const models: Model<Api>[] = [];
	for (const preset of OPENAI_COMPATIBLE_PRESETS) {
		for (const model of preset.models) {
			models.push(presetModelToModel(preset, model));
		}
	}
	return models;
}

/**
 * Curated models for EXISTING built-in providers that models.dev hasn't published
 * yet (so they're missing from models.generated.ts). The registry injects these
 * only when the same provider/id isn't already present, so each entry disappears
 * automatically once the generated catalog catches up — no stale duplicate.
 *
 * GLM-5.2 is live on the OpenCode Go endpoint today (confirmed via the opencode
 * CLI); cloned from glm-5.1@opencode-go (same endpoint and cost). The opencode
 * catalog reports a 1M context window for glm-5.2 (glm-5.1 was 200k).
 */
export const CURATED_EXTRA_MODELS: readonly Model<Api>[] = [
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		api: "openai-completions",
		provider: "opencode-go",
		baseUrl: "https://opencode.ai/zen/go/v1",
		reasoning: true,
		thinkingLevelMap: undefined,
		input: ["text"],
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		headers: undefined,
		// The glm-5.2 backend validates request fields strictly and rejects the
		// `prompt_cache_retention: "24h"` that detectCompat() auto-enables for
		// opencode.ai URLs (glm-5.1 tolerates it; glm-5.2 returns HTTP 400). Opt out.
		compat: { supportsLongCacheRetention: false },
	} as Model<Api>,
];

/** Fresh copies of the curated extras (new objects each call, like getPresetProviderModels). */
export function getCuratedExtraModels(): Model<Api>[] {
	return CURATED_EXTRA_MODELS.map((model) => ({ ...model }));
}

/** Trim and strip trailing slashes so `${base}/chat/completions` is well-formed. */
export function normalizeBaseUrl(url: string): string {
	return url.trim().replace(/\/+$/, "");
}

/**
 * Derive a stable, filesystem/ref-safe provider id from a base URL's host.
 * `takenIds` is consulted to avoid colliding with an existing provider (built-in,
 * preset, or already-configured custom) — a numeric suffix is appended on collision.
 */
export function deriveProviderIdFromBaseUrl(baseUrl: string, takenIds: ReadonlySet<string> = new Set()): string {
	let host = "custom";
	try {
		host = new URL(normalizeBaseUrl(baseUrl)).host;
	} catch {
		// Fall back to the raw string if it isn't a parseable URL.
		host = baseUrl;
	}
	const base =
		host
			.replace(/^www\./, "")
			.replace(/:\d+$/, "")
			.replace(/\.(ai|com|net|io|dev|app|co|org)$/i, "")
			.replace(/[^a-z0-9]+/gi, "-")
			.replace(/^-+|-+$/g, "")
			.toLowerCase() || "custom";

	if (!takenIds.has(base)) return base;
	for (let i = 2; i < 1000; i++) {
		const candidate = `${base}-${i}`;
		if (!takenIds.has(candidate)) return candidate;
	}
	return `${base}-${Date.now()}`;
}

export interface ProbeResult {
	/** Connection + auth verified (either /models or a chat completion succeeded). */
	ok: boolean;
	/** The endpoint explicitly rejected the API key (HTTP 401/403). */
	authRejected: boolean;
	status?: number;
	/** Human-readable line for the login dialog. */
	detail: string;
	/** Model ids returned by GET /models, when available. */
	models?: string[];
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

async function safeText(res: Response): Promise<string> {
	try {
		return (await res.text()).trim();
	} catch {
		return "";
	}
}

function truncate(text: string, max: number): string {
	return truncateWithEllipsis(text.replace(/\s+/g, " ").trim(), max);
}

async function extractModelIds(res: Response): Promise<string[]> {
	try {
		const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
		if (!Array.isArray(json.data)) return [];
		return json.data
			.map((entry) => (typeof entry?.id === "string" ? entry.id : ""))
			.filter((id): id is string => !!id);
	} catch {
		return [];
	}
}

/**
 * Probe an OpenAI-compatible endpoint to verify the base URL + API key right after
 * the user enters them. Tries `GET /models` first (cheap, no tokens), then falls
 * back to a 1-token `POST /chat/completions`. Network/timeout never throws — it is
 * reported as `ok: false`.
 */
export async function probeOpenAICompatibleConnection(opts: {
	baseUrl: string;
	apiKey: string;
	model?: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
}): Promise<ProbeResult> {
	const base = normalizeBaseUrl(opts.baseUrl);
	const timeoutMs = opts.timeoutMs ?? 12_000;
	const authHeaders: Record<string, string> = { Authorization: `Bearer ${opts.apiKey}`, ...opts.headers };

	// 1) GET /models — validates auth without spending tokens.
	let listError: string | undefined;
	try {
		const res = await fetchWithTimeout(`${base}/models`, { method: "GET", headers: authHeaders }, timeoutMs);
		if (res.status === 401 || res.status === 403) {
			return { ok: false, authRejected: true, status: res.status, detail: `API key rejected (HTTP ${res.status}).` };
		}
		if (res.ok) {
			const models = await extractModelIds(res);
			const missing =
				opts.model && models.length > 0 && !models.includes(opts.model)
					? ` Note: "${opts.model}" not in the listed models (it may still work).`
					: "";
			return {
				ok: true,
				authRejected: false,
				status: res.status,
				models,
				detail: `Connected — ${models.length} model(s) available.${missing}`,
			};
		}
		listError = `GET /models → HTTP ${res.status}`;
	} catch (error) {
		listError = error instanceof Error ? error.message : String(error);
	}

	// 2) Fallback: minimal chat completion (some endpoints don't expose /models).
	if (!opts.model) {
		return {
			ok: false,
			authRejected: false,
			detail: `Could not verify: ${listError ?? "no /models endpoint"} and no model id to test a completion.`,
		};
	}
	try {
		const res = await fetchWithTimeout(
			`${base}/chat/completions`,
			{
				method: "POST",
				headers: { ...authHeaders, "Content-Type": "application/json" },
				body: JSON.stringify({
					model: opts.model,
					messages: [{ role: "user", content: "ping" }],
					max_tokens: 1,
					stream: false,
				}),
			},
			timeoutMs,
		);
		if (res.status === 401 || res.status === 403) {
			return { ok: false, authRejected: true, status: res.status, detail: `API key rejected (HTTP ${res.status}).` };
		}
		if (res.ok) {
			return {
				ok: true,
				authRejected: false,
				status: res.status,
				detail: `Connected — chat completion succeeded for "${opts.model}".`,
			};
		}
		const body = await safeText(res);
		return {
			ok: false,
			authRejected: false,
			status: res.status,
			detail: `Endpoint reachable but returned HTTP ${res.status}: ${truncate(body, 200) || "(no body)"}`,
		};
	} catch (error) {
		return {
			ok: false,
			authRejected: false,
			detail: `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Upsert an OpenAI-compatible provider into models.json so it survives restarts.
 * The provider is written with `login: true` and no apiKey — the key is resolved
 * from auth.json (set via the normal /login api-key path). Existing comments in
 * models.json are not preserved (the file is re-serialized as plain JSON).
 */
export function persistOpenAICompatibleProviderToModelsJson(
	modelsJsonPath: string,
	providerId: string,
	config: {
		name: string;
		baseUrl: string;
		api: Api;
		models: Array<{ id: string; name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number }>;
		compat?: PresetCompat;
	},
): void {
	let root: { providers?: Record<string, unknown> } = {};
	if (existsSync(modelsJsonPath)) {
		const raw = readFileSync(modelsJsonPath, "utf-8").trim();
		if (raw) {
			try {
				root = JSON.parse(raw) as { providers?: Record<string, unknown> };
			} catch (error) {
				throw new Error(
					`models.json is not plain JSON (comments/trailing commas?); edit it manually to add "${providerId}". ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
	}

	if (typeof root !== "object" || root === null) root = {};
	if (typeof root.providers !== "object" || root.providers === null) root.providers = {};

	root.providers[providerId] = {
		name: config.name,
		baseUrl: normalizeBaseUrl(config.baseUrl),
		api: config.api,
		login: true,
		...(config.compat ? { compat: config.compat } : {}),
		models: config.models.map((model) => ({
			id: model.id,
			name: model.name ?? model.id,
			reasoning: model.reasoning ?? false,
			input: ["text"],
			cost: { ...ZERO_COST },
			contextWindow: model.contextWindow ?? 128_000,
			maxTokens: model.maxTokens ?? 16_384,
		})),
	};

	writeFileAtomicSync(modelsJsonPath, `${JSON.stringify(root, null, 2)}\n`);
}
