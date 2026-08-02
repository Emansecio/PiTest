/**
 * Cross-write diagnostics ledger: never show the model a diagnostic it has
 * ALREADY been shown for a file, even when the diagnostic moved.
 *
 * The pre-write baseline filter (`filterBaselineDiagnostics`) fingerprints a
 * diagnostic INCLUDING its range. That is the right question for attribution
 * ("was this already here before this write?") and the wrong one for repetition:
 * inserting a line above a pre-existing error shifts its range, the fingerprint
 * stops matching the baseline, and the error is reported again — under the
 * imperative post-write framing, as "This change introduced 1 error(s)". It did
 * not, and the model is told to fix something it did not break.
 *
 * This ledger keys on the diagnostic's IDENTITY instead — everything except the
 * range — and remembers, per file, every identity seen in a post-write set.
 *
 * It deliberately observes the FULL post-write set rather than only what got
 * reported: a diagnostic the baseline filter suppressed must still be
 * remembered, or it resurfaces the first time an edit shifts its line — which is
 * precisely the case this module exists to kill.
 *
 * Identities are replaced wholesale on every observation, so a diagnostic that
 * is fixed and later reintroduced IS reported again.
 */

import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import { LruMap } from "../lru-map.ts";
import type { Diagnostic } from "./types.ts";

/** Bounded like the post-write baseline cache: a long session must not grow this without limit. */
const LEDGER_CAP = 64;

/** URI -> identities of every diagnostic observed in that file's last post-write set. */
const observedByUri = new LruMap<string, Set<string>>(LEDGER_CAP);

/** PIT_NO_LSP_DIAG_LEDGER=1 disables cross-write suppression (every write re-reports). */
function ledgerDisabled(): boolean {
	return isTruthyEnvFlag(process.env.PIT_NO_LSP_DIAG_LEDGER);
}

/**
 * Everything that identifies a diagnostic EXCEPT where it sits: severity, source,
 * code and message. Two reports of the same problem at different lines share it.
 * NUL-joined so a field containing the separator cannot forge another field.
 */
export function diagnosticIdentity(diagnostic: Diagnostic): string {
	return [diagnostic.severity ?? 1, diagnostic.source ?? "", diagnostic.code ?? "", diagnostic.message].join("\u0000");
}

/**
 * Record `observed` as everything now known for `uri`, then return the subset of
 * `candidates` whose identity had NOT already been recorded for it.
 *
 * `observed` must be the complete post-write set for the file (see the module
 * comment); `candidates` the diagnostics that survived attribution filtering and
 * are about to be shown. Call this only when a fresh observation actually
 * happened — an empty `observed` is read as "this file is clean now" and clears
 * the file's memory, so passing an empty array because the wait timed out would
 * make every suppressed diagnostic reappear on the next write.
 */
export function reduceByDiagnosticsLedger(
	uri: string,
	observed: readonly Diagnostic[],
	candidates: readonly Diagnostic[],
): Diagnostic[] {
	if (ledgerDisabled()) return [...candidates];

	const previous = observedByUri.get(uri);
	const current = new Set<string>();
	for (const diagnostic of observed) current.add(diagnosticIdentity(diagnostic));

	// An empty set is dropped rather than stored: it carries no suppression, and
	// keeping it would hold an LRU slot a live file could use.
	if (current.size === 0) observedByUri.delete(uri);
	else observedByUri.set(uri, current);

	if (!previous) return [...candidates];
	return candidates.filter((diagnostic) => !previous.has(diagnosticIdentity(diagnostic)));
}

/** Drop every remembered identity (dispose / test reset). */
export function clearDiagnosticsLedger(): void {
	observedByUri.clear();
}
