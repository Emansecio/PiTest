/**
 * Hindsight memory — durable, project-scoped fact bank curated by the agent.
 *
 * Each entry is a small Markdown payload tagged with a `kind`. The agent
 * writes facts via the `retain` tool, searches the bank via `recall`, and
 * dumps everything-it-knows about a topic via `reflect`. Session summaries
 * are auto-recorded by compaction so they reload on the next session boot.
 */

export type HindsightKind = "fact" | "decision" | "pattern" | "session-summary";

export interface HindsightEntry {
	id: string; // uuid
	createdAt: number; // epoch ms
	updatedAt: number;
	kind: HindsightKind;
	subject?: string; // short tag, optional
	body: string; // actual content (markdown)
	tags?: string[];
	source?: { sessionId?: string; toolCallId?: string };
}

export interface HindsightSearchOptions {
	query: string;
	limit?: number; // default 10
	kinds?: HindsightKind[];
}

export interface HindsightSearchResult {
	entry: HindsightEntry;
	score: number;
	matchedSnippet?: string;
}
