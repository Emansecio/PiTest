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
});
