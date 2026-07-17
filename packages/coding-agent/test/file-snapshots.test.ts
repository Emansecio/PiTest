import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_runAgeGcForTest,
	_setSnapshotBaseDirForTest,
	beginSnapshotTurn,
	captureSnapshot,
	getLatestSnapshot,
	listSnapshotsForFile,
	listTurns,
	readSnapshotBytes,
	restoreToTurn,
	setCurrentSnapshotContext,
} from "../src/core/file-snapshots.ts";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";
import { FS_CASE_INSENSITIVE } from "../src/core/tools/path-utils.ts";
import { createUndoTool } from "../src/core/tools/undo.ts";

let tmp: string;

const SNAP_ENV = ["PIT_NO_FILE_SNAPSHOTS", "PIT_SNAPSHOT_MAX_PER_FILE", "PIT_SNAPSHOT_MAX_AGE_DAYS"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
	for (const k of SNAP_ENV) savedEnv[k] = process.env[k];
	tmp = await mkdtemp(join(tmpdir(), "pit-snap-"));
	_setSnapshotBaseDirForTest(join(tmp, "snapstore"));
	setCurrentSnapshotContext({ sessionId: "s1", turnId: "t0001" });
});

afterEach(async () => {
	_setSnapshotBaseDirForTest(undefined);
	setCurrentSnapshotContext(undefined);
	for (const k of SNAP_ENV) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

/** Mutate a file through the queue with a snapshot intent (as edit/write do). */
async function mutate(file: string, next: string | Buffer, tool = "edit"): Promise<void> {
	await withFileMutationQueue(file, async () => writeFile(file, next), { snapshot: { tool } });
}

describe("captureSnapshot via the mutation queue", () => {
	it("captures the pre-image of an existing file before it is mutated", async () => {
		const f = join(tmp, "a.txt");
		await writeFile(f, "hello");
		await mutate(f, "world");
		const snaps = await listSnapshotsForFile(f);
		expect(snaps.length).toBe(1);
		expect((await readSnapshotBytes(snaps[0])).toString("utf-8")).toBe("hello");
		expect(snaps[0].meta.tool).toBe("edit");
		expect(snaps[0].meta.sessionId).toBe("s1");
	});

	it("does NOT capture when the file is brand new (no pre-image)", async () => {
		const g = join(tmp, "new.txt");
		await withFileMutationQueue(g, async () => writeFile(g, "created"), { snapshot: { tool: "write" } });
		expect((await listSnapshotsForFile(g)).length).toBe(0);
	});

	it("does not capture without a snapshot intent (e.g. preview staging)", async () => {
		const f = join(tmp, "b.txt");
		await writeFile(f, "x");
		await withFileMutationQueue(f, async () => writeFile(f, "y"));
		expect((await listSnapshotsForFile(f)).length).toBe(0);
	});
});

describe("undo tool", () => {
	it("restores the exact bytes byte-for-byte (BOM + CRLF preserved)", async () => {
		const f = join(tmp, "bom.txt");
		const original = Buffer.from("﻿line1\r\nline2\r\n", "utf-8");
		await writeFile(f, original);
		await mutate(f, "changed");

		const undo = createUndoTool(tmp);
		const res = await undo.execute("id", { path: "bom.txt" });
		expect((res.content[0] as { text: string }).text).toMatch(/Reverted/);
		expect(readFileSync(f)).toEqual(original); // exact bytes, incl. BOM + CRLF
	});

	it("is itself undoable — undo of undo re-applies the reverted change", async () => {
		const f = join(tmp, "u.txt");
		await writeFile(f, "A");
		await mutate(f, "B"); // snapshot {A}, file now B
		const undo = createUndoTool(tmp);

		await undo.execute("id", { path: "u.txt" });
		expect(readFileSync(f, "utf-8")).toBe("A"); // restored pre-edit state

		await undo.execute("id", { path: "u.txt" });
		expect(readFileSync(f, "utf-8")).toBe("B"); // undo-of-undo redoes
	});

	it("reports when there is no snapshot to undo", async () => {
		await writeFile(join(tmp, "z.txt"), "z");
		const undo = createUndoTool(tmp);
		const res = await undo.execute("id", { path: "z.txt" });
		expect((res.content[0] as { text: string }).text).toMatch(/No snapshot/);
	});

	it("undoes in LIFO order across multiple edits", async () => {
		const f = join(tmp, "lifo.txt");
		await writeFile(f, "v0");
		await mutate(f, "v1"); // snap v0
		await mutate(f, "v2"); // snap v1
		const undo = createUndoTool(tmp);
		await undo.execute("id", { path: "lifo.txt" }); // restore most recent snap = v1
		expect(readFileSync(f, "utf-8")).toBe("v1");
	});
});

describe("retention", () => {
	it("caps snapshots per file, evicting the oldest (LRU)", async () => {
		process.env.PIT_SNAPSHOT_MAX_PER_FILE = "3";
		const f = join(tmp, "cap.txt");
		await writeFile(f, "v0");
		for (let i = 1; i <= 6; i++) await mutate(f, `v${i}`);
		const snaps = await listSnapshotsForFile(f);
		expect(snaps.length).toBe(3);
		const contents = await Promise.all(snaps.map(async (s) => (await readSnapshotBytes(s)).toString("utf-8")));
		expect(contents).toEqual(["v3", "v4", "v5"]); // oldest three evicted
	});

	it("age-GCs snapshots older than the max age", async () => {
		process.env.PIT_SNAPSHOT_MAX_AGE_DAYS = "7";
		const f = join(tmp, "old.txt");
		await writeFile(f, "a");
		await mutate(f, "b");
		const [snap] = await listSnapshotsForFile(f);
		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		await utimes(snap.snapPath, eightDaysAgo, eightDaysAgo);
		await _runAgeGcForTest();
		expect((await listSnapshotsForFile(f)).length).toBe(0);
	});
});

describe("kill-switch", () => {
	it("PIT_NO_FILE_SNAPSHOTS disables capture, and undo reports disabled", async () => {
		process.env.PIT_NO_FILE_SNAPSHOTS = "1";
		const f = join(tmp, "k.txt");
		await writeFile(f, "a");
		await mutate(f, "b");
		expect((await listSnapshotsForFile(f)).length).toBe(0);
		const undo = createUndoTool(tmp);
		const res = await undo.execute("id", { path: "k.txt" });
		expect((res.content[0] as { text: string }).text).toMatch(/disabled/i);
	});
});

describe("/rewind turn grouping + multi-file restore", () => {
	it("groups snapshots by turn and restores every touched file to before the turn", async () => {
		const f1 = join(tmp, "f1.txt");
		const f2 = join(tmp, "f2.txt");
		await writeFile(f1, "f1-v0");
		await writeFile(f2, "f2-v0");

		beginSnapshotTurn("s"); // turn A
		await mutate(f1, "f1-v1");

		const turnB = beginSnapshotTurn("s");
		await mutate(f1, "f1-v2");
		await mutate(f2, "f2-v1");

		const turns = await listTurns();
		expect(turns.length).toBe(2);
		expect(turns[0].turnId).toBe(turnB); // newest first
		expect(turns[0].files.map((p) => basename(p)).sort()).toEqual(["f1.txt", "f2.txt"]);

		const result = await restoreToTurn(turnB);
		expect(result.restored).toBe(2);
		expect(readFileSync(f1, "utf-8")).toBe("f1-v1"); // state just before turn B
		expect(readFileSync(f2, "utf-8")).toBe("f2-v0");

		// Turn B's snapshots are consumed; turn A's f1 pre-image ("f1-v0") survives.
		const remaining = await listSnapshotsForFile(f1);
		expect(remaining.length).toBe(1);
		expect((await readSnapshotBytes(remaining[0])).toString("utf-8")).toBe("f1-v0");
	});
});

describe("path canonicalization", () => {
	it.skipIf(!FS_CASE_INSENSITIVE)("keys snapshots case-insensitively on win32/darwin", async () => {
		const f = join(tmp, "Case.txt");
		await writeFile(f, "v0");
		await mutate(f, "v1");
		// Look up via a different casing of the same path — must hit the same bucket.
		const snaps = await listSnapshotsForFile(join(tmp, "case.txt"));
		expect(snaps.length).toBe(1);
		expect((await readSnapshotBytes(snaps[0])).toString("utf-8")).toBe("v0");
	});
});

describe("/rewind session scoping (plan 010)", () => {
	it("lists only the given session's turns, but all turns with no filter", async () => {
		const fa = join(tmp, "sa.txt");
		const fb = join(tmp, "sb.txt");
		await writeFile(fa, "a0");
		await writeFile(fb, "b0");

		const turnA = beginSnapshotTurn("A");
		await mutate(fa, "a1"); // captured under session A
		const turnB = beginSnapshotTurn("B");
		await mutate(fb, "b1"); // captured under session B

		expect((await listTurns(20, "A")).map((t) => t.turnId)).toEqual([turnA]);
		expect((await listTurns(20, "B")).map((t) => t.turnId)).toEqual([turnB]);
		expect((await listTurns()).map((t) => t.turnId).sort()).toEqual([turnA, turnB].sort());
	});

	it("restores only the given session's pre-image and leaves the other session's snapshots intact", async () => {
		const f = join(tmp, "shared.txt");
		await writeFile(f, "v0");
		beginSnapshotTurn("A");
		await mutate(f, "v1"); // snap v0 under session A
		const turnB = beginSnapshotTurn("B");
		await mutate(f, "v2"); // snap v1 under session B

		const result = await restoreToTurn(turnB, "B");
		expect(result.restored).toBe(1);
		expect(readFileSync(f, "utf-8")).toBe("v1"); // B's pre-image

		// Session A's snapshot ("v0") must survive untouched.
		const remaining = await listSnapshotsForFile(f);
		expect(remaining.length).toBe(1);
		expect((await readSnapshotBytes(remaining[0])).toString("utf-8")).toBe("v0");
	});
});

describe("/rewind created-file removal (plan 010)", () => {
	it("removes a file the turn created and reports removed===1", async () => {
		const f = join(tmp, "created.txt");
		const turn = beginSnapshotTurn("screate");
		await captureSnapshot(f, "write"); // f does not exist yet → creation marker
		await writeFile(f, "brand new"); // the turn creates it on disk

		const result = await restoreToTurn(turn, "screate");
		expect(result.removed).toBe(1);
		expect(result.kept).toEqual([]);
		expect(existsSync(f)).toBe(false);
	});

	it("keeps a created file that a LATER turn also touched, reporting it in kept", async () => {
		const f = join(tmp, "kept.txt");
		const turn1 = beginSnapshotTurn("skeep");
		await captureSnapshot(f, "write"); // marker in turn 1 (f missing)
		await writeFile(f, "v1"); // file now exists
		beginSnapshotTurn("skeep"); // turn 2
		await captureSnapshot(f, "edit"); // real pre-image of "v1" in turn 2
		await writeFile(f, "v2");

		const result = await restoreToTurn(turn1, "skeep");
		expect(result.removed).toBe(0);
		expect(result.kept.map((p) => basename(p))).toContain("kept.txt");
		expect(existsSync(f)).toBe(true); // a later turn touched it — never deleted
	});

	it("records a creation marker on ENOENT but not for an existing non-file", async () => {
		// True ENOENT (file does not exist) → a creation marker is recorded.
		const ghost = join(tmp, "enoent.txt");
		beginSnapshotTurn("senoent");
		await captureSnapshot(ghost, "write");
		expect((await listTurns(20, "senoent")).some((t) => t.files.some((p) => basename(p) === "enoent.txt"))).toBe(
			true,
		);

		// An existing path that is NOT a regular file (a directory) → no marker.
		const dir = join(tmp, "adir");
		await mkdir(dir);
		beginSnapshotTurn("sdir");
		await captureSnapshot(dir, "write");
		expect(await listTurns(20, "sdir")).toEqual([]);
		// Note: an unreadable-but-existing regular file cannot be simulated portably
		// on win32; it follows the same non-ENOENT catch branch as above (stat
		// succeeds / readFile throws EACCES ≠ ENOENT → swallowed, no marker), so we
		// assert the two portable ends: true ENOENT creates a marker; existing does not.
	});
});

describe("direct captureSnapshot API", () => {
	it("getLatestSnapshot returns the most recent capture", async () => {
		const f = join(tmp, "direct.txt");
		writeFileSync(f, "one");
		await captureSnapshot(f, "manual");
		writeFileSync(f, "two");
		await captureSnapshot(f, "manual");
		const latest = await getLatestSnapshot(f);
		expect((await readSnapshotBytes(latest!)).toString("utf-8")).toBe("two");
	});

	it("skips capture for a non-existent file", async () => {
		const f = join(tmp, "ghost.txt");
		await captureSnapshot(f, "manual");
		expect((await listSnapshotsForFile(f)).length).toBe(0);
	});

	it("reads back a snapshot's raw bytes", async () => {
		const f = join(tmp, "raw.txt");
		const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x41, 0x0d, 0x0a]);
		await writeFile(f, bytes);
		await captureSnapshot(f, "manual");
		const [snap] = await listSnapshotsForFile(f);
		expect(await readFile(snap.snapPath)).toEqual(bytes);
	});
});

describe("capture dedup (plan 015)", () => {
	it("skips a byte-identical re-capture of an unchanged file", async () => {
		const f = join(tmp, "dedup.txt");
		await writeFile(f, "stable content");
		await captureSnapshot(f, "edit");
		// File is untouched — the newest snapshot already has this (mtime, size),
		// so a second capture is a no-op.
		await captureSnapshot(f, "edit");
		expect((await listSnapshotsForFile(f)).length).toBe(1);
	});

	it("captures again after the file's bytes change (different size)", async () => {
		const f = join(tmp, "changed.txt");
		await writeFile(f, "short");
		await captureSnapshot(f, "edit");
		// Different length → size differs from the newest snapshot, so even with
		// coarse mtime resolution the dedup check does not suppress this capture.
		await writeFile(f, "a considerably longer body of text");
		await captureSnapshot(f, "edit");
		expect((await listSnapshotsForFile(f)).length).toBe(2);
	});
});
