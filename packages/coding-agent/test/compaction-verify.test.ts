import type { AgentMessage } from "@pit/agent-core";
import type { AssistantMessage, Usage } from "@pit/ai";
import { getModel } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildVerificationSource,
	type CompactionPreparation,
	type CompactionSettings,
	compact,
	correctionCitesSource,
	createFileOps,
	createSerializedWindow,
	DEFAULT_COMPACTION_SETTINGS,
} from "../src/core/compaction/index.js";

// Wrap convertToLlm with a pass-through counter so the SerializedWindow tests
// can assert how many times compact() serializes a window. Behavior unchanged.
const { convertToLlmSpy } = vi.hoisted(() => ({ convertToLlmSpy: { count: 0 } }));
vi.mock("../src/core/messages.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/messages.js")>();
	return {
		...actual,
		convertToLlm: (...args: Parameters<typeof actual.convertToLlm>) => {
			convertToLlmSpy.count++;
			return actual.convertToLlm(...args);
		},
	};
});

// ============================================================================
// Helpers
// ============================================================================

function createMockUsage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: createMockUsage(100, 50),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-5",
	};
}

function createToolResultMessage(text: string): AgentMessage {
	return {
		role: "toolResult",
		content: [{ type: "text", text }],
		toolCallId: "tc-1",
		toolName: "read",
		isError: false,
		timestamp: Date.now(),
	} as AgentMessage;
}

// ============================================================================
// buildVerificationSource — pure unit tests
// ============================================================================

describe("buildVerificationSource", () => {
	it("serializes the window as a conversation-delta (compact JSON) containing user/assistant text", () => {
		const messages = [
			createUserMessage("Fix the verify pass in compaction.ts"),
			createAssistantMessage("On it, reading the file first."),
		];
		const source = buildVerificationSource(messages, []);
		// Delta format is a JSON array of {k,t,...} events; user text survives inside.
		expect(source).toContain('"k":"u"');
		expect(source).toContain("Fix the verify pass in compaction.ts");
		expect(source).toContain('"k":"a"');
		expect(source).toContain("reading the file first");
	});

	it("prepends turn-prefix messages before the main window in source order", () => {
		const main = [createUserMessage("main turn text")];
		const prefix = [createAssistantMessage("prefix turn text")];
		const source = buildVerificationSource(main, prefix);
		const prefixIdx = source.indexOf("prefix turn text");
		const mainIdx = source.indexOf("main turn text");
		expect(prefixIdx).toBeGreaterThanOrEqual(0);
		expect(mainIdx).toBeGreaterThanOrEqual(0);
		expect(prefixIdx).toBeLessThan(mainIdx);
	});

	it("returns the full delta unchanged when it fits within the head+tail budget", () => {
		const small = [createUserMessage("short")];
		const source = buildVerificationSource(small, []);
		// No elision marker when nothing was cut.
		expect(source).not.toContain("characters elided");
		expect(source).toContain("short");
	});

	it("bounds a huge window with a head+tail excerpt and an elision marker", () => {
		// ~60k chars of prose -> delta JSON well over the 32k head+tail budget.
		const huge = createUserMessage("alpha-beta-gamma-delta-epsilon ".repeat(2000));
		const source = buildVerificationSource([huge], []);
		expect(source.length).toBeLessThan(40_000);
		expect(source).toContain("characters elided");
		// Head content (start of the repeated phrase) survives.
		expect(source).toContain("alpha-beta-gamma");
	});

	it("ignores an empty turn-prefix array (no leading separator)", () => {
		const source = buildVerificationSource([createUserMessage("solo")], []);
		expect(source).toContain("solo");
		expect(source.startsWith("\n")).toBe(false);
	});
});

// ============================================================================
// compact() — verify pass receives the conversation source (anti-alucinação)
// ============================================================================

describe("compact() self-correction verify pass", () => {
	beforeEach(() => {
		// Force the always-LLM path so the summarizer + verify both run even when
		// the window is tool-heavy; our window here is prose-heavy anyway, but this
		// keeps the test robust against structural-only fast path changes.
		process.env.PIT_NO_STRUCTURAL_COMPACTION = "1";
		// Disable JSON-primary output so the canned summary passes through verbatim
		// (no JSON schema parse/fallback noise in assertions).
		process.env.PIT_NO_STRUCTURED_SUMMARY_OUTPUT = "1";
		process.env.PIT_NO_COMPACT_SUMMARY_OUTPUT = "1";
	});
	afterEach(() => {
		delete process.env.PIT_NO_STRUCTURAL_COMPACTION;
		delete process.env.PIT_NO_STRUCTURED_SUMMARY_OUTPUT;
		delete process.env.PIT_NO_COMPACT_SUMMARY_OUTPUT;
	});

	// Captures every prompt sent to the summarizer LLM and returns canned responses.
	// compact() calls streamFn once for generateSummary, then once for verifySummary.
	function capturingStreamFn(responses: string[]): {
		streamFn: any;
		prompts: string[];
	} {
		const prompts: string[] = [];
		let callIdx = 0;
		const streamFn = (
			_model: unknown,
			context: { messages: Array<{ content: Array<{ text?: string }> }> },
			_options: unknown,
		) => {
			const promptText = context.messages[0]?.content?.[0]?.text ?? "";
			prompts.push(promptText);
			const text = responses[Math.min(callIdx, responses.length - 1)];
			callIdx++;
			const response: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text }],
				usage: createMockUsage(10, 10),
				stopReason: "stop",
				timestamp: Date.now(),
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-5",
			};
			return { result: async () => response };
		};
		return { streamFn, prompts };
	}

	it("sends the verify pass a prompt with <conversation-delta> source AND <summary>, plus the anti-fabrication rule", async () => {
		const model = getModel("anthropic", "claude-sonnet-5")!;
		// ~420k chars of prose -> ~105k tokens, crossing VERIFY_MIN_INPUT_TOKENS
		// (80k after M15 — the separate verify call now fires only on very large
		// windows; smaller ones ride the in-prompt self-check). User prose is not
		// pruned and counts as prose (skips structural-only).
		const bigProse = "We are fixing the compaction verify pass in compaction.ts. ".repeat(7000);
		const messagesToSummarize: AgentMessage[] = [
			createUserMessage(bigProse),
			createAssistantMessage("Reading compaction.ts now."),
			createUserMessage("Continue the fix."),
			createAssistantMessage("Done editing."),
		];

		const settings: CompactionSettings = { ...DEFAULT_COMPACTION_SETTINGS }; // selfCorrection default true
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept-id",
			messagesToSummarize,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 50_000,
			fileOps: createFileOps(),
			settings,
		};

		const { streamFn, prompts } = capturingStreamFn(["## Goal\nfake summary", "## Goal\nfake summary"]);
		await compact(preparation, model, undefined, undefined, undefined, undefined, undefined, streamFn);

		// Two LLM calls: summarization, then verification.
		expect(prompts.length).toBe(2);
		const summarizePrompt = prompts[0];
		const verifyPrompt = prompts[1];

		// Sanity: the first call is the summarization prompt (carries the conversation).
		expect(summarizePrompt).toContain("<conversation>");

		// The verify pass MUST now carry the source it checks against, plus the summary.
		expect(verifyPrompt).toContain("<conversation-delta>");
		expect(verifyPrompt).toContain("</conversation-delta>");
		expect(verifyPrompt).toContain("<summary>");
		expect(verifyPrompt).toContain("</summary>");
		// Anti-fabrication rule is present so the model does not invent additions.
		expect(verifyPrompt).toContain("ANTI-FABRICATION");
		expect(verifyPrompt).toContain("VERBATIM");
		// The source actually carries window content (not an empty placeholder).
		expect(verifyPrompt).toContain("fixing the compaction verify pass");
	});

	it("does NOT pay the separate verify call in the 25k-80k band (self-check rides the single call — M15)", async () => {
		const model = getModel("anthropic", "claude-sonnet-5")!;
		// ~138k chars -> ~34.5k tokens: above the OLD 25k bar, below the new 80k one.
		const bigProse = "We are fixing the compaction verify pass in compaction.ts. ".repeat(2300);
		const messagesToSummarize: AgentMessage[] = [
			createUserMessage(bigProse),
			createAssistantMessage("Reading compaction.ts now."),
		];

		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept-id",
			messagesToSummarize,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 50_000,
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS },
		};

		const { streamFn, prompts } = capturingStreamFn(["## Goal\nfake summary"]);
		await compact(preparation, model, undefined, undefined, undefined, undefined, undefined, streamFn);

		// One LLM call only; the summarizer prompt itself carries the self-check.
		expect(prompts.length).toBe(1);
		expect(prompts[0]).toContain("self-check");
	});

	it("accepts an oversize verify correction when it is grounded in the source (>10% gate no longer blind)", async () => {
		const model = getModel("anthropic", "claude-sonnet-5")!;
		process.env.PIT_NO_SUMMARY_GROUNDING = "1";
		try {
			const bigProse = "We are fixing the compaction verify pass in compaction.ts. ".repeat(7000);
			const messagesToSummarize: AgentMessage[] = [
				createUserMessage(bigProse),
				createAssistantMessage("Reading compaction.ts now."),
			];
			const preparation: CompactionPreparation = {
				firstKeptEntryId: "kept-id",
				messagesToSummarize,
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 50_000,
				fileOps: createFileOps(),
				settings: { ...DEFAULT_COMPACTION_SETTINGS },
			};

			const original = `## Goal\n${"steady summary body without any file mentions at all ".repeat(8)}`;
			// >10% larger, and the added line cites compaction.ts — present verbatim
			// in the verification source (the window prose mentions it).
			const corrected = `${original}\n- Omitted: the fix targets compaction.ts verify pass\n${"grounded detail ".repeat(4)}`;
			const { streamFn, prompts } = capturingStreamFn([original, corrected]);
			const result = await compact(
				preparation,
				model,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				streamFn,
			);

			expect(prompts.length).toBe(2);
			expect(result.summary).toContain("Omitted: the fix targets compaction.ts verify pass");
		} finally {
			delete process.env.PIT_NO_SUMMARY_GROUNDING;
		}
	});

	it("still rejects oversize UNGROUNDED verify output (fabrication risk)", async () => {
		const model = getModel("anthropic", "claude-sonnet-5")!;
		process.env.PIT_NO_SUMMARY_GROUNDING = "1";
		try {
			const bigProse = "We are fixing the compaction verify pass in compaction.ts. ".repeat(7000);
			const messagesToSummarize: AgentMessage[] = [
				createUserMessage(bigProse),
				createAssistantMessage("Reading compaction.ts now."),
			];
			const preparation: CompactionPreparation = {
				firstKeptEntryId: "kept-id",
				messagesToSummarize,
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 50_000,
				fileOps: createFileOps(),
				settings: { ...DEFAULT_COMPACTION_SETTINGS },
			};

			const original = `## Goal\n${"steady summary body without any file mentions at all ".repeat(8)}`;
			// >10% larger but the additions cite nothing from the source — no paths,
			// no backticked identifiers. Must fall back to the original.
			const corrected = `${original}\n${"padding words with no citations anywhere ".repeat(5)}`;
			const { streamFn, prompts } = capturingStreamFn([original, corrected]);
			const result = await compact(
				preparation,
				model,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				streamFn,
			);

			expect(prompts.length).toBe(2);
			expect(result.summary).not.toContain("padding words with no citations");
			expect(result.summary).toContain("steady summary body");
		} finally {
			delete process.env.PIT_NO_SUMMARY_GROUNDING;
		}
	});

	it("skips the verify pass when selfCorrection is disabled (only one LLM call)", async () => {
		const model = getModel("anthropic", "claude-sonnet-5")!;
		const bigProse = "We are fixing the compaction verify pass in compaction.ts. ".repeat(7000);
		const messagesToSummarize: AgentMessage[] = [
			createUserMessage(bigProse),
			createAssistantMessage("Reading compaction.ts now."),
			createUserMessage("Continue the fix."),
			createAssistantMessage("Done editing."),
		];

		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept-id",
			messagesToSummarize,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 50_000,
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS, selfCorrection: false },
		};

		const { streamFn, prompts } = capturingStreamFn(["## Goal\nfake summary"]);
		await compact(preparation, model, undefined, undefined, undefined, undefined, undefined, streamFn);

		// Only the summarization call — no verify pass.
		expect(prompts.length).toBe(1);
		expect(prompts[0]).toContain("<conversation>");
	});

	it("does not feed tool-result bodies into the verify source verbatim (delta caps + excerpt bound)", async () => {
		const model = getModel("anthropic", "claude-sonnet-5")!;
		// A large tool result (would be ~27k dense tokens). The verify source must
		// still be bounded by the head+tail excerpt, never the raw 90k body.
		const bigToolResult = createToolResultMessage("Z".repeat(90_000));
		// Add enough prose to cross VERIFY_MIN_INPUT_TOKENS (80k) after the prune
		// caps the tool result down (prose is not pruned).
		const bigProse = "We are fixing the compaction verify pass in compaction.ts. ".repeat(7000);
		const messagesToSummarize: AgentMessage[] = [
			bigToolResult,
			createUserMessage(bigProse),
			createAssistantMessage("Working."),
			createUserMessage("Go."),
			createAssistantMessage("Done."),
		];

		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept-id",
			messagesToSummarize,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 50_000,
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS },
		};

		const { streamFn, prompts } = capturingStreamFn(["## Goal\nfake summary", "## Goal\nfake summary"]);
		await compact(preparation, model, undefined, undefined, undefined, undefined, undefined, streamFn);

		expect(prompts.length).toBe(2);
		const verifyPrompt = prompts[1];
		// The raw 90k body must NOT appear in full — the source is bounded.
		expect(verifyPrompt.length).toBeLessThan(60_000);
		expect(verifyPrompt).toContain("<conversation-delta>");
	});
});

// ============================================================================
// correctionCitesSource — deterministic grounding test for the inflation gate
// ============================================================================

describe("correctionCitesSource", () => {
	const source =
		"User asked to fix src/core/compaction/compaction.ts after `TypeError: source is undefined` was thrown.";

	it("true when an added line cites a path present verbatim in the source", () => {
		const original = "## Goal\n- Fix the bug";
		const corrected = `${original}\n- Omitted: the file is src/core/compaction/compaction.ts`;
		expect(correctionCitesSource(original, corrected, source)).toBe(true);
	});

	it("true when an added line cites a backticked identifier from the source", () => {
		const original = "## Goal\n- Fix the bug";
		const corrected = `${original}\n- Error was \`TypeError: source is undefined\``;
		expect(correctionCitesSource(original, corrected, source)).toBe(true);
	});

	it("false when the additions cite nothing from the source", () => {
		const original = "## Goal\n- Fix the bug";
		const corrected = `${original}\n- More vague words about progress`;
		expect(correctionCitesSource(original, corrected, source)).toBe(false);
	});

	it("false when the cited path does NOT appear in the source (fabrication)", () => {
		const original = "## Goal\n- Fix the bug";
		const corrected = `${original}\n- Touched src/fabricated/ghost.ts too`;
		expect(correctionCitesSource(original, corrected, source)).toBe(false);
	});

	it("ignores lines already present in the original (only ADDED lines count)", () => {
		const original = "## Goal\n- Fix src/core/compaction/compaction.ts";
		const corrected = `${original}\n- New vague line`;
		expect(correctionCitesSource(original, corrected, source)).toBe(false);
	});
});

// ============================================================================
// SerializedWindow — shared convertToLlm + delta between summarizer and verify
// ============================================================================

describe("SerializedWindow reuse", () => {
	beforeEach(() => {
		process.env.PIT_NO_STRUCTURAL_COMPACTION = "1";
		process.env.PIT_NO_STRUCTURED_SUMMARY_OUTPUT = "1";
		process.env.PIT_NO_COMPACT_SUMMARY_OUTPUT = "1";
		convertToLlmSpy.count = 0;
	});
	afterEach(() => {
		delete process.env.PIT_NO_STRUCTURAL_COMPACTION;
		delete process.env.PIT_NO_STRUCTURED_SUMMARY_OUTPUT;
		delete process.env.PIT_NO_COMPACT_SUMMARY_OUTPUT;
	});

	function cannedStreamFn(text: string): any {
		return () => ({
			result: async (): Promise<AssistantMessage> => ({
				role: "assistant",
				content: [{ type: "text", text }],
				usage: createMockUsage(10, 10),
				stopReason: "stop",
				timestamp: Date.now(),
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-5",
			}),
		});
	}

	it("buildVerificationSource returns a byte-identical string with and without a precomputed window", () => {
		const main = [
			createUserMessage("Fix the verify pass in compaction.ts"),
			createAssistantMessage("On it, reading the file first."),
		];
		const prefix = [createAssistantMessage("prefix turn text")];
		const withoutWindow = buildVerificationSource(main, prefix);
		const withWindow = buildVerificationSource(
			main,
			prefix,
			createSerializedWindow(main),
			createSerializedWindow(prefix),
		);
		expect(withWindow).toBe(withoutWindow);
	});

	it("memoizes: repeated access to .llm returns the same reference and serializes only once", () => {
		const window = createSerializedWindow([createUserMessage("hello"), createAssistantMessage("world")]);
		expect(convertToLlmSpy.count).toBe(0); // lazy — nothing computed yet
		const first = window.llm;
		expect(window.llm).toBe(first);
		expect(window.delta).toBe(window.delta);
		expect(convertToLlmSpy.count).toBe(1);
	});

	it("compact() serializes the window once on the incremental path with the verify pass active", async () => {
		const model = getModel("anthropic", "claude-sonnet-5")!;
		// ~420k chars of prose -> ~105k tokens, crossing VERIFY_MIN_INPUT_TOKENS
		// (80k) so the verify pass fires; previousSummary makes the summarizer use
		// the delta.
		const bigProse = "We are fixing the compaction verify pass in compaction.ts. ".repeat(7000);
		const messagesToSummarize: AgentMessage[] = [
			createUserMessage(bigProse),
			createAssistantMessage("Reading compaction.ts now."),
			createUserMessage("Continue the fix."),
			createAssistantMessage("Done editing."),
		];
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept-id",
			messagesToSummarize,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 50_000,
			previousSummary: "## Goal\nprevious checkpoint",
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS },
		};

		convertToLlmSpy.count = 0;
		await compact(
			preparation,
			model,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			cannedStreamFn("## Goal\nfake summary"),
		);

		// Summarizer (delta) + verify source share one SerializedWindow.
		expect(convertToLlmSpy.count).toBe(1);
	});
});
