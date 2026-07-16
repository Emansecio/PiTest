/**
 * A revoked/expired OAuth refresh token used to surface as a raw multi-line
 * "Failed to refresh OAuth token for anthropic: ...; stack=..." dump in the TUI,
 * printed twice and misclassified as a retryable rate limit. These helpers detect
 * that permanent failure and rewrite it into a short, actionable /login prompt.
 */

import { describe, expect, it } from "vitest";
import { formatOAuthReauthMessage, isOAuthReauthRequired } from "../src/core/auth-guidance.ts";

describe("isOAuthReauthRequired", () => {
	it("detects invalid_grant and the invalid-refresh-token wording", () => {
		expect(isOAuthReauthRequired('body={"error": "invalid_grant"}')).toBe(true);
		expect(isOAuthReauthRequired("Refresh token not found or invalid")).toBe(true);
		expect(
			isOAuthReauthRequired(
				'Failed to refresh OAuth token for anthropic: ... body={"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}',
			),
		).toBe(true);
	});

	it("does not fire on transient network/server failures (those should retry)", () => {
		expect(isOAuthReauthRequired("fetch failed: ECONNRESET")).toBe(false);
		expect(isOAuthReauthRequired("503 Service Unavailable")).toBe(false);
		expect(isOAuthReauthRequired("overloaded_error")).toBe(false);
		expect(isOAuthReauthRequired(undefined)).toBe(false);
		expect(isOAuthReauthRequired("")).toBe(false);
	});
});

describe("formatOAuthReauthMessage", () => {
	it("names the provider and the exact /login command", () => {
		expect(formatOAuthReauthMessage("anthropic")).toBe(
			"Your anthropic session expired or was revoked. Run '/login anthropic' to re-authenticate.",
		);
	});

	it("degrades gracefully when the provider is unknown", () => {
		expect(formatOAuthReauthMessage("unknown")).toBe(
			"Your the selected provider session expired or was revoked. Run '/login' to re-authenticate.",
		);
	});
});
