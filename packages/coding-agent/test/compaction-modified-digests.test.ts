import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@pit/agent-core";
import type { AssistantMessage, Usage } from "@pit/ai";
import { getModel } from "@pit/ai";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
} from "../src/core/compaction/index.js";

const dir = mkdtempSync(join(tmpdir(), "pit-mod-digests-"));

function usage(): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function userMsg(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function assistantMsg(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: usage(),
		stopReason: "stop",
		timestamp: 1,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	} as AgentMessage;
}

// Canned summary stream — compact() only calls `.result()`, so this shape suffices.
function fakeStreamFn(summaryText: string) {
	const response: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: summaryText }],
		usage: usage(),
		stopReason: "stop",
		timestamp: 1,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
	return (() => ({ result: async () => response })) as any;
}

function preparationFor(fileOps: ReturnType<typeof createFileOps>): CompactionPreparation {
	return {
		firstKeptEntryId: "kept",
		messagesToSummarize: [userMsg("q1"), assistantMsg("a1"), userMsg("q2"), assistantMsg("a2")],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 1000,
		fileOps,
		settings: { ...DEFAULT_COMPACTION_SETTINGS, selfCorrection: false },
		cwd: dir,
	};
}

describe("compaction digests modified files by default", () => {
	let savedFlag: string | undefined;
	// Force the flag OFF so we prove modified-file digests are default-on, not flag-driven.
	beforeEach(() => {
		savedFlag = process.env.PIT_FILE_DIGESTS;
		delete process.env.PIT_FILE_DIGESTS;
	});
	afterEach(() => {
		if (savedFlag !== undefined) process.env.PIT_FILE_DIGESTS = savedFlag;
		else delete process.env.PIT_FILE_DIGESTS;
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("includes a symbol digest for a modified file without PIT_FILE_DIGESTS", async () => {
		writeFileSync(join(dir, "mod.ts"), "export function touched() {}\nexport class Shape {}\n");
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const fileOps = createFileOps();
		fileOps.edited.add("mod.ts");

		const result = await compact(
			preparationFor(fileOps),
			model,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStreamFn("## Goal\nfake"),
		);

		expect(result.summary).toContain("file-digests");
		expect(result.summary).toContain("touched");
		expect(result.summary).toContain("Shape");
		expect(result.summary).toContain("mod.ts");
	});

	it("does not digest read-only files by default (those stay behind the flag)", async () => {
		writeFileSync(join(dir, "ro.ts"), "export function readOnlyThing() {}\n");
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const fileOps = createFileOps();
		fileOps.read.add("ro.ts");

		const result = await compact(
			preparationFor(fileOps),
			model,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStreamFn("## Goal\nfake"),
		);

		expect(result.summary).toContain("<read-files>");
		expect(result.summary).not.toContain("readOnlyThing");
	});
});
