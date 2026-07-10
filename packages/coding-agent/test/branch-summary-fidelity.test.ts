import type { AgentMessage } from "@pit/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateBranchSummary } from "../src/core/compaction/branch-summarization.js";
import * as compaction from "../src/core/compaction/compaction.js";
import * as summaryGrounding from "../src/core/compaction/summary-grounding.js";
import type { SessionEntry } from "../src/core/session-manager.js";

const mockModel = {
	contextWindow: 128000,
	maxTokens: 4096,
} as Parameters<typeof generateBranchSummary>[1]["model"];

function userEntry(text: string, i: number): SessionEntry {
	return {
		type: "message",
		id: `m${i}`,
		parentId: i === 0 ? null : `m${i - 1}`,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: text, timestamp: Date.now() } as AgentMessage,
	} as unknown as SessionEntry;
}

describe("branch summary fidelity (C7/E16)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.PIT_NO_SUMMARY_GROUNDING;
	});

	it("runs verifySummary and groundSummaryPaths on the generated prose", async () => {
		const entries = [userEntry("one", 0), userEntry("two", 1), userEntry("three", 2)];

		vi.spyOn(compaction, "runSummarizationWithStatus").mockResolvedValue({
			status: "ok",
			text: "## Goal\nDo the thing",
		});
		vi.spyOn(compaction, "sumMessageTokens").mockReturnValue(100_000);
		const verifySpy = vi.spyOn(compaction, "verifySummary").mockResolvedValue("## Goal\nDo the thing (verified)");
		const groundSpy = vi.spyOn(summaryGrounding, "groundSummaryPaths").mockReturnValue({
			summary: "## Goal\nDo the thing (verified, grounded)",
			ungroundedPaths: [],
		});

		const result = await generateBranchSummary(entries, {
			model: mockModel,
			apiKey: "test-key",
			signal: new AbortController().signal,
			cwd: process.cwd(),
			selfCorrection: true,
		});

		expect(verifySpy).toHaveBeenCalledOnce();
		expect(groundSpy).toHaveBeenCalledOnce();
		expect(result.summary).toContain("Do the thing (verified, grounded)");
		expect(result.summary).toMatch(/^The user explored a different conversation branch/);
	});

	it("skips verify when selfCorrection is false but still grounds", async () => {
		const entries = [userEntry("one", 0), userEntry("two", 1), userEntry("three", 2)];

		vi.spyOn(compaction, "runSummarizationWithStatus").mockResolvedValue({
			status: "ok",
			text: "## Goal\nSkip verify",
		});
		vi.spyOn(compaction, "sumMessageTokens").mockReturnValue(100_000);
		const verifySpy = vi.spyOn(compaction, "verifySummary");
		const groundSpy = vi.spyOn(summaryGrounding, "groundSummaryPaths").mockReturnValue({
			summary: "## Goal\nSkip verify (grounded)",
			ungroundedPaths: [],
		});

		await generateBranchSummary(entries, {
			model: mockModel,
			apiKey: "test-key",
			signal: new AbortController().signal,
			selfCorrection: false,
		});

		expect(verifySpy).not.toHaveBeenCalled();
		expect(groundSpy).toHaveBeenCalledOnce();
	});

	it("fail-open: keeps original prose when verify throws", async () => {
		const entries = [userEntry("one", 0), userEntry("two", 1), userEntry("three", 2)];

		vi.spyOn(compaction, "runSummarizationWithStatus").mockResolvedValue({
			status: "ok",
			text: "## Goal\nOriginal prose",
		});
		vi.spyOn(compaction, "sumMessageTokens").mockReturnValue(100_000);
		vi.spyOn(compaction, "verifySummary").mockRejectedValue(new Error("provider down"));
		const groundSpy = vi.spyOn(summaryGrounding, "groundSummaryPaths");

		const result = await generateBranchSummary(entries, {
			model: mockModel,
			apiKey: "test-key",
			signal: new AbortController().signal,
			selfCorrection: true,
		});

		expect(groundSpy).not.toHaveBeenCalled();
		expect(result.summary).toContain("Original prose");
		expect(result.summary).not.toContain("(verified");
	});
});
