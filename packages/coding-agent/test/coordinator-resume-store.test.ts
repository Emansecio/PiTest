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
	listResumeHandlesSync,
	loadResumeState,
	RESUME_STATE_TTL_MS,
	type ResumeState,
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
		const raw = readFileSync(join(cwd, ".pit", "subagents", "h1.json"), "utf8");
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
		expect(listResumeHandlesSync(cwd)).not.toContain("h1");
	});

	it("list GCs files whose mtime exceeded the TTL", async () => {
		const cwd = tempCwd();
		await saveResumeState(cwd, makeState(cwd));
		const file = join(cwd, ".pit", "subagents", "h1.json");
		const old = (Date.now() - RESUME_STATE_TTL_MS - 60_000) / 1000;
		utimesSync(file, old, old);
		expect(listResumeHandlesSync(cwd)).toEqual([]);
		expect(await loadResumeState(cwd, "h1")).toBeUndefined();
	});

	it("keeps fresh states listable and loadable", async () => {
		const cwd = tempCwd();
		await saveResumeState(cwd, makeState(cwd));
		expect(listResumeHandlesSync(cwd)).toEqual(["h1"]);
		expect(await loadResumeState(cwd, "h1")).toBeDefined();
	});
});
