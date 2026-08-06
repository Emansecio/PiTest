/**
 * Hindsight memory entry point.
 *
 * - Re-exports types + bank.
 * - Defines the default per-project bank location.
 * - Hosts a module-level "current bank" registry so tools can pull it on
 *   demand (same pattern as `user-input-bus.ts`).
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sliceSafe } from "../../utils/surrogate.ts";
import type { HindsightBank } from "./bank.ts";

export * from "./bank.ts";
export * from "./types.ts";

export function defaultBankPath(cwd: string): string {
	return resolve(cwd, ".pit", "hindsight", "bank.jsonl");
}

export function ensureBankDir(filePath: string): void {
	const dir = dirname(filePath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Module-level current bank.
// ---------------------------------------------------------------------------

let currentBank: HindsightBank | undefined;

export function setCurrentHindsightBank(bank: HindsightBank | undefined): void {
	currentBank = bank;
}

export function getCurrentHindsightBank(): HindsightBank | undefined {
	return currentBank;
}

const HINDSIGHT_HINT_BLOCK = [
	"<hindsight_hint>",
	"Summaries of prior sessions exist in the hindsight bank (not inlined). " +
		'Before re-investigating prior work, recall({ query: "<topic>", kinds: ["session-summary"] }).',
	"</hindsight_hint>",
].join("\n");

/**
 * On-demand hindsight prefix (E4): points at the bank; bodies come via recall().
 *
 * Static by construction. This block lands in the *cacheable* system-prompt
 * prefix (appendSections → before SYSTEM_PROMPT_DYNAMIC_MARKER), so any byte
 * tracking bank state — counts, dates, subjects — would rewrite the prefix on
 * every rebuild and re-bill the whole history. The bank grows mid-session
 * (every compaction adds a session-summary), so the text must not depend on it.
 * Only presence is encoded: no bank or no summaries → undefined.
 */
export function formatHindsightHintForPrompt(): string | undefined {
	const bank = currentBank;
	if (!bank) return undefined;
	// Only the empty→non-empty transition can invalidate the prefix, once per session.
	if (!bank.all().some((e) => e.kind === "session-summary")) return undefined;
	return HINDSIGHT_HINT_BLOCK;
}

export function formatSessionSummariesForPrompt(limit = 5, perEntryChars = 400): string | undefined {
	const bank = currentBank;
	if (!bank) return undefined;
	const all = bank.all().filter((e) => e.kind === "session-summary");
	if (all.length === 0) return undefined;
	const recent = all.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
	const blocks: string[] = ["<hindsight_session_memory>"];
	blocks.push(
		"Recent session summaries from this project's hindsight bank. Treat as durable context, not chat history.",
	);
	for (const entry of recent) {
		const subject = entry.subject ? ` (${entry.subject})` : "";
		const date = new Date(entry.createdAt).toISOString().slice(0, 10);
		const trimmed =
			entry.body.length > perEntryChars ? `${sliceSafe(entry.body, 0, perEntryChars).trimEnd()}…` : entry.body;
		blocks.push(`- ${date}${subject}: ${trimmed}`);
	}
	blocks.push("</hindsight_session_memory>");
	return blocks.join("\n");
}
