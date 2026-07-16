import { describe, expect, test } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.js";
import {
	createPendingFollowUpDraftSnapshot,
	findLatestPendingFollowUpDrafts,
	mergePendingFollowUpsIntoDraft,
	PENDING_FOLLOW_UP_DRAFT_TYPE,
} from "../src/modes/interactive/pending-follow-up-drafts.js";

function customEntry(customType: string, data: unknown, id: string): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-07-15T00:00:00.000Z",
		customType,
		data,
	};
}

describe("pending follow-up drafts", () => {
	test("returns the latest valid snapshot in original order", () => {
		const entries = [
			customEntry(PENDING_FOLLOW_UP_DRAFT_TYPE, createPendingFollowUpDraftSnapshot(["old"]), "1"),
			customEntry("other", { messages: ["ignored"] }, "2"),
			customEntry(PENDING_FOLLOW_UP_DRAFT_TYPE, createPendingFollowUpDraftSnapshot(["first", "second"]), "3"),
		];

		expect(findLatestPendingFollowUpDrafts(entries)).toEqual(["first", "second"]);
	});

	test("treats a malformed latest snapshot as empty", () => {
		const entries = [customEntry(PENDING_FOLLOW_UP_DRAFT_TYPE, { version: 1, messages: [42] }, "1")];
		expect(findLatestPendingFollowUpDrafts(entries)).toEqual([]);
	});

	test("does not revive older messages after an empty consumed snapshot", () => {
		const entries = [
			customEntry(PENDING_FOLLOW_UP_DRAFT_TYPE, createPendingFollowUpDraftSnapshot(["already restored"]), "1"),
			customEntry(PENDING_FOLLOW_UP_DRAFT_TYPE, createPendingFollowUpDraftSnapshot([]), "2"),
		];
		expect(findLatestPendingFollowUpDrafts(entries)).toEqual([]);
	});

	test("merges restored messages before the current unsent draft", () => {
		expect(mergePendingFollowUpsIntoDraft(["first", "second"], "current")).toBe("first\n\nsecond\n\ncurrent");
	});
});
