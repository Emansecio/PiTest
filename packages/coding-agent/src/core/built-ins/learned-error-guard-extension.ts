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
 * fingerprint must EQUAL the stored representative `sampleArgs`, the pattern must
 * have recurred at least `minOccurrences` times across at least `minSessions`
 * sessions, and it must NOT already be covered by a built-in Tier-4 rule (those
 * carry a better-targeted hint). The guard fires at most ONCE per (tool, args)
 * per session: if the model genuinely intends the call, the immediate retry runs.
 *
 * Runs on the `tool_call` event — BEFORE `prepareArguments` — mirroring the
 * read-guard. It therefore normalises the raw input through the same path/edit
 * key aliases the tool applies, so a model emitting `file_path` still matches a
 * `sampleArgs` captured from the canonical `path` form.
 */

import type { ExtensionAPI } from "../extensions/index.js";
import {
	type AggregatedLearnedError,
	aggregateLearnedErrors,
	defaultLearnedErrorsDir,
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
	provider?: () => AggregatedLearnedError[];
	/** Minimum cumulative occurrences before a pattern guards. Default: 3. */
	minOccurrences?: number;
	/** Minimum distinct sessions before a pattern guards. Default: 2. */
	minSessions?: number;
}

function normaliseInput(input: unknown): unknown {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
	return applyKeyAliases(input as Record<string, unknown>, ALIASES);
}

export function createLearnedErrorGuardExtension(options: LearnedErrorGuardOptions = {}) {
	return (pi: ExtensionAPI) => {
		if (options.enabled === false) return;
		const minOccurrences = Math.max(2, options.minOccurrences ?? 3);
		const minSessions = Math.max(1, options.minSessions ?? 2);
		const provider =
			options.provider ??
			(() => {
				try {
					return aggregateLearnedErrors(options.dir ?? defaultLearnedErrorsDir());
				} catch {
					return [];
				}
			});

		// tool -> (sampleArgs fingerprint -> aggregated entry). Built lazily on the
		// first tool call so session creation never pays the disk scan.
		let index: Map<string, Map<string, AggregatedLearnedError>> | undefined;
		const blocked = new Set<string>();

		const buildIndex = (): Map<string, Map<string, AggregatedLearnedError>> => {
			const idx = new Map<string, Map<string, AggregatedLearnedError>>();
			let aggregated: AggregatedLearnedError[];
			try {
				aggregated = provider();
			} catch {
				aggregated = [];
			}
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
				inner.set(entry.sampleArgs, entry);
			}
			return idx;
		};

		pi.on("tool_call", (event) => {
			if (index === undefined) index = buildIndex();
			const inner = index.get(event.toolName);
			if (!inner || inner.size === 0) return undefined;
			const fingerprint = fingerprintToolArgs(normaliseInput(event.input), SAMPLE_ARGS_FINGERPRINT_CHARS);
			const entry = inner.get(fingerprint);
			if (!entry) return undefined;
			const key = `${event.toolName}:${fingerprint}`;
			// Fire once per pattern per session — then let the model proceed if it
			// truly means it, so the guard can never wedge a legitimate retry.
			if (blocked.has(key)) return undefined;
			blocked.add(key);
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
