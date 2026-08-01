/**
 * End-to-end coverage for `InteractiveMode` built on a REAL instance.
 *
 * These are the first tests in the package that construct the class (the
 * terminal is now injectable), instead of calling prototype methods against a
 * hand-rolled `this`. Events go through the real `handleEvent`, the real widget
 * tree and the real renderer, and assertions read the rendered frame back.
 */

import { afterEach, describe, expect, test } from "vitest";
import { createInteractiveHarness, type InteractiveHarness } from "./interactive-harness.ts";

let harness: InteractiveHarness | undefined;

afterEach(() => {
	harness?.dispose();
	harness = undefined;
});

describe("InteractiveMode headless (injected terminal)", () => {
	test("constructs against a VirtualTerminal and paints agent_start on the real screen", async () => {
		harness = createInteractiveHarness();
		const internals = harness.internals();
		internals.workingVisible = true;

		await harness.emit({ type: "agent_start" } as never);

		expect(harness.hasWorkingLoader()).toBe(true);
		expect(harness.workingPhase()).toBe("Thinking…");
		// The frame really reached the xterm-backed terminal.
		expect(await harness.screen()).toContain("Thinking…");
	});

	test("tool_execution_start drives the loader phase and builds a transcript block", async () => {
		harness = createInteractiveHarness();
		const internals = harness.internals();
		internals.workingVisible = true;
		await harness.emit({ type: "agent_start" } as never);

		await harness.emit({
			type: "tool_execution_start",
			toolName: "read",
			toolCallId: "call-1",
			args: { path: "src/index.ts" },
		} as never);

		// legacy toolActivity → the loader mirrors the tool verb.
		expect(harness.workingPhase()).not.toBe("Thinking…");
		expect(internals.pendingTools.size).toBe(1);
	});

	test("grouped toolActivity keeps the working loader neutral", async () => {
		harness = createInteractiveHarness({ toolActivity: "grouped" });
		const internals = harness.internals();
		internals.workingVisible = true;
		await harness.emit({ type: "agent_start" } as never);

		await harness.emit({
			type: "tool_execution_start",
			toolName: "read",
			toolCallId: "call-1",
			args: { path: "src/index.ts" },
		} as never);

		expect(harness.workingPhase()).toBe("Working…");
	});

	test("fallback_warning appends a warning line to the transcript", async () => {
		harness = createInteractiveHarness();

		await harness.emit({
			type: "fallback_warning",
			from: "anthropic/opus",
			to: "anthropic/sonnet",
			reason: "overloaded",
		} as never);

		expect(harness.chatText()).toContain("[fallback] anthropic/opus -> anthropic/sonnet: overloaded");
	});

	test("subagent lifecycle events land in the status band", async () => {
		harness = createInteractiveHarness();

		await harness.emit({ type: "subagent_start", handle: "explorer" } as never);
		expect(harness.statusText()).toContain("Agent “explorer” started");

		await harness.emit({
			type: "subagent_complete",
			handle: "explorer",
			status: "done",
			turns: 3,
			totalTokens: 1234,
		} as never);
		expect(harness.statusText()).toContain("Agent “explorer” finished");
		expect(harness.statusText()).toContain("3 turns");
		// `toLocaleString()` groups per the host locale (1,234 / 1.234) — assert
		// the grouping happened without pinning the separator.
		expect(harness.statusText()).toMatch(/1[.,\s ]234 tok/);
	});

	test("compaction_start swaps the status band for the compaction spinner and rebinds Esc", async () => {
		harness = createInteractiveHarness();
		const internals = harness.internals();
		const escapeBefore = internals.defaultEditor.onEscape;

		await harness.emit({ type: "compaction_start", reason: "overflow" } as never);

		expect(internals.autoCompactionLoader).toBeDefined();
		expect(harness.statusText()).toContain("Context overflow detected, Auto-compacting…");
		expect(internals.defaultEditor.onEscape).not.toBe(escapeBefore);
		expect(internals.autoCompactionEscapeHandler).toBe(escapeBefore);
	});

	test("verification running rebuilds a retired loader, timeout retires it again", async () => {
		harness = createInteractiveHarness();
		const internals = harness.internals();
		internals.workingVisible = true;

		await harness.emit({
			type: "verification",
			phase: "running",
			command: "npm test",
			attempt: 1,
			maxAttempts: 2,
		} as never);
		expect(harness.hasWorkingLoader()).toBe(true);
		expect(harness.workingPhase()).toBe("Verifying (npm test)…");

		await harness.emit({
			type: "verification",
			phase: "timeout",
			command: "npm test",
			attempt: 1,
			maxAttempts: 2,
		} as never);
		expect(harness.hasWorkingLoader()).toBe(false);
		expect(harness.statusText()).toContain("npm test timed out");
	});

	test("auto_retry_start/end own the status band and restore the Esc handler", async () => {
		harness = createInteractiveHarness();
		const internals = harness.internals();
		// `_cleanupRetryUI` only restores a PREVIOUS handler when one existed, so
		// give the editor a sentinel first.
		const escapeBefore = () => {};
		internals.defaultEditor.onEscape = escapeBefore;

		await harness.emit({
			type: "auto_retry_start",
			attempt: 2,
			maxAttempts: 5,
			delayMs: 4000,
			errorMessage: "429 rate limit exceeded",
		} as never);
		expect(internals.retryLoader).toBeDefined();
		expect(harness.statusText()).toContain("retry 2/5 in 4s");
		expect(internals.defaultEditor.onEscape).not.toBe(escapeBefore);

		await harness.emit({ type: "auto_retry_end", success: false, attempt: 2, cancelled: true } as never);
		expect(internals.retryLoader).toBeUndefined();
		expect(internals.retryCountdown).toBeUndefined();
		expect(internals.defaultEditor.onEscape).toBe(escapeBefore);
		expect(harness.statusText()).toContain("Retry cancelled");
	});

	test("fusion_member/fusion_stage build and drive the live strip", async () => {
		harness = createInteractiveHarness();
		const internals = harness.internals();

		await harness.emit({ type: "fusion_stage", stage: "panel", synthId: "synth-1" } as never);
		await harness.emit({
			type: "fusion_member",
			index: 0,
			cli: "codex",
			model: "gpt-5",
			status: "running",
			elapsedMs: 1500,
		} as never);
		expect(internals.fusionLive).toBeDefined();
		expect(harness.statusText()).toContain("gpt-5");

		await harness.emit({ type: "fusion_stage", stage: "writer", synthId: "synth-1" } as never);
		expect(internals._fusionWriterLoaderActive).toBe(true);
	});

	test("stop() retires the working loader and tears the UI down", async () => {
		harness = createInteractiveHarness();
		const internals = harness.internals();
		internals.workingVisible = true;
		await harness.emit({ type: "agent_start" } as never);
		expect(harness.hasWorkingLoader()).toBe(true);

		harness.dispose();
		harness = undefined;

		expect(internals.loadingAnimation).toBeUndefined();
		expect(internals.isInitialized).toBe(false);
	});
});
