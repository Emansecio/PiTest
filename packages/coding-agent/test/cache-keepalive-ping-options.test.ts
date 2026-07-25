import type { Agent } from "@pit/agent-core";
import type { CacheRetention, Context, Model, SimpleStreamOptions } from "@pit/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The keepalive ping is the one call whose entire job is cache continuity, so
 * what it puts on the wire is the behavior under test — not just that it fires.
 * It must ask for the retention it scheduled itself for and ride the session's
 * own routing key; otherwise it renews a tier or a shard nobody asked for.
 */

const completeSimple = vi.fn();

vi.mock("@pit/ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@pit/ai")>();
	return { ...actual, completeSimple: (...args: unknown[]) => completeSimple(...args) };
});

const { createCacheKeepalive } = await import("../src/core/cache-keepalive.js");
type CacheKeepaliveHost = import("../src/core/cache-keepalive.js").CacheKeepaliveHost;

function fakeModel(compat?: { supportsLongCacheRetention?: boolean }): Model<any> {
	return { id: "claude-test", provider: "anthropic", ...(compat ? { compat } : {}) } as unknown as Model<any>;
}

function fakeAgent(): Agent {
	return {
		state: { systemPrompt: "sys", messages: [], tools: [] },
		convertToLlm: async () => [],
		promptCacheKey: "pit:deadbeef",
		sessionId: "session-abc",
	} as unknown as Agent;
}

function hostWith(opts: { retention?: CacheRetention; model?: Model<any> } = {}): CacheKeepaliveHost {
	return {
		agent: fakeAgent(),
		compaction: { backgroundCompactionPromise: undefined } as never,
		model: opts.model ?? fakeModel(),
		isStreaming: false,
		isFusing: false,
		getContextUsage: () => ({ wireTokens: 999_999 }) as never,
		getCompactionRequestAuth: async () => ({ apiKey: "k", headers: { h: "1" } }),
		getSessionCacheRetention: () => opts.retention,
	};
}

/** Arm + fire one ping through the real scheduler and return the provider options it sent. */
async function firedPingOptions(host: CacheKeepaliveHost): Promise<SimpleStreamOptions> {
	vi.useFakeTimers();
	try {
		createCacheKeepalive(host).scheduleIdle();
		await vi.runOnlyPendingTimersAsync();
	} finally {
		vi.useRealTimers();
	}
	expect(completeSimple).toHaveBeenCalledTimes(1);
	return completeSimple.mock.calls[0][2] as SimpleStreamOptions;
}

describe("cache-keepalive ping options", () => {
	beforeEach(() => {
		completeSimple.mockReset();
		completeSimple.mockResolvedValue({ stopReason: "stop" });
		delete process.env.PIT_CACHE_RETENTION;
	});

	it("sends the session's retention instead of leaning on the provider default", async () => {
		const options = await firedPingOptions(hostWith({ retention: "short" }));
		expect(options.cacheRetention).toBe("short");
	});

	it("sends long when the session takes the long tier", async () => {
		const options = await firedPingOptions(hostWith({ retention: "long" }));
		expect(options.cacheRetention).toBe("long");
	});

	it("demotes to short when the model has no long-retention support", async () => {
		const host = hostWith({ retention: "long", model: fakeModel({ supportsLongCacheRetention: false }) });
		const options = await firedPingOptions(host);
		expect(options.cacheRetention).toBe("short");
	});

	it("rides the session's prompt-cache routing key", async () => {
		const options = await firedPingOptions(hostWith({ retention: "long" }));
		expect(options.promptCacheKey).toBe("pit:deadbeef");
		expect(options.sessionId).toBe("session-abc");
	});

	it("still pings with max_tokens 1", async () => {
		const options = await firedPingOptions(hostWith({ retention: "long" }));
		expect(options.maxTokens).toBe(1);
	});

	it("sends the context the session would send, not a synthetic one", async () => {
		await firedPingOptions(hostWith({ retention: "long" }));
		const context = completeSimple.mock.calls[0][1] as Context;
		expect(context.systemPrompt).toBe("sys");
	});
});
