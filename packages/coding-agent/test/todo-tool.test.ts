import { afterEach, describe, expect, it } from "vitest";
import { setCurrentTodoManager, TodoManager } from "../src/core/todo/todo-manager.js";
import { createTodoToolDefinition, type TodoToolDetails } from "../src/core/tools/todo.js";

afterEach(() => setCurrentTodoManager(undefined));

// ToolDefinition.execute takes (toolCallId, params, signal, onUpdate, ctx).
function runExec(def: { execute: (...args: any[]) => any }, input: unknown) {
	return def.execute("call", input, undefined, undefined, undefined);
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => c.text ?? "").join("");
}

describe("todo tool", () => {
	it("creates, updates and lists via actions", async () => {
		const mgr = new TodoManager();
		setCurrentTodoManager(mgr);
		const def = createTodoToolDefinition("/tmp");

		const created = await runExec(def, { action: "create", subject: "Build it" });
		expect(text(created)).toContain("Created #1: Build it");

		const updated = await runExec(def, { action: "update", id: 1, status: "in_progress", activeForm: "Building" });
		expect(text(updated)).toContain("Updated #1 → in_progress");

		const listed = await runExec(def, { action: "list" });
		const details = listed.details as TodoToolDetails;
		expect(details.tasks).toHaveLength(1);
		expect(details.tasks[0]?.status).toBe("in_progress");
		expect(details.tasks[0]?.activeForm).toBe("Building");
	});

	it("validates required fields per action", async () => {
		setCurrentTodoManager(new TodoManager());
		const def = createTodoToolDefinition("/tmp");
		const createRes = await runExec(def, { action: "create" });
		expect((createRes.details as TodoToolDetails).error).toContain("subject");
		expect(createRes.isError).toBe(true);
		expect(((await runExec(def, { action: "update" })).details as TodoToolDetails).error).toContain("id");
		expect(((await runExec(def, { action: "delete" })).details as TodoToolDetails).error).toContain("id");
	});

	it("filters list by status", async () => {
		const mgr = new TodoManager();
		setCurrentTodoManager(mgr);
		const def = createTodoToolDefinition("/tmp");
		await runExec(def, { action: "create", subject: "a" });
		await runExec(def, { action: "create", subject: "b" });
		await runExec(def, { action: "update", id: 2, status: "completed" });

		const completed = (await runExec(def, { action: "list", status: "completed" })).details as TodoToolDetails;
		expect(completed.tasks.map((t) => t.subject)).toEqual(["b"]);
	});

	it("deletes and clears", async () => {
		const mgr = new TodoManager();
		setCurrentTodoManager(mgr);
		const def = createTodoToolDefinition("/tmp");
		await runExec(def, { action: "create", subject: "a" });
		await runExec(def, { action: "create", subject: "b" });
		await runExec(def, { action: "delete", id: 1 });
		expect(mgr.list()).toHaveLength(1);
		await runExec(def, { action: "clear" });
		expect(mgr.list()).toHaveLength(0);
	});

	it("is a graceful no-op when no manager is bound", async () => {
		setCurrentTodoManager(undefined);
		const def = createTodoToolDefinition("/tmp");
		const res = await runExec(def, { action: "list" });
		expect((res.details as TodoToolDetails).error).toContain("unavailable");
	});
});

describe("todo tool — set action", () => {
	it("rewrites the whole list in one call and echoes the result", async () => {
		const mgr = new TodoManager();
		setCurrentTodoManager(mgr);
		const def = createTodoToolDefinition("/tmp");

		await runExec(def, { action: "create", subject: "Investigate" });
		const out = await runExec(def, {
			action: "set",
			items: [
				{ id: 1, subject: "Investigate", status: "completed" },
				{ subject: "Implement", status: "in_progress", activeForm: "Implementing" },
			],
		});

		const details = out.details as TodoToolDetails;
		expect(details.action).toBe("set");
		expect(details.tasks.map((t) => t.status)).toEqual(["completed", "in_progress"]);
		expect(text(out)).toContain("✓ #1 Investigate");
		expect(text(out)).toContain("◐ #2 Implement (Implementing)");
	});

	it("rejects a set without items", async () => {
		setCurrentTodoManager(new TodoManager());
		const out = await runExec(createTodoToolDefinition("/tmp"), { action: "set" });
		expect(out.isError).toBe(true);
		expect(text(out)).toContain("set requires `items`");
	});

	it("rejects an item with a blank subject and names the index", async () => {
		setCurrentTodoManager(new TodoManager());
		const out = await runExec(createTodoToolDefinition("/tmp"), {
			action: "set",
			items: [{ subject: "Fine" }, { subject: "  " }],
		});
		expect(out.isError).toBe(true);
		expect(text(out)).toContain("index 1");
	});
});
