import { beforeAll, describe, expect, it } from "vitest";
import type { TodoItem } from "../src/core/todo/todo-manager.js";
import { renderTodoOverlay } from "../src/modes/interactive/components/todo-overlay.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

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

	it("returns [] when every todo is completed (auto-hide on done)", () => {
		const items = [item(1, "a", "completed"), item(2, "b", "completed")];
		expect(renderTodoOverlay({ items, done: 2, total: 2 }, 80, "◐")).toEqual([]);
	});

	it("renders header, statuses, activeForm and connectors", () => {
		const out = overlay([
			item(1, "Create DemoTodo domain entity", "completed"),
			item(2, "Create IDemoTodoRepository interface", "completed"),
			item(3, "Create DemoTodoRepository in Infrastructure", "in_progress", "Creating impl"),
			item(4, "Write tests", "pending"),
		]);
		expect(out).toContain("Todos (2/4)");
		expect(out).toContain("✓");
		expect(out).toContain("◐ Create DemoTodoRepository in Infrastructure");
		expect(out).toContain("(Creating impl)");
		expect(out).toContain("○ Write tests");
		expect(out).toMatch(/├─/);
		expect(out).toMatch(/└─/);
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
		expect(out).toContain("completed hidden");
		expect(out).toContain("active");
	});
});
