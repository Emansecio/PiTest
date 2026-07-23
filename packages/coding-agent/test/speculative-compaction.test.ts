/**
 * P2 — speculative compaction (mid-turn precompute + apply-only consumption).
 *
 * Hermetic: builds a CompactionController over a partial host with a REAL
 * in-memory SessionManager (so getBranch/getLeafId/appendCompaction/lineage are
 * real) and a FAKE streamFn (so `compact()` returns a canned summary without any
 * network call — the same shape compaction.test.ts uses). PIT_NO_STRUCTURAL_COMPACTION
 * forces the always-LLM path so the streamFn call-count is a meaningful proxy for
 * "the LLM summarization ran".
 */

import type { AgentMessage } from "@pit/agent-core";
import type { Api, Model, Usage } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CompactionController,
	type CompactionHost,
	clearSpeculativeCompaction,
	consumeSpeculativeCompaction,
	maybeStartSpeculativeCompaction,
	runAutoCompaction,
	SPECULATIVE_COMPACT_RATIO,
	type SpeculativeCompactionSlot,
	shouldPrecomputeSpeculativeCompaction,
	startSpeculativeCompaction,
} from "../src/core/agent-session-compaction.ts";
import { type CompactionSettings, computeDynamicReserve } from "../src/core/compaction/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const MODEL: Model<"anthropic-messages"> = {
	id: "claude-opus-4-8",
	name: "Claude Opus 4.8",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	contextWindow: 200_000,
	maxTokens: 8192,
};

const SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16_384,
	keepRecentTokens: 1, // tiny → almost everything is a summarizable span
	selfCorrection: false, // skip the verify LLM pass; one streamFn call per compact()
};

function mockUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userMsg(text: string, ts: number): AgentMessage {
	return { role: "user", content: text, timestamp: ts } as AgentMessage;
}

function assistantMsg(text: string, ts: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: mockUsage(2_000, 400),
		stopReason: "stop",
		timestamp: ts,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-8",
	} as unknown as AgentMessage;
}

interface Harness {
	ctx: CompactionController;
	sessionManager: SessionManager;
	entryIds: string[];
	streamCalls: () => number;
	events: Array<{ type: string }>;
	setHasHandlers: (fn: (name: string) => boolean) => void;
}

/** Build a controller whose host has a real seeded SessionManager + fake streamFn. */
function makeHarness(): Harness {
	const sessionManager = SessionManager.inMemory();
	const entryIds: string[] = [];
	// Seed three real user/assistant turns with enough prose to summarize.
	let ts = 1;
	for (let i = 0; i < 3; i++) {
		entryIds.push(sessionManager.appendMessage(userMsg(`question ${i} ${"lorem ".repeat(80)}`, ts++) as never));
		entryIds.push(sessionManager.appendMessage(assistantMsg(`answer ${i} ${"ipsum ".repeat(80)}`, ts++) as never));
	}
	const messages = sessionManager.buildSessionContext().messages;

	let streamCalls = 0;
	const fakeStreamFn = (() => {
		streamCalls++;
		const response = {
			role: "assistant",
			content: [{ type: "text", text: "## Goal\nfake speculative summary" }],
			usage: mockUsage(10, 10),
			stopReason: "stop",
			timestamp: Date.now(),
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-8",
		};
		return { result: async () => response };
	}) as never;

	const events: Array<{ type: string }> = [];
	let hasHandlers: (name: string) => boolean = () => false;

	const agentState = { messages };
	const host = {
		sessionId: "sess-1",
		model: MODEL,
		thinkingLevel: "low" as const,
		agent: { state: agentState, streamFn: fakeStreamFn, hasQueuedMessages: () => false },
		sessionManager,
		settingsManager: {
			getCompactionSettings: () => SETTINGS,
			getModelRoleSettings: () => ({ modelRoles: {} }),
			getThinkingBudgets: () => undefined,
		},
		extensionRunner: {
			hasHandlers: (name: string) => hasHandlers(name),
			emit: async () => undefined,
		},
		modelRegistry: {
			getAll: () => [MODEL] as Model<Api>[],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {} }),
		},
		hindsightBank: undefined,
		readDedupeStore: undefined,
		fileMtimeStore: undefined,
		pins: undefined,
		cwd: "/repo",
		isCompacting: false,
		isStreaming: false,
		emit: (event: { type: string }) => events.push(event),
		getCompactionRequestAuth: async () => ({ apiKey: "k", headers: {} }),
		disconnectFromAgent: () => {},
		reconnectToAgent: () => {},
		abort: async () => {},
	};

	const ctx = new CompactionController(host as unknown as CompactionHost);
	return {
		ctx,
		sessionManager,
		entryIds,
		streamCalls: () => streamCalls,
		events,
		setHasHandlers: (fn) => {
			hasHandlers = fn;
		},
	};
}

function hardThreshold(): number {
	return MODEL.contextWindow - computeDynamicReserve(MODEL.contextWindow, SETTINGS.reserveTokens);
}

afterEach(() => {
	vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Trigger predicate (band / ratio)
// ---------------------------------------------------------------------------

describe("shouldPrecomputeSpeculativeCompaction", () => {
	it("trips a band below the hard threshold, earlier than the prune (0.92) band", () => {
		const hard = hardThreshold();
		// Just above the speculative band → trips.
		expect(
			shouldPrecomputeSpeculativeCompaction(hard * SPECULATIVE_COMPACT_RATIO + 1, MODEL.contextWindow, SETTINGS),
		).toBe(true);
		// Well below the band → does not trip.
		expect(
			shouldPrecomputeSpeculativeCompaction(hard * SPECULATIVE_COMPACT_RATIO - 5_000, MODEL.contextWindow, SETTINGS),
		).toBe(false);
		// The speculative band sits below the 0.92*window mid-turn prune band.
		expect(hard * SPECULATIVE_COMPACT_RATIO).toBeLessThan(MODEL.contextWindow * 0.92);
	});

	it("is disabled when settings are off or the window is invalid", () => {
		expect(
			shouldPrecomputeSpeculativeCompaction(1_000_000, MODEL.contextWindow, { ...SETTINGS, enabled: false }),
		).toBe(false);
		expect(shouldPrecomputeSpeculativeCompaction(1_000_000, 0, SETTINGS)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// maybeStartSpeculativeCompaction — trigger guards
// ---------------------------------------------------------------------------

describe("maybeStartSpeculativeCompaction guards", () => {
	const trippingPressure = () => hardThreshold() * SPECULATIVE_COMPACT_RATIO + 5_000;

	it("does not start when the kill-switch is set", () => {
		vi.stubEnv("PIT_NO_SPECULATIVE_COMPACTION", "1");
		const h = makeHarness();
		maybeStartSpeculativeCompaction(h.ctx, {
			pressure: trippingPressure(),
			contextWindow: MODEL.contextWindow,
			settings: SETTINGS,
		});
		expect(h.ctx.speculative).toBeUndefined();
	});

	it("does not start below the band", () => {
		const h = makeHarness();
		maybeStartSpeculativeCompaction(h.ctx, {
			pressure: hardThreshold() * SPECULATIVE_COMPACT_RATIO - 10_000,
			contextWindow: MODEL.contextWindow,
			settings: SETTINGS,
		});
		expect(h.ctx.speculative).toBeUndefined();
	});

	it("does not start a second precompute while one is in flight", () => {
		const h = makeHarness();
		const existing: SpeculativeCompactionSlot = {
			promise: new Promise(() => {}),
			abort: new AbortController(),
			result: undefined, // in flight
			anchorLatestCompactionId: undefined,
			anchorLeafEntryId: h.entryIds.at(-1),
			tokensAtPrecompute: 1,
			customInstructionsAtX: undefined,
		};
		h.ctx.speculative = existing;
		maybeStartSpeculativeCompaction(h.ctx, {
			pressure: trippingPressure(),
			contextWindow: MODEL.contextWindow,
			settings: SETTINGS,
		});
		expect(h.ctx.speculative).toBe(existing);
	});

	it("does not start while a real/background compaction is in flight", () => {
		const h = makeHarness();
		h.ctx.backgroundCompactionPromise = Promise.resolve();
		maybeStartSpeculativeCompaction(h.ctx, {
			pressure: trippingPressure(),
			contextWindow: MODEL.contextWindow,
			settings: SETTINGS,
		});
		expect(h.ctx.speculative).toBeUndefined();
	});

	it("keeps a ready result whose window grew < 25% of the hard threshold", () => {
		const h = makeHarness();
		const base = trippingPressure();
		const ready: SpeculativeCompactionSlot = {
			promise: Promise.resolve(),
			abort: new AbortController(),
			result: { summary: "s", firstKeptEntryId: h.entryIds[0], tokensBefore: 100 },
			anchorLatestCompactionId: undefined,
			anchorLeafEntryId: h.entryIds.at(-1),
			tokensAtPrecompute: base,
			customInstructionsAtX: undefined,
		};
		h.ctx.speculative = ready;
		maybeStartSpeculativeCompaction(h.ctx, {
			pressure: base + hardThreshold() * 0.1, // +10% of hard
			contextWindow: MODEL.contextWindow,
			settings: SETTINGS,
		});
		expect(h.ctx.speculative).toBe(ready);
	});

	it("discards a ready result whose window grew > 25% of the hard threshold", () => {
		const h = makeHarness();
		const base = trippingPressure();
		const ready: SpeculativeCompactionSlot = {
			promise: Promise.resolve(),
			abort: new AbortController(),
			result: { summary: "s", firstKeptEntryId: h.entryIds[0], tokensBefore: 100 },
			anchorLatestCompactionId: undefined,
			anchorLeafEntryId: h.entryIds.at(-1),
			tokensAtPrecompute: base,
			customInstructionsAtX: undefined,
		};
		h.ctx.speculative = ready;
		maybeStartSpeculativeCompaction(h.ctx, {
			pressure: base + hardThreshold() * 0.26, // +26% of hard
			contextWindow: MODEL.contextWindow,
			settings: SETTINGS,
		});
		// Discarded this trip (a fresh one starts on the next trip).
		expect(h.ctx.speculative).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// startSpeculativeCompaction — precompute never applies
// ---------------------------------------------------------------------------

describe("startSpeculativeCompaction", () => {
	beforeEach(() => {
		vi.stubEnv("PIT_NO_STRUCTURAL_COMPACTION", "1");
	});

	it("computes a result WITHOUT mutating agent.state or the session entries", async () => {
		const h = makeHarness();
		const messagesBefore = h.ctx.host.agent.state.messages;
		const entryCountBefore = h.sessionManager.getEntries().length;

		await startSpeculativeCompaction(h.ctx, SETTINGS, hardThreshold() * SPECULATIVE_COMPACT_RATIO + 5_000);

		// A summary was pre-computed (the LLM ran once).
		expect(h.streamCalls()).toBeGreaterThanOrEqual(1);
		expect(h.ctx.speculative?.result?.summary).toContain("fake speculative summary");
		// agent.state.messages is the SAME array reference — nothing applied.
		expect(h.ctx.host.agent.state.messages).toBe(messagesBefore);
		// No compaction entry was appended.
		expect(h.sessionManager.getEntries().length).toBe(entryCountBefore);
		expect(h.sessionManager.getEntries().some((e) => e.type === "compaction")).toBe(false);
		// No session events were emitted by the precompute.
		expect(h.events).toHaveLength(0);
		// Anchors were captured.
		expect(h.ctx.speculative?.anchorLeafEntryId).toBe(h.entryIds.at(-1));
		expect(h.ctx.speculative?.anchorLatestCompactionId).toBeUndefined();
	});

	it("skips (no precompute) when a session_before_compact handler is registered", async () => {
		const h = makeHarness();
		h.setHasHandlers((name) => name === "session_before_compact");
		await startSpeculativeCompaction(h.ctx, SETTINGS, hardThreshold() * SPECULATIVE_COMPACT_RATIO + 5_000);
		expect(h.ctx.speculative).toBeUndefined();
		expect(h.streamCalls()).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Consumption — apply-only when valid, LLM otherwise
// ---------------------------------------------------------------------------

describe("runAutoCompaction consuming a speculative result", () => {
	beforeEach(() => {
		vi.stubEnv("PIT_NO_STRUCTURAL_COMPACTION", "1");
	});

	async function precompute(h: Harness): Promise<void> {
		await startSpeculativeCompaction(h.ctx, SETTINGS, hardThreshold() * SPECULATIVE_COMPACT_RATIO + 5_000);
		expect(h.ctx.speculative?.result).toBeDefined();
	}

	it("applies the precomputed summary apply-only (no extra LLM call) and clears the slot", async () => {
		const h = makeHarness();
		await precompute(h);
		const callsAfterPrecompute = h.streamCalls();

		const applied = await runAutoCompaction(h.ctx, "threshold", false);
		expect(applied).toBe(false); // no queued messages

		// The LLM was NOT called again — the summary was applied apply-only.
		expect(h.streamCalls()).toBe(callsAfterPrecompute);
		// A compaction entry carrying the precomputed summary now exists.
		const compactions = h.sessionManager.getEntries().filter((e) => e.type === "compaction");
		expect(compactions).toHaveLength(1);
		expect((compactions[0] as { summary: string }).summary).toContain("fake speculative summary");
		// Slot cleared after apply.
		expect(h.ctx.speculative).toBeUndefined();
	});

	it("invalidates (real LLM compaction) when a compaction was applied between X and Y", async () => {
		const h = makeHarness();
		await precompute(h);
		const callsAfterPrecompute = h.streamCalls();

		// A real compaction lands after the precompute (changes latest-compaction id).
		h.sessionManager.appendCompaction("interim summary", h.entryIds[0], 100, {}, false);

		await runAutoCompaction(h.ctx, "threshold", false);
		// The stale precompute was rejected → a fresh LLM compaction ran.
		expect(h.streamCalls()).toBeGreaterThan(callsAfterPrecompute);
		expect(h.ctx.speculative).toBeUndefined();
	});

	it("invalidates (real LLM compaction) after a branch/rewind moves the leaf off-path", async () => {
		const h = makeHarness();
		await precompute(h);
		const callsAfterPrecompute = h.streamCalls();

		// Rewind to an earlier entry: the anchored leaf is no longer on the active path.
		h.sessionManager.branch(h.entryIds[1]);

		await runAutoCompaction(h.ctx, "threshold", false);
		expect(h.streamCalls()).toBeGreaterThan(callsAfterPrecompute);
		expect(h.ctx.speculative).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// consumeSpeculativeCompaction — direct validation unit tests
// ---------------------------------------------------------------------------

describe("consumeSpeculativeCompaction validation", () => {
	function readySlot(h: Harness, over: Partial<SpeculativeCompactionSlot> = {}): SpeculativeCompactionSlot {
		return {
			promise: Promise.resolve(),
			abort: new AbortController(),
			result: { summary: "ready", firstKeptEntryId: h.entryIds[0], tokensBefore: 100 },
			anchorLatestCompactionId: undefined,
			anchorLeafEntryId: h.entryIds.at(-1),
			tokensAtPrecompute: 1,
			customInstructionsAtX: undefined,
			...over,
		};
	}

	it("returns the result and clears the slot when all anchors hold", () => {
		const h = makeHarness();
		h.ctx.speculative = readySlot(h);
		const result = consumeSpeculativeCompaction(h.ctx, undefined);
		expect(result?.summary).toBe("ready");
		expect(h.ctx.speculative).toBeUndefined();
	});

	it("rejects when custom instructions differ", () => {
		const h = makeHarness();
		h.ctx.speculative = readySlot(h, { customInstructionsAtX: undefined });
		const result = consumeSpeculativeCompaction(h.ctx, "focus on X");
		expect(result).toBeUndefined();
		expect(h.ctx.speculative).toBeUndefined();
	});

	it("rejects (and aborts) an in-flight precompute without waiting", () => {
		const h = makeHarness();
		const abort = new AbortController();
		h.ctx.speculative = readySlot(h, { result: undefined, abort });
		const result = consumeSpeculativeCompaction(h.ctx, undefined);
		expect(result).toBeUndefined();
		expect(abort.signal.aborted).toBe(true);
		expect(h.ctx.speculative).toBeUndefined();
	});

	it("rejects when the anchored leaf is no longer on the active path", () => {
		const h = makeHarness();
		h.ctx.speculative = readySlot(h, { anchorLeafEntryId: "nonexistent-entry" });
		const result = consumeSpeculativeCompaction(h.ctx, undefined);
		expect(result).toBeUndefined();
		expect(h.ctx.speculative).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// clearSpeculativeCompaction — lifecycle (abort)
// ---------------------------------------------------------------------------

describe("clearSpeculativeCompaction", () => {
	it("aborts the in-flight controller and drops the slot", () => {
		const h = makeHarness();
		const abort = new AbortController();
		h.ctx.speculative = {
			promise: new Promise(() => {}),
			abort,
			result: undefined,
			anchorLatestCompactionId: undefined,
			anchorLeafEntryId: h.entryIds.at(-1),
			tokensAtPrecompute: 1,
			customInstructionsAtX: undefined,
		};
		clearSpeculativeCompaction(h.ctx);
		expect(abort.signal.aborted).toBe(true);
		expect(h.ctx.speculative).toBeUndefined();
	});

	it("is a no-op when there is no slot", () => {
		const h = makeHarness();
		expect(() => clearSpeculativeCompaction(h.ctx)).not.toThrow();
		expect(h.ctx.speculative).toBeUndefined();
	});
});
