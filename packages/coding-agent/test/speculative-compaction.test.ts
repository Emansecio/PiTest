/**
 * P2 — speculative compaction (mid-turn precompute + apply-only consumption).
 *
 * Hermetic: builds a CompactionController over a partial host with a REAL
 * in-memory SessionManager (so getBranch/getLeafId/appendCompaction/lineage are
 * real) and a FAKE streamFn (so `compact()` returns a canned summary without any
 * network call — the same shape compaction.test.ts uses). PIT_NO_STRUCTURAL_COMPACTION
 * forces the always-LLM path so the streamFn call-count is a meaningful proxy for
 * "the LLM summarization ran".
 *
 * The default harness models the configuration that ACTUALLY SHIPS: a
 * `session_before_compact` OBSERVER is registered (the built-in read-guard is in
 * every bundle) and no mutator. Tests that need a mutator opt in explicitly. The
 * previous default — "no handlers at all" — never occurs in a real session, and
 * hiding behind it is what let the precompute be dead code in production while
 * this suite stayed green.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@pit/agent-core";
import type { Api, Model, Usage } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CompactionController,
	type CompactionHost,
	clearSpeculativeCompaction,
	compactSession,
	consumeSpeculativeCompaction,
	executeCompactionPipeline,
	maybeStartSpeculativeCompaction,
	runAutoCompaction,
	SPECULATIVE_COMPACT_RATIO,
	type SpeculativeCompactionSlot,
	shouldPrecomputeSpeculativeCompaction,
	speculativeCutIsAtLeastAsDeep,
	startSpeculativeCompaction,
} from "../src/core/agent-session-compaction.ts";
import { createReadGuardExtension } from "../src/core/built-ins/read-guard-extension.ts";
import { type CompactionSettings, computeDynamicReserve } from "../src/core/compaction/index.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { Extension, ExtensionAPI, SessionBeforeCompactResult } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

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
	/** Every event the host's extension runner was asked to emit, in order. */
	emitted: Array<{ type: string }>;
	/**
	 * Register a MUTATING `session_before_compact` handler (one that can cancel or
	 * replace the summary). Default harness has only an observer.
	 */
	setMutatingBeforeCompact: (result?: SessionBeforeCompactResult) => void;
	/** Remove every `session_before_compact` handler (no observer, no mutator). */
	clearBeforeCompactHandlers: () => void;
}

interface HarnessOptions {
	/** Swap in a real ExtensionRunner instead of the mock (integration tests). */
	extensionRunner?: ExtensionRunner;
}

/** Build a controller whose host has a real seeded SessionManager + fake streamFn. */
function makeHarness(options: HarnessOptions = {}): Harness {
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
	const emitted: Array<{ type: string }> = [];
	// Ships-by-default shape: the read-guard observer is registered, nothing mutating.
	let hasObserver = true;
	let mutatingResult: SessionBeforeCompactResult | undefined;
	let hasMutator = false;
	const mockRunner = {
		hasHandlers: (name: string) => name === "session_before_compact" && (hasObserver || hasMutator),
		hasMutatingHandlers: (name: string) => name === "session_before_compact" && hasMutator,
		emit: async (event: { type: string }) => {
			emitted.push(event);
			if (event.type === "session_before_compact" && hasMutator) return mutatingResult;
			return undefined;
		},
	};

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
		extensionRunner: options.extensionRunner ?? mockRunner,
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
		emitted,
		setMutatingBeforeCompact: (result) => {
			hasMutator = true;
			mutatingResult = result;
		},
		clearBeforeCompactHandlers: () => {
			hasObserver = false;
			hasMutator = false;
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

	it("RUNS with the shipped bundle shape: a session_before_compact OBSERVER present", async () => {
		const h = makeHarness();
		// Exactly what every real session looks like: read-guard registered.
		expect(h.ctx.host.extensionRunner.hasHandlers("session_before_compact")).toBe(true);
		expect(h.ctx.host.extensionRunner.hasMutatingHandlers("session_before_compact")).toBe(false);

		await startSpeculativeCompaction(h.ctx, SETTINGS, hardThreshold() * SPECULATIVE_COMPACT_RATIO + 5_000);

		expect(h.ctx.speculative?.result?.summary).toContain("fake speculative summary");
		// The precompute itself must NOT emit the event (it has no authority to run
		// observers on a summary that may never be applied).
		expect(h.emitted).toHaveLength(0);
	});

	it("skips (no precompute) when a MUTATING session_before_compact handler is registered", async () => {
		const h = makeHarness();
		h.setMutatingBeforeCompact();
		await startSpeculativeCompaction(h.ctx, SETTINGS, hardThreshold() * SPECULATIVE_COMPACT_RATIO + 5_000);
		expect(h.ctx.speculative).toBeUndefined();
		expect(h.streamCalls()).toBe(0);
	});

	it("skips (no precompute) when the kill-switch is set", async () => {
		vi.stubEnv("PIT_NO_SPECULATIVE_COMPACTION", "1");
		const h = makeHarness();
		await startSpeculativeCompaction(h.ctx, SETTINGS, hardThreshold() * SPECULATIVE_COMPACT_RATIO + 5_000);
		expect(h.ctx.speculative).toBeUndefined();
		expect(h.streamCalls()).toBe(0);
	});

	it("honours a truthy (non-'1') kill-switch value", async () => {
		vi.stubEnv("PIT_NO_SPECULATIVE_COMPACTION", "true");
		const h = makeHarness();
		maybeStartSpeculativeCompaction(h.ctx, {
			pressure: hardThreshold() * SPECULATIVE_COMPACT_RATIO + 5_000,
			contextWindow: MODEL.contextWindow,
			settings: SETTINGS,
		});
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

	it("EMITS session_before_compact when applying a precomputed summary (read-guard must not regress)", async () => {
		const h = makeHarness();
		await precompute(h);
		expect(h.emitted).toHaveLength(0); // precompute stayed silent
		const callsAfterPrecompute = h.streamCalls();

		await runAutoCompaction(h.ctx, "threshold", false);

		// Apply-only (no second LLM call) AND the observers still got their event.
		expect(h.streamCalls()).toBe(callsAfterPrecompute);
		expect(h.emitted.filter((e) => e.type === "session_before_compact")).toHaveLength(1);
		// Order: the before-event precedes session_compact (i.e. it ran before the
		// summary was appended to the session).
		const types = h.emitted.map((e) => e.type);
		expect(types.indexOf("session_before_compact")).toBeLessThan(types.indexOf("session_compact"));
	});

	it("discards the precompute and runs the normal flow when a mutator appears before apply", async () => {
		const h = makeHarness();
		await precompute(h);
		const callsAfterPrecompute = h.streamCalls();

		// An extension with a mutating handler shows up after the precompute started.
		h.setMutatingBeforeCompact();

		await runAutoCompaction(h.ctx, "threshold", false);

		// The precomputed summary was NOT applied — a fresh LLM compaction ran and
		// the mutator was consulted.
		expect(h.streamCalls()).toBeGreaterThan(callsAfterPrecompute);
		expect(h.emitted.filter((e) => e.type === "session_before_compact")).toHaveLength(1);
		expect(h.ctx.speculative).toBeUndefined();
	});

	it("emits nothing when no session_before_compact handler is registered at all", async () => {
		const h = makeHarness();
		h.clearBeforeCompactHandlers();
		await precompute(h);
		const callsAfterPrecompute = h.streamCalls();

		await executeCompactionPipeline(h.ctx, {
			preparation: {
				firstKeptEntryId: h.entryIds[0],
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 100,
			} as never,
			pathEntries: h.sessionManager.getBranch(),
			model: MODEL,
			apiKey: "k",
			headers: {},
			abortSignal: new AbortController().signal,
			precomputed: consumeSpeculativeCompaction(h.ctx, undefined),
		});

		expect(h.streamCalls()).toBe(callsAfterPrecompute); // apply-only
		expect(h.emitted.filter((e) => e.type === "session_before_compact")).toHaveLength(0);
	});

	it("lets a mutator REPLACE the summary even when a precompute was waiting", async () => {
		const h = makeHarness();
		await precompute(h);
		h.setMutatingBeforeCompact({
			compaction: {
				summary: "extension-authored summary",
				firstKeptEntryId: h.entryIds[0],
				tokensBefore: 100,
				details: {},
			},
		});

		await runAutoCompaction(h.ctx, "threshold", false);

		const compactions = h.sessionManager.getEntries().filter((e) => e.type === "compaction");
		expect(compactions).toHaveLength(1);
		expect((compactions[0] as { summary: string }).summary).toContain("extension-authored summary");
		expect((compactions[0] as { summary: string }).summary).not.toContain("fake speculative summary");
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
// Manual /compact consuming a speculative result
// ---------------------------------------------------------------------------

describe("speculativeCutIsAtLeastAsDeep", () => {
	const entries = [{ id: "a" }, { id: "b" }, { id: "c" }] as never;

	it("accepts an equal or deeper slot cut, rejects a shallower one", () => {
		expect(speculativeCutIsAtLeastAsDeep(entries, "b", "b")).toBe(true); // same cut
		expect(speculativeCutIsAtLeastAsDeep(entries, "c", "b")).toBe(true); // slot folds more
		expect(speculativeCutIsAtLeastAsDeep(entries, "a", "b")).toBe(false); // slot folds less
	});

	it("rejects unknown ids (no slot, or either id off the branch)", () => {
		expect(speculativeCutIsAtLeastAsDeep(entries, undefined, "b")).toBe(false);
		expect(speculativeCutIsAtLeastAsDeep(entries, "zzz", "b")).toBe(false);
		expect(speculativeCutIsAtLeastAsDeep(entries, "c", "zzz")).toBe(false);
	});
});

describe("compactSession (manual /compact) consuming a speculative result", () => {
	beforeEach(() => {
		vi.stubEnv("PIT_NO_STRUCTURAL_COMPACTION", "1");
	});

	async function precompute(h: Harness): Promise<void> {
		await startSpeculativeCompaction(h.ctx, SETTINGS, hardThreshold() * SPECULATIVE_COMPACT_RATIO + 5_000);
		expect(h.ctx.speculative?.result).toBeDefined();
	}

	it("applies the ready summary apply-only — no second LLM call", async () => {
		const h = makeHarness();
		await precompute(h);
		const callsAfterPrecompute = h.streamCalls();

		const result = await compactSession(h.ctx);

		expect(h.streamCalls()).toBe(callsAfterPrecompute);
		expect(result.summary).toContain("fake speculative summary");
		const compactions = h.sessionManager.getEntries().filter((e) => e.type === "compaction");
		expect(compactions).toHaveLength(1);
		expect((compactions[0] as { summary: string }).summary).toContain("fake speculative summary");
		expect(h.ctx.speculative).toBeUndefined();
		// Observers still ran on the apply-only path (read-guard migration).
		expect(h.emitted.filter((e) => e.type === "session_before_compact")).toHaveLength(1);
	});

	it("never reuses the slot when the user passed custom instructions", async () => {
		const h = makeHarness();
		await precompute(h);
		const callsAfterPrecompute = h.streamCalls();

		await compactSession(h.ctx, "focus on the parser bug");

		// A fresh summarization ran: the precompute was generated without that focus.
		expect(h.streamCalls()).toBeGreaterThan(callsAfterPrecompute);
		expect(h.ctx.speculative).toBeUndefined();
	});

	it("ignores a slot whose cut is SHALLOWER than the manual one", async () => {
		const h = makeHarness();
		await precompute(h);
		const callsAfterPrecompute = h.streamCalls();
		// Rewrite the ready slot so it keeps everything from the first entry on — a
		// far gentler fold than the usage-scaled manual cut.
		const slot = h.ctx.speculative;
		if (!slot?.result) throw new Error("precompute missing");
		slot.result = { ...slot.result, firstKeptEntryId: h.entryIds[0] };

		await compactSession(h.ctx);

		// The shallower slot was not applied — the manual compaction paid its own call.
		expect(h.streamCalls()).toBeGreaterThan(callsAfterPrecompute);
		const compactions = h.sessionManager.getEntries().filter((e) => e.type === "compaction");
		expect(compactions).toHaveLength(1);
		expect((compactions[0] as { firstKeptEntryId: string }).firstKeptEntryId).not.toBe(h.entryIds[0]);
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

// ---------------------------------------------------------------------------
// Bundle-shape integration: the REAL read-guard extension over the REAL
// ExtensionRunner. No API key, no network — the fake streamFn still stands in
// for the summarizer. This is the test that would have caught the original bug:
// the precompute must run with the guard chain that actually ships, and applying
// a precomputed summary must still emit session_before_compact so the guard
// migrates its read set (otherwise every post-compaction edit is blocked).
// ---------------------------------------------------------------------------

describe("speculative compaction with the real read-guard extension", () => {
	beforeEach(() => {
		vi.stubEnv("PIT_NO_STRUCTURAL_COMPACTION", "1");
	});

	const tmpDirs: string[] = [];
	afterEach(() => {
		while (tmpDirs.length > 0) {
			const dir = tmpDirs.pop();
			if (!dir) continue;
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* ignore Windows handle race */
			}
		}
	});

	/** A real ExtensionRunner holding the real read-guard extension. */
	function makeRealRunner(cwd: string): ExtensionRunner {
		const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
		const shim = {
			on(event: string, handler: (event: any, ctx: any) => any) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
		} as unknown as ExtensionAPI;
		createReadGuardExtension({ cwd })(shim);

		const extension: Extension = {
			path: "<built-in:read-guard>",
			resolvedPath: "<built-in:read-guard>",
			sourceInfo: createSyntheticSourceInfo("<built-in:read-guard>", { source: "built-in" }),
			handlers: handlers as Extension["handlers"],
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};

		return new ExtensionRunner(
			[extension],
			createExtensionRuntime(),
			cwd,
			SessionManager.inMemory(),
			{} as never, // modelRegistry: never touched by the read-guard
		);
	}

	function makeCwd(): string {
		const dir = mkdtempSync(join(tmpdir(), "pit-spec-compact-"));
		tmpDirs.push(dir);
		return dir;
	}

	it("classifies the shipped read-guard handler as an observer, not a mutator", () => {
		const runner = makeRealRunner(makeCwd());
		expect(runner.hasHandlers("session_before_compact")).toBe(true);
		expect(runner.hasMutatingHandlers("session_before_compact")).toBe(false);
	});

	it("precomputes with the real guard registered, and the apply path still migrates its read set", async () => {
		const cwd = makeCwd();
		const runner = makeRealRunner(cwd);
		const h = makeHarness({ extensionRunner: runner });

		const file = join(cwd, "sample.ts");
		writeFileSync(file, "export const value = 1;\n");
		// The model reads the file BEFORE compaction: the guard tracks it in `readFiles`.
		await runner.emitToolCall({ toolName: "read", input: { path: file } } as never);

		// 1. The precompute actually runs (this was dead code before the fix).
		await startSpeculativeCompaction(h.ctx, SETTINGS, hardThreshold() * SPECULATIVE_COMPACT_RATIO + 5_000);
		expect(h.ctx.speculative?.result?.summary).toContain("fake speculative summary");
		const callsAfterPrecompute = h.streamCalls();

		// 2. Applying it is apply-only (no second LLM call) …
		await runAutoCompaction(h.ctx, "threshold", false);
		expect(h.streamCalls()).toBe(callsAfterPrecompute);
		expect(h.sessionManager.getEntries().filter((e) => e.type === "compaction")).toHaveLength(1);

		// 3. … and the guard was still told to migrate `readFiles` → stat snapshots,
		// which puts it in POST-COMPACT mode for this file. Proof: an edit whose
		// oldText does not match the file verbatim is now blocked (the model only
		// carried a lossy summary across the fold). Before the fix the apply path
		// skipped the emit, `readFiles` still held the path, and this edit sailed
		// through unchecked.
		const stale = await runner.emitToolCall({
			toolName: "edit",
			input: { path: file, oldText: "export const value = 999;", newText: "nope" },
		} as never);
		expect(stale?.block).toBe(true);
		expect(String(stale?.reason)).toContain("post-compact mismatch");
	});

	it("still allows a verbatim-anchored edit after the precomputed summary is applied", async () => {
		const cwd = makeCwd();
		const runner = makeRealRunner(cwd);
		const h = makeHarness({ extensionRunner: runner });

		const file = join(cwd, "sample.ts");
		writeFileSync(file, "export const value = 1;\n");
		await runner.emitToolCall({ toolName: "read", input: { path: file } } as never);

		await startSpeculativeCompaction(h.ctx, SETTINGS, hardThreshold() * SPECULATIVE_COMPACT_RATIO + 5_000);
		await runAutoCompaction(h.ctx, "threshold", false);

		const ok = await runner.emitToolCall({
			toolName: "edit",
			input: { path: file, oldText: "export const value = 1;", newText: "export const value = 2;" },
		} as never);
		expect(ok?.block).toBeUndefined();
	});
});
