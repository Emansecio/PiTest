import { describe, expect, it } from "vitest";
import { buildCrossErrorReminder } from "../src/core/cross-error.js";
import { buildStagnationReminder } from "../src/core/stagnation.js";
import {
	buildDoomLoopReminder,
	buildFailureBudgetReminder,
	buildToolErrorReflection,
	DOOM_LOOP_STEER_MARKER,
	decideDoomLoopReminder,
	decideErrorReflection,
	FAILURE_BUDGET_STEER_MARKER,
	LOOP_STEER_ADVICE,
	STEER_REMINDER_CLOSE,
	TOOL_ERROR_REFLECTION_STEER_MARKER,
} from "../src/core/tool-call-feedback.js";

describe("buildToolErrorReflection", () => {
	it("includes tool name, args, error, and the 3 structured questions", () => {
		const out = buildToolErrorReflection({
			toolName: "edit",
			args: { path: "src/a.ts", old: "x", new: "y" },
			errorMessage: "no match for old_string",
		});

		expect(out.startsWith(TOOL_ERROR_REFLECTION_STEER_MARKER)).toBe(true);
		expect(out).toContain("`edit`");
		expect(out).toContain('"path": "src/a.ts"');
		expect(out).toContain("no match for old_string");
		expect(out).toMatch(/1\. \*\*What was wrong\*\*/);
		expect(out).toMatch(/2\. \*\*Why\*\*/);
		expect(out).toMatch(/3\. \*\*What is the corrected approach\*\*/);
		expect(out.endsWith(STEER_REMINDER_CLOSE)).toBe(true);
	});

	it("surfaces attemptsLeft when provided", () => {
		const out = buildToolErrorReflection({
			toolName: "bash",
			errorMessage: "exit 1",
			attemptsLeft: 2,
		});
		expect(out).toContain("Retries remaining for this tool: 2");
	});

	it("clamps negative attemptsLeft to 0", () => {
		const out = buildToolErrorReflection({
			toolName: "bash",
			errorMessage: "boom",
			attemptsLeft: -3,
		});
		expect(out).toContain("Retries remaining for this tool: 0");
	});

	it("omits args block when args are absent or null", () => {
		const out = buildToolErrorReflection({ toolName: "read", errorMessage: "nope" });
		expect(out).not.toContain("Arguments:");
		const out2 = buildToolErrorReflection({ toolName: "read", args: null, errorMessage: "nope" });
		expect(out2).not.toContain("Arguments:");
	});

	it("omits error block when errorMessage is empty/whitespace", () => {
		const out = buildToolErrorReflection({ toolName: "read", args: { path: "x" }, errorMessage: "   \n" });
		expect(out).not.toContain("Error:");
	});

	it("truncates very long args payloads", () => {
		const out = buildToolErrorReflection({
			toolName: "write",
			args: { content: "x".repeat(2000) },
		});
		expect(out).toContain("truncated");
		expect(out.length).toBeLessThan(2000);
	});

	it("survives circular args via stringify fallback", () => {
		const a: Record<string, unknown> = { name: "root" };
		a.self = a;
		expect(() => buildToolErrorReflection({ toolName: "x", args: a, errorMessage: "e" })).not.toThrow();
	});
});

describe("buildDoomLoopReminder", () => {
	it("names the tool and reports the consecutive count", () => {
		const out = buildDoomLoopReminder({ toolName: "grep", consecutiveCount: 5 });
		expect(out.startsWith(DOOM_LOOP_STEER_MARKER)).toBe(true);
		expect(out).toContain("`grep`");
		expect(out).toContain("5 consecutive");
		expect(out).toContain(LOOP_STEER_ADVICE);
		expect(out.endsWith(STEER_REMINDER_CLOSE)).toBe(true);
	});

	it("clamps negative counts to 0", () => {
		const out = buildDoomLoopReminder({ toolName: "x", consecutiveCount: -1 });
		expect(out).toContain("0 consecutive");
	});

	it("floors fractional counts", () => {
		const out = buildDoomLoopReminder({ toolName: "x", consecutiveCount: 3.9 });
		expect(out).toContain("3 consecutive");
	});

	// P3.9: a doom-loop IS the same arguments repeated, so echoing them back
	// duplicates the assistant tool-call blocks sitting right above in the transcript.
	it("never echoes the repeated arguments", () => {
		const out = buildDoomLoopReminder({ toolName: "grep", consecutiveCount: 5 });
		expect(out).not.toContain("Repeated arguments:");
		expect(out).not.toContain("```json");
	});

	describe("escalation tiers", () => {
		const base = { toolName: "bash", consecutiveCount: 6 } as const;

		it("keeps the three tiers textually distinct", () => {
			const tier1 = buildDoomLoopReminder(base);
			const tier2 = buildDoomLoopReminder({ ...base, tier: "pause", remaining: 2 });
			const tier3 = buildDoomLoopReminder({ ...base, tier: "recovery" });
			expect(new Set([tier1, tier2, tier3]).size).toBe(3);
			// Each tier extends the SAME base rather than re-explaining the context.
			expect(tier2.startsWith(tier1.slice(0, tier1.length - STEER_REMINDER_CLOSE.length - 1))).toBe(true);
			expect(tier3.startsWith(tier1.slice(0, tier1.length - STEER_REMINDER_CLOSE.length - 1))).toBe(true);
		});

		it("tier 2 counts down to the abort and tier 3 asks for a decomposition", () => {
			const tier2 = buildDoomLoopReminder({ ...base, tier: "pause", remaining: 2 });
			expect(tier2).toContain("2 more identical calls aborts the turn");
			const single = buildDoomLoopReminder({ ...base, tier: "pause", remaining: 1 });
			expect(single).toContain("1 more identical call aborts the turn");

			const tier3 = buildDoomLoopReminder({ ...base, tier: "recovery" });
			expect(tier3).toContain("Restate the goal in one sentence");
			expect(tier3).toContain("ONLY sub-step 1");
		});

		it("keeps the escalation INSIDE the reminder block (so N8 can collapse it)", () => {
			for (const tier of ["reminder", "pause", "recovery"] as const) {
				const out = buildDoomLoopReminder({ ...base, tier, remaining: 2 });
				expect(out.endsWith(STEER_REMINDER_CLOSE)).toBe(true);
				expect(out.indexOf(STEER_REMINDER_CLOSE)).toBe(out.length - STEER_REMINDER_CLOSE.length);
			}
		});
	});
});

describe("buildFailureBudgetReminder", () => {
	it("names the tool, reports the count, and tells the model to change approach", () => {
		const out = buildFailureBudgetReminder({ toolName: "bash", failureCount: 3, maxPerTurn: 3 });
		expect(out.startsWith(FAILURE_BUDGET_STEER_MARKER)).toBe(true);
		expect(out).toContain("`bash`");
		expect(out).toContain("failed 3 times in this turn");
		expect(out).toContain("per-turn budget exhausted");
		expect(out).toContain(LOOP_STEER_ADVICE);
		expect(out.endsWith(STEER_REMINDER_CLOSE)).toBe(true);
	});

	it("uses the singular when the count is 1", () => {
		const out = buildFailureBudgetReminder({ toolName: "edit", failureCount: 1, maxPerTurn: 1 });
		expect(out).toContain("failed 1 time in this turn");
		expect(out).not.toContain("failed 1 times");
	});

	it("clamps negative/fractional counts", () => {
		expect(buildFailureBudgetReminder({ toolName: "x", failureCount: -2, maxPerTurn: 3 })).toContain(
			"failed 0 times in this turn",
		);
		expect(buildFailureBudgetReminder({ toolName: "x", failureCount: 3.9, maxPerTurn: 3 })).toContain(
			"failed 3 times in this turn",
		);
	});
});

describe("decideDoomLoopReminder", () => {
	const base = { threshold: 3, cooldownMs: 1000, consecutiveCount: 0, lastFiredAt: 0, now: 5000 };

	it("does not fire when disabled", () => {
		const r = decideDoomLoopReminder({ ...base, enabled: false, consecutiveCount: 100 });
		expect(r.fire).toBe(false);
		expect(r.nextLastFiredAt).toBe(0);
	});

	it("does not fire below threshold", () => {
		const r = decideDoomLoopReminder({ ...base, enabled: true, consecutiveCount: 2 });
		expect(r.fire).toBe(false);
	});

	it("fires at or above threshold when cooldown has elapsed", () => {
		const r = decideDoomLoopReminder({ ...base, enabled: true, consecutiveCount: 3, now: 5000, lastFiredAt: 0 });
		expect(r.fire).toBe(true);
		expect(r.nextLastFiredAt).toBe(5000);
	});

	it("respects cooldown window", () => {
		const r = decideDoomLoopReminder({
			...base,
			enabled: true,
			consecutiveCount: 5,
			lastFiredAt: 4500,
			now: 5000,
			cooldownMs: 1000,
		});
		expect(r.fire).toBe(false);
		expect(r.nextLastFiredAt).toBe(4500);
	});

	it("fires again once cooldown has fully elapsed (inclusive boundary)", () => {
		const r = decideDoomLoopReminder({
			...base,
			enabled: true,
			consecutiveCount: 5,
			lastFiredAt: 4000,
			now: 5000,
			cooldownMs: 1000,
		});
		expect(r.fire).toBe(true);
	});
});

describe("decideErrorReflection", () => {
	it("does not fire when disabled", () => {
		expect(decideErrorReflection({ enabled: false, isError: true })).toBe(false);
	});

	it("does not fire on success", () => {
		expect(decideErrorReflection({ enabled: true, isError: false })).toBe(false);
	});

	it("fires when enabled and the tool returned an error", () => {
		expect(decideErrorReflection({ enabled: true, isError: true })).toBe(true);
	});
});

/**
 * The four loop/flailing reminders (doom-loop, per-turn failure budget,
 * repeated-error, stagnation) are permanent `role: "user"` context once injected
 * — they used to spend ~1.8k chars per bad turn re-stating the same advice four
 * ways. They now share {@link LOOP_STEER_ADVICE} and carry ONE specific line each.
 * This pins the budget so the family cannot drift back into essays.
 */
describe("loop-reminder family — char budget", () => {
	const BUDGET = 300;

	it("keeps the shared advice body short", () => {
		expect(LOOP_STEER_ADVICE.length).toBeLessThanOrEqual(150);
	});

	it("keeps every tier-1 reminder within budget", () => {
		const reminders: Array<[string, string]> = [
			["doom-loop", buildDoomLoopReminder({ toolName: "bash", consecutiveCount: 4 })],
			["failure-budget", buildFailureBudgetReminder({ toolName: "bash", failureCount: 3, maxPerTurn: 3 })],
			// sampleError omitted: the excerpt is the variable part of this one.
			["repeated-error", buildCrossErrorReminder({ count: 3, distinctApproaches: 2 })],
			["stagnation", buildStagnationReminder({ count: 12, paused: false })],
		];
		for (const [kind, text] of reminders) {
			expect(`${kind}:${text.length}`).toBe(`${kind}:${Math.min(text.length, BUDGET)}`);
		}
	});

	it("caps the repeated-error sample instead of pasting the whole error", () => {
		const huge = `HEAD ${"x".repeat(5000)} TAIL`;
		const out = buildCrossErrorReminder({ count: 3, distinctApproaches: 2, sampleError: huge });
		expect(out).toContain("HEAD");
		expect(out).toContain("TAIL");
		// Base + a sample capped at head(96)+tail(64); nowhere near the old 400-char head.
		expect(out.length).toBeLessThanOrEqual(BUDGET + 170);
	});

	it("keeps the doom-loop escalations proportionally small", () => {
		// Tier 2/3 add ONE line each instead of re-explaining the whole situation.
		const tier2 = buildDoomLoopReminder({ toolName: "bash", consecutiveCount: 6, tier: "pause", remaining: 2 });
		const tier3 = buildDoomLoopReminder({ toolName: "bash", consecutiveCount: 6, tier: "recovery" });
		expect(tier2.length).toBeLessThanOrEqual(BUDGET + 100);
		expect(tier3.length).toBeLessThanOrEqual(BUDGET + 160);
	});
});
