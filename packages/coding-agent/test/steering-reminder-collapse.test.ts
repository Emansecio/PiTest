/**
 * N8 — consumed steering-reminder collapse.
 *
 * `<system-reminder>` steers the anti-waste guards inject (overthink / TTSR) are
 * synthetic and re-generable, so once they scroll past the protected window they
 * are dead weight. pruneOldToolOutputs collapses each to a one-line marker BEFORE
 * the N5 paste prune, without a store (nothing to recover). This suite pins the
 * conservative matcher: only confirmed steering prefixes collapse; generic
 * `<system-reminder>` content (hook/user), mixed blocks, the first user message,
 * and reminders still inside the protected window are all left intact.
 */
import type { AgentMessage } from "@pit/agent-core";
import { buildOverthinkReminderMessage } from "@pit/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	cloneToolResultMessagesForPrune,
	pruneOldToolOutputs,
	wouldPruneOldToolOutputs,
} from "../src/core/compaction/compaction.js";
import { createDeferredOutputStore, setCurrentDeferredOutputStore } from "../src/core/deferred-output-store.js";

const PRUNE_TOKEN_THRESHOLD = 20_000;

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as unknown as AgentMessage;
}

/** Real overthink steer (uses the shipping generator — non-enumerable marker + text). */
function overthinkReminder(): AgentMessage {
	return buildOverthinkReminderMessage({ estimatedTokens: 3200, threshold: 2500 });
}

/** TTSR steer text, matching agent-loop.ts's `<system-reminder>[TTSR:name] message</system-reminder>`. */
function ttsrReminder(): AgentMessage {
	const text =
		"<system-reminder>[TTSR:no-console] The stream matched a rule: do not add console.log/debug " +
		"statements to production code; remove any you introduced and use the project logger instead.</system-reminder>";
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as unknown as AgentMessage;
}

function textAt(messages: AgentMessage[], i: number): string {
	return (messages[i] as unknown as { content: { text: string }[] }).content[0].text;
}

afterEach(() => {
	setCurrentDeferredOutputStore(undefined);
});

describe("N8 — consumed steering-reminder collapse", () => {
	it("collapses a consumed overthink reminder to one line — no store needed", () => {
		const messages = [user("task statement — never pruned"), overthinkReminder(), user("a"), user("b")];
		const original = textAt(messages, 1);

		expect(wouldPruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2)).toBe(true);
		// defer=false → no deferred-output store; N8 still fires (synthetic, re-generable).
		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2, false);

		expect(reclaimed).toBeGreaterThan(0);
		expect(textAt(messages, 1)).toBe("[steering reminder (overthink) consumed]");
		expect(textAt(messages, 1).length).toBeLessThan(original.length);
	});

	it("collapses a consumed TTSR reminder to one line", () => {
		const messages = [user("task"), ttsrReminder(), user("a"), user("b")];

		expect(wouldPruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2)).toBe(true);
		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2, false);

		expect(reclaimed).toBeGreaterThan(0);
		expect(textAt(messages, 1)).toBe("[steering reminder (TTSR) consumed]");
	});

	it("collapses a reminder whose content is a raw string (JSONL-restored shape)", () => {
		const reminderText = textAt([ttsrReminder()], 0);
		const messages = [
			user("task"),
			{ role: "user", content: reminderText, timestamp: 1 } as unknown as AgentMessage,
			user("a"),
			user("b"),
		];

		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2, false);

		expect(reclaimed).toBeGreaterThan(0);
		expect((messages[1] as unknown as { content: string }).content).toBe("[steering reminder (TTSR) consumed]");
	});

	it("leaves a reminder INSIDE the protected window intact (not yet consumed)", () => {
		// Reminder is the most-recent message: protectTurns=2 keeps it protected.
		const messages = [user("task"), user("a"), user("b"), overthinkReminder()];
		const original = textAt(messages, 3);

		expect(wouldPruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2)).toBe(false);
		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2, false);

		expect(reclaimed).toBe(0);
		expect(textAt(messages, 3)).toBe(original);
	});

	it("NEVER collapses the first user message even when it is a reminder", () => {
		const messages = [overthinkReminder(), user("a"), user("b"), user("c")];
		const original = textAt(messages, 0);

		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2, false);

		expect(reclaimed).toBe(0);
		expect(textAt(messages, 0)).toBe(original);
	});

	it("leaves a MIXED block (reminder + user prose) intact", () => {
		const reminder = textAt([overthinkReminder()], 0);
		const mixedTrailing = `${reminder}\n\nAlso: please double-check the auth flow while you are here.`;
		const mixedLeading = `Heads up before you continue: ${reminder}`;
		const messages = [user("task"), user(mixedTrailing), user(mixedLeading), user("a"), user("b")];

		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2, false);

		expect(reclaimed).toBe(0);
		expect(textAt(messages, 1)).toBe(mixedTrailing);
		expect(textAt(messages, 2)).toBe(mixedLeading);
	});

	it("leaves an UNKNOWN generic <system-reminder> (hook/user) intact — the false-positive guard", () => {
		const generic =
			"<system-reminder>Repository policy: run `npm run verify` and update CHANGELOG.md before every commit. " +
			"This note was injected by a project hook and must be preserved.</system-reminder>";
		const messages = [user("task"), user(generic), user("a"), user("b")];

		expect(wouldPruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2)).toBe(false);
		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2, false);

		expect(reclaimed).toBe(0);
		expect(textAt(messages, 1)).toBe(generic);
	});

	it("prunes the CLONE only — the original session messages stay byte-identical", () => {
		const messages = [user("task"), overthinkReminder(), user("a"), user("b")];
		const original = textAt(messages, 1);

		const copy = cloneToolResultMessagesForPrune(messages);
		const reclaimed = pruneOldToolOutputs(copy, PRUNE_TOKEN_THRESHOLD, 2, false);

		expect(reclaimed).toBeGreaterThan(0);
		expect(textAt(copy, 1)).toBe("[steering reminder (overthink) consumed]");
		// The live branch entry.message layer is untouched.
		expect(textAt(messages, 1)).toBe(original);
	});

	it("collapses reminders AND defers pastes in the same stream (N8 before N5)", () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);
		// Must clear the 20k-token prune threshold so the N5 paste path engages.
		const paste = `PASTE_HEAD\n${"log line\n".repeat(20_000)}PASTE_TAIL`;
		const messages = [user("task"), overthinkReminder(), user(paste), user("a"), user("b")];

		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2, true);

		expect(reclaimed).toBeGreaterThan(0);
		expect(textAt(messages, 1)).toBe("[steering reminder (overthink) consumed]");
		// The paste took the N5 path (excerpt + recall id), not the N8 marker.
		expect(textAt(messages, 2)).toContain("recall_tool_output");
		expect(textAt(messages, 2)).toContain("PASTE_HEAD");
		store.dispose();
	});
});
