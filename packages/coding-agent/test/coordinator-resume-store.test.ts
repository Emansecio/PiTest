/**
 * Resume-store disk hygiene — secret redaction on save + TTL garbage collection.
 *
 * The persisted resume state carries a partial TRANSCRIPT (tool outputs from
 * bash/read may embed credentials), so it must honor the repo invariant that
 * bytes landing on disk pass through redactForDisk. And since resume files are
 * only deleted on a successful resume, expired states must be GC'd lazily so
 * stale handles stop resurfacing in op:"list" forever.
 */

import { mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@pit/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	deleteResumeState,
	listResumeHandlesSync,
	loadResumeState,
	RESUME_STATE_TTL_MS,
	type ResumeState,
	resumeStateStem,
	saveResumeState,
} from "../src/core/coordinator/resume-store.js";

const FAKE_KEY = `sk-ant-${"a1b2c3d4e5".repeat(3)}`;

function makeState(cwd: string, overrides: Partial<ResumeState> = {}): ResumeState {
	const messages = [
		{
			role: "user",
			content: [{ type: "text", text: `env dump: ANTHROPIC_API_KEY=${FAKE_KEY}` }],
			timestamp: Date.now(),
		},
	] as unknown as AgentMessage[];
	return {
		handle: "h1",
		messages,
		cwd,
		depth: 1,
		savedAt: Date.now(),
		...overrides,
	};
}

describe("resume-store disk hygiene", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) {
			const d = dirs.pop();
			if (d) rmSync(d, { recursive: true, force: true });
		}
	});

	function tempCwd(): string {
		const dir = mkdtempSync(join(tmpdir(), "pit-resume-test-"));
		dirs.push(dir);
		return dir;
	}

	it("redacts secrets in the persisted transcript (repo disk invariant)", async () => {
		const cwd = tempCwd();
		await saveResumeState(cwd, makeState(cwd));
		const raw = readFileSync(join(cwd, ".pit", "subagents", `${resumeStateStem("h1")}.json`), "utf8");
		expect(raw).not.toContain(FAKE_KEY);
		expect(raw).toContain("[REDACTED:");
		// Redaction markers contain no JSON metacharacters — the state round-trips.
		const loaded = await loadResumeState(cwd, "h1");
		expect(loaded).toBeDefined();
		const text = JSON.stringify(loaded?.messages);
		expect(text).not.toContain(FAKE_KEY);
		expect(text).toContain("[REDACTED:");
	});

	it("load GCs a state older than the TTL and reports it as gone", async () => {
		const cwd = tempCwd();
		await saveResumeState(cwd, makeState(cwd, { savedAt: Date.now() - RESUME_STATE_TTL_MS - 60_000 }));
		expect(await loadResumeState(cwd, "h1")).toBeUndefined();
		// The expired file was deleted — a second load misses cleanly too.
		expect(listResumeHandlesSync(cwd)).not.toContain(resumeStateStem("h1"));
	});

	it("list GCs files whose mtime exceeded the TTL", async () => {
		const cwd = tempCwd();
		await saveResumeState(cwd, makeState(cwd));
		const file = join(cwd, ".pit", "subagents", `${resumeStateStem("h1")}.json`);
		const old = (Date.now() - RESUME_STATE_TTL_MS - 60_000) / 1000;
		utimesSync(file, old, old);
		expect(listResumeHandlesSync(cwd)).toEqual([]);
		expect(await loadResumeState(cwd, "h1")).toBeUndefined();
	});

	it("keeps fresh states listable and loadable", async () => {
		const cwd = tempCwd();
		await saveResumeState(cwd, makeState(cwd));
		// The on-disk stem carries a collision-safe discriminator, but the RAW handle
		// still round-trips through load (canonical candidate) and list surfaces the stem.
		expect(listResumeHandlesSync(cwd)).toEqual([resumeStateStem("h1")]);
		expect(resumeStateStem("h1")).toMatch(/^h1-[0-9a-f]{8}$/);
		expect(await loadResumeState(cwd, "h1")).toBeDefined();
		// And a resume addressed by the list-surfaced STEM resolves the same file.
		expect(await loadResumeState(cwd, resumeStateStem("h1"))).toBeDefined();
	});

	it("keeps distinct transcripts for two handles that collapse to the same readable stem (H21)", async () => {
		const cwd = tempCwd();
		// Under the old `sanitize` (collapse + slice) both names → "dup_task", so the
		// second save overwrote the first's transcript. The discriminator separates them.
		const nameA = "dup task";
		const nameB = "dup_task";
		expect(nameA).not.toBe(nameB);
		expect(nameA.replace(/[^a-zA-Z0-9_-]+/g, "_")).toBe(nameB.replace(/[^a-zA-Z0-9_-]+/g, "_"));
		expect(resumeStateStem(nameA)).not.toBe(resumeStateStem(nameB));

		const mkMsg = (text: string) =>
			[{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] as unknown as AgentMessage[];
		await saveResumeState(cwd, makeState(cwd, { handle: nameA, messages: mkMsg("transcript-A") }));
		await saveResumeState(cwd, makeState(cwd, { handle: nameB, messages: mkMsg("transcript-B") }));

		// Two distinct files on disk — no overwrite.
		expect(listResumeHandlesSync(cwd).sort()).toEqual([resumeStateStem(nameA), resumeStateStem(nameB)].sort());

		// Each raw handle loads its OWN transcript (no cross-contamination).
		const a = await loadResumeState(cwd, nameA);
		const b = await loadResumeState(cwd, nameB);
		expect(JSON.stringify(a?.messages)).toContain("transcript-A");
		expect(JSON.stringify(a?.messages)).not.toContain("transcript-B");
		expect(JSON.stringify(b?.messages)).toContain("transcript-B");
		expect(JSON.stringify(b?.messages)).not.toContain("transcript-A");

		// Deleting one leaves the other intact.
		await deleteResumeState(cwd, nameA);
		expect(await loadResumeState(cwd, nameA)).toBeUndefined();
		expect(await loadResumeState(cwd, nameB)).toBeDefined();
	});
});
