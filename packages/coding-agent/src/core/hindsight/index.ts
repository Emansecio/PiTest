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

/**
 * Format the most recent N session-summary entries as a system-prompt prefix.
 * Returns undefined when there is no bank or no summaries to surface.
 */
/**
 * On-demand hindsight prefix (E4): index of recent session summaries; bodies via recall().
 */
export function formatHindsightHintForPrompt(limit = 5): string | undefined {
	const bank = currentBank;
	if (!bank) return undefined;
	const all = bank.all().filter((e) => e.kind === "session-summary");
	if (all.length === 0) return undefined;
	const recent = all.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
	const lines: string[] = ["<hindsight_hint>"];
	lines.push(
		`${all.length} session summar${all.length === 1 ? "y" : "ies"} in the hindsight bank (not inlined). ` +
			'Use recall({ query: "<topic>", kinds: ["session-summary"] }) before re-investigating prior work.',
	);
	lines.push("Recent:");
	for (const entry of recent) {
		const subject = entry.subject ? ` "${entry.subject}"` : "";
		const date = new Date(entry.createdAt).toISOString().slice(0, 10);
		lines.push(`- ${date}${subject}`);
	}
	lines.push("</hindsight_hint>");
	return lines.join("\n");
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
