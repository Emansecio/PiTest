import { beforeAll, describe, expect, it } from "vitest";
import type { TodoItem } from "../src/core/todo/todo-manager.js";
import { renderTodoOverlay } from "../src/modes/interactive/components/todo-overlay.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";
import { ADVERSARIAL_TEXT, BORDER_WIDTHS, expectFitsWidth } from "./helpers/render-width.js";

function item(id: number, subject: string, status: TodoItem["status"], activeForm?: string): TodoItem {
	return { id, subject, status, activeForm };
}

function overlay(items: TodoItem[], width = 100): string {
	const done = items.filter((t) => t.status === "completed").length;
	return stripAnsi(renderTodoOverlay({ items, done, total: items.length }, width, "◐").join("\n"));
}

describe("renderTodoOverlay", () => {
	beforeAll(() => initTheme(undefined, false));

	it("returns [] when empty (auto-hide)", () => {
		expect(renderTodoOverlay({ items: [], done: 0, total: 0 }, 80, "◐")).toEqual([]);
	});

	it("returns [] when every todo is completed and no linger age is given", () => {
		const items = [item(1, "a", "completed"), item(2, "b", "completed")];
		expect(renderTodoOverlay({ items, done: 2, total: 2 }, 80, "◐")).toEqual([]);
	});

	it("lingers the completed state (full bar, all ✓) inside the linger window, then hides", () => {
		const items = [item(1, "a", "completed"), item(2, "b", "completed")];
		const during = stripAnsi(renderTodoOverlay({ items, done: 2, total: 2 }, 80, "◐", 1000).join("\n"));
		expect(during).toContain("2/2");
		expect(during).toContain("100%");
		expect(during).toContain("✓");
		expect(renderTodoOverlay({ items, done: 2, total: 2 }, 80, "◐", 4001)).toEqual([]);
	});

	it("renders header, statuses, activeForm and connectors", () => {
		const out = overlay([
			item(1, "Create DemoTodo domain entity", "completed"),
			item(2, "Create IDemoTodoRepository interface", "completed"),
			item(3, "Create DemoTodoRepository in Infrastructure", "in_progress", "Creating impl"),
			item(4, "Write tests", "pending"),
		]);
		expect(out).toContain("Tasks");
		expect(out).toContain("2/4");
		expect(out).toContain("✓");
		expect(out).toContain("◐ Create DemoTodoRepository in Infrastructure");
		expect(out).toContain("— Creating impl");
		expect(out).toContain("○ Write tests");
		expect(out).toMatch(/├─/);
		expect(out).toMatch(/└─/);
		expect(out).toContain("▰");
		expect(out).not.toContain("█");
	});

	it("uses the supplied spinner frame for in_progress", () => {
		const out = stripAnsi(
			renderTodoOverlay({ items: [item(1, "x", "in_progress")], done: 0, total: 1 }, 80, "◓").join("\n"),
		);
		expect(out).toContain("◓ x");
	});

	it("hides oldest completed first when the list is long", () => {
		const items: TodoItem[] = [];
		for (let i = 1; i <= 16; i++) items.push(item(i, `done ${i}`, "completed"));
		items.push(item(17, "active", "pending"));
		const out = overlay(items);
		expect(out).toContain("done hidden");
		expect(out).toContain("active");
	});
});

describe("renderTodoOverlay width safety", () => {
	beforeAll(() => initTheme(undefined, false));

	// The crash that motivated this: an in_progress row whose subject + the
	// parenthesised activeForm + the "├─ " connector summed past the terminal
	// width, because budgeting used String.length (code units) instead of the
	// visible column count. These assertions would have caught it in CI — the
	// pre-existing suite only checked content (toContain), never line width.
	it("never emits a line wider than the terminal, across widths × adversarial content", () => {
		for (const [name, text] of Object.entries(ADVERSARIAL_TEXT)) {
			const items: TodoItem[] = [
				item(1, `done ${text}`, "completed"),
				item(2, `pending ${text}`, "pending"),
				// the exact shape that crashed: long subject AND long activeForm.
				item(3, `inprog ${text}`, "in_progress", `working on ${text}`),
			];
			for (const width of BORDER_WIDTHS) {
				const lines = renderTodoOverlay({ items, done: 1, total: items.length }, width, "◐");
				expectFitsWidth(lines, width, `todo-overlay[${name}]@${width}`);
			}
		}
	});

	it("regression: in_progress subject + activeForm together fit a 120-col terminal (crash shape)", () => {
		// Mirrors pi-crash.log line 178: a ~85-char subject plus a parenthesised
		// activeForm rendered to 126 visible cols on a 120-col terminal.
		const items: TodoItem[] = [
			item(
				1,
				"Apply PROPOSAL.md corrections (§6 size, §9 roadmap, §11 criteria, §12 open questions)",
				"in_progress",
				"Applying PROPOSAL.md corrections",
			),
		];
		const lines = renderTodoOverlay({ items, done: 0, total: 1 }, 120, "⠏");
		expectFitsWidth(lines, 120, "todo-overlay crash-shape@120");

		// The row is truncated, not dropped: the spinner and an ellipsis survive.
		const joined = stripAnsi(lines.join("\n"));
		expect(joined).toContain("⠏");
		expect(joined).toContain("…");
		expect(joined).toContain("— Applying PROPOSAL.md corrections"); // activeForm preserved
	});

	it("truncates an over-long completed subject (strike row also fits)", () => {
		const items: TodoItem[] = [item(1, "z".repeat(300), "completed"), item(2, "next", "in_progress")];
		for (const width of BORDER_WIDTHS) {
			const lines = renderTodoOverlay({ items, done: 1, total: 2 }, width, "◐");
			expectFitsWidth(lines, width, `todo-overlay[completed-long]@${width}`);
		}
	});
});
