/** Stable classification for provider authentication failures. */
export const PROVIDER_AUTH_ERROR_CODE = "PIT_PROVIDER_AUTH" as const;

export class ProviderAuthError extends Error {
	readonly code = PROVIDER_AUTH_ERROR_CODE;
	readonly provider: string;

	constructor(provider: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ProviderAuthError";
		this.provider = provider;
	}
}

/**
 * Extract a human-readable message from Error instances, strings, or plain
 * structured objects (including cross-realm values that lost prototype identity).
 * Avoids `String(plainObject)` → `"[object Object]"`.
 */
export function describeUnknownError(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error) return error;
	if (typeof error === "object" && error !== null) {
		const value = error as { message?: unknown; provider?: unknown; code?: unknown };
		if (typeof value.message === "string" && value.message) return value.message;
		if (typeof value.provider === "string" && value.provider) {
			return typeof value.code === "string" && value.code
				? `${value.code} for ${value.provider}`
				: `Error for ${value.provider}`;
		}
		if (typeof value.code === "string" && value.code) return value.code;
	}
	try {
		const text = String(error);
		return text === "[object Object]" ? "Unknown error" : text;
	} catch {
		return "Unknown error";
	}
}

/** Conservative fallback classification used only before a child has made progress. */
export function isProviderAuthFailure(error: unknown): boolean {
	if (error instanceof ProviderAuthError) return true;
	if (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === PROVIDER_AUTH_ERROR_CODE
	) {
		return true;
	}
	const message = describeUnknownError(error);
	return (
		/no api key(?: found)? for(?: provider)?\b/i.test(message) ||
		/(?:oauth.*(?:expired|revoked)|(?:expired|revoked).*oauth)/i.test(message) ||
		/\b(?:unauthorized|forbidden)\b/i.test(message) ||
		/\b(?:401|403)\b/i.test(message) ||
		/(?:oauth|auth(?:entication|orization)?|api key|credentials?|permission_error).*(?:denied|forbidden|not allowed|missing|invalid|expired|revoked)/i.test(
			message,
		)
	);
}

/** Human-readable diagnostic for a recognized auth failure without object stringification. */
export function providerAuthFailureDiagnostic(error: unknown): string | undefined {
	if (!isProviderAuthFailure(error)) return undefined;
	const message = describeUnknownError(error);
	if (message && message !== "Unknown error") return message;
	if (typeof error === "object" && error !== null) {
		const provider = (error as { provider?: unknown }).provider;
		if (typeof provider === "string" && provider) {
			return `Provider authentication failed for ${provider}`;
		}
	}
	return "Provider authentication failed";
}
