/**
 * Pure view decisions for the interactive event loop.
 *
 * Every event covered here previously had ZERO test coverage: it was decided
 * inside the 685-line `handleEvent` switch, which no test could reach without a
 * terminal. The decisions now live in `turn-view.ts` and are asserted as data.
 */

import { beforeAll, describe, expect, test } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import {
	compactionLoaderLabel,
	decideAgentStart,
	decideAutoRetryEnd,
	decideAutoRetryStart,
	decideCompactionStart,
	decideFallbackWarning,
	decideFusionMember,
	decideFusionStage,
	decidePendingCheck,
	decideSubagentComplete,
	decideSubagentProgress,
	decideSubagentStart,
	decideToolExecutionStart,
	decideVerification,
	retryLoaderMessage,
	type TurnViewEffect,
} from "../src/modes/interactive/turn-view.ts";

beforeAll(() => {
	// workingPhaseLabel() paints through the global theme.
	initTheme("dark");
});

function kinds(effects: readonly TurnViewEffect[]): string[] {
	return effects.map((effect) => effect.kind);
}

function find<K extends TurnViewEffect["kind"]>(
	effects: readonly TurnViewEffect[],
	kind: K,
): Extract<TurnViewEffect, { kind: K }> | undefined {
	return effects.find((effect) => effect.kind === kind) as Extract<TurnViewEffect, { kind: K }> | undefined;
}

describe("decideAgentStart", () => {
	test("rebuilds the working loader when the turn wants one and none is live", () => {
		const effects = decideAgentStart({ workingVisible: true, hasWorkingLoader: false });
		expect(kinds(effects)).toEqual([
			"terminal-progress",
			"cleanup-retry-ui",
			"ensure-working-loader",
			"working-phase",
			"pet-mood",
			"render",
		]);
		expect(find(effects, "working-phase")?.text).toBe("Thinking…");
		expect(find(effects, "terminal-progress")?.active).toBe(true);
	});

	test("reuses the submit-time loader (gap-morto) instead of rebuilding it", () => {
		const effects = decideAgentStart({ workingVisible: true, hasWorkingLoader: true });
		expect(kinds(effects)).not.toContain("ensure-working-loader");
	});

	test("never builds a loader when the turn is not showing one", () => {
		const effects = decideAgentStart({ workingVisible: false, hasWorkingLoader: false });
		expect(kinds(effects)).not.toContain("ensure-working-loader");
	});
});

describe("decideToolExecutionStart", () => {
	test("grouped transcript keeps the loader neutral so the verb is not mirrored twice", () => {
		const effects = decideToolExecutionStart(
			{ toolName: "read", toolCallId: "c1", args: { path: "a.ts" } },
			{ toolActivity: "grouped" },
		);
		expect(find(effects, "working-phase")?.text).toBe("Working…");
	});

	test("legacy transcript mirrors the tool verb on the loader", () => {
		const effects = decideToolExecutionStart(
			{ toolName: "read", toolCallId: "c1", args: { path: "a.ts" } },
			{ toolActivity: "legacy" },
		);
		expect(find(effects, "working-phase")?.text).not.toBe("Working…");
		expect(find(effects, "working-phase")?.text.length).toBeGreaterThan(0);
	});

	test("the `ask` tool upshifts the gearbox before the block is built", () => {
		const effects = decideToolExecutionStart(
			{ toolName: "ask", toolCallId: "c1", args: {} },
			{ toolActivity: "grouped" },
		);
		expect(kinds(effects)).toEqual([
			"gearbox-upshift",
			"tool-component-start",
			"working-phase",
			"refresh-loader-suffix",
			"pet-mood",
			"render",
		]);
		expect(find(effects, "gearbox-upshift")?.reason).toBe("ask");
	});

	test("a normal tool does not touch the gearbox", () => {
		const effects = decideToolExecutionStart(
			{ toolName: "bash", toolCallId: "c1", args: { command: "ls" } },
			{ toolActivity: "grouped" },
		);
		expect(kinds(effects)).not.toContain("gearbox-upshift");
	});
});

describe("compactionLoaderLabel", () => {
	test("manual compaction says so and carries the cancel hint", () => {
		expect(compactionLoaderLabel("manual", "esc")).toBe("Compacting context… (esc cancel)");
	});

	test("overflow is called out ahead of the auto wording", () => {
		expect(compactionLoaderLabel("overflow", "esc")).toBe("Context overflow detected, Auto-compacting… (esc cancel)");
	});

	test("threshold is a plain auto-compaction", () => {
		expect(compactionLoaderLabel("threshold", "ctrl+c")).toBe("Auto-compacting… (ctrl+c cancel)");
	});

	test("the event rebinds Esc before painting the spinner", () => {
		const effects = decideCompactionStart({ reason: "manual" }, { interruptKey: "esc" });
		expect(kinds(effects)).toEqual([
			"terminal-progress",
			"bind-compaction-escape",
			"compaction-loader",
			"pet-mood",
			"render",
		]);
		expect(find(effects, "pet-mood")?.mood).toBe("digesting");
	});
});

describe("decideFusionMember / decideFusionStage", () => {
	test("projects the event onto a strip row and relies on upsert's own render", () => {
		const effects = decideFusionMember({
			type: "fusion_member",
			index: 1,
			cli: "claude",
			model: "opus",
			status: "done",
			elapsedMs: 4200,
			timeoutMs: 60_000,
			chars: 900,
		});
		expect(kinds(effects)).toEqual(["fusion-ensure", "fusion-member"]);
		expect(find(effects, "fusion-member")?.member).toEqual({
			index: 1,
			cli: "claude",
			model: "opus",
			status: "done",
			elapsedMs: 4200,
			timeoutMs: 60_000,
			idleTimeoutMs: undefined,
			chars: 900,
			error: undefined,
		});
	});

	// The idle cap — not the wall-clock one — is what actually reaps a stuck
	// member, and the row renders an `idle Ns / Ts` countdown off it. Dropping the
	// field here left idleLimit at 0, so that countdown could never paint.
	test("forwards idleTimeoutMs so the strip can render the idle countdown", () => {
		const effects = decideFusionMember({
			type: "fusion_member",
			index: 0,
			cli: "codex",
			model: "gpt",
			status: "running",
			elapsedMs: 12_000,
			timeoutMs: 600_000,
			idleTimeoutMs: 90_000,
			chars: 40,
		});
		expect(find(effects, "fusion-member")?.member.idleTimeoutMs).toBe(90_000);
	});

	test("the writer stage arms the hand-off flag; other stages do not", () => {
		const writer = decideFusionStage({ type: "fusion_stage", stage: "writer", synthId: "s1" });
		expect(kinds(writer)).toEqual([
			"fusion-ensure",
			"fusion-synth",
			"fusion-stage",
			"fusion-writer-handoff",
			"render",
		]);

		const panel = decideFusionStage({ type: "fusion_stage", stage: "panel", synthId: "s1" });
		expect(kinds(panel)).toEqual(["fusion-ensure", "fusion-synth", "fusion-stage", "render"]);
	});
});

describe("subagent events", () => {
	// The strip owns one row per handle, so every lifecycle event is a plain
	// upsert; the component renders itself (no explicit `render` effect).
	test("start upserts the agent's row on the live strip", () => {
		expect(decideSubagentStart({ handle: "explorer" })).toEqual([{ kind: "subagents-start", handle: "explorer" }]);
	});

	test("progress forwards the turn counter, last tool, and live token total", () => {
		expect(decideSubagentProgress({ handle: "e", turn: 2, lastTool: "read", totalTokens: 9300 })).toEqual([
			{ kind: "subagents-progress", handle: "e", turn: 2, lastTool: "read", totalTokens: 9300 },
		]);
		expect(decideSubagentProgress({ handle: "e", turn: 2 })).toEqual([
			{ kind: "subagents-progress", handle: "e", turn: 2, lastTool: undefined, totalTokens: undefined },
		]);
	});

	test("completion settles the row with its status and metrics", () => {
		expect(decideSubagentComplete({ handle: "e", status: "done", turns: 3, totalTokens: 12_000 })).toEqual([
			{ kind: "subagents-complete", handle: "e", status: "done", turns: 3, totalTokens: 12_000 },
		]);
		expect(decideSubagentComplete({ handle: "e", status: "error" })).toEqual([
			{ kind: "subagents-complete", handle: "e", status: "error", turns: undefined, totalTokens: undefined },
		]);
	});

	test("no lifecycle event asks for a render — the strip paints on upsert", () => {
		for (const effects of [
			decideSubagentStart({ handle: "e" }),
			decideSubagentProgress({ handle: "e", turn: 1 }),
			decideSubagentComplete({ handle: "e", status: "done" }),
		]) {
			expect(kinds(effects)).not.toContain("render");
		}
	});
});

describe("auto retry", () => {
	test("the countdown message surfaces WHY we are retrying", () => {
		const effects = decideAutoRetryStart({
			attempt: 2,
			maxAttempts: 5,
			delayMs: 8000,
			errorMessage: "429 rate limit exceeded",
		});
		expect(kinds(effects)).toEqual(["bind-retry-escape", "retry-loader", "pet-mood", "render"]);
		expect(find(effects, "pet-mood")?.mood).toBe("waiting");
		const loader = find(effects, "retry-loader");
		expect(loader?.reason).toBeTruthy();
		expect(retryLoaderMessage(loader as never, 8, "esc")).toContain("retry 2/5 in 8s · esc cancel");
		expect(retryLoaderMessage(loader as never, 8, "esc")).toMatch(/ — retry/);
	});

	test("an unclassifiable error keeps the wording unchanged", () => {
		const effects = decideAutoRetryStart({ attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "???" });
		const loader = find(effects, "retry-loader");
		expect(retryLoaderMessage(loader as never, 1, "esc")).toBe("retry 1/3 in 1s · esc cancel");
	});

	test("a cancelled retry is a muted status, not sticky error red", () => {
		const effects = decideAutoRetryEnd({ success: false, attempt: 2, cancelled: true });
		expect(kinds(effects)).toEqual(["cleanup-retry-ui", "pet-mood", "status", "render"]);
		expect(find(effects, "status")).toEqual({ kind: "status", text: "Retry cancelled", tone: "dim" });
		// The user called it off — no error shake, just back to rest.
		expect(find(effects, "pet-mood")?.mood).toBe("idle");
	});

	test("a failed retry reports the attempt count with the right plural", () => {
		expect(find(decideAutoRetryEnd({ success: false, attempt: 1, finalError: "boom" }), "error")?.text).toBe(
			"Retry failed after 1 attempt: boom",
		);
		expect(find(decideAutoRetryEnd({ success: false, attempt: 3, finalError: "boom" }), "error")?.text).toBe(
			"Retry failed after 3 attempts: boom",
		);
		expect(find(decideAutoRetryEnd({ success: false, attempt: 3 }), "error")?.text).toContain("Unknown error");
	});

	test("a successful retry cleans up and puts the pet back to work", () => {
		const effects = decideAutoRetryEnd({ success: true, attempt: 2 });
		expect(kinds(effects)).toEqual(["cleanup-retry-ui", "pet-mood", "render"]);
		expect(find(effects, "pet-mood")?.mood).toBe("thinking");
	});

	test("a retry that gave up for good plays the error tell", () => {
		expect(find(decideAutoRetryEnd({ success: false, attempt: 3, finalError: "boom" }), "pet-mood")?.mood).toBe(
			"error",
		);
	});
});

describe("decideFallbackWarning", () => {
	test("appends one permanent transcript line", () => {
		const effects = decideFallbackWarning({ from: "a", to: "b", reason: "overloaded" });
		expect(effects).toEqual([
			{ kind: "chat-warning-line", text: "[fallback] a -> b: overloaded" },
			{ kind: "render" },
		]);
	});
});

describe("decideVerification", () => {
	const live = { workingVisible: true, hasWorkingLoader: true };

	test("running bridges the post-turn gap by rebuilding a retired loader", () => {
		const effects = decideVerification(
			{ phase: "running", command: "npm test", attempt: 1, maxAttempts: 2 },
			{ workingVisible: true, hasWorkingLoader: false },
		);
		expect(kinds(effects)).toEqual(["terminal-progress", "ensure-working-loader", "working-phase", "render"]);
		expect(find(effects, "terminal-progress")?.active).toBe(true);
		expect(find(effects, "working-phase")?.text).toBe("Verifying (npm test)…");
	});

	test("a retry attempt is numbered in the phase label", () => {
		const effects = decideVerification({ phase: "running", command: "tsc", attempt: 3, maxAttempts: 3 }, live);
		expect(find(effects, "working-phase")?.text).toBe("Verifying (tsc) — attempt 3…");
	});

	test("passed clears terminal progress and reports the command", () => {
		const effects = decideVerification({ phase: "passed", command: "tsc", attempt: 1, maxAttempts: 2 }, live);
		expect(find(effects, "terminal-progress")?.active).toBe(false);
		expect(find(effects, "working-phase")?.text).toBe("✓ Verified — tsc passed");
	});

	test("timeout is inconclusive: warning status, never the red failure", () => {
		const effects = decideVerification({ phase: "timeout", command: "tsc", attempt: 1, maxAttempts: 2 }, live);
		expect(kinds(effects)).toEqual(["terminal-progress", "stop-working-loader", "status", "render"]);
		expect(find(effects, "status")?.tone).toBe("warning");
		expect(find(effects, "status")?.text).toContain("not treated as failure");
	});

	test("a failure that will be fixed keeps the loader alive", () => {
		const effects = decideVerification(
			{ phase: "failed", command: "tsc", attempt: 1, maxAttempts: 2, exitCode: 2, willRetry: true },
			live,
		);
		expect(kinds(effects)).not.toContain("stop-working-loader");
		expect(find(effects, "working-phase")?.text).toBe("✗ tsc failed (exit 2) — fixing…");
	});

	test("an exhausted failure retires the loader and reports unverified", () => {
		const effects = decideVerification(
			{ phase: "failed", command: "tsc", attempt: 2, maxAttempts: 2, willRetry: false },
			live,
		);
		expect(kinds(effects)).toEqual(["terminal-progress", "stop-working-loader", "error", "render"]);
		expect(find(effects, "error")?.text).toBe("✗ tsc still failing after 2 fix attempts — reported unverified.");
	});
});

describe("decidePendingCheck", () => {
	test("waiting shows the elapsed clock and rebuilds a retired loader", () => {
		const effects = decidePendingCheck(
			{ phase: "waiting", command: "npm test", elapsedMs: 65_000 },
			{ workingVisible: true, hasWorkingLoader: false },
		);
		expect(kinds(effects)).toEqual(["terminal-progress", "status", "ensure-working-loader", "render"]);
		expect(find(effects, "terminal-progress")?.active).toBe(true);
		expect(find(effects, "status")?.text).toMatch(/^Waiting for npm test… \(.+\)$/);
	});

	test("waiting without an elapsed reading omits the parenthetical", () => {
		const effects = decidePendingCheck(
			{ phase: "waiting", command: "npm test" },
			{
				workingVisible: false,
				hasWorkingLoader: false,
			},
		);
		expect(find(effects, "status")?.text).toBe("Waiting for npm test…");
	});

	test("terminal phases tone the line and clear terminal progress", () => {
		const passed = decidePendingCheck(
			{ phase: "passed", command: "x" },
			{ workingVisible: true, hasWorkingLoader: true },
		);
		expect(find(passed, "terminal-progress")?.active).toBe(false);
		expect(find(passed, "status")).toEqual({ kind: "status", text: "✓ x passed", tone: "success" });

		const timeout = decidePendingCheck(
			{ phase: "timeout", command: "x" },
			{ workingVisible: true, hasWorkingLoader: true },
		);
		expect(find(timeout, "status")).toEqual({
			kind: "status",
			text: "⚠ x still running after wait",
			tone: "warning",
		});

		const failed = decidePendingCheck(
			{ phase: "failed", command: "x", exitCode: 1 },
			{
				workingVisible: true,
				hasWorkingLoader: true,
			},
		);
		expect(find(failed, "status")).toEqual({ kind: "status", text: "✗ x failed (exit 1)", tone: "warning" });

		const unknownExit = decidePendingCheck(
			{ phase: "failed", command: "x" },
			{
				workingVisible: true,
				hasWorkingLoader: true,
			},
		);
		expect(find(unknownExit, "status")?.text).toBe("✗ x failed (exit ?)");
	});
});
