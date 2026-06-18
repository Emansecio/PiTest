import { afterEach, describe, expect, it } from "vitest";
import {
	_resetSecretRedactionCacheForTest,
	isSecretRedactionEnabled,
	redactForDisk,
	redactSecrets,
} from "../src/core/secret-redactor.js";

afterEach(() => {
	delete process.env.PIT_NO_SECRET_REDACT;
	_resetSecretRedactionCacheForTest();
});

describe("redactSecrets — each secret type is caught and replaced", () => {
	const cases: Array<{ name: string; sample: string; type: string }> = [
		{ name: "AWS access key id", sample: "AKIAIOSFODNN7EXAMPLE", type: "aws-access-key" },
		{
			name: "AWS secret key (assignment)",
			sample: "aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			type: "aws-secret-key",
		},
		{ name: "Anthropic key", sample: "sk-ant-api03-abcDEF123456_-ghiJKLmnop", type: "anthropic-key" },
		{ name: "OpenAI key", sample: "sk-abcDEF1234567890ghijKLMN", type: "openai-key" },
		{ name: "Google API key", sample: "AIzaSyA1234567890abcdefghijklmnopqrstuv", type: "google-api-key" },
		{
			name: "GitHub token",
			sample: "ghp_1234567890abcdefghijklmnopqrstuvwxyzAB",
			type: "github-token",
		},
		// Prefix split with an interpolation so no literal Slack-token string sits in
		// the source (GitHub push protection flags the test file otherwise); the
		// assembled value still exercises the slack-token regex.
		{ name: "Slack token", sample: `xox${"b"}-1234567890-abcdefghijklmABC`, type: "slack-token" },
		{
			name: "JWT",
			sample: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
			type: "jwt",
		},
		{
			name: "Authorization Bearer",
			sample: "Authorization: Bearer abcDEF1234567890tokenVALUE",
			type: "bearer-token",
		},
		{
			name: "PEM private key",
			sample: "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1234567890\n-----END RSA PRIVATE KEY-----",
			type: "private-key",
		},
		{ name: "generic password assignment", sample: "password=hunter2secret", type: "credential" },
		{ name: "generic api_key assignment", sample: 'api_key="abcdef123456789"', type: "credential" },
	];

	for (const { name, sample, type } of cases) {
		it(`redacts ${name}`, () => {
			const { redacted, count } = redactSecrets(`prefix ${sample} suffix`);
			expect(count).toBeGreaterThanOrEqual(1);
			expect(redacted).toContain(`[REDACTED:${type}]`);
			// The raw secret material must be gone.
			const rawCore = sample.replace(/^[A-Za-z_]+\s*[=:]\s*['"]?/, "").replace(/['"]$/, "");
			expect(redacted).not.toContain(rawCore.slice(0, 24));
		});
	}

	it("preserves the header/key prefix for Bearer and credential assignments", () => {
		expect(redactSecrets("Authorization: Bearer SECRETTOKEN1234567890").redacted).toContain(
			"Authorization: Bearer [REDACTED:bearer-token]",
		);
		expect(redactSecrets("password=hunter2secret").redacted).toContain("password=[REDACTED:credential]");
	});

	it("counts multiple secrets in one string", () => {
		const { count } = redactSecrets("AKIAIOSFODNN7EXAMPLE and ghp_1234567890abcdefghijklmnopqrstuvwxyzAB");
		expect(count).toBe(2);
	});
});

describe("redactSecrets — case-insensitive anchors must not slip the gate", () => {
	// UPPERCASE is the dominant dotenv/env convention for exactly these keys, so
	// the pre-scan gate must be case-insensitive for the /i regexes; otherwise the
	// secret the feature exists to catch leaks verbatim to disk.
	const leaky: Array<{ name: string; sample: string; type: string }> = [
		{ name: "API_KEY uppercase", sample: "API_KEY=abcdef123456", type: "credential" },
		{ name: "SECRET uppercase", sample: "SECRET=abcdef123456", type: "credential" },
		{ name: "Password mixed-case", sample: "Password=SuperSecret123", type: "credential" },
		{ name: "PASSWORD uppercase", sample: "PASSWORD=hunter2secret", type: "credential" },
		{
			name: "AWS_SECRET_ACCESS_KEY uppercase",
			sample: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			type: "aws-secret-key",
		},
		{
			name: "Authorization BEARER uppercase",
			sample: "AUTHORIZATION: BEARER abcDEF1234567890tokenVALUE",
			type: "bearer-token",
		},
	];

	for (const { name, sample, type } of leaky) {
		it(`redacts ${name} (gate is case-insensitive)`, () => {
			const { redacted, count } = redactSecrets(sample);
			expect(count).toBeGreaterThanOrEqual(1);
			expect(redacted).toContain(`[REDACTED:${type}]`);
		});
	}

	it("the lowercase form still redacts (regression guard for the lower path)", () => {
		expect(redactSecrets("api_key=abcdef123456").count).toBe(1);
		expect(redactSecrets("aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY").count).toBe(1);
	});
});

describe("redactSecrets — quoted credential value may contain '&'", () => {
	// The quote already delimits the value, so '&' inside quotes is legitimate
	// secret material and must be redacted. '&' is only excluded in the BARE
	// alternative (to avoid eating a trailing query string).
	it("redacts a quoted value containing '&'", () => {
		const { redacted, count } = redactSecrets('api_key="ab&cd1234"');
		expect(count).toBe(1);
		expect(redacted).toContain("[REDACTED:credential]");
		expect(redacted).not.toContain("ab&cd1234");
	});

	it("still redacts a quoted value without '&' (baseline)", () => {
		expect(redactSecrets('api_key="abcd1234"').count).toBe(1);
	});

	it("keeps the bare alternative anchored so a query string is not eaten whole", () => {
		// Bare RHS stops at the first '&' (the {6,} run before it is the secret).
		const { redacted } = redactSecrets("password=hunter2secret&next=value");
		expect(redacted).toContain("password=[REDACTED:credential]");
		expect(redacted).toContain("&next=value");
	});
});

describe("redactSecrets — no false positives on normal text", () => {
	const benign = [
		"git commit 38327b51c63c7a906b061da10c0cc0ca645d30d0", // commit hashes
		"C:/PiTest/packages/coding-agent/src/core/secret-redactor.ts", // path
		"The quick brown fox jumps over the lazy dog.", // prose
		"function redactSecrets(text: string): RedactionResult {}", // code
		"sha256:abc123 deadbeef cafef00d", // short hex
		"const password = userInput; // mentions password but no value", // word w/o assignment
		"version 4.8 model opus-4-8 token budget", // 'token' word, no assignment
	];

	for (const text of benign) {
		it(`leaves untouched: ${text.slice(0, 32)}…`, () => {
			const { redacted, count } = redactSecrets(text);
			expect(count).toBe(0);
			expect(redacted).toBe(text);
		});
	}

	it("does not eat a 40-char git/object hash as an AWS secret", () => {
		const hash = "da39a3ee5e6b4b0d3255bfef95601890afd80709"; // 40 hex chars
		const { count } = redactSecrets(`object ${hash} committed`);
		expect(count).toBe(0);
	});
});

describe("redactSecrets — JSON round-trip safety", () => {
	it("a redacted serialized JSONL line still parses", () => {
		const entry = {
			type: "message",
			id: "abc",
			message: {
				role: "user",
				content: "my key is sk-ant-api03-abcDEF123456_-ghiJKLmnop please use it",
			},
		};
		const line = JSON.stringify(entry);
		const { redacted, count } = redactSecrets(line);
		expect(count).toBe(1);
		const parsed = JSON.parse(redacted) as typeof entry;
		expect(parsed.message.content).toContain("[REDACTED:anthropic-key]");
		expect(parsed.message.content).not.toContain("sk-ant-api03");
	});

	it('redacts a quoted credential after JSON serialization (KEY="value" → KEY=\\"value\\")', () => {
		// The dominant dotenv/config shape `PASSWORD="hunter2secret"` becomes
		// `PASSWORD=\"hunter2secret\"` once the line is JSON-serialized. Before the
		// fix neither alt matched that form and the secret leaked verbatim to the
		// pushed .jsonl.
		const entry = { type: "message", message: { role: "user", content: 'PASSWORD="hunter2secret"' } };
		const line = JSON.stringify(entry);
		expect(line).toContain('PASSWORD=\\"hunter2secret\\"');
		const { redacted, count } = redactSecrets(line);
		expect(count).toBeGreaterThan(0);
		const parsed = JSON.parse(redacted) as typeof entry;
		expect(parsed.message.content).toContain("[REDACTED:credential]");
		expect(parsed.message.content).not.toContain("hunter2secret");
	});

	it("a multi-line JSONL batch with a PEM key stays valid per line", () => {
		const pem = "-----BEGIN PRIVATE KEY-----\\nMIIEvQ123\\n-----END PRIVATE KEY-----";
		const batch = `${JSON.stringify({ a: 1, k: pem })}\n${JSON.stringify({ b: 2 })}\n`;
		const { redacted } = redactSecrets(batch);
		for (const line of redacted.split("\n").filter(Boolean)) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
		expect(redacted).toContain("[REDACTED:private-key]");
	});
});

describe("kill switch — PIT_NO_SECRET_REDACT", () => {
	it("redacts by default (env unset)", () => {
		_resetSecretRedactionCacheForTest();
		expect(isSecretRedactionEnabled()).toBe(true);
		expect(redactForDisk("key sk-ant-api03-abcDEF123456_-ghiJKLmnop")).toContain("[REDACTED:anthropic-key]");
	});

	it("PIT_NO_SECRET_REDACT=1 disables redaction (passthrough)", () => {
		process.env.PIT_NO_SECRET_REDACT = "1";
		_resetSecretRedactionCacheForTest();
		expect(isSecretRedactionEnabled()).toBe(false);
		const raw = "key sk-ant-api03-abcDEF123456_-ghiJKLmnop";
		expect(redactForDisk(raw)).toBe(raw);
	});

	it("PIT_NO_SECRET_REDACT=0 keeps redaction ON", () => {
		process.env.PIT_NO_SECRET_REDACT = "0";
		_resetSecretRedactionCacheForTest();
		expect(isSecretRedactionEnabled()).toBe(true);
	});

	it("env is read once and cached across calls", () => {
		_resetSecretRedactionCacheForTest();
		expect(isSecretRedactionEnabled()).toBe(true);
		// Flip env AFTER first read; cache should keep the original value.
		process.env.PIT_NO_SECRET_REDACT = "1";
		expect(isSecretRedactionEnabled()).toBe(true);
	});
});

describe("redactForDisk — short-circuit on indicator-free text", () => {
	it("returns the exact same string reference semantics for plain prose", () => {
		const text = "Just some ordinary log output with no credentials at all.";
		expect(redactForDisk(text)).toBe(text);
		expect(redactSecrets(text).count).toBe(0);
	});
});
