// NEVER convert to top-level imports - breaks browser/Vite builds
let _existsSync: typeof import("node:fs").existsSync | null = null;
let _homedir: typeof import("node:os").homedir | null = null;
let _join: typeof import("node:path").join | null = null;

type DynamicImport = (specifier: string) => Promise<unknown>;

const dynamicImport: DynamicImport = (specifier) => import(specifier);
const NODE_FS_SPECIFIER = "node:" + "fs";
const NODE_OS_SPECIFIER = "node:" + "os";
const NODE_PATH_SPECIFIER = "node:" + "path";

// Eagerly load in Node.js/Bun environment only
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	dynamicImport(NODE_FS_SPECIFIER).then((m) => {
		_existsSync = (m as typeof import("node:fs")).existsSync;
	});
	dynamicImport(NODE_OS_SPECIFIER).then((m) => {
		_homedir = (m as typeof import("node:os")).homedir;
	});
	dynamicImport(NODE_PATH_SPECIFIER).then((m) => {
		_join = (m as typeof import("node:path")).join;
	});
}

import type { KnownProvider } from "./types.ts";

let _procEnvCache: Map<string, string> | null = null;

/**
 * Fallback for https://github.com/oven-sh/bun/issues/27802
 * Bun compiled binaries have an empty `process.env` inside sandbox
 * environments on Linux. We can recover the env from `/proc/self/environ`.
 */
function getProcEnv(key: string): string | undefined {
	if (!process.versions?.bun) return undefined;
	if (typeof process === "undefined") return undefined;

	// If process.env already has entries, the bug is not triggered.
	if (Object.keys(process.env).length > 0) return undefined;

	if (_procEnvCache === null) {
		_procEnvCache = new Map();
		try {
			const { readFileSync } = require("node:fs") as typeof import("node:fs");
			const data = readFileSync("/proc/self/environ", "utf-8");
			for (const entry of data.split("\0")) {
				const idx = entry.indexOf("=");
				if (idx > 0) {
					_procEnvCache.set(entry.slice(0, idx), entry.slice(idx + 1));
				}
			}
		} catch {
			// /proc/self/environ may not be readable.
		}
	}

	return _procEnvCache.get(key);
}

let cachedVertexAdcCredentialsExists: boolean | null = null;

function hasVertexAdcCredentials(): boolean {
	if (cachedVertexAdcCredentialsExists === null) {
		// If node modules haven't loaded yet (async import race at startup),
		// return false WITHOUT caching so the next call retries once they're ready.
		// Only cache false permanently in a browser environment where fs is never available.
		if (!_existsSync || !_homedir || !_join) {
			const isNode = typeof process !== "undefined" && (process.versions?.node || process.versions?.bun);
			if (!isNode) {
				// Definitively in a browser — safe to cache false permanently
				cachedVertexAdcCredentialsExists = false;
			}
			return false;
		}

		// Check GOOGLE_APPLICATION_CREDENTIALS env var first (standard way)
		const gacPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || getProcEnv("GOOGLE_APPLICATION_CREDENTIALS");
		if (gacPath) {
			cachedVertexAdcCredentialsExists = _existsSync(gacPath);
		} else {
			// Fall back to default ADC path (lazy evaluation)
			cachedVertexAdcCredentialsExists = _existsSync(
				_join(_homedir(), ".config", "gcloud", "application_default_credentials.json"),
			);
		}
	}
	return cachedVertexAdcCredentialsExists;
}

function getApiKeyEnvVars(provider: string): readonly string[] | undefined {
	// ANTHROPIC_OAUTH_TOKEN takes precedence over ANTHROPIC_API_KEY
	if (provider === "anthropic") {
		return ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];
	}

	const envMap: Record<string, string> = {
		openai: "OPENAI_API_KEY",
		google: "GEMINI_API_KEY",
		"google-vertex": "GOOGLE_CLOUD_API_KEY",
		xai: "XAI_API_KEY",
		openrouter: "OPENROUTER_API_KEY",
		"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
		zai: "ZAI_API_KEY",
		minimax: "MINIMAX_API_KEY",
		opencode: "OPENCODE_API_KEY",
		"opencode-go": "OPENCODE_API_KEY",
		"kimi-coding": "KIMI_API_KEY",
		xiaomi: "XIAOMI_API_KEY",
		"xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
		"xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
		"xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	};

	const envVar = envMap[provider];
	return envVar ? [envVar] : undefined;
}

/**
 * Find configured environment variables that can provide an API key for a provider.
 *
 * This only reports actual API key variables. It intentionally excludes ambient
 * credential sources such as AWS profiles, AWS IAM credentials, and Google
 * Application Default Credentials.
 */
export function findEnvKeys(provider: KnownProvider): string[] | undefined;
export function findEnvKeys(provider: string): string[] | undefined;
export function findEnvKeys(provider: string): string[] | undefined {
	const envVars = getApiKeyEnvVars(provider);
	if (!envVars) return undefined;

	const found = envVars.filter((envVar) => !!process.env[envVar] || !!getProcEnv(envVar));
	return found.length > 0 ? found : undefined;
}

/**
 * Read a single env var, falling back to the proc-env recovery path.
 */
function readEnv(name: string): string | undefined {
	return process.env[name] || getProcEnv(name);
}

/**
 * Collect every configured API key for a provider, including round-robin
 * extensions of the form `<VAR>_1`, `<VAR>_2`, ..., `<VAR>_N`.
 *
 * Order: the primary env var (first listed) comes first, followed by its
 * numbered extensions in numeric order. Subsequent base env vars (and their
 * own numbered extensions) follow. Duplicate values are de-duplicated while
 * preserving first occurrence.
 *
 * Will not include ambient credentials (AWS profiles, Vertex ADC) — for
 * those use `getEnvApiKey()` which still returns the `<authenticated>`
 * sentinel.
 */
export function getEnvApiKeys(provider: KnownProvider): string[];
export function getEnvApiKeys(provider: string): string[];
export function getEnvApiKeys(provider: string): string[] {
	const envVars = getApiKeyEnvVars(provider);
	if (!envVars) return [];

	const seen = new Set<string>();
	const out: string[] = [];
	for (const base of envVars) {
		const primary = readEnv(base);
		if (primary && !seen.has(primary)) {
			seen.add(primary);
			out.push(primary);
		}
		// Numbered extensions: BASE_1, BASE_2, ... in order until first gap.
		// We allow gaps up to a small bound so misnumbered configs still work.
		const MAX_GAP = 4;
		let gap = 0;
		for (let i = 1; gap <= MAX_GAP; i++) {
			const extra = readEnv(`${base}_${i}`);
			if (extra) {
				gap = 0;
				if (!seen.has(extra)) {
					seen.add(extra);
					out.push(extra);
				}
			} else {
				gap++;
			}
			// Hard upper bound to avoid scanning forever on hostile env.
			if (i > 64) break;
		}
	}
	return out;
}

/**
 * Get API key for provider from known environment variables, e.g. OPENAI_API_KEY.
 *
 * Will not return API keys for providers that require OAuth tokens.
 */
export function getEnvApiKey(provider: KnownProvider): string | undefined;
export function getEnvApiKey(provider: string): string | undefined;
export function getEnvApiKey(provider: string): string | undefined {
	const keys = getEnvApiKeys(provider);
	if (keys[0]) {
		return keys[0];
	}
	const envKeys = findEnvKeys(provider);
	if (envKeys?.[0]) {
		return readEnv(envKeys[0]);
	}

	// Vertex AI supports either an explicit API key or Application Default Credentials.
	// Auth is configured via `gcloud auth application-default login`.
	if (provider === "google-vertex") {
		const hasCredentials = hasVertexAdcCredentials();
		const hasProject = !!(
			process.env.GOOGLE_CLOUD_PROJECT ||
			process.env.GCLOUD_PROJECT ||
			getProcEnv("GOOGLE_CLOUD_PROJECT") ||
			getProcEnv("GCLOUD_PROJECT")
		);
		const hasLocation = !!(process.env.GOOGLE_CLOUD_LOCATION || getProcEnv("GOOGLE_CLOUD_LOCATION"));

		if (hasCredentials && hasProject && hasLocation) {
			return "<authenticated>";
		}
	}

	return undefined;
}
