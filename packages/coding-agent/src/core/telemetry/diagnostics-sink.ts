/**
 * Durable diagnostics sink — one JSONL file per session under
 * `<agentDir>/diagnostics/<sessionId>.jsonl`.
 *
 * Mirrors the learned-error-store layout (manifest first line, record lines,
 * one file per session, ≤{@link MAX_SESSION_FILES} prune, PIT_CODING_AGENT_DIR
 * aware) but APPENDS over the session lifetime instead of overwriting:
 * diagnostics accumulate turn by turn, so the file grows via appendFileSync
 * rather than one writeFileSync at dispose.
 *
 * Constraint: this is observability, never load-bearing. Writes are buffered and
 * flushed off a timer / on dispose, and every path fails open — a telemetry
 * failure must never throw into the guard/tool path that recorded the event.
 * Opt-out via PIT_NO_TELEMETRY_SINK=1.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { onDiagnostic, type RecordedDiagnosticEvent } from "@pit/ai";
import { getAgentDir } from "../../config.ts";
import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import { redactForDisk } from "../secret-redactor.ts";

const DIAGNOSTICS_DIRNAME = "diagnostics";
const MAX_SESSION_FILES = 200;
const DEFAULT_FLUSH_INTERVAL_MS = 2000;
/** Hard cap on buffered lines so a stuck disk cannot leak memory. Oldest dropped. */
const MAX_BUFFERED_LINES = 5000;

/** Manifest written as the first line of every session file. */
export interface DiagnosticsSinkMeta {
	sessionId: string;
	cwd: string;
}

/**
 * Default location: `<agentDir>/diagnostics/`. Respects `PIT_CODING_AGENT_DIR`
 * (via {@link getAgentDir}) so isolated installs get their own sink instead of
 * fighting over the shared `~/.pit/` path — same policy as the learned-error store.
 */
export function defaultDiagnosticsDir(): string {
	try {
		return join(getAgentDir(), DIAGNOSTICS_DIRNAME);
	} catch {
		// Fallback for sandboxes where homedir() is unset (CI workers, harnesses).
		return join(homedir(), ".pit", "agent", DIAGNOSTICS_DIRNAME);
	}
}

/** Opt-out: PIT_NO_TELEMETRY_SINK=1 disables all diagnostics persistence. */
export function isTelemetrySinkDisabled(): boolean {
	return isTruthyEnvFlag(process.env.PIT_NO_TELEMETRY_SINK);
}

/**
 * Buffered append-only JSONL writer for one session's diagnostics. Call
 * {@link start} to begin capturing `onDiagnostic` events; {@link writeRecord} to
 * append non-event records (efficacy, session-summary) onto the same lane; and
 * {@link dispose} to unsubscribe and flush a final time.
 */
export class DiagnosticsSink {
	private readonly dir: string;
	private readonly meta: DiagnosticsSinkMeta;
	private readonly flushIntervalMs: number;
	private readonly path: string;
	/** Buffered records — stringified only on {@link flush}, not on enqueue. */
	private readonly buffer: object[] = [];
	private manifestWritten = false;
	private flushTimer: ReturnType<typeof setInterval> | undefined;
	private unsubscribe: (() => void) | undefined;
	private disposed = false;

	constructor(dir: string, meta: DiagnosticsSinkMeta, flushIntervalMs: number = DEFAULT_FLUSH_INTERVAL_MS) {
		this.dir = dir;
		this.meta = meta;
		this.flushIntervalMs = flushIntervalMs;
		this.path = join(dir, `${meta.sessionId}.jsonl`);
	}

	/** Subscribe to the diagnostics channel and arm the periodic flush. No-op if disabled. */
	start(): void {
		if (isTelemetrySinkDisabled() || this.disposed || this.unsubscribe) return;
		this.unsubscribe = onDiagnostic((event) => this.recordEvent(event));
		this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
		// Never keep the event loop (or a test runner) alive for a telemetry timer.
		this.flushTimer.unref?.();
	}

	/** Buffer one diagnostic event as a `{type:"event", …}` line. */
	private recordEvent(event: RecordedDiagnosticEvent): void {
		this.enqueue({ type: "event", ...event });
	}

	/**
	 * Append an arbitrary record (efficacy / session-summary) onto the same JSONL
	 * lane. Serialised lazily on flush; fails open on unserialisable input.
	 */
	writeRecord(record: object): void {
		this.enqueue(record);
	}

	private enqueue(record: object): void {
		if (this.disposed) return;
		this.buffer.push(record);
		if (this.buffer.length > MAX_BUFFERED_LINES) {
			this.buffer.splice(0, this.buffer.length - MAX_BUFFERED_LINES);
		}
	}

	/**
	 * Flush buffered records to disk. Stringifies here (not on enqueue). Writes the
	 * manifest as the very first line of a fresh file and prunes old session files
	 * once, then appends. On any failure the buffer is retained for the next attempt
	 * (fail-open, no throw). Unserialisable records are dropped.
	 */
	flush(): void {
		if (this.buffer.length === 0) return;
		try {
			mkdirSync(this.dir, { recursive: true });
			const lines: string[] = [];
			const writingManifest = !this.manifestWritten;
			if (writingManifest) {
				lines.push(
					redactForDisk(
						JSON.stringify({
							type: "manifest",
							sessionId: this.meta.sessionId,
							timestamp: new Date().toISOString(),
							cwd: this.meta.cwd,
						}),
					),
				);
			}
			for (const record of this.buffer) {
				try {
					lines.push(redactForDisk(JSON.stringify(record)));
				} catch {
					// A record that will not serialise is dropped, never thrown.
				}
			}
			// Nothing to write beyond an already-written manifest → clear and exit.
			if (lines.length === 0) {
				this.buffer.length = 0;
				return;
			}
			appendFileSync(this.path, `${lines.join("\n")}\n`);
			this.buffer.length = 0;
			if (writingManifest) {
				this.manifestWritten = true;
				pruneOldFiles(this.dir, MAX_SESSION_FILES);
			}
		} catch {
			// Best-effort: keep the buffer and retry on the next flush/dispose.
		}
	}

	/** Unsubscribe, stop the timer, and flush a final time. Idempotent. */
	dispose(): void {
		if (this.disposed) return;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.flushTimer) {
			clearInterval(this.flushTimer);
			this.flushTimer = undefined;
		}
		this.flush();
		this.disposed = true;
	}
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
