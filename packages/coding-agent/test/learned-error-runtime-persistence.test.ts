/**
 * CR4 — incremental (runtime) persistence of the learned-error store.
 *
 * The store used to be written ONLY on dispose, so a session killed/crashed
 * before teardown contributed nothing — exactly the looping weak-model session
 * whose recurring error would most help the next boot. CR4 flushes the store at
 * each turn_end (dirty-gated, idempotent), keeping the dispose write as a safety
 * net. These tests prove:
 *   1) a persisted session that learns an error and completes a turn WITHOUT
 *      dispose already has its `${sessionId}.jsonl` on disk (survives a kill);
 *   2) two turns of new errors produce ONE session file and do NOT inflate
 *      aggregateLearnedErrors' per-file sessionCount (idempotent overwrite);
 *   3) a NON-persisted (in-memory) session writes nothing, even at turn_end;
 *   4) a turn that learns no new fingerprint triggers no extra write (dirty flag).
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@pit/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aggregateLearnedErrors } from "../src/core/learned-error-store.js";
import { createHarness, type Harness } from "./suite/harness.js";

// A tool that always throws a controlled message so each `tag` yields a distinct
// normalised fingerprint (no digits to collapse). Throwing is the AgentTool
// contract for failure -> tool_execution_end fires with isError === true.
function makeFailingTool(): AgentTool {
	return {
		name: "boom",
		description: "Always fails",
		label: "boom",
		parameters: Type.Object({ tag: Type.String() }),
		execute: async (_toolCallId: string, params: unknown) => {
			const tag =
				typeof params === "object" && params && "tag" in params ? String((params as { tag: unknown }).tag) : "x";
			throw new Error(`boom failed for tag ${tag}`);
		},
	};
}

function markPersisted(harness: Harness): void {
	// Harness sessions are SessionManager.inMemory() (isPersisted === false). Flip
	// just the gate the learned-error flush consults; nothing else in agent-session
	// reads isPersisted(), so this stays surgical (no session-file writes).
	(harness.sessionManager as unknown as { isPersisted: () => boolean }).isPersisted = () => true;
}

// The turn_end flush is async (serialized write queue — see 5.4): awaiting the
// session's tail promise is the write barrier before asserting on-disk state.
// Durability itself is unchanged: the write is enqueued AT turn_end, before
// prompt() resolves, and dispose awaits the same queue.
function awaitLearnedErrorsFlush(harness: Harness): Promise<void> {
	return (harness.session as unknown as { _learnedErrorsFlushTail: Promise<void> })._learnedErrorsFlushTail;
}

describe("CR4 — learned-error runtime persistence", () => {
	const harnesses: Harness[] = [];
	let agentDir: string;
	let prevEnv: string | undefined;

	beforeEach(() => {
		prevEnv = process.env.PIT_CODING_AGENT_DIR;
		agentDir = mkdtempSync(join(tmpdir(), "pi-cr4-learned-"));
		// defaultLearnedErrorsDir() -> getAgentDir() honours PIT_CODING_AGENT_DIR,
		// so the store writes into this disposable dir, never the real one.
		process.env.PIT_CODING_AGENT_DIR = agentDir;
	});

	afterEach(async () => {
		// Dispose FIRST (still under the temp agent dir) so any dispose-time persist
		// lands in the temp store, then restore env, then remove the temp store.
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
		if (prevEnv === undefined) delete process.env.PIT_CODING_AGENT_DIR;
		else process.env.PIT_CODING_AGENT_DIR = prevEnv;
		if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
	});

	function learnedDir(): string {
		return join(agentDir, "learned-errors");
	}

	it("persists the store at turn_end (survives a kill) — file exists WITHOUT dispose", async () => {
		const harness = await createHarness({ tools: [makeFailingTool()] });
		harnesses.push(harness);
		markPersisted(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("boom", { tag: "alpha" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		// The error was genuinely learned in memory…
		const learned = (harness.session as unknown as { _learnedErrors: Map<string, unknown> })._learnedErrors;
		expect(learned.size).toBe(1);

		// …and ALREADY on disk (write enqueued at turn_end; await the queue only
		// as a barrier for the assertion), with no dispose having run.
		await awaitLearnedErrorsFlush(harness);
		const file = join(learnedDir(), `${harness.session.sessionId}.jsonl`);
		expect(existsSync(file)).toBe(true);

		const aggregated = await aggregateLearnedErrors(learnedDir());
		expect(aggregated.length).toBe(1);
		expect(aggregated[0].tool).toBe("boom");
		expect(aggregated[0].sessionCount).toBe(1);
	});

	it("is idempotent across turns: one session file, sessionCount stays 1", async () => {
		const harness = await createHarness({ tools: [makeFailingTool()] });
		harnesses.push(harness);
		markPersisted(harness);

		// Turn A learns fingerprint 'alpha'.
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("boom", { tag: "alpha" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("a-done"),
		]);
		await harness.session.prompt("first");

		// Turn B learns a DISTINCT fingerprint 'beta'.
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("boom", { tag: "beta" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("b-done"),
		]);
		await harness.session.prompt("second");
		await awaitLearnedErrorsFlush(harness);

		// Exactly ONE session file for this session (overwrite, not append-per-turn).
		const files = readdirSync(learnedDir()).filter((n) => n.endsWith(".jsonl"));
		expect(files).toEqual([`${harness.session.sessionId}.jsonl`]);

		// Both fingerprints accumulated, and re-writing the same sessionId did NOT
		// inflate the per-file sessionCount.
		const aggregated = await aggregateLearnedErrors(learnedDir());
		expect(aggregated.length).toBe(2);
		for (const entry of aggregated) {
			expect(entry.sessionCount).toBe(1);
		}
	});

	it("a NON-persisted session writes nothing, even at turn_end", async () => {
		const harness = await createHarness({ tools: [makeFailingTool()] });
		harnesses.push(harness);
		// NB: do NOT markPersisted — harness default isPersisted() === false.

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("boom", { tag: "alpha" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		// Learned in memory, but NOTHING on disk (the isPersisted guard holds at
		// turn_end exactly as it does at dispose).
		const learned = (harness.session as unknown as { _learnedErrors: Map<string, unknown> })._learnedErrors;
		expect(learned.size).toBe(1);
		expect(existsSync(learnedDir())).toBe(false);
	});

	it("a turn with no new fingerprint triggers no extra write (dirty flag gates it)", async () => {
		const harness = await createHarness({ tools: [makeFailingTool()] });
		harnesses.push(harness);
		markPersisted(harness);

		// Turn 1: learn an error -> file is written at turn_end.
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("boom", { tag: "alpha" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("first");
		await awaitLearnedErrorsFlush(harness);

		const file = join(learnedDir(), `${harness.session.sessionId}.jsonl`);
		expect(existsSync(file)).toBe(true);

		// Delete the file as a write sentinel: if the next (clean) turn flushes, the
		// file reappears; if the dirty flag correctly gates it, it stays gone.
		// (Turn 1's write was already awaited above, so it cannot recreate it.)
		rmSync(file);

		// Turn 2: a plain text turn learns nothing new -> dirty stays false.
		harness.setResponses([fauxAssistantMessage("nothing to do")]);
		await harness.session.prompt("second");
		await awaitLearnedErrorsFlush(harness);

		const dirty = (harness.session as unknown as { _learnedErrorsDirty: boolean })._learnedErrorsDirty;
		expect(dirty).toBe(false);
		// No write happened on the clean turn -> the deleted file did NOT reappear.
		expect(existsSync(file)).toBe(false);
	});
});
