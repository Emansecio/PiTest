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
	/**
	 * Agent scope that wrote this entry. Undefined = global (main agent or an
	 * ad-hoc untyped subagent). A subagent spawned with `type: "<name>"` stamps
	 * its type name here, so reads can be scoped per agent type.
	 */
	agentScope?: string;
}

export interface HindsightSearchOptions {
	query: string;
	limit?: number; // default 10
	kinds?: HindsightKind[];
	/**
	 * Restrict to these scopes. `null` matches global (undefined agentScope).
	 * Omitted = no scope filter (every scope is eligible).
	 */
	scopes?: (string | null)[];
	/**
	 * Rank entries whose scope matches above ties. A string boosts that named
	 * scope; `null` boosts global (undefined-scope) entries — used by the main
	 * agent to keep its own memory on top while still reading subagent scopes.
	 */
	boostScope?: string | null;
}

export interface HindsightSearchResult {
	entry: HindsightEntry;
	score: number;
	matchedSnippet?: string;
}
