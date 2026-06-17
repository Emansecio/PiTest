import { type AssistantMessage, getModel, type ToolResultMessage } from "@pit/ai";
import { describe, expect, it } from "vitest";
import type { TodoItem } from "../src/core/todo/todo-manager.js";
import {
	buildTodoCadenceReminder,
	classifyTodoTurn,
	decideTodoCadenceReminder,
	TodoCadenceTracker,
} from "../src/core/todo-cadence.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function assistantWithToolCalls(calls: Array<{ id: string; name: string }>): AssistantMessage {
	return {
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: {} })),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function textOnlyAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function result(toolCallId: string, isError: boolean): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "x",
		content: [{ type: "text", text: isError ? "boom" : "ok" }],
		isError,
		timestamp: 0,
	};
}

function todo(id: number, subject: string, status: TodoItem["status"]): TodoItem {
	return { id, subject, status };
}

describe("classifyTodoTurn", () => {
	it("reports neither for a text-only turn", () => {
		expect(classifyTodoTurn(textOnlyAssistant("done"), [])).toEqual({ touchedTodo: false, mutated: false });
	});

	it("touchedTodo is true when a todo tool call is present", () => {
		const msg = assistantWithToolCalls([
			{ id: "a", name: "read" },
			{ id: "b", name: "todo" },
		]);
		const out = classifyTodoTurn(msg, [result("a", false), result("b", false)]);
		expect(out.touchedTodo).toBe(true);
	});

	it("touchedTodo is false when no todo tool call is present", () => {
		const msg = assistantWithToolCalls([{ id: "a", name: "grep" }]);
		expect(classifyTodoTurn(msg, [result("a", false)]).touchedTodo).toBe(false);
	});

	it("mutated is true for a successful mutating call", () => {
		const msg = assistantWithToolCalls([{ id: "a", name: "edit" }]);
		expect(classifyTodoTurn(msg, [result("a", false)]).mutated).toBe(true);
	});

	it("mutated is false when the only mutating call errored", () => {
		const msg = assistantWithToolCalls([{ id: "a", name: "write" }]);
		expect(classifyTodoTurn(msg, [result("a", true)]).mutated).toBe(false);
	});

	it("mutated is false when no mutating tool is called", () => {
		const msg = assistantWithToolCalls([
			{ id: "a", name: "read" },
			{ id: "b", name: "bash" },
		]);
		expect(classifyTodoTurn(msg, [result("a", false), result("b", false)]).mutated).toBe(false);
	});

	it("treats a mutating call with no matching result as a mutation (lean against false positives)", () => {
		const msg = assistantWithToolCalls([{ id: "a", name: "write" }]);
		expect(classifyTodoTurn(msg, []).mutated).toBe(true);
	});

	it("can report both touchedTodo and mutated in one turn", () => {
		const msg = assistantWithToolCalls([
			{ id: "a", name: "edit" },
			{ id: "b", name: "todo" },
		]);
		expect(classifyTodoTurn(msg, [result("a", false), result("b", false)])).toEqual({
			touchedTodo: true,
			mutated: true,
		});
	});
});

describe("TodoCadenceTracker", () => {
	it("increments while work is open and the todo is untouched", () => {
		const t = new TodoCadenceTracker();
		expect(t.observe({ hasInProgress: true, touchedTodo: false })).toBe(1);
		expect(t.observe({ hasInProgress: true, touchedTodo: false })).toBe(2);
		expect(t.staleTurns).toBe(2);
	});

	it("resets when the todo is touched", () => {
		const t = new TodoCadenceTracker();
		t.observe({ hasInProgress: true, touchedTodo: false });
		t.observe({ hasInProgress: true, touchedTodo: false });
		expect(t.observe({ hasInProgress: true, touchedTodo: true })).toBe(0);
	});

	it("resets when there is no open work", () => {
		const t = new TodoCadenceTracker();
		t.observe({ hasInProgress: true, touchedTodo: false });
		expect(t.observe({ hasInProgress: false, touchedTodo: false })).toBe(0);
	});

	it("reset() zeroes the streak", () => {
		const t = new TodoCadenceTracker();
		t.observe({ hasInProgress: true, touchedTodo: false });
		t.reset();
		expect(t.staleTurns).toBe(0);
	});
});

describe("decideTodoCadenceReminder", () => {
	const base = {
		enabled: true,
		threshold: 5,
		staleTurns: 0,
		mutatedWithoutTodo: false,
		lastFiredAt: 0,
		now: 100_000,
		cooldownMs: 30_000,
	};

	it("does nothing when disabled", () => {
		expect(decideTodoCadenceReminder({ ...base, enabled: false, staleTurns: 99 }).action).toBe("none");
	});

	it("does nothing below the threshold without a mutation", () => {
		expect(decideTodoCadenceReminder({ ...base, staleTurns: 4 }).action).toBe("none");
	});

	it("reminds once the stale streak hits the threshold", () => {
		const out = decideTodoCadenceReminder({ ...base, staleTurns: 5 });
		expect(out.action).toBe("remind");
		expect(out.nextLastFiredAt).toBe(100_000);
	});

	it("reminds when a file was mutated without touching the todo, even below threshold", () => {
		const out = decideTodoCadenceReminder({ ...base, staleTurns: 1, mutatedWithoutTodo: true });
		expect(out.action).toBe("remind");
	});

	it("suppresses a repeat reminder inside the cooldown", () => {
		const out = decideTodoCadenceReminder({
			...base,
			staleTurns: 6,
			lastFiredAt: 95_000,
			now: 100_000,
		});
		expect(out.action).toBe("none");
		expect(out.nextLastFiredAt).toBe(95_000);
	});

	it("re-reminds once the cooldown has elapsed", () => {
		const out = decideTodoCadenceReminder({
			...base,
			staleTurns: 6,
			lastFiredAt: 60_000,
			now: 100_000,
		});
		expect(out.action).toBe("remind");
		expect(out.nextLastFiredAt).toBe(100_000);
	});
});

describe("buildTodoCadenceReminder", () => {
	const items: TodoItem[] = [
		todo(1, "scaffold module", "completed"),
		todo(2, "wire the session", "in_progress"),
		todo(3, "add tests", "pending"),
	];

	it("enumerates the items and names the stale item by id", () => {
		const out = buildTodoCadenceReminder({ items, staleItem: items[1], reason: "stale" });
		expect(out).toContain("<todo-sync-reminder>");
		expect(out).toContain("#1 scaffold module");
		expect(out).toContain("#2 wire the session");
		expect(out).toContain("#3 add tests");
		expect(out).toContain("#2 (wire the session) is in_progress");
		expect(out).toContain("</todo-sync-reminder>");
	});

	it("uses the mutated wording when reason is mutated", () => {
		const out = buildTodoCadenceReminder({ items, staleItem: items[1], reason: "mutated" });
		expect(out).toContain("edited a file");
	});

	it("never tells the agent to auto-complete", () => {
		const out = buildTodoCadenceReminder({ items, staleItem: items[1], reason: "stale" });
		expect(out.toLowerCase()).not.toContain("auto");
		expect(out.toLowerCase()).not.toContain("automatically");
	});
});
