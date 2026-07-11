import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	encodeSessionDirName,
	isEphemeralSessionDirName,
	normalizeCwdKey,
	type SessionHeader,
	SessionManager,
	sessionMatchesCwd,
} from "../src/core/session-manager.js";

function writeSession(dir: string, id: string, cwd: string, firstMessage = "hi"): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
	const header: SessionHeader = {
		type: "session",
		id,
		version: 3,
		timestamp: new Date(0).toISOString(),
		cwd,
	};
	const userEntry = {
		type: "message",
		id: `${id}-m1`,
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: { role: "user", content: firstMessage, timestamp: 1 },
	};
	writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n`, "utf8");
	return file;
}

describe("session cwd filtering", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("normalizeCwdKey is case-insensitive on win32", () => {
		if (process.platform !== "win32") return;
		expect(normalizeCwdKey("C:\\Users\\User\\Desktop\\Robinhood")).toBe(
			normalizeCwdKey("c:\\users\\user\\desktop\\robinhood"),
		);
	});

	it("sessionMatchesCwd treats casing variants as the same folder on win32", () => {
		if (process.platform !== "win32") return;
		expect(sessionMatchesCwd("C:\\Work\\App", "c:\\work\\app")).toBe(true);
		expect(sessionMatchesCwd("C:\\Work\\App", "C:\\Other")).toBe(false);
	});

	it("isEphemeralSessionDirName detects pit tmp buckets", () => {
		expect(isEphemeralSessionDirName("--C--Users-User-.pit-tmp-pi-2753-abc--")).toBe(true);
		expect(isEphemeralSessionDirName("--C--Users-User-AppData-Local-Temp-foo--")).toBe(true);
		expect(isEphemeralSessionDirName("--C--Users-User-Desktop-Robinhood--")).toBe(false);
	});

	it("list keeps only sessions whose header cwd matches the execution folder", async () => {
		const root = mkdtempSync(join(tmpdir(), "pit-cwd-filter-"));
		tempDirs.push(root);
		const projectA = join(root, "project-a");
		const projectB = join(root, "project-b");
		mkdirSync(projectA);
		mkdirSync(projectB);

		// Shared session dir holding mixed projects (custom --session-dir case)
		const shared = join(root, "shared-sessions");
		writeSession(shared, "a1", projectA, "from-a");
		writeSession(shared, "b1", projectB, "from-b");

		const listed = await SessionManager.list(projectA, shared);
		expect(listed.map((s) => s.id)).toEqual(["a1"]);
		expect(listed[0]?.firstMessage).toBe("from-a");
	});

	it("encodeSessionDirName is stable for a given cwd string", () => {
		expect(encodeSessionDirName("C:\\Users\\User\\Desktop\\Robinhood")).toBe("--C--Users-User-Desktop-Robinhood--");
	});
});
