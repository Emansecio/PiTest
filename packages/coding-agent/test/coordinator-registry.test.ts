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
		reg.setStatus("missing", "completed");
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

	it("enforces the terminal record cap when records settle in a burst", () => {
		const registry = new SubagentRegistry();
		const records = Array.from({ length: 100 }, (_, index) =>
			registry.create({ prompt: `prompt-${index}`, taskName: `task-${index}` }),
		);

		for (const record of records) registry.setStatus(record.id, "completed");

		expect(registry.list()).toHaveLength(64);
		expect(registry.get(records[0].id)).toBeUndefined();
		expect(registry.get(records.at(-1)!.id)?.status).toBe("completed");
	});

	it("retains an older live record when it settles after the terminal cache is full", () => {
		const registry = new SubagentRegistry();
		const slow = registry.create({ prompt: "slow", taskName: "slow" });
		for (let index = 0; index < 64; index += 1) {
			const record = registry.create({ prompt: `fast-${index}`, taskName: `fast-${index}` });
			registry.setStatus(record.id, "completed");
		}

		const settled = registry.update(slow.id, { status: "completed", output: "finished" });

		expect(registry.list()).toHaveLength(64);
		expect(registry.get(slow.id)).toBe(settled);
		expect(registry.get(slow.id)?.output).toBe("finished");
	});

	it("reports cumulative lifecycle and retained-record counters", () => {
		const registry = new SubagentRegistry();
		const live = registry.create({ prompt: "live" });
		const done = registry.create({ prompt: "done" });
		registry.setStatus(live.id, "running");
		registry.setStatus(done.id, "completed");
		registry.update(done.id, { output: "late metadata" });

		expect(registry.stats()).toEqual({
			created: 2,
			settled: 1,
			evicted: 0,
			retained: 2,
			live: 1,
			terminal: 1,
		});
	});

	it("publishes a settled record before terminal eviction", () => {
		const evicted: Array<{ taskName: string; output?: string }> = [];
		const registry = new SubagentRegistry({ onBeforeEvict: (record) => evicted.push(record) });
		const records = Array.from({ length: 65 }, (_, index) =>
			registry.create({ prompt: `prompt-${index}`, taskName: `task-${index}` }),
		);
		for (const [index, record] of records.entries()) {
			registry.update(record.id, { status: "completed", output: `output-${index}` });
		}

		expect(evicted).toHaveLength(1);
		expect(evicted[0]).toMatchObject({ taskName: "task-0", output: "output-0" });
		expect(registry.stats().evicted).toBe(1);
	});
});
