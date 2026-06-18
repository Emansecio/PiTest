import { describe, expect, it } from "vitest";
import { GOAL_SPINNER_FRAMES, GoalManager, parseTokenBudget } from "../src/core/goal/goal-manager.js";

function makeManager(startMs = 0) {
	let now = startMs;
	let seq = 0;
	const mgr = new GoalManager({
		now: () => now,
		genId: () => `g${++seq}`,
	});
	return {
		mgr,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("parseTokenBudget", () => {
	it("parses plain, k and m suffixes", () => {
		expect(parseTokenBudget("100000")).toBe(100000);
		expect(parseTokenBudget("100k")).toBe(100_000);
		expect(parseTokenBudget("1.5k")).toBe(1500);
		expect(parseTokenBudget("2m")).toBe(2_000_000);
	});
	it("rejects garbage", () => {
		expect(parseTokenBudget("abc")).toBeUndefined();
		expect(parseTokenBudget("")).toBeUndefined();
		expect(parseTokenBudget("-5")).toBeUndefined();
	});
});

describe("GoalManager lifecycle", () => {
	it("starts an active goal and tracks it", () => {
		const { mgr } = makeManager();
		const snap = mgr.start("Refactor the parser", {});
		expect(snap.status).toBe("active");
		expect(snap.objective).toBe("Refactor the parser");
		expect(mgr.isActive()).toBe(true);
		expect(mgr.shouldAutoContinue()).toBe(true);
	});

	it("edits the objective without resetting counters", () => {
		const { mgr } = makeManager();
		mgr.start("old", {});
		mgr.recordTurn(500);
		mgr.edit("new objective");
		const g = mgr.get();
		expect(g?.objective).toBe("new objective");
		expect(g?.tokensUsed).toBe(500);
		expect(g?.iterations).toBe(1);
	});

	it("pauses and resumes", () => {
		const { mgr } = makeManager();
		mgr.start("x", {});
		mgr.pause();
		expect(mgr.get()?.status).toBe("paused");
		expect(mgr.shouldAutoContinue()).toBe(false);
		mgr.resume();
		expect(mgr.get()?.status).toBe("active");
		expect(mgr.shouldAutoContinue()).toBe(true);
	});

	it("clears the goal", () => {
		const { mgr } = makeManager();
		mgr.start("x", {});
		mgr.clear();
		expect(mgr.get()).toBeUndefined();
		expect(mgr.shouldAutoContinue()).toBe(false);
	});

	it("completes via goal_complete and stops continuing", () => {
		const { mgr } = makeManager();
		mgr.start("x", {});
		mgr.complete("done");
		expect(mgr.get()?.status).toBe("complete");
		expect(mgr.shouldAutoContinue()).toBe(false);
	});

	it("enforces the token budget", () => {
		const { mgr } = makeManager();
		mgr.start("x", { tokenBudget: 1000 });
		mgr.recordTurn(400);
		expect(mgr.get()?.status).toBe("active");
		mgr.recordTurn(700); // 1100 > 1000
		expect(mgr.get()?.status).toBe("budget_limited");
		expect(mgr.shouldAutoContinue()).toBe(false);
	});

	it("resume on an exhausted budget does NOT reactivate; setTokenBudget unwedges it", () => {
		const { mgr } = makeManager();
		mgr.start("x", { tokenBudget: 1000 });
		mgr.recordTurn(1100);
		expect(mgr.get()?.status).toBe("budget_limited");
		// resume() alone can't progress: tokensUsed already >= budget, so it would
		// re-trip budget_limited on the very next recordTurn (yields ~1 turn then
		// wedges). It must stay budget_limited until the budget is raised.
		mgr.resume();
		expect(mgr.get()?.status).toBe("budget_limited");
		// Raising the ceiling above tokensUsed is the real unwedge.
		mgr.setTokenBudget(2000);
		expect(mgr.get()?.status).toBe("active");
	});

	it("pauses on aborted/error interruptions", () => {
		const { mgr } = makeManager();
		mgr.start("x", {});
		mgr.onInterrupted("aborted");
		expect(mgr.get()?.status).toBe("paused");

		mgr.resume();
		mgr.onInterrupted("error");
		expect(mgr.get()?.status).toBe("paused");

		mgr.resume();
		mgr.onInterrupted("endTurn");
		expect(mgr.get()?.status).toBe("active");
	});

	it("renders a compact status line", () => {
		const { mgr, advance } = makeManager();
		mgr.start("x", {});
		advance(3 * 60_000);
		expect(mgr.statusLine()).toBe("🎯 active 3m");

		mgr.clear();
		mgr.start("y", { tokenBudget: 100_000 });
		mgr.recordTurn(18_000);
		expect(mgr.statusLine()).toBe("🎯 active 18k/100k");
		// Spinner marker only when actively driving the goal.
		expect(mgr.statusLine(true)).toMatch(/^🎯 active 18k\/100k [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/);
		mgr.pause();
		expect(mgr.statusLine()).toBe("🎯 paused");
		expect(mgr.statusLine(true)).toBe("🎯 paused");
	});

	it("animates the spinner over time when continuing", () => {
		const { mgr, advance } = makeManager();
		mgr.start("x", {});
		const first = mgr.statusLine(true);
		advance(80);
		const second = mgr.statusLine(true);
		expect(first).not.toBe(second);
		expect(GOAL_SPINNER_FRAMES.some((f) => first.endsWith(f))).toBe(true);
		expect(GOAL_SPINNER_FRAMES.some((f) => second.endsWith(f))).toBe(true);
	});

	it("includes the objective in the system prompt section and continuation", () => {
		const { mgr } = makeManager();
		mgr.start("Make tests pass", {});
		const section = mgr.systemPromptSection();
		expect(section).toContain("Make tests pass");
		expect(section).toContain("goal_complete");
		expect(mgr.systemPromptSection()).toContain("autonomous");
		expect(mgr.continuationPrompt()).toContain("goal_complete");
	});

	it("drops the persistence boilerplate when paused or budget_limited", () => {
		const { mgr } = makeManager();
		mgr.start("Make tests pass", {});
		// Active: full boilerplate present.
		expect(mgr.systemPromptSection()).toContain("Keep working until the goal is fully resolved");

		// Paused: only a one-line objective reminder, no boilerplate / goal_complete.
		mgr.pause();
		const paused = mgr.systemPromptSection();
		expect(paused).toBe("<goal>Goal (paused): Make tests pass</goal>");
		expect(paused).toContain("Make tests pass");
		expect(paused).not.toContain("Keep working");
		expect(paused).not.toContain("goal_complete");
		expect(paused).not.toContain("autonomous");

		// Budget-limited: same compact one-liner, no boilerplate.
		mgr.clear();
		mgr.start("Ship the feature", { tokenBudget: 1000 });
		mgr.recordTurn(1100);
		expect(mgr.get()?.status).toBe("budget_limited");
		const limited = mgr.systemPromptSection();
		expect(limited).toBe("<goal>Goal (budget_limited): Ship the feature</goal>");
		expect(limited).not.toContain("Keep working");
		expect(limited).not.toContain("goal_complete");

		// Raising the budget reactivates it and restores the full boilerplate
		// (resume() alone can't lift an exhausted budget — see the resume test).
		mgr.setTokenBudget(2000);
		expect(mgr.systemPromptSection()).toContain("Keep working until the goal is fully resolved");

		// Completed goal still emits nothing.
		mgr.complete("done");
		expect(mgr.systemPromptSection()).toBe("");
	});

	it("serializes and restores state", () => {
		const { mgr } = makeManager();
		mgr.start("persist me", { tokenBudget: 5000 });
		mgr.recordTurn(1234);
		const data = mgr.serialize();

		const { mgr: mgr2 } = makeManager();
		mgr2.restore(data);
		expect(mgr2.get()?.objective).toBe("persist me");
		expect(mgr2.get()?.tokensUsed).toBe(1234);
		expect(mgr2.get()?.tokenBudget).toBe(5000);
	});

	it("only completes/edits when a goal exists", () => {
		const { mgr } = makeManager();
		expect(() => mgr.edit("x")).not.toThrow();
		expect(mgr.get()).toBeUndefined();
		mgr.complete("noop");
		expect(mgr.get()).toBeUndefined();
	});
});
