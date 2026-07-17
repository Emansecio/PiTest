/**
 * File snapshot store — the engine behind the `undo` tool and `/rewind`.
 *
 * Every mutating tool (edit, edit_v2, write, ast_edit, undo) serializes through
 * the per-file mutation queue (`file-mutation-queue.ts`). Just before the queue
 * hands control to the mutation, it asks this module to capture the file's
 * CURRENT bytes as a pre-image `.snap`, so a later `undo`/`/rewind` can restore
 * them byte-for-byte. Capturing inside the queue's critical section makes the
 * snapshot atomic with the write: nothing else can mutate the file between the
 * pre-image read and the write it protects.
 *
 * Storage layout (mirrors forgecode's forge_snaps, plus retention it lacks):
 *
 *   <agentDir>/file-snapshots/<pathHash>/<stamp>.snap    full pre-image bytes
 *   <agentDir>/file-snapshots/<pathHash>/<stamp>.json    sidecar metadata
 *
 * `pathHash` is a short sha1 of the CANONICAL path key (case-folded + symlink
 * collapsed on win32/darwin — see `canonicalPathKey`), so `Foo.ts` and `foo.ts`
 * share one bucket on a case-insensitive FS. `stamp` is a lexicographically
 * sortable ISO-ish timestamp + a monotonic counter, so a plain filename sort is
 * chronological and same-millisecond writes never collide.
 *
 * Retention (run lazily on capture): a per-file LRU cap (default 20) and a
 * global age GC (default 7 days). Kill-switch: `PIT_NO_FILE_SNAPSHOTS=1`.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import { canonicalPathKey } from "./tools/path-utils.ts";

const SNAPSHOTS_DIRNAME = "file-snapshots";
const DEFAULT_MAX_PER_FILE = 20;
const DEFAULT_MAX_AGE_DAYS = 7;
/** Global age-GC runs at most this often per process (ms) to stay off the hot path. */
const AGE_GC_THROTTLE_MS = 60_000;

/** Metadata persisted next to every `.snap` pre-image. */
export interface SnapshotSidecar {
	/** Absolute path the bytes were read from (the real, case-preserving path). */
	path: string;
	/** Tool that was about to mutate the file (edit/write/undo/...). */
	tool: string;
	/** Owning session id (best-effort; "unknown" when no context was published). */
	sessionId: string;
	/** Turn/message id — the grouping key `/rewind` restores to. */
	turnId: string;
	/** File mtime (ms) at capture time. */
	mtimeMs: number;
	/** Pre-image size in bytes. */
	size: number;
	/** The sortable stamp (also the filename stem). */
	timestamp: string;
}

/** A single captured snapshot located on disk. */
export interface SnapshotRecord {
	pathHash: string;
	timestamp: string;
	snapPath: string;
	sidecarPath: string;
	meta: SnapshotSidecar;
}

/** One `/rewind` list row: a turn that touched one or more files. */
export interface TurnGroup {
	turnId: string;
	/** Newest snapshot stamp in the turn (for relative-time display). */
	latestTimestamp: string;
	/** Distinct absolute file paths the turn touched. */
	files: string[];
	snapshotCount: number;
}

/** Ambient session/turn context published by the active mode (see setCurrentSnapshotContext). */
export interface SnapshotContext {
	sessionId: string;
	turnId: string;
}

// ---------------------------------------------------------------------------
// Ambient context registry. Mirrors preview-queue.ts: the active mode publishes
// a session/turn context; capture reads it on demand. Defaults keep capture
// working in headless/SDK runs that never publish one.
// ---------------------------------------------------------------------------

let currentContext: SnapshotContext = { sessionId: "unknown", turnId: "t0000000000" };

/** Publish (or clear → reset to defaults) the ambient snapshot context. */
export function setCurrentSnapshotContext(ctx: SnapshotContext | undefined): void {
	currentContext = ctx ?? { sessionId: "unknown", turnId: "t0000000000" };
}

/**
 * Begin a new snapshot "turn": bind the session id and mint a fresh sortable
 * turn id (the grouping key `/rewind` uses). Called by the active mode on each
 * user submission; returns the new turn id for callers that want it.
 */
export function beginSnapshotTurn(sessionId: string): string {
	const turnId = nextStamp();
	currentContext = { sessionId, turnId };
	return turnId;
}

/** Whether capture is enabled (opt out with PIT_NO_FILE_SNAPSHOTS=1). */
export function snapshotsEnabled(): boolean {
	return !isTruthyEnvFlag(process.env.PIT_NO_FILE_SNAPSHOTS);
}

// ---------------------------------------------------------------------------
// Storage location (test-overridable).
// ---------------------------------------------------------------------------

let baseDirOverride: string | undefined;

/** Test-only: pin the snapshot base dir to an isolated temp dir. */
export function _setSnapshotBaseDirForTest(dir: string | undefined): void {
	baseDirOverride = dir;
	lastAgeGcAt = 0;
	stampCounter = 0;
}

function baseDir(): string {
	if (baseDirOverride) return baseDirOverride;
	try {
		return join(getAgentDir(), SNAPSHOTS_DIRNAME);
	} catch {
		return join(homedir(), ".pit", "agent", SNAPSHOTS_DIRNAME);
	}
}

function maxPerFile(): number {
	const raw = Number(process.env.PIT_SNAPSHOT_MAX_PER_FILE);
	return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_PER_FILE;
}

function maxAgeMs(): number {
	const raw = Number(process.env.PIT_SNAPSHOT_MAX_AGE_DAYS);
	const days = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MAX_AGE_DAYS;
	return days * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Stamp + hash helpers.
// ---------------------------------------------------------------------------

let stampCounter = 0;

/**
 * A lexicographically sortable, filename-safe stamp: `2026-07-17T12-30-45-123Z`
 * + a zero-padded process-monotonic counter + a short random tie-break. The
 * fixed-width ISO prefix makes a plain string sort chronological; the counter
 * guarantees intra-process uniqueness; the random suffix avoids cross-process
 * same-millisecond collisions on a shared file bucket.
 */
function nextStamp(): string {
	const iso = new Date().toISOString().replace(/[:.]/g, "-");
	const counter = String(stampCounter++).padStart(6, "0");
	const rand = Math.floor(Math.random() * 0xffff)
		.toString(16)
		.padStart(4, "0");
	return `${iso}-${counter}-${rand}`;
}

function hashPath(canonicalKey: string): string {
	return createHash("sha1").update(canonicalKey).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Capture.
// ---------------------------------------------------------------------------

/**
 * Capture the current bytes of `absolutePath` as a pre-image snapshot. Called
 * from inside the file-mutation queue's critical section, BEFORE the mutation
 * runs. No-ops when snapshots are disabled or the file does not exist yet
 * (brand-new file creation has no pre-image — matches forge fs_write.rs).
 *
 * Errors are swallowed: a failed capture means a later undo simply won't find a
 * snapshot (and says so) — it never fabricates or restores wrong bytes.
 */
export async function captureSnapshot(absolutePath: string, tool: string): Promise<void> {
	if (!snapshotsEnabled()) return;
	let bytes: Buffer;
	let mtimeMs: number;
	try {
		const st = await stat(absolutePath);
		if (!st.isFile()) return;
		mtimeMs = st.mtimeMs;
		bytes = await readFile(absolutePath);
	} catch {
		// New file (or unreadable) — nothing to snapshot.
		return;
	}
	try {
		const pathHash = hashPath(canonicalPathKey(absolutePath));
		const dir = join(baseDir(), pathHash);
		await mkdir(dir, { recursive: true });
		const stamp = nextStamp();
		const meta: SnapshotSidecar = {
			path: absolutePath,
			tool,
			sessionId: currentContext.sessionId,
			turnId: currentContext.turnId,
			mtimeMs,
			size: bytes.length,
			timestamp: stamp,
		};
		// Snap first, then sidecar: a snap with no sidecar is still restorable
		// (listing synthesizes minimal meta); a sidecar with no snap is useless.
		await writeFile(join(dir, `${stamp}.snap`), bytes);
		await writeFile(join(dir, `${stamp}.json`), JSON.stringify(meta));
		await enforcePerFileCap(dir);
		await maybeRunAgeGc();
	} catch {
		// Best-effort: never let a snapshot failure break the mutation it guards.
	}
}

// ---------------------------------------------------------------------------
// Retention.
// ---------------------------------------------------------------------------

/** Keep only the newest `maxPerFile()` snaps in one file's bucket (LRU by stamp). */
async function enforcePerFileCap(dir: string): Promise<void> {
	const cap = maxPerFile();
	let entries: string[];
	try {
		entries = (await readdir(dir)).filter((n) => n.endsWith(".snap"));
	} catch {
		return;
	}
	if (entries.length <= cap) return;
	entries.sort(); // stamps sort chronologically
	const excess = entries.slice(0, entries.length - cap);
	for (const snap of excess) {
		const stem = snap.slice(0, -".snap".length);
		await rm(join(dir, `${stem}.snap`), { force: true }).catch(() => {});
		await rm(join(dir, `${stem}.json`), { force: true }).catch(() => {});
	}
}

let lastAgeGcAt = 0;

/** Test-only: run the global age GC immediately, ignoring the throttle. */
export async function _runAgeGcForTest(): Promise<void> {
	lastAgeGcAt = 0;
	await maybeRunAgeGc();
}

/** Delete snaps older than `maxAgeMs()` across all buckets. Throttled per process. */
async function maybeRunAgeGc(): Promise<void> {
	const now = Date.now();
	if (now - lastAgeGcAt < AGE_GC_THROTTLE_MS) return;
	lastAgeGcAt = now;
	const cutoff = now - maxAgeMs();
	let buckets: string[];
	try {
		buckets = await readdir(baseDir());
	} catch {
		return;
	}
	for (const bucket of buckets) {
		const dir = join(baseDir(), bucket);
		let entries: string[];
		try {
			entries = (await readdir(dir)).filter((n) => n.endsWith(".snap"));
		} catch {
			continue;
		}
		for (const snap of entries) {
			const snapPath = join(dir, snap);
			try {
				const st = await stat(snapPath);
				if (st.mtimeMs >= cutoff) continue;
			} catch {
				continue;
			}
			const stem = snap.slice(0, -".snap".length);
			await rm(snapPath, { force: true }).catch(() => {});
			await rm(join(dir, `${stem}.json`), { force: true }).catch(() => {});
		}
	}
}

// ---------------------------------------------------------------------------
// Reading / restore.
// ---------------------------------------------------------------------------

async function readSidecar(dir: string, stem: string, pathHash: string): Promise<SnapshotRecord | undefined> {
	const snapPath = join(dir, `${stem}.snap`);
	const sidecarPath = join(dir, `${stem}.json`);
	let meta: SnapshotSidecar;
	try {
		meta = JSON.parse(await readFile(sidecarPath, "utf-8")) as SnapshotSidecar;
	} catch {
		// Orphan snap (sidecar missing/corrupt): synthesize enough to still list/restore.
		meta = { path: "", tool: "unknown", sessionId: "unknown", turnId: stem, mtimeMs: 0, size: 0, timestamp: stem };
	}
	return { pathHash, timestamp: stem, snapPath, sidecarPath, meta };
}

/** All snapshots for one file, oldest → newest. */
export async function listSnapshotsForFile(absolutePath: string): Promise<SnapshotRecord[]> {
	const pathHash = hashPath(canonicalPathKey(absolutePath));
	const dir = join(baseDir(), pathHash);
	let entries: string[];
	try {
		entries = (await readdir(dir)).filter((n) => n.endsWith(".snap"));
	} catch {
		return [];
	}
	entries.sort();
	const records: SnapshotRecord[] = [];
	for (const snap of entries) {
		const rec = await readSidecar(dir, snap.slice(0, -".snap".length), pathHash);
		if (rec) records.push(rec);
	}
	return records;
}

/** The most recent snapshot for a file, or undefined. */
export async function getLatestSnapshot(absolutePath: string): Promise<SnapshotRecord | undefined> {
	const records = await listSnapshotsForFile(absolutePath);
	return records[records.length - 1];
}

/** Raw pre-image bytes for a record (byte-for-byte, BOM/line-endings intact). */
export async function readSnapshotBytes(record: SnapshotRecord): Promise<Buffer> {
	return readFile(record.snapPath);
}

/** Delete a snapshot and its sidecar (consumed by undo/rewind). */
export async function deleteSnapshot(record: SnapshotRecord): Promise<void> {
	await rm(record.snapPath, { force: true }).catch(() => {});
	await rm(record.sidecarPath, { force: true }).catch(() => {});
}

/** Every snapshot across every file bucket. */
async function scanAllSnapshots(): Promise<SnapshotRecord[]> {
	let buckets: string[];
	try {
		buckets = await readdir(baseDir());
	} catch {
		return [];
	}
	const all: SnapshotRecord[] = [];
	for (const bucket of buckets) {
		const dir = join(baseDir(), bucket);
		let entries: string[];
		try {
			entries = (await readdir(dir)).filter((n) => n.endsWith(".snap"));
		} catch {
			continue;
		}
		for (const snap of entries) {
			const rec = await readSidecar(dir, snap.slice(0, -".snap".length), bucket);
			if (rec) all.push(rec);
		}
	}
	return all;
}

/**
 * Turns that touched files, most recent first. One row per distinct turnId with
 * the files it touched and the newest stamp in the turn.
 */
export async function listTurns(limit = 20): Promise<TurnGroup[]> {
	const all = await scanAllSnapshots();
	const byTurn = new Map<string, { files: Set<string>; latest: string; count: number }>();
	for (const rec of all) {
		const turnId = rec.meta.turnId;
		const g = byTurn.get(turnId) ?? { files: new Set<string>(), latest: rec.timestamp, count: 0 };
		if (rec.meta.path) g.files.add(rec.meta.path);
		if (rec.timestamp > g.latest) g.latest = rec.timestamp;
		g.count += 1;
		byTurn.set(turnId, g);
	}
	const groups: TurnGroup[] = [...byTurn.entries()].map(([turnId, g]) => ({
		turnId,
		latestTimestamp: g.latest,
		files: [...g.files],
		snapshotCount: g.count,
	}));
	groups.sort((a, b) => (a.turnId < b.turnId ? 1 : a.turnId > b.turnId ? -1 : 0)); // newest first
	return groups.slice(0, limit);
}

/**
 * Restore every file touched at-or-after `turnId` to its OLDEST pre-image within
 * that range — i.e. the state just before the selected turn began — consuming
 * (deleting) all in-range snapshots for those files.
 */
export async function restoreToTurn(turnId: string): Promise<{ files: string[]; restored: number }> {
	// Deferred import avoids a static cycle (queue ↔ snapshots).
	const { withFileMutationQueue } = await import("./tools/file-mutation-queue.ts");
	const inRange = (await scanAllSnapshots()).filter((r) => r.meta.turnId >= turnId && r.meta.path);
	const byFile = new Map<string, SnapshotRecord[]>();
	for (const rec of inRange) {
		const list = byFile.get(rec.pathHash) ?? [];
		list.push(rec);
		byFile.set(rec.pathHash, list);
	}
	const files: string[] = [];
	for (const recs of byFile.values()) {
		recs.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
		const oldest = recs[0];
		const bytes = await readSnapshotBytes(oldest);
		await withFileMutationQueue(oldest.meta.path, async () => {
			await writeFile(oldest.meta.path, bytes);
		});
		files.push(oldest.meta.path);
		for (const rec of recs) await deleteSnapshot(rec);
	}
	return { files, restored: files.length };
}
