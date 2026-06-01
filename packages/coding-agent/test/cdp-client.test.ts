import { describe, expect, it, vi } from "vitest";
import { CdpConnection, listTargets, type WebSocketLike } from "../src/core/chrome/cdp-client.js";

/** Minimal scriptable WebSocket double following the WHATWG event API. */
class FakeWebSocket implements WebSocketLike {
	sent: string[] = [];
	closed = false;
	private listeners = new Map<string, Set<(ev: any) => void>>();
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.closed = true;
		this.emit("close", {});
	}
	addEventListener(type: string, listener: (ev: any) => void): void {
		let set = this.listeners.get(type);
		if (!set) {
			set = new Set();
			this.listeners.set(type, set);
		}
		set.add(listener);
	}
	emit(type: string, ev: any): void {
		for (const l of this.listeners.get(type) ?? []) l(ev);
	}
	/** Reply to the last sent command with a result/error. */
	reply(result: unknown, error?: { message: string }): void {
		const last = JSON.parse(this.sent[this.sent.length - 1] ?? "{}");
		this.emit("message", { data: JSON.stringify({ id: last.id, result, error }) });
	}
	event(method: string, params: unknown): void {
		this.emit("message", { data: JSON.stringify({ method, params }) });
	}
}

// Drain microtasks so an awaited send() proceeds past ensureOpen() and writes.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function connect(): { conn: CdpConnection; ws: FakeWebSocket } {
	const ws = new FakeWebSocket();
	const conn = new CdpConnection("ws://x", () => ws);
	return { conn, ws };
}

describe("listTargets", () => {
	it("fetches /json and returns page targets", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => [
				{ id: "1", type: "page", title: "A", url: "http://a", webSocketDebuggerUrl: "ws://1" },
				{ id: "2", type: "background_page", title: "bg", url: "" },
			],
		});
		const targets = await listTargets("127.0.0.1", 9222, undefined, fetchImpl);
		expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:9222/json", expect.anything());
		expect(targets.map((t) => t.id)).toEqual(["1", "2"]);
	});

	it("throws a clear error on non-ok response", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => [] });
		await expect(listTargets("h", 1, undefined, fetchImpl)).rejects.toThrow(/500/);
	});

	it("throws a setup hint when the endpoint is unreachable", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
		await expect(listTargets("h", 9222, undefined, fetchImpl)).rejects.toThrow(/remote-debugging-port/);
	});
});

describe("CdpConnection", () => {
	it("resolves a command with its result once the socket opens", async () => {
		const { conn, ws } = connect();
		const p = conn.send("Page.navigate", { url: "http://x" });
		ws.emit("open", {});
		await flush();
		const sent = JSON.parse(ws.sent[0]!);
		expect(sent.method).toBe("Page.navigate");
		ws.reply({ frameId: "f1" });
		await expect(p).resolves.toEqual({ frameId: "f1" });
	});

	it("rejects on a CDP error reply", async () => {
		const { conn, ws } = connect();
		const p = conn.send("Bad.method");
		ws.emit("open", {});
		await flush();
		ws.reply(undefined, { message: "no such method" });
		await expect(p).rejects.toThrow(/no such method/);
	});

	it("delivers events to on() listeners", async () => {
		const { conn, ws } = connect();
		const seen: unknown[] = [];
		conn.on("Runtime.consoleAPICalled", (params) => seen.push(params));
		const p = conn.send("Runtime.enable");
		ws.emit("open", {});
		await flush();
		ws.reply({});
		await p;
		ws.event("Runtime.consoleAPICalled", { type: "log", args: [{ value: "hi" }] });
		expect(seen).toEqual([{ type: "log", args: [{ value: "hi" }] }]);
	});

	it("times out a command that never replies", async () => {
		const { conn, ws } = connect();
		const p = conn.send("Slow.op", {}, { timeoutMs: 50 });
		ws.emit("open", {});
		await expect(p).rejects.toThrow(/timed out/);
	});

	it("fails pending commands when the socket closes", async () => {
		const { conn, ws } = connect();
		const p = conn.send("Page.enable");
		ws.emit("open", {});
		await flush();
		ws.emit("close", {});
		await expect(p).rejects.toThrow();
	});
});
