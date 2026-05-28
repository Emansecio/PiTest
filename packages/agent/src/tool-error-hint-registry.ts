/**
 * Tier 4: post-hoc tool-error hint registry.
 *
 * The rewrite registry (`ToolRewriteRegistry`) runs BEFORE the tool executes
 * and either rewrites or rejects the call. That covers shape-level mistakes
 * but cannot prevent runtime failures — `ENOENT`, `command not found`,
 * `Permission denied`, exit codes from genuine syntax errors, and so on.
 *
 * Tier 4 closes that gap. When a tool completes with `isError: true`, every
 * matching rule fires and contributes a short, actionable hint. The hints are
 * appended to the tool result's text content as a `[hint]` block, so the LLM
 * sees them in the next turn alongside the original error and recovers in one
 * round-trip instead of guessing.
 *
 * Tier 4 NEVER changes:
 *  - the error status (`isError` stays true)
 *  - the original error text (hints are appended, never replaced)
 *  - the result's `details` payload
 *
 * That preserves the LLM's view of what actually failed; the hint is purely
 * additive context.
 *
 * Rules are matched in registration order. Every matching rule contributes
 * its hint (we do not short-circuit); duplicate hint text is deduplicated.
 */

import type { AgentToolCall, AgentToolResult } from "./types.ts";

export interface ToolErrorHintMatchInput {
	call: AgentToolCall;
	result: AgentToolResult<unknown>;
	/** Joined text content of the result for cheap regex matching. */
	errorText: string;
}

export interface ToolErrorHintRule {
	/** Stable identifier used in telemetry and error attribution. */
	id: string;
	/** Tool name(s) the rule applies to. `"*"` matches any tool. */
	appliesTo: string | string[] | "*";
	/** True iff this rule should fire on the (call, error) pair. */
	matcher: (input: ToolErrorHintMatchInput) => boolean;
	/** Short, actionable hint to append to the error text. */
	hint: (input: ToolErrorHintMatchInput) => string;
}

export interface ToolErrorHintFired {
	ruleId: string;
	hint: string;
}

export interface ToolErrorHintOutcome {
	hints: ToolErrorHintFired[];
}

export class ToolErrorHintRegistry {
	private readonly rules: ToolErrorHintRule[] = [];

	add(rule: ToolErrorHintRule): void {
		this.rules.push(rule);
	}

	addMany(rules: ToolErrorHintRule[]): void {
		for (const rule of rules) this.rules.push(rule);
	}

	list(): readonly ToolErrorHintRule[] {
		return this.rules;
	}

	size(): number {
		return this.rules.length;
	}

	/**
	 * Apply every matching rule. Returns the ordered list of fired hints with
	 * duplicates removed by hint text (same wording → keep first).
	 */
	apply(call: AgentToolCall, result: AgentToolResult<unknown>): ToolErrorHintOutcome {
		const errorText = extractErrorText(result);
		const input: ToolErrorHintMatchInput = { call, result, errorText };
		const hints: ToolErrorHintFired[] = [];
		const seenHints = new Set<string>();
		for (const rule of this.rules) {
			if (!ruleAppliesTo(rule, call.name)) continue;
			let matches = false;
			try {
				matches = rule.matcher(input);
			} catch {
				// A rule's matcher MUST be pure; if it throws, skip silently rather
				// than fail the whole post-hoc enrichment pass.
				continue;
			}
			if (!matches) continue;
			let hintText: string;
			try {
				hintText = rule.hint(input);
			} catch {
				continue;
			}
			const trimmed = hintText.trim();
			if (trimmed.length === 0) continue;
			if (seenHints.has(trimmed)) continue;
			seenHints.add(trimmed);
			hints.push({ ruleId: rule.id, hint: trimmed });
		}
		return { hints };
	}
}

function ruleAppliesTo(rule: ToolErrorHintRule, toolName: string): boolean {
	if (rule.appliesTo === "*") return true;
	if (typeof rule.appliesTo === "string") return rule.appliesTo === toolName;
	return rule.appliesTo.includes(toolName);
}

function extractErrorText(result: AgentToolResult<unknown>): string {
	if (!result.content || !Array.isArray(result.content)) return "";
	const parts: string[] = [];
	for (const block of result.content) {
		if (block && block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

/**
 * Mutate a result so hints appear as a `[hint]` block appended to the trailing
 * text content. Returns the modified content array (the caller is responsible
 * for placing it back on the result).
 *
 * Idempotent: the function checks the existing trailing text for a
 * `[hint] <text>` line before appending, so a rule that fires twice or a
 * downstream wrap that re-runs hint application does not duplicate.
 */
export function appendHintsToContent(
	content: AgentToolResult<unknown>["content"],
	hints: ToolErrorHintFired[],
): AgentToolResult<unknown>["content"] {
	if (hints.length === 0) return content;
	const blocks = Array.isArray(content) ? [...content] : [];
	const hintLines = hints.map((h) => `[hint] ${h.hint}`);
	const block = `\n\n${hintLines.join("\n")}`;

	for (let i = blocks.length - 1; i >= 0; i--) {
		const candidate = blocks[i];
		if (candidate && candidate.type === "text" && typeof candidate.text === "string") {
			if (candidate.text.includes(hintLines[0])) {
				// First hint already present — assume idempotent re-entry; do not append.
				return blocks;
			}
			blocks[i] = { ...candidate, text: `${candidate.text}${block}` };
			return blocks;
		}
	}

	// No text block to append to (e.g., image-only result). Push a fresh block.
	blocks.push({ type: "text", text: block.trimStart() });
	return blocks;
}
