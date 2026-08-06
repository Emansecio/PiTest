import { describe, expect, it } from "vitest";
import {
	DEFAULT_GOAL_MAX_ACTIVE_MS,
	DEFAULT_GOAL_MAX_ITERATIONS,
	DEFAULT_GOAL_TOKEN_BUDGET,
	GoalManager,
	parseGoalDuration,
	parseTokenBudget,
} from "../src/core/goal/goal-manager.js";

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
	it("exposes zero-config limits on every new goal", () => {
		const { mgr } = makeManager();
		const snap = mgr.start("bounded", {});
		expect(snap.tokenBudget).toBe(DEFAULT_GOAL_TOKEN_BUDGET);
		expect(snap.maxIterations).toBe(DEFAULT_GOAL_MAX_ITERATIONS);
		expect(snap.maxActiveMs).toBe(DEFAULT_GOAL_MAX_ACTIVE_MS);
		expect(snap.activeElapsedMs).toBe(0);
	});

	it("parses active durations", () => {
		expect(parseGoalDuration("30m")).toBe(30 * 60_000);
		expect(parseGoalDuration("2h")).toBe(2 * 60 * 60_000);
		expect(parseGoalDuration("30000")).toBe(30_000);
		expect(parseGoalDuration("1.5m")).toBeUndefined();
		expect(parseGoalDuration("0")).toBeUndefined();
		expect(parseGoalDuration("2d")).toBeUndefined();
	});

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

	it("counts the completing turn once but freezes counters afterward (#13)", () => {
		const { mgr } = makeManager();
		mgr.start("x", {});
		mgr.recordTurn(500); // an ordinary work turn
		// goal_complete fires mid-turn (status -> complete); the completing turn's
		// recordTurn runs AFTER complete() and must still count once.
		mgr.complete("done");
		mgr.recordTurn(400); // completing turn
		const afterCompletingTurn = mgr.get();
		expect(afterCompletingTurn?.iterations).toBe(2);
		expect(afterCompletingTurn?.tokensUsed).toBe(900);
		// Subsequent turns on the completed goal must NOT inflate the counters.
		mgr.recordTurn(900);
		mgr.recordTurn(900);
		const frozen = mgr.get();
		expect(frozen?.iterations).toBe(2);
		expect(frozen?.tokensUsed).toBe(900);
		expect(frozen?.status).toBe("complete");
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

	it("limits total iterations and reports the reason", () => {
		const { mgr } = makeManager();
		mgr.start("x", { maxIterations: 2 });
		mgr.recordIteration();
		expect(mgr.shouldAutoContinue()).toBe(true);
		mgr.recordIteration();
		expect(mgr.shouldAutoContinue()).toBe(false);
		expect(mgr.get()?.status).toBe("iteration_limited");
		expect(mgr.get()?.limitReason).toEqual({ type: "iterations", used: 2, limit: 2 });
	});

	it("counts only active time and requires raising the time limit", () => {
		const { mgr, advance } = makeManager();
		mgr.start("x", { maxActiveMs: 1000 });
		advance(600);
		mgr.pause();
		advance(5000);
		expect(mgr.get()?.activeElapsedMs).toBe(600);
		mgr.resume();
		advance(399);
		expect(mgr.shouldAutoContinue()).toBe(true);
		advance(2);
		expect(mgr.shouldAutoContinue()).toBe(false);
		expect(mgr.get()?.status).toBe("time_limited");
		mgr.resume();
		expect(mgr.get()?.status).toBe("time_limited");
		mgr.setMaxActiveMs(2000);
		expect(mgr.get()?.status).toBe("active");
	});

	it("restores legacy active goals with defaults and a fresh active interval", () => {
		const { mgr } = makeManager(10_000);
		mgr.restore({
			id: "legacy",
			objective: "restore",
			status: "active",
			tokensUsed: 12,
			iterations: 1,
			startedAt: 1,
		});
		const restored = mgr.get();
		expect(restored?.tokenBudget).toBe(DEFAULT_GOAL_TOKEN_BUDGET);
		expect(restored?.maxIterations).toBe(DEFAULT_GOAL_MAX_ITERATIONS);
		expect(restored?.maxActiveMs).toBe(DEFAULT_GOAL_MAX_ACTIVE_MS);
		expect(restored?.activeElapsedMs).toBe(0);
		expect(restored?.activeSince).toBe(10_000);
	});

	it("renders a compact status line", () => {
		const { mgr, advance } = makeManager();
		mgr.start("x", {});
		advance(3 * 60_000);
		// Canonical formatElapsed (utils/format-display.ts) keeps seconds: 3m00s, not 3m.
		expect(mgr.statusLine()).toBe("🎯 active 0/80k");

		mgr.clear();
		mgr.start("y", { tokenBudget: 100_000 });
		mgr.recordTurn(18_000);
		expect(mgr.statusLine()).toBe("🎯 active 18k/100k");
		// Spinner is appended by the footer outside its cache — statusLine stays static.
		expect(mgr.statusLine(true)).toBe("🎯 active 18k/100k");
		mgr.pause();
		expect(mgr.statusLine()).toBe("🎯 paused");
		expect(mgr.statusLine(true)).toBe("🎯 paused");
	});

	it("keeps statusLine static while continuing (spinner lives in the footer)", () => {
		const { mgr, advance } = makeManager();
		mgr.start("x", {});
		const first = mgr.statusLine(true);
		advance(80);
		const second = mgr.statusLine(true);
		expect(first).toBe(second);
		expect(first).toBe("🎯 active 0/80k");
	});

	it("splits the prompt: objective+status in the suffix, persistence rules in the prefix", () => {
		const { mgr } = makeManager();
		mgr.start("Make tests pass", {});
		// Dynamic suffix — billed on EVERY request of the turn, so it carries only
		// what actually mutates.
		expect(mgr.systemPromptSection()).toBe("<goal>Goal (active): Make tests pass</goal>");
		// Cacheable prefix — the immutable rules, paid once per goal lifecycle.
		const rules = mgr.systemPromptPrefixSection();
		expect(rules).toContain("goal_complete");
		expect(rules).toContain("autonomous");
		expect(rules).toContain("Keep working until the goal is fully resolved");
		expect(rules).not.toContain("Make tests pass");
		expect(mgr.continuationPrompt()).toContain("goal_complete");
	});

	it("keeps the prefix rules byte-identical across pause/resume and budget transitions", () => {
		const { mgr } = makeManager();
		mgr.start("Make tests pass", { tokenBudget: 1000 });
		const active = mgr.systemPromptPrefixSection();
		expect(mgr.hasPromptRules()).toBe(true);

		// Pausing/resuming is frequent (every interrupt pauses); if it moved the
		// prefix it would re-bill the whole cached prompt each time. Only the
		// one-line suffix reacts.
		mgr.pause();
		expect(mgr.hasPromptRules()).toBe(true);
		expect(mgr.systemPromptPrefixSection()).toBe(active);
		expect(mgr.systemPromptSection()).toBe("<goal>Goal (paused): Make tests pass</goal>");
		mgr.resume();
		expect(mgr.systemPromptPrefixSection()).toBe(active);

		// Same for exhausting (and raising) the token budget.
		mgr.recordTurn(1100);
		expect(mgr.get()?.status).toBe("budget_limited");
		expect(mgr.systemPromptPrefixSection()).toBe(active);
		expect(mgr.systemPromptSection()).toBe("<goal>Goal (budget_limited): Make tests pass</goal>");
		mgr.setTokenBudget(2000);
		expect(mgr.systemPromptPrefixSection()).toBe(active);
		expect(mgr.systemPromptSection()).toBe("<goal>Goal (active): Make tests pass</goal>");

		// Completion is the terminal event that DOES drop both blocks (one rebuild).
		mgr.complete("done");
		expect(mgr.hasPromptRules()).toBe(false);
		expect(mgr.systemPromptPrefixSection()).toBe("");
		expect(mgr.systemPromptSection()).toBe("");

		// No goal at all: nothing either way.
		mgr.clear();
		expect(mgr.hasPromptRules()).toBe(false);
		expect(mgr.systemPromptPrefixSection()).toBe("");
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

	it("restores snapshots while preserving forward-compatible gate fields", () => {
		const { mgr } = makeManager();
		mgr.restore(
			JSON.parse(
				JSON.stringify({
					id: "legacy-gates",
					objective: "legacy",
					status: "active",
					tokensUsed: 0,
					iterations: 0,
					startedAt: 1,
					unknownFutureField: { ignored: true },
					gateProgress: { revision: 4, passedGateIds: ["check"] },
				}),
			),
		);
		expect(mgr.get()?.objective).toBe("legacy");
		expect(mgr.get()?.tokenBudget).toBe(DEFAULT_GOAL_TOKEN_BUDGET);
		expect(mgr.gateProgressFor(4)).toEqual(["check"]);
	});

	it("only completes/edits when a goal exists", () => {
		const { mgr } = makeManager();
		expect(() => mgr.edit("x")).not.toThrow();
		expect(mgr.get()).toBeUndefined();
		mgr.complete("noop");
		expect(mgr.get()).toBeUndefined();
	});
});
