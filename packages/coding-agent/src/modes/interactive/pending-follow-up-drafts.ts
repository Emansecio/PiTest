import type { SessionEntry } from "../../core/session-manager.ts";

export const PENDING_FOLLOW_UP_DRAFT_TYPE = "pit.pending-follow-ups.v1";

export interface PendingFollowUpDraftSnapshot {
	version: 1;
	messages: string[];
}

export function createPendingFollowUpDraftSnapshot(messages: readonly string[]): PendingFollowUpDraftSnapshot {
	return { version: 1, messages: [...messages] };
}

export function findLatestPendingFollowUpDrafts(entries: readonly SessionEntry[]): string[] {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== PENDING_FOLLOW_UP_DRAFT_TYPE) continue;
		const data = entry.data;
		if (
			typeof data !== "object" ||
			data === null ||
			!("version" in data) ||
			data.version !== 1 ||
			!("messages" in data) ||
			!Array.isArray(data.messages) ||
			!data.messages.every((message): message is string => typeof message === "string")
		) {
			return [];
		}
		return data.messages.filter((message) => message.trim().length > 0);
	}
	return [];
}

export function mergePendingFollowUpsIntoDraft(messages: readonly string[], currentDraft: string): string {
	return [...messages, currentDraft].filter((text) => text.trim().length > 0).join("\n\n");
}
