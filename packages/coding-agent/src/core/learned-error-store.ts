/**
 * Cross-session learned-error store.
 *
 * Persists normalised error fingerprints to disk at the end of every session
 * so the next session boots warm with knowledge of which patterns recur. The
 * registry uses this to:
 *
 *  1. Generate dynamic Tier 4 rules for fingerprints that recur often but
 *     are not yet covered by a hand-written rule (see `tool-error-hint-rules.ts`).
 *  2. Surface candidate patterns for human review via the
 *     `scripts/learned-errors-report.mts` CLI.
 *
 * Storage layout — one JSONL file per session under
 * `~/.pit/agent/learned-errors/<sessionId>.jsonl`. Per-session files avoid
 * concurrent-write races between parallel pi sessions and let the aggregator
 * skip individual corrupt files without losing the rest.
 *
 * Each line is one {@link LearnedErrorEntry}: a single error fingerprint from
 * one session with its count, the matched Tier 4 rule (if any), and a
 * sample of the full error text for human-readable reports.
 *
 * Self-cleaning — when more than `MAX_SESSION_FILES` files exist, the oldest
 * ones are pruned at session dispose (see {@link pruneLearnedErrorSessionFiles}).
 * Keeps disk usage bounded even after months of sessions.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { sliceSafe } from "../utils/surrogate.ts";
import { redactForDisk } from "./secret-redactor.ts";

/** One entry per (tool, errorFingerprint) pair within a single session. */
export interface LearnedErrorEntry {
	tool: string;
	/** Normalised error fingerprint (whitespace collapsed, digits → N, length-capped). */
	fingerprint: string;
	/** Number of times this fingerprint appeared in the source session. */
	count: number;
	/** Tier 4 rule ID that matched the error, or undefined if uncovered. */
	matchedRuleId?: string;
	/** First 240 chars of one representative full error text (untrimmed). */
	sampleErrorText: string;
	/** Args fingerprint of one representative call. */
	sampleArgs?: string;
}

/** A session manifest persisted as one JSONL file. */
interface SessionFileMeta {
	sessionId: string;
	timestamp: string;
	cwd: string;
}

const LEARNED_ERRORS_DIRNAME = "learned-errors";
const MAX_SESSION_FILES = 200;
const SAMPLE_TEXT_MAX_CHARS = 240;

/**
 * Default location: `<agentDir>/learned-errors/`. Respects `PIT_CODING_AGENT_DIR`
 * so pi and PiTuned installs that isolate state via env vars get their own
 * learned-error stores instead of fighting over the upstream `~/.pit/` path.
 */
export function defaultLearnedErrorsDir(): string {
	try {
		return join(getAgentDir(), LEARNED_ERRORS_DIRNAME);
	} catch {
		// Fallback for sandboxes where homedir() is unset (CI workers, harnesses).
		return join(homedir(), ".pit", "agent", LEARNED_ERRORS_DIRNAME);
	}
}

/**
 * Learned-errors directory for an explicit agent dir. Used where the caller
 * already knows the (possibly test-isolated) agent dir and must not fall back to
 * the shared global store — e.g. the preventive guard extension, which would
 * otherwise read the real cross-session store during isolated e2e runs.
 */
export function learnedErrorsDirFor(agentDir: string): string {
	return join(agentDir, LEARNED_ERRORS_DIRNAME);
}

/**
 * Persist a session's normalised fingerprints to a fresh per-session file.
 *
 * Async on purpose: the per-turn flush runs on the turn boundary, where a
 * writeFileSync (1–50ms occasional, worse on Windows with AV scanning) would
 * stall the event loop between turns. Callers serialize their own writes
 * (agent-session chains flushes on a tail promise), so overlapping writes to
 * the same `${sessionId}.jsonl` never interleave. Pruning is NOT done here —
 * call {@link pruneLearnedErrorSessionFiles} once at dispose instead of paying
 * readdir+stat-per-file on every turn.
 */
export async function persistSessionLearnedErrors(
	dir: string,
	meta: SessionFileMeta,
	entries: LearnedErrorEntry[],
): Promise<void> {
	if (entries.length === 0) return;
	await mkdir(dir, { recursive: true });
	// Redact ONLY `sampleErrorText` (display/report field). `sampleArgs` is left
	// raw on purpose: it is the preventive guard's matching key, compared
	// byte-for-byte against a fingerprint computed from the live call
	// (`learned-error-guard-extension.ts:139,161-173`), so redacting it would
	// silently break the guard. It is a length-capped (~160-char) fingerprint and
	// this store lives OUTSIDE the repo (`~/.pit`), so the push-to-remote egress
	// risk that motivates redaction elsewhere does not apply to it.
	const lines: string[] = [redactForDisk(JSON.stringify({ type: "manifest", ...meta }))];
	for (const entry of entries) {
		const safe = { ...entry, sampleErrorText: redactForDisk(entry.sampleErrorText) };
		lines.push(JSON.stringify({ type: "entry", ...safe }));
	}
	await writeFile(join(dir, `${meta.sessionId}.jsonl`), `${lines.join("\n")}\n`);
}

/**
 * Prune the oldest session files beyond `max`. Run once per session lifecycle
 * (at dispose) — keeps disk usage bounded without paying readdir+stat on the
 * per-turn flush path. Best-effort: missing dir or unremovable files are skipped.
 */
export async function pruneLearnedErrorSessionFiles(dir: string, max: number = MAX_SESSION_FILES): Promise<void> {
	let files: string[];
	try {
		files = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return; // Dir does not exist (nothing was ever persisted) or is unreadable.
	}
	if (files.length <= max) return;
	const withMtime = await Promise.all(
		files.map(async (name) => {
			try {
				return { name, mtimeMs: (await stat(join(dir, name))).mtimeMs };
			} catch {
				return { name, mtimeMs: 0 };
			}
		}),
	);
	withMtime.sort((a, b) => a.mtimeMs - b.mtimeMs);
	const toDelete = withMtime.slice(0, withMtime.length - max);
	for (const entry of toDelete) {
		try {
			await rm(join(dir, entry.name));
		} catch {
			// Best-effort prune; skip files we cannot remove.
		}
	}
}

/** Aggregated view across every session file in `dir`. */
export interface AggregatedLearnedError {
	tool: string;
	fingerprint: string;
	/** Cumulative occurrence count across all sessions. */
	totalCount: number;
	/** Number of distinct sessions where the pattern appeared. */
	sessionCount: number;
	/** Rule ID(s) that matched the error in past sessions. Empty array = uncovered. */
	matchedRuleIds: string[];
	/** Representative sample (chosen from the most recent session). */
	sampleErrorText: string;
	/** Representative args fingerprint (chosen from the most recent session). */
	sampleArgs?: string;
}

/**
 * Read every session file and aggregate fingerprint counts. Used both by the
 * registry (to know which patterns to dynamically rule on) and by the CLI
 * report. Skips corrupt lines silently — append-only stores are racy by
 * nature and partial last lines are common.
 */
const LEARNED_ERROR_READ_CONCURRENCY = 8;

export async function aggregateLearnedErrors(dir: string): Promise<AggregatedLearnedError[]> {
	if (!existsSync(dir)) return [];
	const byKey = new Map<string, AggregatedLearnedError & { sessionIds: Set<string>; latestTs: string }>();
	const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
	for (let base = 0; base < files.length; base += LEARNED_ERROR_READ_CONCURRENCY) {
		const batch = files.slice(base, base + LEARNED_ERROR_READ_CONCURRENCY);
		const raws = await Promise.all(
			batch.map(async (file) => {
				try {
					return await readFile(join(dir, file), "utf-8");
				} catch {
					return null;
				}
			}),
		);
		for (const raw of raws) {
			if (!raw) continue;
			ingestLearnedErrorFile(raw, byKey);
		}
	}
	return finalizeAggregated(byKey);
}

function ingestLearnedErrorFile(
	raw: string,
	byKey: Map<string, AggregatedLearnedError & { sessionIds: Set<string>; latestTs: string }>,
): void {
	let sessionId = "";
	let timestamp = "";
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: { type?: string } & Record<string, unknown>;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (parsed.type === "manifest") {
			sessionId = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
			timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : "";
			continue;
		}
		if (parsed.type !== "entry") continue;
		const entry = parsed as unknown as LearnedErrorEntry;
		if (!entry.tool || !entry.fingerprint) continue;
		const key = `${entry.tool}:${entry.fingerprint}`;
		const bucket =
			byKey.get(key) ??
			({
				tool: entry.tool,
				fingerprint: entry.fingerprint,
				totalCount: 0,
				sessionCount: 0,
				matchedRuleIds: [],
				sampleErrorText: entry.sampleErrorText,
				sampleArgs: entry.sampleArgs,
				sessionIds: new Set<string>(),
				latestTs: "",
			} satisfies AggregatedLearnedError & { sessionIds: Set<string>; latestTs: string });
		bucket.totalCount += entry.count;
		if (sessionId) bucket.sessionIds.add(sessionId);
		if (entry.matchedRuleId && !bucket.matchedRuleIds.includes(entry.matchedRuleId)) {
			bucket.matchedRuleIds.push(entry.matchedRuleId);
		}
		if (timestamp > bucket.latestTs) {
			bucket.latestTs = timestamp;
			bucket.sampleErrorText = entry.sampleErrorText;
			bucket.sampleArgs = entry.sampleArgs;
		}
		byKey.set(key, bucket);
	}
}

function finalizeAggregated(
	byKey: Map<string, AggregatedLearnedError & { sessionIds: Set<string>; latestTs: string }>,
): AggregatedLearnedError[] {
	return Array.from(byKey.values())
		.map(({ sessionIds, latestTs: _ts, ...rest }) => ({ ...rest, sessionCount: sessionIds.size }))
		.sort((a, b) => b.totalCount - a.totalCount);
}

/** Sequential fallback for sync callers (lazy hint registry before prefetch lands). */
export function aggregateLearnedErrorsSync(dir: string): AggregatedLearnedError[] {
	if (!existsSync(dir)) return [];
	const byKey = new Map<string, AggregatedLearnedError & { sessionIds: Set<string>; latestTs: string }>();
	const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
	for (const file of files) {
		let raw: string;
		try {
			raw = readFileSync(join(dir, file), "utf-8");
		} catch {
			continue;
		}
		ingestLearnedErrorFile(raw, byKey);
	}
	return finalizeAggregated(byKey);
}

const RE_WHITESPACE = /\s+/g;
const RE_DIGITS = /\d+/g;

/**
 * Same normalisation as `ToolCallStats.normalizeFingerprint`. Inlined here so
 * the store does not depend on the stats class. Whitespace → single space,
 * digits → `N`, length-capped to 120 chars with ellipsis. Two errors with the
 * same shape but different paths/line numbers collapse into one bucket.
 */
export function normalizeErrorFingerprint(message: string | undefined, maxLength = 120): string | undefined {
	if (!message) return undefined;
	RE_WHITESPACE.lastIndex = 0;
	RE_DIGITS.lastIndex = 0;
	const collapsed = message.replace(RE_WHITESPACE, " ").replace(RE_DIGITS, "N").trim();
	if (collapsed.length === 0) return undefined;
	if (collapsed.length <= maxLength) return collapsed;
	return `${sliceSafe(collapsed, 0, maxLength)}\u2026`;
}

/** Truncate to {@link SAMPLE_TEXT_MAX_CHARS} for storage. */
export function truncateErrorSample(text: string): string {
	if (text.length <= SAMPLE_TEXT_MAX_CHARS) return text;
	return `${sliceSafe(text, 0, SAMPLE_TEXT_MAX_CHARS)}\u2026`;
}

const RE_WS_RUN = /\s+/g;
/** A value is "path-like" if it contains a separator or a `X:` drive prefix. */
const RE_PATH_LIKE = /[/\\]|^[A-Za-z]:/;
const RE_BACKSLASH = /\\/g;
/** Drive letter immediately before a separator, not part of a longer token (e.g. a URL scheme). */
const RE_DRIVE = /(?<![A-Za-z])([A-Za-z]):(?=\/)/g;

/**
 * Fold formatting-only variance out of a single string value so semantically
 * identical arguments hash the same. Conservative by design \u2014 it only touches
 * layout, never content:
 *
 *  - Runs of whitespace collapse to a single space, and the value is trimmed.
 *    (`"a   b"` \u2192 `"a b"`.) NOTE: this does NOT strip whitespace between tokens,
 *    so `"x = 1"` and `"x=1"` still differ \u2014 those are content, not formatting.
 *  - Path-like values (containing a separator or a drive prefix) get backslashes
 *    normalised to forward slashes and their drive letter lowercased, so
 *    `"C:\\repo\\a.ts"` and `"c:/repo/a.ts"` collapse to one key.
 *
 * Genuinely different paths/commands never collide: only the separator style,
 * drive-letter case, and whitespace runs are folded.
 */
function normalizeStringValue(value: string): string {
	RE_WS_RUN.lastIndex = 0;
	const collapsed = value.replace(RE_WS_RUN, " ").trim();
	if (!RE_PATH_LIKE.test(collapsed)) return collapsed;
	RE_DRIVE.lastIndex = 0;
	return collapsed.replace(RE_BACKSLASH, "/").replace(RE_DRIVE, (_m, drive: string) => `${drive.toLowerCase()}:`);
}

/**
 * Deep-normalise a tool-arguments value for fingerprint MATCHING. Recurses into
 * arrays and objects (keys preserved \u2014 the fingerprinter sorts them) and applies
 * {@link normalizeStringValue} to every string leaf. Non-string primitives pass
 * through untouched.
 *
 * Used only at the guard's candidate-comparison layer: the live call's args and
 * each stored `sampleArgs` are normalised through this before comparing, so
 * whitespace- and path-separator-variant calls re-fire a learned lesson while
 * genuinely different calls stay distinct. It never rewrites what gets persisted,
 * so old on-disk fingerprints keep matching by their original exact form too.
 */
export function normalizeArgsForFingerprint(input: unknown): unknown {
	if (typeof input === "string") return normalizeStringValue(input);
	if (Array.isArray(input)) return input.map(normalizeArgsForFingerprint);
	if (input !== null && typeof input === "object") {
		const obj = input as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(obj)) {
			out[key] = normalizeArgsForFingerprint(obj[key]);
		}
		return out;
	}
	return input;
}
