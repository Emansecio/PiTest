import { describe, expect, it } from "vitest";
import { redactHttpBody, redactHttpHeaders, redactHttpUrl } from "../src/core/security/redaction.js";

describe("security HTTP redaction", () => {
	it("redacts sensitive headers by name and all other secret-shaped values", () => {
		const headers = redactHttpHeaders({
			Authorization: "Bearer opaque-not-patterned",
			Cookie: "session=plain-cookie",
			"Set-Cookie": "refresh=plain-cookie",
			"X-Trace": "sk-123456789012345678901234567890",
		});

		expect(headers.Authorization).toBe("[REDACTED:http-header]");
		expect(headers.Cookie).toBe("[REDACTED:http-header]");
		expect(headers["Set-Cookie"]).toBe("[REDACTED:http-header]");
		expect(headers["X-Trace"]).toContain("[REDACTED:openai-key]");
	});

	it("redacts credential query parameters and response bodies", () => {
		const url = redactHttpUrl("https://example.test/x?token=plain-secret-value&q=safe");
		const body = redactHttpBody('{"api_key":"sk-123456789012345678901234567890"}');

		expect(url).toContain("token=%5BREDACTED%3Aquery%5D");
		expect(url).toContain("q=safe");
		expect(body).not.toContain("sk-123");
	});
});
