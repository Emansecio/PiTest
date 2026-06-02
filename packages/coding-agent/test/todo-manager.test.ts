import { describe, expect, it } from "vitest";
import { TodoManager } from "../src/core/todo/todo-manager.js";

describe("TodoManager CRUD", () => {
	it("creates todos with incrementing ids, pending by default", () => {
		const mgr = new TodoManager();
		const a = mgr.create({ subject: "First" });
		const b = mgr.create({ subject: "Second", description: "more", activeForm: "Doing second" });
		expect(a.id).toBe(1);
		expect(b.id).toBe(2);
		expect(a.status).toBe("pending");
		expect(b.activeForm).toBe("Doing second");
		expect(mgr.list().length).toBe(2);
	});

	it("updates status, subject and activeForm", () => {
		const mgr = new TodoManager();
		const a = mgr.create({ subject: "Task" });
		mgr.update({ id: a.id, status: "in_progress", activeForm: "Working" });
		expect(mgr.get(a.id)?.status).toBe("in_progress");
		expect(mgr.get(a.id)?.activeForm).toBe("Working");
		mgr.update({ id: a.id, status: "completed" });
		expect(mgr.get(a.id)?.status).toBe("completed");
	});

	it("lists with an optional status filter", () => {
		const mgr = new TodoManager();
		mgr.create({ subject: "p1" });
		const x = mgr.create({ subject: "p2" });
		mgr.update({ id: x.id, status: "completed" });
		expect(mgr.list({ status: "completed" }).map((t) => t.subject)).toEqual(["p2"]);
		expect(mgr.list({ status: "pending" }).length).toBe(1);
	});

	it("deletes an item and clears all", () => {
		const mgr = new TodoManager();
		const a = mgr.create({ subject: "a" });
		mgr.create({ subject: "b" });
		mgr.delete(a.id);
		expect(mgr.list().length).toBe(1);
		mgr.clear();
		expect(mgr.list().length).toBe(0);
	});

	it("reports counts and in-progress presence", () => {
		const mgr = new TodoManager();
		const a = mgr.create({ subject: "a" });
		const b = mgr.create({ subject: "b" });
		mgr.create({ subject: "c" });
		mgr.update({ id: a.id, status: "completed" });
		mgr.update({ id: b.id, status: "in_progress" });
		expect(mgr.counts()).toEqual({ done: 1, total: 3 });
		expect(mgr.hasInProgress()).toBe(true);
	});

	it("serializes and restores", () => {
		const mgr = new TodoManager();
		mgr.create({ subject: "keep me", activeForm: "Keeping" });
		mgr.create({ subject: "second" });
		const data = mgr.serialize();

		const mgr2 = new TodoManager();
		mgr2.restore(data);
		expect(mgr2.list().map((t) => t.subject)).toEqual(["keep me", "second"]);
		// nextId preserved so new ids don't collide
		expect(mgr2.create({ subject: "third" }).id).toBe(3);
	});

	it("ignores updates/deletes for unknown ids", () => {
		const mgr = new TodoManager();
		expect(() => mgr.update({ id: 99, status: "completed" })).not.toThrow();
		expect(() => mgr.delete(99)).not.toThrow();
		expect(mgr.get(99)).toBeUndefined();
	});

	it("summary text lists todos with counts and activeForm", () => {
		const mgr = new TodoManager();
		const a = mgr.create({ subject: "only one" });
		expect(mgr.summaryText()).toContain("only one");
		expect(mgr.summaryText()).toContain("0/1");
		mgr.update({ id: a.id, status: "in_progress", activeForm: "Doing it" });
		expect(mgr.summaryText()).toContain("(Doing it)");
	});

	it("system prompt section appears only with open todos", () => {
		const mgr = new TodoManager();
		expect(mgr.systemPromptSection()).toBe("");
		const a = mgr.create({ subject: "x" });
		expect(mgr.systemPromptSection()).toContain("todo");
		mgr.update({ id: a.id, status: "completed" });
		// still rendered (history present) but reports 0 open
		expect(mgr.systemPromptSection()).toContain("0 open");
	});

	it("starts a fresh batch when creating after every todo is completed", () => {
		const mgr = new TodoManager();
		const a = mgr.create({ subject: "old1" });
		const b = mgr.create({ subject: "old2" });
		mgr.update({ id: a.id, status: "completed" });
		mgr.update({ id: b.id, status: "completed" });
		// New work after the batch is fully done → completed items dropped, ids reset
		// so new todos don't pile up as "next steps" under the old checked-off list.
		const fresh = mgr.create({ subject: "new work" });
		expect(mgr.list().map((t) => t.subject)).toEqual(["new work"]);
		expect(fresh.id).toBe(1);
	});
});
