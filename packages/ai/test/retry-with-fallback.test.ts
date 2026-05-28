import { beforeEach, describe, expect, test } from "vitest";
import {
	_resetFallbackCooldowns,
	defaultIsRetryable,
	type FallbackChainEntry,
	withFallbackChain,
} from "../src/retry-with-fallback.js";
import type { Api, Model } from "../src/types.js";

function fakeEntry(provider: string, id: string): FallbackChainEntry {
	return {
		model: {
			id,
			provider,
		} as unknown as Model<Api>,
	};
}

class HttpError extends Error {
	status: number;
	constructor(status: number, message?: string) {
		super(message ?? `HTTP ${status}`);
		this.status = status;
	}
}

describe("defaultIsRetryable", () => {
	test("returns true for retryable HTTP statuses", () => {
		expect(defaultIsRetryable(new HttpError(429))).toBe(true);
		expect(defaultIsRetryable(new HttpError(502))).toBe(true);
		expect(defaultIsRetryable(new HttpError(503))).toBe(true);
		expect(defaultIsRetryable(new HttpError(504))).toBe(true);
	});

	test("returns true for retryable message patterns", () => {
		expect(defaultIsRetryable(new Error("connection refused"))).toBe(true);
		expect(defaultIsRetryable(new Error("ETIMEDOUT while reading"))).toBe(true);
		expect(defaultIsRetryable(new Error("quota exceeded"))).toBe(true);
		expect(defaultIsRetryable(new Error("rate-limit reached"))).toBe(true);
		expect(defaultIsRetryable(new Error("ECONNREFUSED 127.0.0.1"))).toBe(true);
	});

	test("returns false for non-retryable HTTP statuses", () => {
		expect(defaultIsRetryable(new HttpError(401))).toBe(false);
		expect(defaultIsRetryable(new HttpError(403))).toBe(false);
		expect(defaultIsRetryable(new HttpError(404))).toBe(false);
	});

	test("returns false for null/undefined", () => {
		expect(defaultIsRetryable(null)).toBe(false);
		expect(defaultIsRetryable(undefined)).toBe(false);
	});
});

describe("withFallbackChain", () => {
	beforeEach(() => {
		_resetFallbackCooldowns();
	});

	test("primary succeeds → result returned, no retry", async () => {
		const chain = [fakeEntry("anthropic", "claude-1"), fakeEntry("openai", "gpt-1")];
		let calls = 0;
		const out = await withFallbackChain({ chain }, async (entry) => {
			calls++;
			expect(entry.model.id).toBe("claude-1");
			return "ok";
		});
		expect(out).toBe("ok");
		expect(calls).toBe(1);
	});

	test("primary throws 429 (retryable) → fallback entry succeeds", async () => {
		const chain = [fakeEntry("anthropic", "claude-1"), fakeEntry("openai", "gpt-1")];
		const calls: string[] = [];
		const out = await withFallbackChain({ chain }, async (entry) => {
			calls.push(entry.model.id);
			if (entry.model.id === "claude-1") {
				throw new HttpError(429, "rate-limit hit");
			}
			return "fallback-ok";
		});
		expect(out).toBe("fallback-ok");
		expect(calls).toEqual(["claude-1", "gpt-1"]);
	});

	test("non-retryable error → throws immediately without trying fallback", async () => {
		const chain = [fakeEntry("anthropic", "claude-1"), fakeEntry("openai", "gpt-1")];
		const calls: string[] = [];
		await expect(
			withFallbackChain({ chain }, async (entry) => {
				calls.push(entry.model.id);
				throw new HttpError(401, "unauthorized");
			}),
		).rejects.toMatchObject({ status: 401 });
		expect(calls).toEqual(["claude-1"]);
	});

	test("all chain entries cooled down → throws after exhaustion", async () => {
		const chain = [fakeEntry("anthropic", "claude-1"), fakeEntry("openai", "gpt-1")];
		// Use a huge cooldown so wait-for-cooldown short-circuits.
		await expect(
			withFallbackChain({ chain, cooldownMs: 10 * 60_000 }, async () => {
				throw new HttpError(429, "rate-limit");
			}),
		).rejects.toBeDefined();
	});

	test("empty chain throws", async () => {
		await expect(withFallbackChain({ chain: [] }, async () => "noop")).rejects.toThrow(/chain is empty/);
	});

	test("_resetFallbackCooldowns clears state between tests", async () => {
		const chain = [fakeEntry("anthropic", "claude-cool")];
		await expect(
			withFallbackChain({ chain, cooldownMs: 10 * 60_000 }, async () => {
				throw new HttpError(429);
			}),
		).rejects.toBeDefined();
		// After reset, a fresh call against the same chain (different call fn) succeeds.
		_resetFallbackCooldowns();
		const out = await withFallbackChain({ chain }, async () => "fresh");
		expect(out).toBe("fresh");
	});
});
