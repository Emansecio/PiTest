/**
 * "Repair Node" — an opt-in feedback signal appended to a SUCCESSFUL tool
 * result after the harness silently repaired the model's arguments.
 *
 * The auto-rewrite layers (per-tool `prepareArguments`, the Tier-1 rewrite
 * registry, and schema coercion) fix shape-only mistakes — `file_path`→`path`,
 * a JSON-stringified array→array, `"10"`→`10` — without the model ever seeing
 * the correction. That is the right default for strong models: it preserves
 * context. But a weaker model keeps re-emitting the same malformed shape every
 * turn because nothing tells it the call was wrong.
 *
 * When enabled (see `AgentLoopConfig.emitRepairNotes`), this module compares the
 * arguments the model SENT against the arguments that actually RAN and, if they
 * differ in a way worth reporting, produces a one-line note appended to the tool
 * result: "you sent X, it ran as Y — emit Y next time". The note is purely
 * additive (never changes `isError`) and only fires on success, so a failing
 * call still gets the richer Tier-4 hint instead.
 *
 * Pure and dependency-free so it stays trivially testable.
 */

import type { AgentToolResult } from "./types.ts";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coarse JSON shape tag used to detect a type coercion between send and run. */
function kindOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/** Structural equality good enough for matching a value moved between keys. */
function valuesEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}

/**
 * Describe the repairs applied to a tool call's top-level arguments as short
 * human-readable fragments. Reports two classes the model can act on:
 *
 *  - renamed key: a key present in `sent` but not `ran`, whose value reappears
 *    under a new key in `ran` (e.g. `file_path` → `path`). Paired by value so an
 *    alias rewrite is attributed precisely; each `ran` key is consumed once.
 *  - coerced type: a key in both whose JSON kind changed (e.g. `offset` string →
 *    number, `edits` string → array).
 *
 * Returns [] when nothing reportable changed (or either side isn't an object).
 * Deliberately ignores same-kind value tweaks (path normalization, trimming) —
 * those are not shape mistakes the model needs to change.
 */
export function summarizeArgRepairs(sent: unknown, ran: unknown): string[] {
	if (!isPlainRecord(sent) || !isPlainRecord(ran)) return [];

	const removed = Object.keys(sent).filter((k) => !(k in ran));
	const added = Object.keys(ran).filter((k) => !(k in sent));
	const fragments: string[] = [];

	// Renames: match each added key to a removed key carrying the same value.
	const claimedRemoved = new Set<string>();
	for (const addedKey of added) {
		const match = removed.find((r) => !claimedRemoved.has(r) && valuesEqual(sent[r], ran[addedKey]));
		if (match !== undefined) {
			claimedRemoved.add(match);
			fragments.push(`renamed \`${match}\` → \`${addedKey}\``);
		}
	}

	// Type coercions on keys present on both sides.
	for (const key of Object.keys(sent)) {
		if (!(key in ran)) continue;
		const sentKind = kindOf(sent[key]);
		const ranKind = kindOf(ran[key]);
		if (sentKind !== ranKind) {
			fragments.push(`coerced \`${key}\` (${sentKind} → ${ranKind})`);
		}
	}

	return fragments;
}

/**
 * Build the repair note from `summarizeArgRepairs` fragments, or undefined when
 * there is nothing to report. The wording tells the model the call still ran and
 * asks it to emit the corrected shape next time — not to retry.
 */
export function buildRepairNote(sent: unknown, ran: unknown): string | undefined {
	const fragments = summarizeArgRepairs(sent, ran);
	if (fragments.length === 0) return undefined;
	return (
		`Your arguments were auto-repaired before this call ran (${fragments.join("; ")}). ` +
		"The result below is correct — emit the corrected shape directly next time so no rewrite is needed."
	);
}

const REPAIR_PREFIX = "[repair] ";

/**
 * Append a repair note to a tool result's content. Mirrors
 * `appendHintsToContent`: attaches to the trailing text block (idempotent — a
 * re-entry with the same note is a no-op), or pushes a fresh block when there is
 * no text block (e.g. an image-only result).
 */
export function appendRepairNoteToContent(
	content: AgentToolResult<unknown>["content"],
	note: string,
): AgentToolResult<unknown>["content"] {
	const line = `${REPAIR_PREFIX}${note}`;
	const blocks = Array.isArray(content) ? [...content] : [];
	for (let i = blocks.length - 1; i >= 0; i--) {
		const candidate = blocks[i];
		if (candidate && candidate.type === "text" && typeof candidate.text === "string") {
			if (candidate.text.includes(line)) return blocks;
			blocks[i] = { ...candidate, text: `${candidate.text}\n\n${line}` };
			return blocks;
		}
	}
	blocks.push({ type: "text", text: line });
	return blocks;
}
