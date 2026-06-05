import { describe, expect, it } from "vitest";
import { AgentMessageBus } from "../../src/core/messaging/bus.ts";

describe("AgentMessageBus — registry", () => {
	it("reserve returns the base id when free, and dedupes collisions", () => {
		const bus = new AgentMessageBus(() => 1000);
		expect(bus.reserve("Worker", { kind: "sub" })).toBe("Worker");
		expect(bus.reserve("Worker", { kind: "sub" })).toBe("Worker-2");
		expect(bus.reserve("Worker", { kind: "sub" })).toBe("Worker-3");
	});

	it("reserve falls back to 'Agent' for a blank base", () => {
		const bus = new AgentMessageBus(() => 1000);
		expect(bus.reserve("   ", { kind: "sub" })).toBe("Agent");
	});

	it("get/list reflect reserved participants; respond starts null", () => {
		const bus = new AgentMessageBus(() => 1000);
		const id = bus.reserve("Main", { kind: "main", displayName: "Main" });
		const p = bus.get(id);
		expect(p?.kind).toBe("main");
		expect(p?.status).toBe("running");
		expect(p?.respond).toBeNull();
		expect(bus.list()).toHaveLength(1);
	});

	it("attachResponder sets the closure; setStatus + unregister mutate the map", () => {
		const bus = new AgentMessageBus(() => 1000);
		const id = bus.reserve("Main", { kind: "main" });
		bus.attachResponder(id, async () => "ok");
		expect(bus.get(id)?.respond).toBeTypeOf("function");
		bus.setStatus(id, "completed");
		expect(bus.get(id)?.status).toBe("completed");
		bus.unregister(id);
		expect(bus.get(id)).toBeUndefined();
	});

	it("listVisibleTo excludes self and non-running participants", () => {
		const bus = new AgentMessageBus(() => 1000);
		const main = bus.reserve("Main", { kind: "main" });
		const a = bus.reserve("A", { kind: "sub", parentId: main });
		const b = bus.reserve("B", { kind: "sub", parentId: main });
		bus.setStatus(b, "completed");
		const visible = bus.listVisibleTo(a).map((p) => p.id);
		expect(visible).toContain("Main");
		expect(visible).not.toContain("A"); // self excluded
		expect(visible).not.toContain("B"); // completed excluded
	});
});
