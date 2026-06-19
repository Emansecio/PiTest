import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Make the 429 backoff instant and deterministic.
vi.mock("../src/utils/sleep.ts", () => ({ sleep: async () => {} }));

import { braveProvider } from "../src/core/web-search/providers.ts";

const ORIG_FETCH = globalThis.fetch;
const ORIG_KEY = process.env.BRAVE_SEARCH_API_KEY;

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function rateLimited(): Response {
	return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
}

beforeEach(() => {
	process.env.BRAVE_SEARCH_API_KEY = "test-key";
});

afterEach(() => {
	globalThis.fetch = ORIG_FETCH;
	if (ORIG_KEY === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
	else process.env.BRAVE_SEARCH_API_KEY = ORIG_KEY;
	vi.restoreAllMocks();
});

describe("web_search 429 retry", () => {
	it("retries on 429 then succeeds", async () => {
		let calls = 0;
		globalThis.fetch = vi.fn(async () => {
			calls++;
			if (calls === 1) return rateLimited();
			return jsonResponse({ web: { results: [{ title: "T", url: "https://example.com" }] } });
		}) as unknown as typeof fetch;

		const hits = await braveProvider.search("q", 5);
		expect(calls).toBe(2);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.url).toBe("https://example.com");
	});

	it("gives up after MAX_429_RETRIES and throws a 429 error", async () => {
		let calls = 0;
		globalThis.fetch = vi.fn(async () => {
			calls++;
			return rateLimited();
		}) as unknown as typeof fetch;

		await expect(braveProvider.search("q", 5)).rejects.toThrow(/429/);
		// initial attempt + MAX_429_RETRIES (2) = 3 calls
		expect(calls).toBe(3);
	});

	it("does not retry on a non-429 error", async () => {
		let calls = 0;
		globalThis.fetch = vi.fn(async () => {
			calls++;
			return new Response("server error", { status: 500 });
		}) as unknown as typeof fetch;

		await expect(braveProvider.search("q", 5)).rejects.toThrow(/500/);
		expect(calls).toBe(1);
	});
});
