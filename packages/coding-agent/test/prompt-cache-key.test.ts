import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	deriveSessionPromptCacheKey,
	isSessionPromptCacheKeyDisabled,
	resolveSessionPromptCacheKey,
} from "../src/core/prompt-cache-key.ts";

/**
 * The whole value of this key is that it is STABLE across processes: a second
 * session over the same repo and model has to produce the same string, or it
 * lands on a cold shard and the long `prompt_cache_retention` we pay for is
 * wasted. Every assertion here is about that stability or about what must break
 * it.
 */

const BASE = { cwd: "/repo/project", provider: "openai", modelId: "gpt-5" };

afterEach(() => {
	delete process.env.PIT_NO_SESSION_CACHE_KEY;
});

describe("deriveSessionPromptCacheKey", () => {
	it("is stable for identical inputs", () => {
		expect(deriveSessionPromptCacheKey(BASE)).toBe(deriveSessionPromptCacheKey({ ...BASE }));
	});

	it("changes with the workspace", () => {
		expect(deriveSessionPromptCacheKey({ ...BASE, cwd: "/repo/other" })).not.toBe(deriveSessionPromptCacheKey(BASE));
	});

	it("changes with the model — a different prefix must not claim the same shard", () => {
		expect(deriveSessionPromptCacheKey({ ...BASE, modelId: "gpt-5-mini" })).not.toBe(
			deriveSessionPromptCacheKey(BASE),
		);
	});

	it("changes with the provider even at an identical model id", () => {
		expect(deriveSessionPromptCacheKey({ ...BASE, provider: "azure" })).not.toBe(deriveSessionPromptCacheKey(BASE));
	});

	it("treats a relative and an absolute path to the same dir as one workspace", () => {
		const absolute = deriveSessionPromptCacheKey({ ...BASE, cwd: resolve(".") });
		const relative = deriveSessionPromptCacheKey({ ...BASE, cwd: "." });
		expect(relative).toBe(absolute);
	});

	it("cannot be confused by field boundaries", () => {
		// "a" + "bc" must not collide with "ab" + "c" through naive concatenation.
		const left = deriveSessionPromptCacheKey({ cwd: "/x", provider: "a", modelId: "bc" });
		const right = deriveSessionPromptCacheKey({ cwd: "/x", provider: "ab", modelId: "c" });
		expect(left).not.toBe(right);
	});

	it("stays well inside every provider's key length cap", () => {
		const key = deriveSessionPromptCacheKey({ ...BASE, modelId: "m".repeat(500), cwd: `/${"d".repeat(500)}` });
		expect(key.length).toBeLessThanOrEqual(64);
		expect(key.startsWith("pit:")).toBe(true);
	});

	it("leaks no path or model text into the key", () => {
		const key = deriveSessionPromptCacheKey({
			cwd: "/home/secret-client/repo",
			provider: "openai",
			modelId: "gpt-5",
		});
		expect(key).not.toContain("secret-client");
		expect(key).not.toContain("gpt-5");
	});
});

describe("resolveSessionPromptCacheKey", () => {
	it("returns the derived key by default", () => {
		expect(resolveSessionPromptCacheKey(BASE)).toBe(deriveSessionPromptCacheKey(BASE));
	});

	it("falls back to undefined under the kill-switch, restoring session-id routing", () => {
		process.env.PIT_NO_SESSION_CACHE_KEY = "1";
		expect(isSessionPromptCacheKeyDisabled()).toBe(true);
		expect(resolveSessionPromptCacheKey(BASE)).toBeUndefined();
	});

	it("stays on by default", () => {
		expect(isSessionPromptCacheKeyDisabled()).toBe(false);
	});
});
