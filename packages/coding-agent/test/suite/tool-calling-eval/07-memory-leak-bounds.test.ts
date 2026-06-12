/**
 * Memory-leak bounds on the per-session error/hint bookkeeping.
 *
 * Two low-severity leaks that only surface in long sessions:
 *
 *  B15. `_hintsByToolCallId` is drained per-callId in `_handleToolExecutionEnd`,
 *       but a turn aborted between hint-applied and execution-end leaves an
 *       orphan entry that nothing collects. `agent_end` now clears it alongside
 *       its sibling maps (`_toolCallArgsByCallId`, `_rejectedToolCallIds`).
 *
 *  B16. `_learnedErrors` mints one key per (tool + fingerprint). The fingerprint
 *       normalizes only digits, so path/identifier-varied errors create unbounded
 *       distinct keys. An LRU cap (`MAX_LEARNED_ERRORS`) evicts the coldest entry
 *       when a new key would overflow.
 */

import type { AgentEvent } from "@pit/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { createReadTool } from "../../../src/core/tools/index.js";
import { createHarness, type Harness } from "../harness.js";

// Keep in sync with MAX_LEARNED_ERRORS in agent-session.ts. The constant is not
// exported (module-private), so we mirror the value here.
const MAX_LEARNED_ERRORS = 500;

type SessionInternals = {
	_emitExtensionEvent: (event: AgentEvent) => Promise<void>;
	_handleToolExecutionStart: (event: Extract<AgentEvent, { type: "tool_execution_start" }>) => void;
	_handleToolExecutionEnd: (event: Extract<AgentEvent, { type: "tool_execution_end" }>) => void;
	_hintsByToolCallId: Map<string, string[]>;
	_learnedErrors: Map<string, unknown>;
};

function internals(harness: Harness): SessionInternals {
	return harness.session as unknown as SessionInternals;
}

// Drive the full start→end pair the real agent loop emits, so the end handler
// sees the args captured at start (matches production; the cross-error reminder
// fingerprints those args).
function failOnce(session: SessionInternals, toolCallId: string, text: string): void {
	session._handleToolExecutionStart({
		type: "tool_execution_start",
		toolCallId,
		toolName: "read",
		args: { path: `/x/${toolCallId}` },
	});
	session._handleToolExecutionEnd({
		type: "tool_execution_end",
		toolCallId,
		toolName: "read",
		result: { content: [{ type: "text", text }] },
		isError: true,
	});
}

describe("memory-leak bounds (e2e)", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) {
			await harnesses.pop()?.cleanup();
		}
	});

	it("B15: clears _hintsByToolCallId on agent_end (orphan from aborted turn)", async () => {
		const harness = await createHarness({ tools: [createReadTool(process.cwd())] });
		harnesses.push(harness);
		const session = internals(harness);

		// Simulate a hint applied to an in-flight call whose execution-end never
		// arrives (turn aborted) — the entry would otherwise leak for the session.
		await session._emitExtensionEvent({
			type: "tool_error_hint_applied",
			toolCallId: "orphan-call-1",
			toolName: "read",
			hints: [{ ruleId: "rule-a", hint: "try again" }],
		});
		expect(session._hintsByToolCallId.size).toBe(1);

		await session._emitExtensionEvent({ type: "agent_end", messages: [] });
		expect(session._hintsByToolCallId.size).toBe(0);
	});

	it("B16: caps _learnedErrors at MAX_LEARNED_ERRORS, evicting the coldest", async () => {
		const harness = await createHarness({ tools: [createReadTool(process.cwd())] });
		harnesses.push(harness);
		const session = internals(harness);

		// Each error text carries a distinct non-digit token, so the fingerprint
		// (which only normalizes digits) is unique → a new key every time.
		const distinctKeys = MAX_LEARNED_ERRORS + 50;
		for (let i = 0; i < distinctKeys; i++) {
			failOnce(session, `call-${i}`, `failure token ${tokenFor(i)}`);
		}

		// Map never exceeds the cap.
		expect(session._learnedErrors.size).toBe(MAX_LEARNED_ERRORS);

		// The most-recently inserted key survives; the oldest were evicted.
		const newestKey = `read:failure token ${tokenFor(distinctKeys - 1)}`;
		const oldestKey = `read:failure token ${tokenFor(0)}`;
		expect(session._learnedErrors.has(newestKey)).toBe(true);
		expect(session._learnedErrors.has(oldestKey)).toBe(false);
	});

	it("B16: LRU touch keeps a re-hit key alive past the eviction window", async () => {
		const harness = await createHarness({ tools: [createReadTool(process.cwd())] });
		harnesses.push(harness);
		const session = internals(harness);

		const hotKey = `read:failure token ${tokenFor(0)}`;
		// Insert the hot key first (oldest position), then fill the rest of the cap.
		failOnce(session, "call-hot", `failure token ${tokenFor(0)}`);
		for (let i = 1; i < MAX_LEARNED_ERRORS; i++) {
			failOnce(session, `call-${i}`, `failure token ${tokenFor(i)}`);
		}
		// Re-hit the hot key: this moves it to the tail (LRU touch) and bumps count.
		failOnce(session, "call-hot-again", `failure token ${tokenFor(0)}`);

		// One more distinct key overflows the cap; the evicted entry is the new
		// oldest (key index 1), NOT the re-hit hot key.
		failOnce(session, "call-overflow", `failure token ${tokenFor(MAX_LEARNED_ERRORS)}`);

		expect(session._learnedErrors.size).toBe(MAX_LEARNED_ERRORS);
		expect(session._learnedErrors.has(hotKey)).toBe(true);
		expect(session._learnedErrors.has(`read:failure token ${tokenFor(1)}`)).toBe(false);
	});
});

/** Distinct letter-only token per index (digits would normalize to "N"). */
function tokenFor(i: number): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
	let n = i;
	let out = "";
	do {
		out = alphabet[n % 26] + out;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return out;
}
