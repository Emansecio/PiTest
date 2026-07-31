import type { AgentMessage } from "@pit/agent-core";
import { Agent } from "@pit/agent-core";
import { getModel, getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

/** Multi-line, non-JSON filler so headTailExcerpt actually shrinks it under prune. */
function blob(nChars: number, head = "HEAD", tail = "TAIL"): string {
	const line = "filler line of dense text\n"; // 26 chars
	const repeats = Math.ceil(nChars / line.length);
	return `${head}\n${line.repeat(repeats)}${tail}`;
}

function toolCall(name: string, id: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		timestamp: 1,
	} as AgentMessage;
}

function toolResult(toolName: string, toolCallId: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	} as AgentMessage;
}

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function textAt(messages: AgentMessage[], i: number): string {
	return (messages[i] as unknown as { content: { text: string }[] }).content[0].text;
}

function makeSession(modelId: "claude-sonnet-5" | "claude-haiku-4-5"): AgentSession {
	const model = getModel("anthropic", modelId)!;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: "You are helpful.", tools: [], thinkingLevel: "off" },
	});
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	return new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory(),
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});
}

function pruneWire(session: AgentSession, messages: AgentMessage[]): AgentMessage[] {
	// Cast to reach the private wire-prune method under test.
	return (session as any)._pruneContextForProvider(messages);
}

function deferCount(): number {
	return getRuntimeDiagnostics().counters["prune.economics-defer"]?.count ?? 0;
}

function proactiveCount(): number {
	return getRuntimeDiagnostics().counters["prune.proactive"]?.count ?? 0;
}

function supersedeCount(): number {
	return getRuntimeDiagnostics().counters["prune.supersede-only"]?.count ?? 0;
}

describe("_pruneContextForProvider — cache-economics deferral", () => {
	afterEach(() => {
		resetRuntimeDiagnostics();
		delete process.env.PIT_NO_PRUNE_CACHE_ECONOMICS;
		delete process.env.PIT_MID_TURN_PRESSURE_RATIO;
		delete process.env.PIT_PROACTIVE_PRUNE_FLOOR;
	});

	/** Big old size-prunable result + huge protected recent tail → reclaim can't earn back the invalidation. */
	function comfortableDeferScenario(): AgentMessage[] {
		return [
			user("task"),
			toolCall("read", "cbig", { path: "big.ts" }),
			toolResult("read", "cbig", blob(70_000, "BIG_HEAD", "BIG_TAIL")), // unprotected (turn 1), size-prunable
			user("t2"),
			toolCall("read", "chuge", { path: "huge.ts" }),
			toolResult("read", "chuge", blob(250_000, "HUGE_HEAD", "HUGE_TAIL")), // protected recent → inflates tail
			user("t3"),
		];
	}

	it("defers the size-prune below pressure and records a prune.economics-defer diagnostic", () => {
		resetRuntimeDiagnostics();
		// Drop the proactive floor so a modest transcript reaches the size-prune branch
		// while occupancy (~10%) stays far below the pressure ratio (comfortable band).
		process.env.PIT_PROACTIVE_PRUNE_FLOOR = "1000";
		const session = makeSession("claude-sonnet-5");
		const messages = comfortableDeferScenario();
		const before = textAt(messages, 2);

		const out = pruneWire(session, messages);

		// The big old result was NOT pruned — the prune was deferred.
		expect(textAt(out, 2)).toBe(before);
		expect(deferCount()).toBeGreaterThanOrEqual(1);
		expect(proactiveCount()).toBe(0);
		// Nothing else reclaimed → the array is returned unchanged.
		expect(out).toBe(messages);
	});

	it("prunes as before when PIT_NO_PRUNE_CACHE_ECONOMICS=1 (kill-switch restores old behavior)", () => {
		resetRuntimeDiagnostics();
		process.env.PIT_PROACTIVE_PRUNE_FLOOR = "1000";
		process.env.PIT_NO_PRUNE_CACHE_ECONOMICS = "1";
		const session = makeSession("claude-sonnet-5");
		const messages = comfortableDeferScenario();
		const before = textAt(messages, 2);

		const out = pruneWire(session, messages);

		// With the guard disabled the big old result is size-pruned (shrinks) and no deferral fires.
		expect(textAt(out, 2).length).toBeLessThan(before.length);
		expect(textAt(out, 2)).toContain("BIG_HEAD");
		expect(deferCount()).toBe(0);
		expect(proactiveCount()).toBeGreaterThanOrEqual(1);
	});

	it("never defers in the pressure band — the prune runs unconditionally", () => {
		resetRuntimeDiagnostics();
		// Clamp floor of the pressure ratio is 0.5; a 200k-window model with a huge
		// resident tail crosses it on modest token counts.
		process.env.PIT_MID_TURN_PRESSURE_RATIO = "0.5";
		const session = makeSession("claude-haiku-4-5");
		const messages: AgentMessage[] = [
			user("task"),
			toolCall("read", "cbig", { path: "big.ts" }),
			toolResult("read", "cbig", blob(70_000, "BIG_HEAD", "BIG_TAIL")),
			toolCall("read", "chuge", { path: "huge.ts" }),
			toolResult("read", "chuge", blob(520_000, "HUGE_HEAD", "HUGE_TAIL")), // pushes occupancy over 0.5
			user("t2"),
			user("t3"),
		];
		const before = textAt(messages, 2);

		const out = pruneWire(session, messages);

		// Pressure band: the big result is pruned (not deferred), no economics-defer.
		expect(textAt(out, 2).length).toBeLessThan(before.length);
		expect(deferCount()).toBe(0);
	});

	/**
	 * P2-6 — a DUPLICATE (pure economy: the fresh copy is already in context) in
	 * the middle of the history, with a huge cached tail behind it. Collapsing it
	 * reclaims a few thousand tokens and cold-writes the whole tail.
	 */
	function duplicateWithHugeTailScenario(dup: string): AgentMessage[] {
		return [
			user("task"),
			toolCall("read", "c1", { path: "dup.ts" }),
			toolResult("read", "c1", dup), // [2] superseded by c2 — duplicate class
			toolCall("read", "c2", { path: "dup.ts" }),
			toolResult("read", "c2", "fresh"), // [4] supersedes c1
			toolCall("read", "c3", { path: "huge.ts" }),
			toolResult("read", "c3", blob(250_000, "HUGE_HEAD", "HUGE_TAIL")), // [6] tail the collapse invalidates
			user("t2"),
			user("t3"),
		];
	}

	it("defers the DUPLICATE supersede collapse when it can't earn back the cached tail (P2-6)", () => {
		resetRuntimeDiagnostics();
		const session = makeSession("claude-sonnet-5");
		const dup = blob(16_000, "DUP_HEAD", "DUP_TAIL");
		const messages = duplicateWithHugeTailScenario(dup);

		const out = pruneWire(session, messages);

		// Duplicate/N4 is a size play: below pressure it waits instead of
		// cold-writing ~60k tokens of cached tail to reclaim ~4k.
		expect(textAt(out, 2)).toBe(dup);
		expect(out).toBe(messages);
		expect(supersedeCount()).toBe(0);
		expect(deferCount()).toBeGreaterThanOrEqual(1);
	});

	it("collapses the duplicate anyway when PIT_NO_PRUNE_CACHE_ECONOMICS=1", () => {
		resetRuntimeDiagnostics();
		process.env.PIT_NO_PRUNE_CACHE_ECONOMICS = "1";
		const session = makeSession("claude-sonnet-5");
		const dup = blob(16_000, "DUP_HEAD", "DUP_TAIL");
		const messages = duplicateWithHugeTailScenario(dup);

		const out = pruneWire(session, messages);

		expect(textAt(out, 2).length).toBeLessThan(dup.length);
		expect(textAt(out, 2)).toContain("DUP_HEAD");
		expect(supersedeCount()).toBeGreaterThanOrEqual(1);
		expect(deferCount()).toBe(0);
	});

	it("collapses the duplicate when the reclaim covers the invalidated tail", () => {
		resetRuntimeDiagnostics();
		const session = makeSession("claude-sonnet-5");
		// The duplicate IS the tail: reclaiming ~55k tokens leaves almost nothing to
		// cold-write, so the economy half pays for itself immediately.
		const dup = blob(200_000, "DUP_HEAD", "DUP_TAIL");
		const messages: AgentMessage[] = [
			user("task"),
			toolCall("read", "c1", { path: "dup.ts" }),
			toolResult("read", "c1", dup), // [2] superseded by c2
			toolCall("read", "c2", { path: "dup.ts" }),
			toolResult("read", "c2", "fresh"), // [4]
			user("t2"),
			user("t3"),
		];

		const out = pruneWire(session, messages);

		expect(textAt(out, 2).length).toBeLessThan(dup.length);
		expect(textAt(out, 2)).toContain("DUP_HEAD");
		expect(supersedeCount()).toBeGreaterThanOrEqual(1);
		expect(deferCount()).toBe(0);
	});

	it("never defers the M11 write-invalidation collapse — correction, not size play", () => {
		resetRuntimeDiagnostics();
		const session = makeSession("claude-sonnet-5");
		const stale = blob(16_000, "STALE_HEAD", "STALE_TAIL");
		const messages: AgentMessage[] = [
			user("task"),
			toolCall("read", "c1", { path: "mutated.ts" }),
			toolResult("read", "c1", stale), // [2] invalidated by the write below (M11)
			toolCall("write", "c2", { path: "mutated.ts", content: "new body" }),
			toolResult("write", "c2", "ok"), // [4] successful mutation
			toolCall("read", "c3", { path: "huge.ts" }),
			toolResult("read", "c3", blob(250_000, "HUGE_HEAD", "HUGE_TAIL")), // [6] huge tail — economics would veto
			user("t2"),
			user("t3"),
		];

		const out = pruneWire(session, messages);

		// The disk contradicts this read: it collapses whatever the cache costs,
		// with the cause marker naming the mutated path.
		expect(textAt(out, 2).length).toBeLessThan(stale.length);
		expect(textAt(out, 2)).toContain("STALE_HEAD");
		expect(textAt(out, 2)).toContain("mutated.ts was modified by a later write/edit");
		expect(supersedeCount()).toBeGreaterThanOrEqual(1);
	});

	it("still applies the M11 supersede collapse when the size-prune is deferred", () => {
		resetRuntimeDiagnostics();
		process.env.PIT_PROACTIVE_PRUNE_FLOOR = "1000";
		const session = makeSession("claude-sonnet-5");
		const stale = blob(16_000, "STALE_HEAD", "STALE_TAIL"); // below size threshold → only supersede reclaims it
		const big = blob(70_000, "BIG_HEAD", "BIG_TAIL"); // non-superseded size-prunable → drives the deferred prune
		const messages: AgentMessage[] = [
			user("task"),
			toolCall("read", "c1", { path: "mutated.ts" }),
			toolResult("read", "c1", stale), // [2] M11-invalidated
			toolCall("write", "c2", { path: "mutated.ts", content: "new body" }),
			toolResult("write", "c2", "ok"), // [4]
			toolCall("read", "c3", { path: "big.ts" }),
			toolResult("read", "c3", big), // [6] size-prunable, non-superseded
			user("t2"),
			toolCall("read", "c4", { path: "huge.ts" }),
			toolResult("read", "c4", blob(250_000, "HUGE_HEAD", "HUGE_TAIL")), // [9] protected recent tail
			user("t3"),
		];

		const out = pruneWire(session, messages);

		// Size-prune deferred: the big non-superseded result is untouched…
		expect(textAt(out, 6)).toBe(big);
		expect(deferCount()).toBeGreaterThanOrEqual(1);
		expect(proactiveCount()).toBe(0);
		// …but the write-invalidated read is STILL collapsed (correction never defers).
		expect(textAt(out, 2).length).toBeLessThan(stale.length);
		expect(textAt(out, 2)).toContain("STALE_HEAD");
		expect(supersedeCount()).toBeGreaterThanOrEqual(1);
	});
});
