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
 * ones are pruned. Keeps disk usage bounded even after months of sessions.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";

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

/** Persist a session's normalised fingerprints to a fresh per-session file. */
export function persistSessionLearnedErrors(dir: string, meta: SessionFileMeta, entries: LearnedErrorEntry[]): void {
	if (entries.length === 0) return;
	mkdirSync(dir, { recursive: true });
	const lines: string[] = [JSON.stringify({ type: "manifest", ...meta })];
	for (const entry of entries) {
		lines.push(JSON.stringify({ type: "entry", ...entry }));
	}
	writeFileSync(join(dir, `${meta.sessionId}.jsonl`), `${lines.join("\n")}\n`);
	pruneOldFiles(dir, MAX_SESSION_FILES);
}

function pruneOldFiles(dir: string, max: number): void {
	if (!existsSync(dir)) return;
	const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
	if (files.length <= max) return;
	const withMtime = files
		.map((name) => {
			try {
				return { name, mtimeMs: statSync(join(dir, name)).mtimeMs };
			} catch {
				return { name, mtimeMs: 0 };
			}
		})
		.sort((a, b) => a.mtimeMs - b.mtimeMs);
	const toDelete = withMtime.slice(0, withMtime.length - max);
	for (const entry of toDelete) {
		try {
			rmSync(join(dir, entry.name));
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
export function aggregateLearnedErrors(dir: string): AggregatedLearnedError[] {
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
			// Always overwrite the sample with the most recent session's data so
			// the report and dynamic rules reflect current shapes, not stale ones.
			if (timestamp > bucket.latestTs) {
				bucket.latestTs = timestamp;
				bucket.sampleErrorText = entry.sampleErrorText;
				bucket.sampleArgs = entry.sampleArgs;
			}
			byKey.set(key, bucket);
		}
	}
	return Array.from(byKey.values())
		.map(({ sessionIds, latestTs: _ts, ...rest }) => ({ ...rest, sessionCount: sessionIds.size }))
		.sort((a, b) => b.totalCount - a.totalCount);
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
	return `${collapsed.slice(0, maxLength)}\u2026`;
}

/** Truncate to {@link SAMPLE_TEXT_MAX_CHARS} for storage. */
export function truncateErrorSample(text: string): string {
	if (text.length <= SAMPLE_TEXT_MAX_CHARS) return text;
	return `${text.slice(0, SAMPLE_TEXT_MAX_CHARS)}\u2026`;
}
