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

describe("AgentMessageBus — send routing", () => {
	function busWith(...specs: Array<{ id: string; reply?: (from: string, msg: string) => string }>) {
		const bus = new AgentMessageBus(() => 1000);
		for (const s of specs) {
			const id = bus.reserve(s.id, { kind: s.id === "Main" ? "main" : "sub" });
			if (s.reply) bus.attachResponder(id, async (from, msg) => s.reply!(from, msg));
		}
		return bus;
	}

	it("DM round-trip: delivers and returns the peer's reply", async () => {
		const bus = busWith({ id: "A" }, { id: "Main", reply: (from, msg) => `pong:${from}:${msg}` });
		const r = await bus.send({ from: "A", to: "Main", message: "hi" });
		expect(r.delivered).toEqual(["Main"]);
		expect(r.replies).toEqual([{ from: "Main", text: "pong:A:hi" }]);
		expect(r.failed).toEqual([]);
		expect(r.notFound).toEqual([]);
	});

	it("broadcast: messages every running peer except self and gathers replies", async () => {
		const bus = busWith({ id: "A" }, { id: "B", reply: () => "from-B" }, { id: "C", reply: () => "from-C" });
		const r = await bus.send({ from: "A", to: "all", message: "anyone?" });
		expect(r.delivered.sort()).toEqual(["B", "C"]);
		expect(r.replies.map((x) => x.text).sort()).toEqual(["from-B", "from-C"]);
	});

	it("unknown / self / non-running recipients land in notFound", async () => {
		const bus = busWith({ id: "A", reply: () => "self?" }, { id: "Main", reply: () => "x" });
		bus.setStatus("Main", "completed");
		expect((await bus.send({ from: "A", to: "ghost", message: "?" })).notFound).toEqual(["ghost"]);
		expect((await bus.send({ from: "A", to: "A", message: "?" })).notFound).toEqual(["A"]);
		expect((await bus.send({ from: "A", to: "Main", message: "?" })).notFound).toEqual(["Main"]);
	});

	it("a placeholder participant (no responder) is reported as failed, not delivered", async () => {
		const bus = busWith({ id: "A" }, { id: "Main" }); // Main has no responder
		const r = await bus.send({ from: "A", to: "Main", message: "hi" });
		expect(r.delivered).toEqual([]);
		expect(r.failed[0]?.id).toBe("Main");
		expect(r.failed[0]?.error).toMatch(/not reachable/i);
	});

	it("a responder error is captured as a failure (other recipients unaffected)", async () => {
		const bus = busWith(
			{ id: "A" },
			{
				id: "B",
				reply: () => {
					throw new Error("boom");
				},
			},
			{ id: "C", reply: () => "ok" },
		);
		const r = await bus.send({ from: "A", to: "all", message: "x" });
		expect(r.replies).toEqual([{ from: "C", text: "ok" }]);
		expect(r.failed).toEqual([{ id: "B", error: "boom" }]);
	});

	it("a hung responder is aborted by the timeout and reported as failed", async () => {
		const bus = new AgentMessageBus(() => 1000);
		bus.reserve("A", { kind: "sub" });
		const stuck = bus.reserve("Slow", { kind: "sub" });
		bus.attachResponder(
			stuck,
			(_from, _msg, signal) =>
				new Promise<string>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);
		const r = await bus.send({ from: "A", to: "Slow", message: "x", timeoutMs: 10 });
		expect(r.delivered).toEqual([]);
		expect(r.failed[0]?.id).toBe("Slow");
	}, 5000);
});

describe("AgentMessageBus — fire-and-forget (awaitReply:false)", () => {
	it("delivers via the deliver channel and returns no reply", async () => {
		const bus = new AgentMessageBus(() => 1000);
		bus.reserve("A", { kind: "sub" });
		const b = bus.reserve("B", { kind: "sub" });
		let received: { from: string; message: string } | undefined;
		bus.attachDelivery(b, (from, message) => {
			received = { from, message };
		});
		const r = await bus.send({ from: "A", to: "B", message: "fyi", awaitReply: false });
		expect(r.delivered).toEqual(["B"]);
		expect(r.replies).toEqual([]);
		expect(received).toEqual({ from: "A", message: "fyi" });
	});

	it("a peer without a delivery channel is reported as failed", async () => {
		const bus = new AgentMessageBus(() => 1000);
		bus.reserve("A", { kind: "sub" });
		bus.reserve("B", { kind: "sub" }); // responder maybe, but no delivery channel
		const r = await bus.send({ from: "A", to: "B", message: "fyi", awaitReply: false });
		expect(r.delivered).toEqual([]);
		expect(r.failed[0]?.id).toBe("B");
		expect(r.failed[0]?.error).toMatch(/delivery channel/i);
	});

	it("broadcast fire-and-forget reaches every running peer with a channel", async () => {
		const bus = new AgentMessageBus(() => 1000);
		bus.reserve("A", { kind: "sub" });
		const got: string[] = [];
		for (const id of ["B", "C"]) {
			const r = bus.reserve(id, { kind: "sub" });
			bus.attachDelivery(r, (from) => got.push(`${id}<-${from}`));
		}
		const r = await bus.send({ from: "A", to: "all", message: "shipped", awaitReply: false });
		expect(r.delivered.sort()).toEqual(["B", "C"]);
		expect(got.sort()).toEqual(["B<-A", "C<-A"]);
	});
});
