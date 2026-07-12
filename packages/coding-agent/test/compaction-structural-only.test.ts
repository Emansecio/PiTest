/**
 * Tests for the structural-only compaction fast path (#7).
 *
 * When the compacted window is a pure burst of tool I/O with no explanatory
 * prose, compact() skips the summarization LLM entirely and emits only the
 * deterministic structural frame (file operations + digests). Default-on;
 * PIT_NO_STRUCTURAL_COMPACTION=1 forces the always-LLM path.
 */
import type { AgentMessage } from "@pit/agent-core";
import type { AssistantMessage, Usage } from "@pit/ai";
import { getModel } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CompactionPreparation,
	compact,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
} from "../src/core/compaction/index.js";
import { MESSAGE_RELAY_CUSTOM_TYPE } from "../src/core/messaging/index.ts";

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
	return { role: "user", content: text, timestamp: 1 } as AgentMessage;
}

function assistantText(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: usage(),
		stopReason: "stop",
		timestamp: 1,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-5",
	} as AgentMessage;
}

/** Assistant message that is pure tool I/O: a tool call with NO text block. */
function assistantToolCall(name: string, args: unknown): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: `tc-${name}`, name, arguments: args }],
		usage: usage(),
		stopReason: "stop",
		timestamp: 1,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-5",
	} as AgentMessage;
}

function toolResult(text: string): AgentMessage {
	return {
		role: "toolResult",
		content: [{ type: "text", text }],
		toolCallId: "tc-read",
		toolName: "read",
		isError: false,
		timestamp: 1,
	} as AgentMessage;
}

/** Extension-injected custom message carrying real text prose. */
function customMsg(customType: string, content: string): AgentMessage {
	return {
		role: "custom",
		customType,
		content,
		display: true,
		timestamp: 1,
	} as AgentMessage;
}

// Canned summary stream + a call counter. compact() only calls `.result()`.
function countingStreamFn(summaryText: string): { streamFn: any; calls: () => number } {
	let calls = 0;
	const response: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: summaryText }],
		usage: usage(),
		stopReason: "stop",
		timestamp: 1,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-5",
	};
	const streamFn = (() => {
		calls++;
		return { result: async () => response };
	}) as any;
	return { streamFn, calls: () => calls };
}

function preparation(
	messagesToSummarize: AgentMessage[],
	overrides?: Partial<CompactionPreparation>,
): CompactionPreparation {
	const fileOps = createFileOps();
	fileOps.read.add("a.ts");
	fileOps.edited.add("b.ts");
	return {
		firstKeptEntryId: "kept",
		messagesToSummarize,
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 1000,
		fileOps,
		// selfCorrection off so any extra call we observe is the summarizer itself.
		settings: { ...DEFAULT_COMPACTION_SETTINGS, selfCorrection: false },
		...overrides,
	};
}

describe("structural-only compaction (#7)", () => {
	const model = getModel("anthropic", "claude-sonnet-5")!;

	afterEach(() => {
		delete process.env.PIT_NO_STRUCTURAL_COMPACTION;
	});

	it("skips the summarizer for a prose-free tool-only window", async () => {
		// A burst of read/grep/edit tool calls with NO assistant narration.
		const window: AgentMessage[] = [
			assistantToolCall("read", { path: "a.ts" }),
			toolResult("export function foo() {}\n".repeat(50)),
			assistantToolCall("grep", { pattern: "foo" }),
			toolResult("a.ts:1: foo\n".repeat(30)),
			assistantToolCall("edit", { path: "b.ts", oldText: "x", newText: "y" }),
			toolResult("edited b.ts"),
		];
		const { streamFn, calls } = countingStreamFn("## Goal\nLLM SUMMARY SHOULD NOT APPEAR");

		const result = await compact(
			preparation(window),
			model,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			streamFn,
		);

		// Summarizer never invoked.
		expect(calls()).toBe(0);
		expect(result.summary).not.toContain("LLM SUMMARY SHOULD NOT APPEAR");
		// Deterministic structural frame is still present.
		expect(result.summary).toContain("<read-files>");
		expect(result.summary).toContain("<modified-files>");
		expect(result.summary).toContain("a.ts");
		expect(result.summary).toContain("b.ts");
	});

	it("uses the summarizer when the window carries explanatory prose", async () => {
		// Same tool burst, but the assistant also explains what it is doing — that
		// prose is what only an LLM can summarize, so the LLM path must run.
		const window: AgentMessage[] = [
			userMsg("Please refactor the foo helper into its own module and update imports."),
			assistantText(
				"I'll extract foo() into a new module, then update every import site. " +
					"This requires touching the barrel export and the two call sites in the UI layer.",
			),
			assistantToolCall("edit", { path: "b.ts", oldText: "x", newText: "y" }),
			toolResult("edited b.ts"),
		];
		const { streamFn, calls } = countingStreamFn("## Goal\nLLM_SUMMARY_TEXT");

		const result = await compact(
			preparation(window),
			model,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			streamFn,
		);

		expect(calls()).toBe(1);
		expect(result.summary).toContain("LLM_SUMMARY_TEXT");
		// Structural frame still appended after the LLM summary.
		expect(result.summary).toContain("<modified-files>");
	});

	it("PIT_NO_STRUCTURAL_COMPACTION=1 forces the always-LLM path even with no prose", async () => {
		process.env.PIT_NO_STRUCTURAL_COMPACTION = "1";
		const window: AgentMessage[] = [
			assistantToolCall("read", { path: "a.ts" }),
			toolResult("export function foo() {}"),
		];
		const { streamFn, calls } = countingStreamFn("## Goal\nFORCED_LLM");

		const result = await compact(
			preparation(window),
			model,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			streamFn,
		);

		expect(calls()).toBe(1);
		expect(result.summary).toContain("FORCED_LLM");
	});

	it("never goes structural-only for an incremental compaction (previousSummary set)", async () => {
		// Incremental: prose lives in the prior summary, not the window. Collapsing to
		// structural-only here would silently drop that prose — so the LLM must run.
		const window: AgentMessage[] = [
			assistantToolCall("read", { path: "a.ts" }),
			toolResult("export function foo() {}"),
		];
		const { streamFn, calls } = countingStreamFn("## Goal\nINCREMENTAL_LLM");

		const result = await compact(
			preparation(window, { previousSummary: "## Goal\nprior work the user described earlier" }),
			model,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			streamFn,
		);

		expect(calls()).toBe(1);
		expect(result.summary).toContain("INCREMENTAL_LLM");
	});

	it("counts only true prose: a tiny assistant note under the threshold stays structural-only", async () => {
		// One short word of narration is below STRUCTURAL_ONLY_PROSE_THRESHOLD (~200
		// chars), so the window is still treated as mechanical.
		const window: AgentMessage[] = [
			assistantText("ok"),
			assistantToolCall("read", { path: "a.ts" }),
			toolResult("export function foo() {}".repeat(40)),
		];
		const { streamFn, calls } = countingStreamFn("## Goal\nSHOULD_NOT_RUN");

		const result = await compact(
			preparation(window),
			model,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			streamFn,
		);

		expect(calls()).toBe(0);
		expect(result.summary).not.toContain("SHOULD_NOT_RUN");
		expect(result.summary).toContain("<read-files>");
	});

	it("counts non-relay custom (extension-injected) prose: tips back to the LLM path", async () => {
		// The ONLY prose in the window lives in a non-relay custom message (e.g.
		// extension-injected context/notes). convertToLlm relays it to the
		// summarizer as a user message, so it must be counted — collapsing to
		// structural-only would silently drop it.
		const window: AgentMessage[] = [
			customMsg(
				"pi.extension-note",
				"Context from the deploy extension: the staging rollout failed because the " +
					"migration 0042 added a NOT NULL column without a default; the runbook says to " +
					"backfill first, then re-run. Keep this constraint in mind when editing the schema.",
			),
			assistantToolCall("read", { path: "a.ts" }),
			toolResult("export function foo() {}".repeat(40)),
		];
		const { streamFn, calls } = countingStreamFn("## Goal\nCUSTOM_PROSE_LLM");

		const result = await compact(
			preparation(window),
			model,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			streamFn,
		);

		expect(calls()).toBe(1);
		expect(result.summary).toContain("CUSTOM_PROSE_LLM");
		expect(result.summary).toContain("<read-files>");
	});

	it("excludes relay custom messages: a relay-only window stays structural-only", async () => {
		// Inter-agent relay lines are display-only — convertToLlm drops them, so they
		// carry no prose the summarizer would ever see. A window whose only "text" is
		// a relay custom must still collapse to the structural frame.
		const window: AgentMessage[] = [
			customMsg(
				MESSAGE_RELAY_CUSTOM_TYPE,
				"This relay line is long enough to exceed the prose threshold on its own, " +
					"so if it were ever counted the window would wrongly tip to the LLM path. " +
					"It is display-only and convertToLlm drops it, so it must NOT be counted.",
			),
			assistantToolCall("read", { path: "a.ts" }),
			toolResult("export function foo() {}".repeat(40)),
		];
		const { streamFn, calls } = countingStreamFn("## Goal\nRELAY_SHOULD_NOT_RUN");

		const result = await compact(
			preparation(window),
			model,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			streamFn,
		);

		expect(calls()).toBe(0);
		expect(result.summary).not.toContain("RELAY_SHOULD_NOT_RUN");
		expect(result.summary).toContain("<read-files>");
	});
});
