import { SPINNER_FRAME_MS, SPINNER_FRAMES } from "@pit/tui";
import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { createTodoOverlay } from "../src/modes/interactive/components/todo-overlay.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

// P7: every live spinner steps one frame per SPINNER_FRAME_MS off the same
// monotonic clock AND shares one glyph set (SPINNER_FRAMES), so the whole UI
// animates as a single, phase-locked spinner identity. This pins both the
// unified cadence (the todo used to run at 120ms) and the unified style (the
// todo used its own ◐◓◑◒ half-moons).
describe("unified spinner cadence + style (P7)", () => {
	it("exposes one shared frame interval (80ms) and one shared braille glyph set", () => {
		expect(SPINNER_FRAME_MS).toBe(80);
		expect([...SPINNER_FRAMES]).toEqual(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
	});

	it("advances the todo overlay spinner once per SPINNER_FRAME_MS using the shared glyphs", () => {
		initTheme("dark");
		const session = {
			todoForOverlay: () => ({ items: [{ id: 1, subject: "task", status: "in_progress" }], done: 0, total: 1 }),
		} as unknown as AgentSession;

		let nowMs = 0;
		const overlay = createTodoOverlay(session, () => nowMs);
		const frameAt = (t: number): string => {
			nowMs = t;
			return stripAnsi(overlay.render(80).join("\n"));
		};

		const n = SPINNER_FRAMES.length;
		// One frame per SPINNER_FRAME_MS bucket, drawn from the shared set, wrapping after n.
		for (let k = 0; k < n; k++) {
			expect(frameAt(SPINNER_FRAME_MS * k)).toContain(SPINNER_FRAMES[k]);
		}
		expect(frameAt(SPINNER_FRAME_MS * n)).toContain(SPINNER_FRAMES[0]); // wraps

		// Still frame 0 just before the first boundary — proves the cadence is
		// SPINNER_FRAME_MS, not the old 120ms (which would not have advanced by 100).
		expect(frameAt(SPINNER_FRAME_MS - 1)).toContain(SPINNER_FRAMES[0]);
		expect(frameAt(100)).toContain(SPINNER_FRAMES[1]); // 100ms is past the 80ms boundary
	});
});
