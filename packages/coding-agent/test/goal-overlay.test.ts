import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { GoalSnapshot } from "../src/core/goal/goal-manager.js";
import {
	createGoalOverlay,
	GOAL_COMPLETE_LINGER_MS,
	GOAL_COMPLETE_SOFT_EXIT_MS,
	renderGoalOverlay,
} from "../src/modes/interactive/components/goal-overlay.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";
import { ADVERSARIAL_TEXT, BORDER_WIDTHS, expectFitsWidth } from "./helpers/render-width.js";

function snapshot(over: Partial<GoalSnapshot> = {}): GoalSnapshot {
	return {
		id: "g1",
		objective: "Refactor the parser",
		status: "active",
		tokensUsed: 18_000,
		iterations: 12,
		startedAt: 0,
		elapsedMs: 4 * 60_000,
		...over,
	};
}

function render(
	snap: GoalSnapshot | undefined,
	width = 100,
	continuing = false,
	spinner = "\u2839",
	completeAgeMs?: number,
): string {
	return stripAnsi(renderGoalOverlay(snap, width, continuing, spinner, completeAgeMs).join("\n"));
}

const SPINNER = "\u2839";
const ELLIPSIS = "\u2026";
const EM_DASH = "\u2014";

describe("renderGoalOverlay", () => {
	beforeAll(() => initTheme(undefined, false));

	it("returns [] when there is no goal (auto-hide)", () => {
		expect(renderGoalOverlay(undefined, 80, false, SPINNER)).toEqual([]);
	});

	it("renders header, objective, metrics and hint for an active driving goal", () => {
		const out = render(snapshot(), 100, true, SPINNER);
		expect(out).toContain("Goal");
		expect(out).toContain("active");
		expect(out).toContain("Refactor the parser");
		expect(out).toContain("iter 12");
		expect(out).toContain("18k");
		expect(out).toContain("4m");
		expect(out).toContain(`${SPINNER} working${ELLIPSIS}`);
		expect(out).toMatch(/\u251C\u2500/);
		expect(out).toMatch(/\u2514\u2500/);
	});

	it("shows an idle hint (no spinner) when continuing is false", () => {
		const out = render(snapshot(), 100, false);
		expect(out).toContain(`idle ${EM_DASH} Esc or /goal pause`);
		expect(out).not.toContain("working");
	});

	it("shows token spend split and ~80% budget when near the limit", () => {
		const out = render(
			snapshot({
				tokensUsed: 85_000,
				tokenBudget: 100_000,
				tokenSpendSplit: { main: 50_000, subagent: 30_000, fusion: 5_000 },
			}),
			120,
			true,
		);
		expect(out).toContain("main 50k · sub 30k · fusion 5k");
		expect(out).toContain("~80% budget");
		expect(out).toContain("85k/100k");
	});

	it("shows a resume hint when paused", () => {
		const out = render(snapshot({ status: "paused" }), 100, false);
		expect(out).toContain("paused");
		expect(out).toContain("resume with /goal resume");
	});

	it("shows a raise-budget hint when budget_limited", () => {
		const out = render(snapshot({ status: "budget_limited", tokenBudget: 100_000 }), 100, false);
		expect(out).toContain("budget");
		expect(out).toContain("18k/100k");
		expect(out).toContain("raise with /goal --tokens <n>");
	});

	it("shows the summary when complete, then auto-hides after the linger window", () => {
		const snap = snapshot({ status: "complete", completedAt: 240_000, summary: "All tests green" });
		const visible = render(snap, 100, false, SPINNER, 1000);
		expect(visible).toContain("complete");
		expect(visible).toContain("All tests green");
		expect(renderGoalOverlay(snap, 100, false, SPINNER, GOAL_COMPLETE_LINGER_MS + 1)).toEqual([]);
	});

	it("falls back to 'done' when the completed goal has no summary", () => {
		const snap = snapshot({ status: "complete", completedAt: 240_000 });
		const out = render(snap, 100, false, SPINNER, 500);
		expect(out).toContain("done");
	});

	it("prefixes the complete hint with ✓ during the soft-exit window (#F)", () => {
		const snap = snapshot({ status: "complete", completedAt: 240_000, summary: "All tests green" });
		const beforeSoft = render(snap, 100, false, SPINNER, GOAL_COMPLETE_LINGER_MS - GOAL_COMPLETE_SOFT_EXIT_MS - 50);
		expect(beforeSoft).toContain("All tests green");
		expect(beforeSoft).not.toContain("✓");
		const soft = render(snap, 100, false, SPINNER, GOAL_COMPLETE_LINGER_MS - 100);
		expect(soft).toContain("✓ All tests green");
	});

	it("renders the token budget as NN/NN when set, and just NN when unset", () => {
		const withBudget = render(snapshot({ tokenBudget: 100_000 }), 100, true, SPINNER);
		expect(withBudget).toContain("18k/100k");
		const noBudget = render(snapshot({ tokenBudget: undefined }), 100, true, SPINNER);
		expect(noBudget).not.toMatch(/18k\/\d/);
		expect(noBudget).toContain("18k");
	});
});

describe("renderGoalOverlay width safety", () => {
	beforeAll(() => initTheme(undefined, false));

	it("never emits a line wider than the terminal, across widths x adversarial content", () => {
		for (const [name, text] of Object.entries(ADVERSARIAL_TEXT)) {
			const snap = snapshot({ objective: text, summary: text });
			for (const width of BORDER_WIDTHS) {
				const lines = renderGoalOverlay(snap, width, true, SPINNER);
				expectFitsWidth(lines, width, `goal-overlay[${name}]@${width}`);
			}
			const done = snapshot({ status: "complete", completedAt: 0, summary: text, objective: text });
			for (const width of BORDER_WIDTHS) {
				const lines = renderGoalOverlay(done, width, false, SPINNER, 100);
				expectFitsWidth(lines, width, `goal-overlay[complete-${name}]@${width}`);
			}
		}
	});

	it("truncates an over-long objective without dropping the connector or spinner", () => {
		const snap = snapshot({ objective: "z".repeat(300) });
		const lines = renderGoalOverlay(snap, 60, true, SPINNER);
		expectFitsWidth(lines, 60, "goal-overlay long-objective@60");
		const joined = stripAnsi(lines.join("\n"));
		expect(joined).toContain("\u251C\u2500");
		expect(joined).toContain(SPINNER);
		expect(joined).toContain(ELLIPSIS);
	});
});

describe("GoalOverlayComponent auto-hide + session rebind", () => {
	beforeAll(() => initTheme(undefined, false));

	it("tracks complete-seen age and hides after the linger window", () => {
		let nowMs = 0;
		let current: GoalSnapshot | undefined = snapshot({ status: "active" });
		const session = {
			goalSnapshot: () => current,
			goalIsDriving: () => false,
		} as unknown as AgentSession;
		const overlay = createGoalOverlay(session, () => nowMs);

		expect(stripAnsi(overlay.render(80).join("\n"))).toContain("active");

		nowMs = 1000;
		current = snapshot({ status: "complete", completedAt: 1000, summary: "done" });
		const lingering = stripAnsi(overlay.render(80).join("\n"));
		expect(lingering).toContain("complete");
		expect(lingering).toContain("done");

		nowMs = 1000 + GOAL_COMPLETE_LINGER_MS - 10;
		expect(stripAnsi(overlay.render(80).join("\n"))).toContain("complete");

		nowMs = 1000 + GOAL_COMPLETE_LINGER_MS + 1;
		expect(overlay.render(80)).toEqual([]);

		nowMs = 5000;
		current = snapshot({ status: "active" });
		expect(stripAnsi(overlay.render(80).join("\n"))).toContain("active");
	});

	it("renders a leading blank line separator (same convention as the todo overlay)", () => {
		const session = {
			goalSnapshot: () => snapshot({ status: "active" }),
			goalIsDriving: () => false,
		} as unknown as AgentSession;
		const overlay = createGoalOverlay(session, () => 0);
		const lines = overlay.render(80);
		expect(lines[0]).toBe("");
		expect(lines.length).toBeGreaterThan(1);
	});

	it("reuses structural cache across spinner frames (elapsed ms alone does not force a full rebuild)", () => {
		let nowMs = 5000;
		const session = {
			goalSnapshot: () => snapshot({ status: "active", elapsedMs: nowMs }),
			goalIsDriving: () => true,
		} as unknown as AgentSession;
		const overlay = createGoalOverlay(session, () => nowMs);
		const first = overlay.render(80);
		nowMs = 5016;
		const second = overlay.render(80);
		expect(first[0]).toBe("");
		expect(second[0]).toBe("");
		expect(stripAnsi(first.join("\n"))).toContain("5s");
		expect(stripAnsi(second.join("\n"))).toContain("5s");
		expect(first[1]).toBe(second[1]);
		expect(first[2]).toBe(second[2]);
		expect(first[3]).toBe(second[3]);
	});

	it("rebinds to a new session via setSession and clears completeSeenAt", () => {
		const sessionA = {
			goalSnapshot: () => snapshot({ status: "complete", completedAt: 0, summary: "ok" }),
			goalIsDriving: () => false,
		} as unknown as AgentSession;
		const sessionB = {
			goalSnapshot: () => snapshot({ status: "active" }),
			goalIsDriving: () => true,
		} as unknown as AgentSession;
		const overlay = createGoalOverlay(sessionA, () => 10_000);
		expect(stripAnsi(overlay.render(80).join("\n"))).toContain("complete");
		overlay.setSession(sessionB);
		const lines = overlay.render(80);
		expect(stripAnsi(lines.join("\n"))).toContain("active");
		expect(lines[0]).toBe("");
	});
});
