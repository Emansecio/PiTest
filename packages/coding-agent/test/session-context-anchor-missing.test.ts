/**
 * A compaction whose kept-history anchor is gone must fail SAFE.
 *
 * `buildSessionContext` walks the path looking for `firstKeptEntryId` and starts
 * emitting from there. When that id matches nothing — a session migrated from the
 * pre-id format whose index pointed at the header, an entry removed by a branch or
 * rewind, a hand-edited file — the scan used to simply never start, and every turn
 * between the summary and the compaction point disappeared from the model's
 * context with nothing said about it. The field is required and its producer
 * refuses to omit it, so "not found" always means lost, never "keep nothing".
 */

import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { beforeEach, describe, expect, test } from "vitest";
import { buildSessionContext, type SessionEntry } from "../src/core/session-manager.ts";

function userEntry(id: string, text: string): SessionEntry {
	return {
		type: "message",
		id,
		timestamp: new Date(0).toISOString(),
		message: { role: "user", content: text, timestamp: 0 },
	} as unknown as SessionEntry;
}

function compactionEntry(id: string, firstKeptEntryId: string): SessionEntry {
	return {
		type: "compaction",
		id,
		timestamp: new Date(0).toISOString(),
		summary: "SUMMARY",
		firstKeptEntryId,
		tokensBefore: 1000,
	} as unknown as SessionEntry;
}

/**
 * Chain entries parent→child. `buildSessionContext` walks the tree from the leaf
 * back to the root, so a flat list with no parent links is a one-entry path.
 */
function chain(entries: SessionEntry[]): SessionEntry[] {
	let prev: string | null = null;
	for (const entry of entries) {
		(entry as unknown as { parentId: string | null }).parentId = prev;
		prev = entry.id;
	}
	return entries;
}

/** Texts of the user messages the context ended up carrying. */
function userTexts(messages: { role: string }[]): string[] {
	return messages.filter((m) => m.role === "user").map((m) => String((m as unknown as { content: unknown }).content));
}

describe("buildSessionContext with a compaction anchor", () => {
	beforeEach(() => resetRuntimeDiagnostics());

	test("keeps history from the anchor forward when it resolves", () => {
		const path = chain([
			userEntry("e1", "old one"),
			userEntry("e2", "old two"),
			userEntry("e3", "kept one"),
			compactionEntry("c1", "e3"),
			userEntry("e4", "after"),
		]);
		const { messages } = buildSessionContext(path);
		expect(userTexts(messages)).toEqual(["kept one", "after"]);
	});

	test("keeps EVERYTHING when the anchor resolves to nothing", () => {
		const path = chain([
			userEntry("e1", "old one"),
			userEntry("e2", "old two"),
			userEntry("e3", "kept one"),
			compactionEntry("c1", "vanished"),
			userEntry("e4", "after"),
		]);
		const { messages } = buildSessionContext(path);
		expect(userTexts(messages)).toEqual(["old one", "old two", "kept one", "after"]);
	});

	test("an unset anchor is the same lost-anchor case, not an instruction to drop", () => {
		const path = chain([userEntry("e1", "old one"), compactionEntry("c1", undefined as unknown as string)]);
		const { messages } = buildSessionContext(path);
		expect(userTexts(messages)).toEqual(["old one"]);
	});

	test("the divergence is recorded rather than silent", () => {
		buildSessionContext(chain([userEntry("e1", "old one"), compactionEntry("c1", "vanished")]));
		const counters = getRuntimeDiagnostics().counters;
		expect(counters["session.compaction_anchor_missing"]?.count).toBe(1);
		expect(counters["session.compaction_anchor_missing"]?.level).toBe("warn");
	});

	test("a resolvable anchor records nothing", () => {
		buildSessionContext(chain([userEntry("e1", "kept"), compactionEntry("c1", "e1")]));
		expect(getRuntimeDiagnostics().counters["session.compaction_anchor_missing"]).toBeUndefined();
	});

	test("the summary still leads the context in both cases", () => {
		const { messages } = buildSessionContext(chain([userEntry("e1", "old"), compactionEntry("c1", "vanished")]));
		expect(messages[0]?.role).not.toBe("user");
		expect(JSON.stringify(messages[0])).toContain("SUMMARY");
	});
});
