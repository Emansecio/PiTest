import { describe, expect, test } from "vitest";
import {
	computeRetryDelay,
	isRetryableStatus,
	parseRetryAfter,
	type RetryHeaderLookup,
} from "../src/utils/retry-headers.js";

// Minimal case-insensitive header bag mirroring the WHATWG `Headers.get`
// contract (returns the value or `null`). Lets tests inject arbitrary header
// shapes without pulling in `undici`/`Response`.
function headers(map: Record<string, string>): RetryHeaderLookup {
	const lower = new Map<string, string>();
	for (const [k, v] of Object.entries(map)) {
		lower.set(k.toLowerCase(), v);
	}
	return {
		get(name: string): string | null {
			return lower.get(name.toLowerCase()) ?? null;
		},
	};
}

describe("parseRetryAfter", () => {
	test("retry-after-ms → milliseconds verbatim", () => {
		expect(parseRetryAfter(headers({ "retry-after-ms": "1500" }))).toBe(1500);
		expect(parseRetryAfter(headers({ "retry-after-ms": "0" }))).toBe(0);
	});

	test("retry-after-ms takes precedence over retry-after", () => {
		expect(parseRetryAfter(headers({ "retry-after-ms": "250", "retry-after": "9" }))).toBe(250);
	});

	test("retry-after as delay-seconds → milliseconds", () => {
		expect(parseRetryAfter(headers({ "retry-after": "3" }))).toBe(3000);
		expect(parseRetryAfter(headers({ "retry-after": "0" }))).toBe(0);
	});

	test("retry-after as HTTP-date → ms until that date, using injected clock", () => {
		const now = Date.parse("Wed, 21 Oct 2025 07:28:00 GMT");
		const future = "Wed, 21 Oct 2025 07:28:05 GMT"; // +5s
		expect(parseRetryAfter(headers({ "retry-after": future }), () => now)).toBe(5000);
	});

	test("retry-after as a past HTTP-date clamps to 0", () => {
		const now = Date.parse("Wed, 21 Oct 2025 07:28:10 GMT");
		const past = "Wed, 21 Oct 2025 07:28:00 GMT"; // -10s
		expect(parseRetryAfter(headers({ "retry-after": past }), () => now)).toBe(0);
	});

	test("missing headers → null", () => {
		expect(parseRetryAfter(headers({}))).toBeNull();
	});

	test("garbage retry-after → null", () => {
		expect(parseRetryAfter(headers({ "retry-after": "not-a-number-or-date" }))).toBeNull();
	});

	test("garbage retry-after-ms falls through to retry-after", () => {
		// Number("abc") is NaN → skip ms branch; retry-after seconds wins.
		expect(parseRetryAfter(headers({ "retry-after-ms": "abc", "retry-after": "2" }))).toBe(2000);
	});

	test("garbage retry-after-ms with no retry-after → null", () => {
		expect(parseRetryAfter(headers({ "retry-after-ms": "abc" }))).toBeNull();
	});

	test("empty-string retry-after is ignored → null", () => {
		expect(parseRetryAfter(headers({ "retry-after": "" }))).toBeNull();
	});

	test("negative retry-after-ms clamps to 0", () => {
		expect(parseRetryAfter(headers({ "retry-after-ms": "-500" }))).toBe(0);
	});
});

describe("isRetryableStatus", () => {
	test("retryable statuses", () => {
		for (const status of [429, 500, 502, 503, 504]) {
			expect(isRetryableStatus(status)).toBe(true);
		}
	});

	test("5xx covered by the contract", () => {
		// 500 is always retryable even though it is not a gateway/timeout code.
		expect(isRetryableStatus(500)).toBe(true);
	});

	test("non-retryable statuses", () => {
		for (const status of [200, 400, 401, 403, 404, 422, 501]) {
			expect(isRetryableStatus(status)).toBe(false);
		}
	});
});

describe("computeRetryDelay", () => {
	test("honors the server delay verbatim when present", () => {
		// Server delay wins regardless of attempt / backoff config.
		expect(computeRetryDelay(0, 1234, { baseDelayMs: 1000, random: () => 0 })).toBe(1234);
		expect(computeRetryDelay(5, 50, { baseDelayMs: 1000, random: () => 0.99 })).toBe(50);
	});

	test("negative server delay clamps to 0", () => {
		expect(computeRetryDelay(0, -10, {})).toBe(0);
	});

	test("falls back to exponential backoff + jitter when no server delay", () => {
		// random=0 → multiplier (0.5 + 0) = 0.5: base * 2^attempt * 0.5
		expect(computeRetryDelay(0, null, { baseDelayMs: 1000, random: () => 0 })).toBe(500);
		expect(computeRetryDelay(1, null, { baseDelayMs: 1000, random: () => 0 })).toBe(1000);
		expect(computeRetryDelay(2, null, { baseDelayMs: 1000, random: () => 0 })).toBe(2000);
		// random=0.5 → multiplier 1.0: base * 2^attempt
		expect(computeRetryDelay(0, null, { baseDelayMs: 1000, random: () => 0.5 })).toBe(1000);
		expect(computeRetryDelay(3, null, { baseDelayMs: 1000, random: () => 0.5 })).toBe(8000);
	});

	test("default baseDelayMs is 1000", () => {
		expect(computeRetryDelay(0, null, { random: () => 0 })).toBe(500);
	});

	test("maxDelayMs clamps the backoff but never the server delay", () => {
		// Backoff would be 8000 at attempt 3 (random=0.5); clamp to 2000.
		expect(computeRetryDelay(3, null, { baseDelayMs: 1000, maxDelayMs: 2000, random: () => 0.5 })).toBe(2000);
		// Server delay is honored even above the clamp.
		expect(computeRetryDelay(3, 9000, { baseDelayMs: 1000, maxDelayMs: 2000, random: () => 0.5 })).toBe(9000);
	});

	test("matches the legacy codex backoff formula for the full jitter range", () => {
		// Original inline: BASE_DELAY_MS * 2 ** attempt * (0.5 + Math.random())
		const baseDelayMs = 1000;
		for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
			for (const attempt of [0, 1, 2, 3]) {
				const expected = baseDelayMs * 2 ** attempt * (0.5 + r);
				expect(computeRetryDelay(attempt, null, { baseDelayMs, random: () => r })).toBe(expected);
			}
		}
	});
});
