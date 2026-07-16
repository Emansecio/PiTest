/**
 * Live E2E wrapper: skip (instead of fail) when a stored credential is
 * invalid server-side.
 *
 * `resolveApiKey` (./oauth.ts) only returns undefined when the auth.json
 * entry is missing or the refresh throws — a token that refreshes locally but
 * is revoked/expired on the server sails past `it.skipIf(!token)` and the
 * test runs live and FAILS. That failure mode trains everyone to push with
 * `--no-verify`, so `live()` classifies auth-shaped failures and skips with
 * an actionable message instead.
 *
 * Escapes:
 *  - CI: when `process.env.CI` is set, auth failures still hard-fail.
 *  - PIT_NO_E2E_AUTOSKIP=1 restores hard-fail locally.
 *
 * How auth errors actually reach a test body (inspected in src/providers):
 *  - Anthropic: the SDK throws `APIError` (`.status`, message like
 *    `401 {"type":"error","error":{"type":"authentication_error",...}}`); the
 *    provider converts it into a RESOLVED response with `stopReason: "error"`
 *    and `errorMessage = error.message` (providers/anthropic.ts:712). Tests
 *    then fail on an assertion whose text embeds that errorMessage (e.g.
 *    `expect(response.stopReason, response.errorMessage).not.toBe("error")`
 *    or `expect(response.errorMessage).toBeFalsy()`), so the classifier works
 *    on the AssertionError message.
 *  - OpenAI Codex: non-ok fetch responses throw
 *    `new Error(parseErrorResponse(...).message)` — the backend's own error
 *    text ("token expired", "Missing scopes", "Unauthorized", ...)
 *    (providers/openai-codex-responses.ts:285) — then surface as
 *    `errorMessage` the same way.
 *  - OAuth refresh: `Failed to refresh OAuth token for <provider>: ...` /
 *    `<provider> token refresh failed (400): ... invalid_grant ...`
 *    (src/utils/oauth/).
 */

import type { TestContext } from "vitest";

function isTruthyEnvFlag(name: string): boolean {
	const value = (process.env[name] ?? "").toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

/** Autoskip is on by default locally; hard-fail on CI or with the kill-switch. */
export function liveAutoskipEnabled(): boolean {
	if (process.env.CI) return false;
	return !isTruthyEnvFlag("PIT_NO_E2E_AUTOSKIP");
}

const AUTH_STATUSES = new Set([401, 403]);

const AUTH_MESSAGE_PATTERNS: Array<[RegExp, string]> = [
	[/invalid_grant/i, "invalid_grant"],
	[/authentication_?error/i, "authentication error"],
	[/permission_?error/i, "permission error"],
	[/\bunauthorized\b/i, "unauthorized"],
	[/\bforbidden\b/i, "forbidden"],
	[/invalid (?:api[ -]?key|x-api-key|bearer token|access token|token)/i, "invalid token/key"],
	[/(?:token|session|credential)s? (?:is |has |was )?(?:expired|revoked|invalid)/i, "expired/revoked credential"],
	[/expired (?:token|session|credentials?)/i, "expired credential"],
	[/\brevoked\b/i, "revoked credential"],
	[/missing scopes/i, "missing scopes"],
	[/token refresh failed/i, "token refresh failed"],
	[/failed to refresh oauth token/i, "oauth refresh failed"],
];

// A bare 401/403 in a message only counts when auth/HTTP context words appear
// too, so numeric assertion noise ("expected 401 to be greater than 500")
// never classifies as an auth failure.
const HTTP_40X = /\b40[13]\b/;
const HTTP_40X_CONTEXT = /\b(?:http|status|error|api|token|auth|oauth|bearer|credential)/i;

/**
 * Classify an error (or an AssertionError whose text embeds a provider
 * errorMessage) as an auth/credential failure. Returns a short human label,
 * or undefined when the error does not look auth-shaped.
 */
export function describeAuthFailure(error: unknown): string | undefined {
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (current !== undefined && current !== null && !seen.has(current)) {
		seen.add(current);
		if (typeof current === "object") {
			const e = current as Record<string, unknown>;
			const status =
				typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : undefined;
			if (status !== undefined && AUTH_STATUSES.has(status)) return `HTTP ${status}`;
		}
		const message =
			typeof current === "string"
				? current
				: typeof (current as { message?: unknown }).message === "string"
					? (current as { message: string }).message
					: "";
		if (message) {
			for (const [pattern, label] of AUTH_MESSAGE_PATTERNS) {
				if (pattern.test(message)) return label;
			}
			if (HTTP_40X.test(message) && HTTP_40X_CONTEXT.test(message)) return "HTTP 401/403 in error text";
		}
		current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
	}
	return undefined;
}

/**
 * Wrap a live E2E test body so an auth/credential failure skips the test
 * (with a re-login hint) instead of failing it. Usage:
 *
 *   it.skipIf(!token)("name", { retry: 3 }, live("openai-codex", async () => { ... }));
 *
 * Vitest passes the TestContext as the callback's first argument, which is
 * how the wrapper reaches `ctx.skip()`; the wrapped body may ignore it.
 */
export function live(provider: string, fn: (ctx: TestContext) => unknown): (ctx: TestContext) => Promise<void> {
	return async (ctx: TestContext) => {
		try {
			await fn(ctx);
		} catch (error) {
			const reason = liveAutoskipEnabled() ? describeAuthFailure(error) : undefined;
			if (reason !== undefined && ctx && typeof ctx.skip === "function") {
				// ctx.skip() aborts the test by throwing internally, so the
				// rethrow below is only reached when autoskip does not apply.
				ctx.skip(
					`credencial ${provider} inválida (${reason}) — renove o login para rodar este E2E live ` +
						"(PIT_NO_E2E_AUTOSKIP=1 para falhar em vez de pular)",
				);
			}
			throw error;
		}
	};
}
