import { redactSecrets } from "../secret-redactor.ts";

const SENSITIVE_HEADERS = new Set([
	"authorization",
	"cookie",
	"proxy-authorization",
	"set-cookie",
	"x-api-key",
	"x-auth-token",
	"x-csrf-token",
	"x-xsrf-token",
]);

const SENSITIVE_QUERY_NAME =
	/^(?:api[_-]?key|access[_-]?token|auth|authorization|client[_-]?secret|code|cookie|jwt|password|refresh[_-]?token|secret|session|token)$/i;

export function redactHttpHeaders(headers: Record<string, string | number | boolean>): Record<string, string> {
	const redacted: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		redacted[name] = SENSITIVE_HEADERS.has(name.toLowerCase())
			? "[REDACTED:http-header]"
			: redactSecrets(String(value)).redacted;
	}
	return redacted;
}

export function redactHttpUrl(value: string): string {
	try {
		const url = new URL(value);
		for (const name of [...url.searchParams.keys()]) {
			if (SENSITIVE_QUERY_NAME.test(name)) url.searchParams.set(name, "[REDACTED:query]");
		}
		return redactSecrets(url.toString()).redacted;
	} catch {
		return redactSecrets(value).redacted;
	}
}

export function redactHttpBody(body: string): string {
	return redactSecrets(body).redacted;
}
