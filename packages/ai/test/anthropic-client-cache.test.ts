import { beforeEach, describe, expect, it } from "vitest";
import { __resetAnthropicClientCacheForTests, getOrCreateAnthropicClient } from "../src/providers/anthropic.ts";

const BASE = {
	baseURL: "https://api.anthropic.com",
	dangerouslyAllowBrowser: true,
} as const;

describe("Anthropic client cache", () => {
	beforeEach(() => {
		__resetAnthropicClientCacheForTests();
	});

	it("reuses the same client for an identical config (preserves keep-alive)", () => {
		const a = getOrCreateAnthropicClient({ ...BASE, apiKey: "sk-1", defaultHeaders: { "x-a": "1" } });
		const b = getOrCreateAnthropicClient({ ...BASE, apiKey: "sk-1", defaultHeaders: { "x-a": "1" } });
		expect(b).toBe(a);
	});

	it("never serves a client with a stale apiKey", () => {
		const a = getOrCreateAnthropicClient({ ...BASE, apiKey: "sk-old", defaultHeaders: {} });
		const b = getOrCreateAnthropicClient({ ...BASE, apiKey: "sk-new", defaultHeaders: {} });
		expect(b).not.toBe(a);
	});

	it("never serves a client with a stale authToken (OAuth refresh)", () => {
		const a = getOrCreateAnthropicClient({ ...BASE, apiKey: null, authToken: "tok-old", defaultHeaders: {} });
		const b = getOrCreateAnthropicClient({ ...BASE, apiKey: null, authToken: "tok-new", defaultHeaders: {} });
		expect(b).not.toBe(a);
	});

	it("never serves a client with stale per-request / beta headers", () => {
		const a = getOrCreateAnthropicClient({ ...BASE, apiKey: "sk-h", defaultHeaders: { "anthropic-beta": "x" } });
		const b = getOrCreateAnthropicClient({ ...BASE, apiKey: "sk-h", defaultHeaders: { "anthropic-beta": "y" } });
		expect(b).not.toBe(a);
	});

	it("distinguishes by baseURL (gateway vs direct)", () => {
		const a = getOrCreateAnthropicClient({ ...BASE, apiKey: "sk-u", defaultHeaders: {} });
		const b = getOrCreateAnthropicClient({
			baseURL: "https://gateway.example/v1",
			dangerouslyAllowBrowser: true,
			apiKey: "sk-u",
			defaultHeaders: {},
		});
		expect(b).not.toBe(a);
	});

	it("bounds the cache so undici sockets do not accumulate (LRU eviction)", () => {
		const mk = (i: number) => getOrCreateAnthropicClient({ ...BASE, apiKey: `sk-evict-${i}`, defaultHeaders: {} });
		const first = mk(0);
		// Insert well past the 32-entry cap; the first (LRU) entry must be evicted.
		for (let i = 1; i <= 40; i++) {
			mk(i);
		}
		const firstAgain = mk(0);
		// Evicted → a fresh instance is constructed rather than the original reused.
		expect(firstAgain).not.toBe(first);
	});

	it("keeps a recently-used entry alive across evictions (LRU recency refresh)", () => {
		const keep = getOrCreateAnthropicClient({ ...BASE, apiKey: "sk-keep", defaultHeaders: {} });
		// Fill exactly to the cap so `keep` is the oldest entry.
		for (let i = 0; i < 31; i++) {
			getOrCreateAnthropicClient({ ...BASE, apiKey: `sk-fill-a-${i}`, defaultHeaders: {} });
		}
		// Touch `keep` so it becomes most-recently-used (no longer the eviction target).
		expect(getOrCreateAnthropicClient({ ...BASE, apiKey: "sk-keep", defaultHeaders: {} })).toBe(keep);
		// Insert 31 more distinct configs: this evicts the 31 oldest (all sk-fill-a),
		// but `keep` was refreshed to MRU so it must survive.
		for (let i = 0; i < 31; i++) {
			getOrCreateAnthropicClient({ ...BASE, apiKey: `sk-fill-b-${i}`, defaultHeaders: {} });
		}
		const keepStill = getOrCreateAnthropicClient({ ...BASE, apiKey: "sk-keep", defaultHeaders: {} });
		expect(keepStill).toBe(keep);
	});
});
