/**
 * Built-in learned-error guard extension.
 *
 * Preventive counterpart to the Tier-4 learned-error hint rules. Those surface a
 * hint only AFTER a recurring error fires again; this guard blocks a call BEFORE
 * it executes when the exact same call has failed repeatedly in PRIOR sessions —
 * so a mistake the model already made (and persisted to the cross-session store)
 * never costs a real failure again.
 *
 * Match is deliberately high-precision / low-recall: the live call's args
 * fingerprint must equal the stored representative `sampleArgs` — either its
 * EXACT form (byte-for-byte, so existing on-disk fingerprints keep firing with
 * zero regression) or its NORMALISED form (whitespace runs collapsed, path
 * separators/drive-letter case folded), so a call that differs from the stored
 * failure only in formatting still re-fires the lesson. The pattern must also
 * have recurred at least `minOccurrences` times across at least `minSessions`
 * sessions, and must NOT already be covered by a built-in Tier-4 rule (those
 * carry a better-targeted hint). The guard fires at most ONCE per (tool, args)
 * per session: if the model genuinely intends the call, the immediate retry runs.
 *
 * Runs on the `tool_call` event — BEFORE `prepareArguments` — mirroring the
 * read-guard. It therefore normalises the raw input through the same path/edit
 * key aliases the tool applies, so a model emitting `file_path` still matches a
 * `sampleArgs` captured from the canonical `path` form.
 */

import { recordDiagnostic } from "@pit/ai";
import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import type { ExtensionAPI } from "../extensions/index.js";
import {
	type AggregatedLearnedError,
	aggregateLearnedErrors,
	defaultLearnedErrorsDir,
	normalizeArgsForFingerprint,
} from "../learned-error-store.ts";
import { fingerprintToolArgs } from "../tool-call-stats.ts";
import { applyKeyAliases, EDIT_KEY_ALIASES, PATH_KEY_ALIASES } from "../tools/argument-prep.ts";

/**
 * Args-fingerprint config MUST match how `sampleArgs` is stored in
 * agent-session (`fingerprintToolArgs(args, 160)`); otherwise the live and
 * stored fingerprints never compare equal.
 */
const SAMPLE_ARGS_FINGERPRINT_CHARS = 160;
const ALIASES = { ...PATH_KEY_ALIASES, ...EDIT_KEY_ALIASES };

export interface LearnedErrorGuardOptions {
	/** Off switch — when false the factory returns a no-op extension. */
	enabled?: boolean;
	/**
	 * Directory of the cross-session learned-error store to scan. Defaults to the
	 * shared global store; the built-in wiring passes the session's (possibly
	 * test-isolated) agent dir so isolated runs never read the real store.
	 * Ignored when `provider` is supplied.
	 */
	dir?: string;
	/**
	 * Provider for the aggregated cross-session learned errors. Injected for
	 * tests; defaults to a disk scan of `dir`. Invoked lazily on the first tool
	 * call, never at session creation.
	 */
	provider?: () => AggregatedLearnedError[] | Promise<AggregatedLearnedError[]>;
	/** Minimum cumulative occurrences before a pattern guards. Default: 3. */
	minOccurrences?: number;
	/** Minimum distinct sessions before a pattern guards. Default: 2. */
	minSessions?: number;
}

function normaliseInput(input: unknown): unknown {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
	return applyKeyAliases(input as Record<string, unknown>, ALIASES);
}

/**
 * Normalised fingerprint for a stored `sampleArgs`. `sampleArgs` is a
 * `fingerprintToolArgs` JSON string, so we parse it back to an object, fold out
 * formatting variance, and re-fingerprint — yielding the same key a live call
 * with formatting-only differences would produce. Returns undefined when the
 * stored fingerprint was length-capped (`…`) and no longer parses as JSON; the
 * exact-match index entry still covers those, so no match is lost.
 */
function normalizeStoredSampleArgs(sampleArgs: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(sampleArgs);
	} catch {
		return undefined;
	}
	return fingerprintToolArgs(normalizeArgsForFingerprint(parsed), SAMPLE_ARGS_FINGERPRINT_CHARS);
}

export function createLearnedErrorGuardExtension(options: LearnedErrorGuardOptions = {}) {
	return (pi: ExtensionAPI) => {
		if (options.enabled === false || isTruthyEnvFlag(process.env.PIT_NO_LEARNED_ERROR_GUARD)) return;
		const minOccurrences = Math.max(2, options.minOccurrences ?? 3);
		const minSessions = Math.max(1, options.minSessions ?? 2);
		const loadAggregated = async (): Promise<AggregatedLearnedError[]> => {
			if (options.provider) return options.provider();
			try {
				return await aggregateLearnedErrors(options.dir ?? defaultLearnedErrorsDir());
			} catch {
				return [];
			}
		};

		// tool -> (sampleArgs fingerprint -> aggregated entry). Built lazily on the
		// first tool call so session creation never pays the disk scan.
		let index: Map<string, Map<string, AggregatedLearnedError>> | undefined;
		let indexReady: Promise<void> | undefined;
		const blocked = new Set<string>();

		const buildIndex = (aggregated: AggregatedLearnedError[]): Map<string, Map<string, AggregatedLearnedError>> => {
			const idx = new Map<string, Map<string, AggregatedLearnedError>>();
			for (const entry of aggregated) {
				if (entry.totalCount < minOccurrences || entry.sessionCount < minSessions) continue;
				// Covered by a built-in Tier-4 rule already — its hint is better targeted.
				if (entry.matchedRuleIds.length > 0) continue;
				if (!entry.sampleArgs) continue;
				let inner = idx.get(entry.tool);
				if (!inner) {
					inner = new Map<string, AggregatedLearnedError>();
					idx.set(entry.tool, inner);
				}
				// Index under BOTH the exact stored fingerprint (byte-for-byte backward
				// compatibility with fingerprints written before normalisation existed)
				// and its normalised form (so formatting-variant live calls still match).
				// First write wins so an entry never shadows an earlier one's exact key.
				if (!inner.has(entry.sampleArgs)) inner.set(entry.sampleArgs, entry);
				const normalised = normalizeStoredSampleArgs(entry.sampleArgs);
				if (normalised && !inner.has(normalised)) inner.set(normalised, entry);
			}
			return idx;
		};

		pi.on("tool_call", async (event) => {
			if (index === undefined) {
				if (!indexReady) {
					indexReady = loadAggregated().then((aggregated) => {
						index = buildIndex(aggregated);
					});
				}
				await indexReady;
			}
			if (!index) return undefined;
			const inner = index.get(event.toolName);
			if (!inner || inner.size === 0) return undefined;
			// Exact fingerprint first (cheap, and how legacy entries match). Only when
			// it misses do we pay for normalisation and retry — so a store with no
			// formatting-variant candidate for this tool costs one hash, not two.
			const normalisedInput = normaliseInput(event.input);
			let fingerprint = fingerprintToolArgs(normalisedInput, SAMPLE_ARGS_FINGERPRINT_CHARS);
			let entry = inner.get(fingerprint);
			if (!entry) {
				const normalisedFingerprint = fingerprintToolArgs(
					normalizeArgsForFingerprint(normalisedInput),
					SAMPLE_ARGS_FINGERPRINT_CHARS,
				);
				if (normalisedFingerprint !== fingerprint) {
					entry = inner.get(normalisedFingerprint);
					fingerprint = normalisedFingerprint;
				}
			}
			if (!entry) return undefined;
			const key = `${event.toolName}:${fingerprint}`;
			// Fire once per pattern per session — then let the model proceed if it
			// truly means it, so the guard can never wedge a legitimate retry.
			if (blocked.has(key)) return undefined;
			blocked.add(key);
			recordDiagnostic({
				category: "guard.learned-error",
				level: "info",
				source: "learned-error-guard-extension",
				context: { note: `${event.toolName} ${fingerprint}` },
			});
			return {
				block: true,
				reason:
					`Learned-error guard: this exact \`${event.toolName}\` call has failed ${entry.totalCount}× ` +
					`across ${entry.sessionCount} prior sessions. Last failure: ${entry.sampleErrorText} — ` +
					"fix the root cause (correct the arguments/path, or read the relevant file/state first) " +
					"instead of repeating it. This guard fires once; re-issue the identical call to run it anyway.",
			};
		});
	};
}
