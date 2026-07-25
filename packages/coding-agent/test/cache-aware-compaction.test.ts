import type { AgentMessage } from "@pit/agent-core";
import type { AssistantMessage, Context, Model } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CacheAwareGeneration,
	decideCacheAwareRoute,
	generateSummary,
	SUMMARIZATION_SYSTEM_PROMPT,
	sumMessageTokens,
} from "../src/core/compaction/index.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@pit/ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@pit/ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

// ============================================================================
// Pure decision function
// ============================================================================

describe("decideCacheAwareRoute (pure)", () => {
	const cheapCacheRead = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }; // Sonnet-ish
	const sibling = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 }; // Haiku-ish

	it("picks cache-read when the session prefix is warm and the read is clearly cheaper", () => {
		// 150k window read at 0.3 = $0.045 vs 150k serialized at sibling 1.0 = $0.15 → 3x.
		const d = decideCacheAwareRoute({
			siblingInputTokens: 150_000,
			cacheReadTokens: 150_000,
			liveMessageTokens: 150_000,
			siblingCost: sibling,
			sessionCost: cheapCacheRead,
			warm: true,
		});
		expect(d.route).toBe("cache-read");
		expect(d.reason).toBe("cache-read-cheaper");
		expect(d.cacheReadCostUsd).toBeCloseTo(0.045, 6);
		expect(d.siblingCostUsd).toBeCloseTo(0.15, 6);
	});

	it("picks the sibling when the session cacheRead rate is expensive (Opus-class)", () => {
		// Opus-class cacheRead 1.5 on the full window vs a cheap Haiku sibling.
		const opus = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };
		const d = decideCacheAwareRoute({
			siblingInputTokens: 150_000,
			cacheReadTokens: 150_000,
			liveMessageTokens: 150_000,
			siblingCost: sibling,
			sessionCost: opus,
			warm: true,
		});
		expect(d.route).toBe("sibling");
		expect(d.reason).toBe("sibling-cheaper");
	});

	it("picks the sibling when the prefix is cold, even if the arithmetic favors cache-read", () => {
		const d = decideCacheAwareRoute({
			siblingInputTokens: 150_000,
			cacheReadTokens: 150_000,
			liveMessageTokens: 150_000,
			siblingCost: sibling,
			sessionCost: cheapCacheRead,
			warm: false,
		});
		expect(d.route).toBe("sibling");
		expect(d.reason).toBe("cold");
	});

	it("requires the min advantage — a thin cache-read win falls to the sibling", () => {
		// Tune so cache-read is only ~10% cheaper (< 25% margin): sibling 100k×1.0 = $0.10,
		// cache 300k×0.3 = $0.09 → 10% cheaper, under the 25% bar.
		const d = decideCacheAwareRoute({
			siblingInputTokens: 100_000,
			cacheReadTokens: 300_000,
			liveMessageTokens: 100_000,
			siblingCost: sibling,
			sessionCost: cheapCacheRead,
			warm: true,
		});
		expect(d.route).toBe("sibling");
		expect(d.reason).toBe("sibling-cheaper");
		// Same numbers with a slack margin flip to cache-read.
		const d2 = decideCacheAwareRoute({
			siblingInputTokens: 100_000,
			cacheReadTokens: 300_000,
			liveMessageTokens: 100_000,
			siblingCost: sibling,
			sessionCost: cheapCacheRead,
			warm: true,
			minAdvantage: 0.05,
		});
		expect(d2.route).toBe("cache-read");
	});

	it("picks the sibling when cost data is missing or zero", () => {
		const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const d = decideCacheAwareRoute({
			siblingInputTokens: 150_000,
			cacheReadTokens: 150_000,
			liveMessageTokens: 150_000,
			siblingCost: zero,
			sessionCost: zero,
			warm: true,
		});
		expect(d.route).toBe("sibling");
		expect(d.reason).toBe("no-cost-data");

		const d2 = decideCacheAwareRoute({
			siblingInputTokens: 150_000,
			cacheReadTokens: 150_000,
			liveMessageTokens: 150_000,
			siblingCost: undefined,
			sessionCost: cheapCacheRead,
			warm: true,
		});
		expect(d2.route).toBe("sibling");
		expect(d2.reason).toBe("no-cost-data");
	});

	it("picks the sibling when either token count is non-positive", () => {
		const d = decideCacheAwareRoute({
			siblingInputTokens: 0,
			cacheReadTokens: 150_000,
			liveMessageTokens: 150_000,
			siblingCost: sibling,
			sessionCost: cheapCacheRead,
			warm: true,
		});
		expect(d.route).toBe("sibling");
		expect(d.reason).toBe("no-tokens");
	});

	it("falls to the sibling when the fold set covers only part of the live window (scope guard)", () => {
		// Incremental compaction shape: fold = 60k of a 150k live window. Even though
		// the raw arithmetic favors the cache-read (45k×0.3 ≈ $0.0135... irrelevant —
		// the summary would scope to the WHOLE window while 90k stays verbatim below).
		const d = decideCacheAwareRoute({
			siblingInputTokens: 60_000,
			cacheReadTokens: 150_000,
			liveMessageTokens: 150_000,
			siblingCost: sibling,
			sessionCost: cheapCacheRead,
			warm: true,
		});
		expect(d.route).toBe("sibling");
		expect(d.reason).toBe("fold-partial");

		// Unknown live size (0) = coverage unknown → sibling.
		const d2 = decideCacheAwareRoute({
			siblingInputTokens: 150_000,
			cacheReadTokens: 150_000,
			liveMessageTokens: 0,
			siblingCost: sibling,
			sessionCost: cheapCacheRead,
			warm: true,
		});
		expect(d2.route).toBe("sibling");
		expect(d2.reason).toBe("fold-partial");

		// Full coverage keeps the cache-read win intact (regression).
		const d3 = decideCacheAwareRoute({
			siblingInputTokens: 145_000,
			cacheReadTokens: 150_000,
			liveMessageTokens: 150_000,
			siblingCost: sibling,
			sessionCost: cheapCacheRead,
			warm: true,
		});
		expect(d3.route).toBe("cache-read");
	});
});

// ============================================================================
// Generation route (generateSummary with a CacheAwareGeneration)
// ============================================================================

function createModel(id: string, cost: Model<"anthropic-messages">["cost"]): Model<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost,
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const bigWindow: AgentMessage[] = [{ role: "user", content: "word ".repeat(40000), timestamp: Date.now() }];
// The realistic warm case: the cached session prefix is ~the same size as the
// window the sibling would serialize. At Sonnet cacheRead 0.3 vs sibling input
// 1.0 that is a clean 3x win, well past the 25% margin.
const windowTokens = sumMessageTokens(bigWindow);

const prefixContext: Context = {
	systemPrompt: "SESSION SYSTEM PROMPT",
	messages: [{ role: "user", content: [{ type: "text", text: "live conversation msg" }], timestamp: Date.now() }],
	tools: [
		{ name: "read", description: "read a file", parameters: { type: "object", properties: {} } },
	] as Context["tools"],
};

/** Session cost with a very cheap cacheRead so the cache-read route wins clearly. */
const cheapSession = createModel("session-sonnet", { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
/** Session cost with an expensive cacheRead so the sibling route wins. */
const expensiveSession = createModel("session-opus", { input: 15, output: 75, cacheRead: 5, cacheWrite: 18.75 });
const siblingModel = createModel("sibling-haiku", { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 });

function cacheAwareFor(sessionModel: Model<"anthropic-messages">): CacheAwareGeneration {
	return {
		sessionModel,
		sessionApiKey: "session-key",
		sessionHeaders: { "x-session": "1" },
		sessionPromptCacheKey: "pit:testkey",
		sessionId: "session-1",
		warm: true,
		prefixWireTokens: windowTokens,
		// Generation-route tests model the eligible case: fold set == live window.
		liveMessageTokens: windowTokens,
		retention: "long",
		buildContext: async () => prefixContext,
	};
}

describe("generateSummary cache-aware generation route", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});
	afterEach(() => {
		delete process.env.PIT_NO_CACHE_AWARE_COMPACTION;
	});

	it("reuses the session prefix on the session model with toolChoice none when the read wins", async () => {
		await generateSummary(
			bigWindow,
			siblingModel,
			20000,
			"sibling-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			cacheAwareFor(cheapSession),
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const [model, context, options] = completeSimpleMock.mock.calls[0];
		// Session model + auth, NOT the sibling.
		expect(model.id).toBe("session-sonnet");
		expect(options.apiKey).toBe("session-key");
		expect(options.toolChoice).toBe("none");
		// Session prefix reused verbatim: session system prompt + tool block preserved.
		expect(context.systemPrompt).toBe("SESSION SYSTEM PROMPT");
		expect(context.tools).toEqual(prefixContext.tools);
		// The live conversation rides ABOVE a trailing user message carrying the prompt.
		const msgs = context.messages;
		expect(msgs.length).toBe(prefixContext.messages.length + 1);
		const last = msgs[msgs.length - 1];
		expect(last.role).toBe("user");
		const lastText = last.content.map((c: { text?: string }) => c.text ?? "").join("");
		expect(lastText).toContain("context checkpoint");
	});

	it("falls back to the serialized text/sibling path when the read is more expensive", async () => {
		await generateSummary(
			bigWindow,
			siblingModel,
			20000,
			"sibling-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			cacheAwareFor(expensiveSession),
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const [model, context, options] = completeSimpleMock.mock.calls[0];
		// Sibling model, summarization system prompt, no tools, no toolChoice.
		expect(model.id).toBe("sibling-haiku");
		expect(options.apiKey).toBe("sibling-key");
		expect(options.toolChoice).toBeUndefined();
		expect(context.systemPrompt).toBe(SUMMARIZATION_SYSTEM_PROMPT);
		expect(context.tools).toBeUndefined();
		// Text route wraps the conversation in a single user message.
		expect(context.messages).toHaveLength(1);
		const onlyText = context.messages[0].content.map((c: { text?: string }) => c.text ?? "").join("");
		expect(onlyText).toContain("<conversation>");
	});

	it("PIT_NO_CACHE_AWARE_COMPACTION forces the text/sibling path even with a winning cacheAware", async () => {
		process.env.PIT_NO_CACHE_AWARE_COMPACTION = "1";
		await generateSummary(
			bigWindow,
			siblingModel,
			20000,
			"sibling-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			cacheAwareFor(cheapSession),
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const [model, context, options] = completeSimpleMock.mock.calls[0];
		expect(model.id).toBe("sibling-haiku");
		expect(context.systemPrompt).toBe(SUMMARIZATION_SYSTEM_PROMPT);
		expect(options.toolChoice).toBeUndefined();
	});

	it("without a cacheAware context the text/sibling path is unchanged (regression)", async () => {
		await generateSummary(bigWindow, siblingModel, 20000, "sibling-key");

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const [model, context, options] = completeSimpleMock.mock.calls[0];
		expect(model.id).toBe("sibling-haiku");
		expect(context.systemPrompt).toBe(SUMMARIZATION_SYSTEM_PROMPT);
		expect(context.tools).toBeUndefined();
		expect(options.toolChoice).toBeUndefined();
	});

	it("falls back to the text/sibling route when the cache-read call errors (route failure never fails compaction)", async () => {
		const errorResponse: AssistantMessage = {
			...mockSummaryResponse,
			content: [],
			stopReason: "error",
			errorMessage: "proxy rejected tool_choice",
		};
		// First call = cache-read route (errors); second call = text/sibling fallback.
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValueOnce(errorResponse).mockResolvedValue(mockSummaryResponse);

		const summary = await generateSummary(
			bigWindow,
			siblingModel,
			20000,
			"sibling-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			cacheAwareFor(cheapSession),
		);

		expect(summary).toContain("Test summary");
		expect(completeSimpleMock).toHaveBeenCalledTimes(2);
		const [firstModel] = completeSimpleMock.mock.calls[0];
		expect(firstModel.id).toBe("session-sonnet");
		const [secondModel, secondContext, secondOptions] = completeSimpleMock.mock.calls[1];
		expect(secondModel.id).toBe("sibling-haiku");
		expect(secondContext.systemPrompt).toBe(SUMMARIZATION_SYSTEM_PROMPT);
		expect(secondOptions.toolChoice).toBeUndefined();
	});
});
