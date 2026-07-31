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

const { completeSimpleMock, recordDiagnosticMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
	recordDiagnosticMock: vi.fn(),
}));

vi.mock("@pit/ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@pit/ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
		recordDiagnostic: recordDiagnosticMock,
	};
});

/** The `compaction.cache-aware` route note recorded by the last generateSummary call. */
function routeNote(): string {
	const call = recordDiagnosticMock.mock.calls
		.map(([event]) => event as { category: string; context?: { note?: string } })
		.find((event) => event.category === "compaction.cache-aware" && event.context?.note?.startsWith("route="));
	return call?.context?.note ?? "";
}

// ============================================================================
// Pure decision function
// ============================================================================

describe("decideCacheAwareRoute (pure)", () => {
	const cheapCacheRead = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }; // Sonnet-ish
	const sibling = { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 }; // Haiku-ish
	/** A modest summary: both routes pay for it, each at its own model's output rate. */
	const SUMMARY = 4_000;

	it("picks cache-read when the session prefix is warm and the read is clearly cheaper", () => {
		// Input leg: 150k read at 0.3 = $0.045 vs 150k serialized at sibling 1.0 = $0.15.
		// Output leg: 4k summary at 15 = $0.06 (session) vs at 4 = $0.016 (sibling).
		// Totals $0.105 vs $0.166 → the read still clears the 25% margin.
		const d = decideCacheAwareRoute({
			siblingInputTokens: 150_000,
			foldMessageTokens: 150_000,
			cacheReadTokens: 150_000,
			expectedSummaryTokens: SUMMARY,
			liveMessageTokens: 150_000,
			siblingCost: sibling,
			sessionCost: cheapCacheRead,
			warm: true,
		});
		expect(d.route).toBe("cache-read");
		expect(d.reason).toBe("cache-read-cheaper");
		expect(d.cacheReadCostUsd).toBeCloseTo(0.045 + 0.06, 6);
		expect(d.siblingCostUsd).toBeCloseTo(0.15 + 0.016, 6);
	});

	it("counts the summary OUTPUT on both sides — an input-only win can flip to the sibling", () => {
		// Identical input legs to the test above ($0.045 vs $0.15 → 3x for the read),
		// but a 16k summary (the enforced ceiling on a first compaction) costs $0.24 on
		// the session model against $0.064 on the sibling: $0.285 vs $0.214 → sibling.
		const inputs = {
			siblingInputTokens: 150_000,
			foldMessageTokens: 150_000,
			cacheReadTokens: 150_000,
			liveMessageTokens: 150_000,
			siblingCost: sibling,
			sessionCost: cheapCacheRead,
			warm: true,
		};
		const withOutput = decideCacheAwareRoute({ ...inputs, expectedSummaryTokens: 16_000 });
		expect(withOutput.route).toBe("sibling");
		expect(withOutput.reason).toBe("sibling-cheaper");
		// The legacy input-only arithmetic (summary size 0) is what used to pick the read.
		const inputOnly = decideCacheAwareRoute({ ...inputs, expectedSummaryTokens: 0 });
		expect(inputOnly.route).toBe("cache-read");
	});

	it("picks the sibling when the session cacheRead rate is expensive (Opus-class)", () => {
		// Opus-class cacheRead 1.5 on the full window vs a cheap Haiku sibling.
		const opus = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };
		const d = decideCacheAwareRoute({
			siblingInputTokens: 150_000,
			foldMessageTokens: 150_000,
			cacheReadTokens: 150_000,
			expectedSummaryTokens: SUMMARY,
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
			foldMessageTokens: 150_000,
			cacheReadTokens: 150_000,
			expectedSummaryTokens: SUMMARY,
			liveMessageTokens: 150_000,
			siblingCost: sibling,
			sessionCost: cheapCacheRead,
			warm: false,
		});
		expect(d.route).toBe("sibling");
		expect(d.reason).toBe("cold");
	});

	it("requires the min advantage — a thin cache-read win falls to the sibling", () => {
		// Output term neutralized (0) to isolate the margin: sibling 100k×1.0 = $0.10,
		// cache 300k×0.3 = $0.09 → 10% cheaper, under the 25% bar.
		const d = decideCacheAwareRoute({
			siblingInputTokens: 100_000,
			foldMessageTokens: 100_000,
			cacheReadTokens: 300_000,
			expectedSummaryTokens: 0,
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
			foldMessageTokens: 100_000,
			cacheReadTokens: 300_000,
			expectedSummaryTokens: 0,
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
			foldMessageTokens: 150_000,
			cacheReadTokens: 150_000,
			expectedSummaryTokens: SUMMARY,
			liveMessageTokens: 150_000,
			siblingCost: zero,
			sessionCost: zero,
			warm: true,
		});
		expect(d.route).toBe("sibling");
		expect(d.reason).toBe("no-cost-data");

		const d2 = decideCacheAwareRoute({
			siblingInputTokens: 150_000,
			foldMessageTokens: 150_000,
			cacheReadTokens: 150_000,
			expectedSummaryTokens: SUMMARY,
			liveMessageTokens: 150_000,
			siblingCost: undefined,
			sessionCost: cheapCacheRead,
			warm: true,
		});
		expect(d2.route).toBe("sibling");
		expect(d2.reason).toBe("no-cost-data");
	});

	it("picks the sibling when a summary is claimed but an OUTPUT rate is unknown", () => {
		// Input rates are fine; the session model has no output price. The output leg
		// cannot be priced → uncertainty → sibling (never a silent input-only decision).
		const noOutputPrice = { input: 3, output: 0, cacheRead: 0.3, cacheWrite: 3.75 };
		const d = decideCacheAwareRoute({
			siblingInputTokens: 150_000,
			foldMessageTokens: 150_000,
			cacheReadTokens: 150_000,
			expectedSummaryTokens: SUMMARY,
			liveMessageTokens: 150_000,
			siblingCost: sibling,
			sessionCost: noOutputPrice,
			warm: true,
		});
		expect(d.route).toBe("sibling");
		expect(d.reason).toBe("no-cost-data");

		// Without a claimed summary the same pricing is enough for the input-only call.
		const d2 = decideCacheAwareRoute({
			siblingInputTokens: 150_000,
			foldMessageTokens: 150_000,
			cacheReadTokens: 150_000,
			expectedSummaryTokens: 0,
			liveMessageTokens: 150_000,
			siblingCost: sibling,
			sessionCost: noOutputPrice,
			warm: true,
		});
		expect(d2.route).toBe("cache-read");
	});

	it("picks the sibling when either token count is non-positive", () => {
		const d = decideCacheAwareRoute({
			siblingInputTokens: 0,
			foldMessageTokens: 0,
			cacheReadTokens: 150_000,
			expectedSummaryTokens: SUMMARY,
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
			foldMessageTokens: 60_000,
			cacheReadTokens: 150_000,
			expectedSummaryTokens: SUMMARY,
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
			foldMessageTokens: 150_000,
			cacheReadTokens: 150_000,
			expectedSummaryTokens: SUMMARY,
			liveMessageTokens: 0,
			siblingCost: sibling,
			sessionCost: cheapCacheRead,
			warm: true,
		});
		expect(d2.route).toBe("sibling");
		expect(d2.reason).toBe("fold-partial");

		// Coverage is measured on the RAW fold size, never on the serialized payload:
		// a window of capped tool results serializes to a fraction of its message
		// tokens, and reading that as a partial fold would kill the route outright.
		const d4 = decideCacheAwareRoute({
			siblingInputTokens: 12_000, // serialized (capped tool results)
			foldMessageTokens: 150_000, // raw fold set — full coverage
			cacheReadTokens: 150_000,
			expectedSummaryTokens: 0,
			liveMessageTokens: 150_000,
			siblingCost: sibling,
			sessionCost: cheapCacheRead,
			warm: true,
		});
		expect(d4.reason).not.toBe("fold-partial");
		// …and the pricing still uses the serialized size: 12k×1.0 = $0.012 vs
		// 150k×0.3 = $0.045 → the sibling is genuinely cheaper here.
		expect(d4.route).toBe("sibling");
		expect(d4.siblingCostUsd).toBeCloseTo(0.012, 6);

		// Full coverage keeps the cache-read win intact (regression).
		const d3 = decideCacheAwareRoute({
			siblingInputTokens: 145_000,
			foldMessageTokens: 145_000,
			cacheReadTokens: 150_000,
			expectedSummaryTokens: SUMMARY,
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
		contextWindow: 1_000_000,
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

// ~250k tokens of plain prose (1M chars / 4). The window has to be this big for
// the cache-read route to actually win: the read saves 0.7/1M on the input leg but
// pays the session model's output rate on the 8k summary ceiling (15 vs the
// sibling's 4), so the input saving must outgrow that premium before the 25%
// margin is cleared. Small windows now legitimately route to the sibling.
const bigWindow: AgentMessage[] = [{ role: "user", content: "word ".repeat(200_000), timestamp: Date.now() }];
// The realistic warm case: the cached session prefix is ~the same size as the
// window the sibling would serialize.
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
		recordDiagnosticMock.mockReset();
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

	it("prices the sibling route on the SERIALIZED text, not on the raw window", async () => {
		// A 90k-char tool result: serializeConversation caps tool-result text, so the
		// text the sibling really ships is a fraction of the raw message estimate.
		// Charging the sibling for the raw size was the second half of the pro-cache bias.
		const window: AgentMessage[] = [
			{
				role: "toolResult",
				content: [{ type: "text", text: "x".repeat(90_000) }],
				timestamp: Date.now(),
				toolCallId: "tc-1",
			} as unknown as AgentMessage,
			{ role: "user", content: "and now summarize", timestamp: Date.now() },
		];
		const rawTokens = sumMessageTokens(window);

		await generateSummary(
			window,
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
			{ ...cacheAwareFor(cheapSession), prefixWireTokens: rawTokens, liveMessageTokens: rawTokens },
		);

		const note = routeNote();
		const sibTok = Number(/sibTok=(\d+)/.exec(note)?.[1]);
		expect(Number.isFinite(sibTok)).toBe(true);
		// The capped serialization is a small fraction of the raw window estimate.
		expect(rawTokens).toBeGreaterThan(20_000);
		expect(sibTok).toBeLessThan(rawTokens / 5);
		// The capped serialization did NOT leak into the fold-coverage guard (that
		// would read as a partial fold and disable the route on every real window).
		expect(note).toContain("reason=sibling-cheaper");
		// The summary-output term is on the record too (both rates named).
		expect(note).toContain("outTok=8192");
		expect(note).toContain("sibOut=4");
		expect(note).toContain("sessOut=15");
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
