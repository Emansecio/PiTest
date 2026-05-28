/**
 * Tool rewrite registry — programmatic correction layer applied between
 * argument preparation and schema validation.
 *
 * The agent loop calls {@link ToolRewriteRegistry.apply} on every incoming
 * tool call. Matching rules can:
 *
 *  - `auto`: silently rewrite the call's arguments (same tool name) — used for
 *     pure shape transformations whose semantics are provably identical
 *     (alias keys, JSON-string array coercion, range-string splits, etc.).
 *  - `suggest`: reject the call with an actionable error pointing the model at
 *     the right call shape — used for cross-tool substitutions where the
 *     semantics could drift (`bash("cat X")` → "use `read({path:'X'})`").
 *  - `block`: reject the call with a no-op / unsafe reason — used for trivially
 *     wrong calls (`edit({oldText:X, newText:X})`, `read` past EOF, etc.).
 *
 * The registry never changes the tool name: rewrite is args-only. Tool
 * substitution always goes through `suggest`, so the swap is visible to the
 * model and the user, and the model recovers in one round-trip instead of
 * receiving a result from a tool it never called.
 *
 * `apply` chains `auto` rules so multiple independent rewrites compose. Each
 * rule fires at most once per call to prevent infinite loops, and the chain
 * is hard-capped at {@link MAX_AUTO_CHAIN}.
 *
 * Rules are matched in registration order. Earlier rules win when multiple
 * match the same call.
 */

import type { AgentToolCall } from "./types.ts";

/** Safety cap on the auto-rewrite chain length. */
const MAX_AUTO_CHAIN = 8;

/** Tier 1: silent args rewrite. Tool name is preserved. */
export interface ToolRewriteAuto {
	tier: "auto";
	rewrite: (call: AgentToolCall) => AgentToolCall;
}

/** Tier 2: reject with actionable suggestion. The message MUST tell the model what call to make instead. */
export interface ToolRewriteSuggest {
	tier: "suggest";
	message: (call: AgentToolCall) => string;
}

/** Tier 3: reject as no-op / unsafe / out-of-bounds. Reason is shown verbatim. */
export interface ToolRewriteBlock {
	tier: "block";
	reason: (call: AgentToolCall) => string;
}

export type ToolRewriteAction = ToolRewriteAuto | ToolRewriteSuggest | ToolRewriteBlock;

export interface ToolRewriteRule {
	/** Stable identifier used in telemetry and error attribution. */
	id: string;
	/** Tool name(s) the rule applies to. `"*"` matches any tool. */
	appliesTo: string | string[] | "*";
	/** True iff this rule should fire on the call. Pure function, no side effects. */
	matcher: (call: AgentToolCall) => boolean;
	action: ToolRewriteAction;
}

export type ToolRewriteOutcome =
	| { kind: "pass"; call: AgentToolCall }
	| { kind: "rewritten"; call: AgentToolCall; ruleIds: string[] }
	| { kind: "rejected"; error: string; ruleId: string };

export class ToolRewriteRegistry {
	private readonly rules: ToolRewriteRule[] = [];

	add(rule: ToolRewriteRule): void {
		this.rules.push(rule);
	}

	addMany(rules: ToolRewriteRule[]): void {
		for (const rule of rules) {
			this.rules.push(rule);
		}
	}

	/** Returns the registered rules in registration order. */
	list(): readonly ToolRewriteRule[] {
		return this.rules;
	}

	/** Total registered rule count. Cheap diagnostic. */
	size(): number {
		return this.rules.length;
	}

	/**
	 * Apply the first matching rule. Chains `auto` rules so independent
	 * rewrites compose. `suggest` / `block` short-circuit immediately.
	 */
	apply(call: AgentToolCall): ToolRewriteOutcome {
		let current = call;
		const applied: string[] = [];
		const seen = new Set<string>();
		for (let i = 0; i < MAX_AUTO_CHAIN; i++) {
			const rule = this.findMatch(current, seen);
			if (!rule) {
				if (applied.length === 0) return { kind: "pass", call: current };
				return { kind: "rewritten", call: current, ruleIds: applied };
			}
			if (rule.action.tier === "suggest") {
				return { kind: "rejected", error: rule.action.message(current), ruleId: rule.id };
			}
			if (rule.action.tier === "block") {
				return { kind: "rejected", error: rule.action.reason(current), ruleId: rule.id };
			}
			// auto
			current = rule.action.rewrite(current);
			applied.push(rule.id);
			seen.add(rule.id);
		}
		// Chain exhausted — return whatever rewrites we accumulated.
		return applied.length > 0
			? { kind: "rewritten", call: current, ruleIds: applied }
			: { kind: "pass", call: current };
	}

	private findMatch(call: AgentToolCall, skip: Set<string>): ToolRewriteRule | undefined {
		for (const rule of this.rules) {
			if (skip.has(rule.id)) continue;
			if (!ruleAppliesTo(rule, call.name)) continue;
			if (!rule.matcher(call)) continue;
			return rule;
		}
		return undefined;
	}
}

function ruleAppliesTo(rule: ToolRewriteRule, toolName: string): boolean {
	if (rule.appliesTo === "*") return true;
	if (typeof rule.appliesTo === "string") return rule.appliesTo === toolName;
	return rule.appliesTo.includes(toolName);
}
