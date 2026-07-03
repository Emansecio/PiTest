/**
 * Shared helpers for the hindsight tool family (retain/recall/reflect/forget):
 * the valid entry-kind list, scope resolution for reads, and the bank-absent
 * message with its remediation hint. Kept here instead of duplicated per-tool
 * so the four tools stay in lockstep as the bank's shape evolves.
 */

/** Every valid entry kind, in canonical/display order. Mirrors `HindsightKind`. */
export const HINDSIGHT_KINDS = ["fact", "decision", "pattern", "session-summary"] as const;

/**
 * Standard message for "no hindsight bank is open this session" — includes
 * the remediation hint (how to turn it on) and the full tool family it
 * disables. Used by retain/recall/reflect/forget so the wording (and the
 * fact that a hint is present at all) never drifts between them again.
 */
export const HINDSIGHT_BANK_ABSENT_MESSAGE =
	"Hindsight bank is not enabled for this session. Set `hindsight.enabled: true` in settings to use retain/recall/reflect/forget.";

/**
 * Resolve a `scope` schema input into `bank.search()` scope filters, given the
 * agent's bound scope (if any). Shared by `recall` and `reflect` — both are
 * read paths over the bank; `retain` writes with a fixed `agentScope` stamp
 * instead, and `forget`'s subject/tags/id paths apply their own inclusive
 * fence (own scope + global only, never a foreign scope).
 */
export function resolveScope(
	bound: string | undefined,
	override: string | undefined,
): { scopes?: (string | null)[]; boostScope?: string | null } {
	const ov = override?.trim();
	if (ov === "all") return {};
	if (ov === "global") return { scopes: [null] };
	if (ov && ov !== "own") return { scopes: [ov, null], boostScope: ov };
	// default ("own" or unset): bound scope reads own+global; main reads all, global boosted.
	if (bound) return { scopes: [bound, null], boostScope: bound };
	return { boostScope: null };
}
