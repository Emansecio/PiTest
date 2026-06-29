import { SPINNER_FRAMES } from "@pit/tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { GoalSnapshot } from "../src/core/goal/goal-manager.ts";
import { createGoalOverlay } from "../src/modes/interactive/components/goal-overlay.ts";
import { spinnerGlyphAt } from "../src/modes/interactive/components/spinner-ticker.ts";
import { createTodoOverlay } from "../src/modes/interactive/components/todo-overlay.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ENV_KEYS = ["PIT_NO_MOTION", "PIT_REDUCED_MOTION", "TERM"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => initTheme("dark"));

function enableReducedMotion(): void {
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
	}
	process.env.PIT_NO_MOTION = "1";
	delete process.env.PIT_REDUCED_MOTION;
}

afterEach(() => {
	for (const key of ENV_KEYS) {
		const prev = savedEnv[key];
		if (prev === undefined) delete process.env[key];
		else process.env[key] = prev;
	}
});

describe("reduced motion spinner freeze (#E)", () => {
	it("spinnerGlyphAt returns frame 0 for any clock value", () => {
		enableReducedMotion();
		expect(spinnerGlyphAt(0)).toBe(SPINNER_FRAMES[0]);
		expect(spinnerGlyphAt(10_000)).toBe(SPINNER_FRAMES[0]);
	});

	it("TERM=dumb enables reduced motion without PIT_NO_MOTION", () => {
		for (const key of ENV_KEYS) {
			savedEnv[key] = process.env[key];
		}
		delete process.env.PIT_NO_MOTION;
		delete process.env.PIT_REDUCED_MOTION;
		process.env.TERM = "dumb";
		expect(spinnerGlyphAt(5000)).toBe(SPINNER_FRAMES[0]);
	});

	it("todo overlay keeps a static in_progress glyph across clock steps", () => {
		enableReducedMotion();
		const session = {
			todoForOverlay: () => ({ items: [{ id: 1, subject: "task", status: "in_progress" }], done: 0, total: 1 }),
		} as unknown as AgentSession;
		let nowMs = 0;
		const overlay = createTodoOverlay(session, () => nowMs);
		const glyphAt = (t: number) => {
			nowMs = t;
			return stripAnsi(overlay.render(80).join("\n"));
		};
		expect(glyphAt(0)).toContain(SPINNER_FRAMES[0]);
		expect(glyphAt(800)).toContain(SPINNER_FRAMES[0]);
		expect(glyphAt(1600)).toContain(SPINNER_FRAMES[0]);
		expect(glyphAt(800)).not.toContain(SPINNER_FRAMES[1]);
	});

	it("goal overlay keeps a static working glyph across clock steps", () => {
		enableReducedMotion();
		const snap: GoalSnapshot = {
			id: "g1",
			objective: "ship it",
			status: "active",
			tokensUsed: 0,
			iterations: 0,
			startedAt: 0,
			elapsedMs: 0,
		};
		const session = {
			goalSnapshot: () => snap,
			goalIsDriving: () => true,
		} as unknown as AgentSession;
		let nowMs = 0;
		const overlay = createGoalOverlay(session, () => nowMs);
		const glyphAt = (t: number) => {
			nowMs = t;
			return stripAnsi(overlay.render(80).join("\n"));
		};
		expect(glyphAt(0)).toContain(`${SPINNER_FRAMES[0]} working`);
		expect(glyphAt(500)).toContain(`${SPINNER_FRAMES[0]} working`);
		expect(glyphAt(500)).not.toContain(SPINNER_FRAMES[1]);
	});
});
