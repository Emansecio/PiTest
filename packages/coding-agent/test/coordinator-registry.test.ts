import { describe, expect, it } from "vitest";
import { SubagentRegistry } from "../src/core/coordinator/registry.js";

describe("SubagentRegistry", () => {
	it("creates a record with status 'pending'", () => {
		const reg = new SubagentRegistry();
		const rec = reg.create({ prompt: "do X" });
		expect(rec.status).toBe("pending");
		expect(rec.id).toMatch(/^sub_/);
	});

	it("update merges patches", () => {
		const reg = new SubagentRegistry();
		const rec = reg.create({ prompt: "x" });
		reg.update(rec.id, { status: "running", turnCount: 3 });
		const after = reg.get(rec.id)!;
		expect(after.status).toBe("running");
		expect(after.turnCount).toBe(3);
		expect(after.prompt).toBe("x");
	});

	it("setStatus is a noop for unknown id", () => {
		const reg = new SubagentRegistry();
		reg.setStatus("missing", "completed"); // must not throw
	});

	it("list returns all records", () => {
		const reg = new SubagentRegistry();
		reg.create({ prompt: "a" });
		reg.create({ prompt: "b" });
		expect(reg.list().length).toBe(2);
	});

	it("remove deletes a record", () => {
		const reg = new SubagentRegistry();
		const rec = reg.create({ prompt: "a" });
		reg.remove(rec.id);
		expect(reg.get(rec.id)).toBeUndefined();
	});

	it("defaults taskName to the record id when none is supplied", () => {
		const reg = new SubagentRegistry();
		const rec = reg.create({ prompt: "a" });
		expect(rec.taskName).toBe(rec.id);
	});

	it("keeps a unique supplied taskName as-is", () => {
		const reg = new SubagentRegistry();
		const rec = reg.create({ prompt: "a", taskName: "build" });
		expect(rec.taskName).toBe("build");
	});

	it("disambiguates a colliding taskName so parallel spawns never clash", () => {
		const reg = new SubagentRegistry();
		const first = reg.create({ prompt: "a", taskName: "build" });
		const second = reg.create({ prompt: "b", taskName: "build" });
		expect(first.taskName).toBe("build");
		expect(second.taskName).not.toBe("build");
		expect(second.taskName.startsWith("build-")).toBe(true);
		expect(second.taskName).not.toBe(first.taskName);
	});

	it("defaults depth to 0 when none is supplied", () => {
		const reg = new SubagentRegistry();
		expect(reg.create({ prompt: "a" }).depth).toBe(0);
	});

	it("records the supplied nesting depth", () => {
		const reg = new SubagentRegistry();
		expect(reg.create({ prompt: "a", depth: 2 }).depth).toBe(2);
	});
});
