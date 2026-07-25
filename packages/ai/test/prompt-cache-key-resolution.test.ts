import { describe, expect, it } from "vitest";
import { buildBaseOptions, resolvePromptCacheKey } from "../src/providers/simple-options.ts";
import type { Model } from "../src/types.ts";

/**
 * `promptCacheKey` names the PREFIX; `sessionId` names the CONVERSATION. Provider
 * cache routing follows the first and falls back to the second, so callers that
 * never set it keep their old behavior byte-for-byte — while connection-level
 * state (the Codex WebSocket pool) stays keyed on `sessionId` alone.
 */

describe("resolvePromptCacheKey", () => {
	it("prefers the explicit prefix key", () => {
		expect(resolvePromptCacheKey({ promptCacheKey: "pit:abc", sessionId: "session-1" })).toBe("pit:abc");
	});

	it("falls back to the session id, preserving pre-existing behavior", () => {
		expect(resolvePromptCacheKey({ sessionId: "session-1" })).toBe("session-1");
	});

	it("is undefined when neither is set", () => {
		expect(resolvePromptCacheKey({})).toBeUndefined();
		expect(resolvePromptCacheKey(undefined)).toBeUndefined();
	});

	it("lets a caller with its own affinity keep it (subagent fan-out)", () => {
		// coordinator/spawn.ts derives one key per agent type; it must win over the
		// parent's session id rather than being overridden by it.
		expect(resolvePromptCacheKey({ promptCacheKey: "parent:sub:review", sessionId: "parent" })).toBe(
			"parent:sub:review",
		);
	});
});

describe("buildBaseOptions", () => {
	it("forwards promptCacheKey to the provider layer", () => {
		const options = buildBaseOptions({} as Model<any>, { promptCacheKey: "pit:abc", sessionId: "session-1" });
		expect(options.promptCacheKey).toBe("pit:abc");
		expect(options.sessionId).toBe("session-1");
	});
});
