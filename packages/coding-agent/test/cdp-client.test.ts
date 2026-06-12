import { afterEach, describe, expect, it, vi } from "vitest";
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

function connect(opts?: { connectTimeoutMs?: number }): { conn: CdpConnection; ws: FakeWebSocket } {
	const ws = new FakeWebSocket();
	const conn = new CdpConnection("ws://x", () => ws, opts);
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

	it("flips isClosed() on remote close and refuses new sends", async () => {
		const { conn, ws } = connect();
		expect(conn.isClosed()).toBe(false);
		const p = conn.send("Page.enable");
		ws.emit("open", {});
		await flush();
		ws.emit("close", {});
		await expect(p).rejects.toThrow();
		expect(conn.isClosed()).toBe(true);
		// A dead connection must refuse instead of hanging — the manager relies
		// on this plus isClosed() to evict and reconnect.
		await expect(conn.send("Page.enable")).rejects.toThrow(/closed/);
	});

	it("aborts an in-flight command via the signal", async () => {
		const { conn, ws } = connect();
		const controller = new AbortController();
		const p = conn.send("Slow.op", {}, { signal: controller.signal });
		ws.emit("open", {});
		await flush();
		controller.abort();
		await expect(p).rejects.toThrow(/aborted/);
	});

	it("rejects when the socket closes before opening", async () => {
		const { conn, ws } = connect();
		const p = conn.send("Page.enable");
		ws.emit("close", {});
		await expect(p).rejects.toThrow(/closed before opening/);
		expect(conn.isClosed()).toBe(true);
	});

	describe("abort-listener hygiene", () => {
		// Wrap a real AbortSignal so we can net-count its "abort" listeners. Both the
		// connect race (openWithAbort) and each command add one; a leak is a positive
		// residual after every command settles.
		function countingSignal(signal: AbortSignal): { signal: AbortSignal; live: () => number } {
			let live = 0;
			const add = signal.addEventListener.bind(signal);
			const remove = signal.removeEventListener.bind(signal);
			signal.addEventListener = ((type: string, ...rest: unknown[]) => {
				if (type === "abort") live += 1;
				return (add as (...args: unknown[]) => void)(type, ...rest);
			}) as typeof signal.addEventListener;
			signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
				if (type === "abort") live -= 1;
				return (remove as (...args: unknown[]) => void)(type, ...rest);
			}) as typeof signal.removeEventListener;
			return { signal, live: () => live };
		}

		it("removes the abort listener on every normal settle (no accumulation)", async () => {
			const { conn, ws } = connect();
			const controller = new AbortController();
			const { signal, live } = countingSignal(controller.signal);
			// Many commands sharing ONE signal across a long turn.
			const sends: Promise<unknown>[] = [];
			for (let i = 0; i < 8; i++) sends.push(conn.send(`Cmd.${i}`, {}, { signal }));
			ws.emit("open", {});
			await flush();
			// Reply to each distinct command id (reply() only targets the last send).
			for (const raw of ws.sent) {
				const { id } = JSON.parse(raw);
				ws.emit("message", { data: JSON.stringify({ id, result: { ok: id } }) });
			}
			await Promise.all(sends);
			// All resolved → both the connect-race and command listeners detached.
			expect(live()).toBe(0);
			expect(controller.signal.aborted).toBe(false);
		});

		it("removes the abort listener when a command rejects via CDP error", async () => {
			const { conn, ws } = connect();
			const controller = new AbortController();
			const { signal, live } = countingSignal(controller.signal);
			const p = conn.send("Bad.method", {}, { signal });
			ws.emit("open", {});
			await flush();
			ws.reply(undefined, { message: "boom" });
			await expect(p).rejects.toThrow(/boom/);
			expect(live()).toBe(0);
		});

		it("still rejects on real abort and leaves no listener behind", async () => {
			const { conn, ws } = connect();
			const controller = new AbortController();
			const { signal, live } = countingSignal(controller.signal);
			const p = conn.send("Slow.op", {}, { signal });
			ws.emit("open", {});
			await flush();
			controller.abort();
			await expect(p).rejects.toThrow(/aborted/);
			// once:true detaches on fire; the settle cleanup's remove is a no-op here,
			// and net listeners are back to zero.
			expect(live()).toBe(0);
		});
	});

	describe("connect resilience", () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it("times out the connect when the upgrade never completes", async () => {
			vi.useFakeTimers();
			// A half-dead port: ws never emits open/error/close. ensureOpen must
			// hit its connect ceiling and reject instead of hanging forever.
			const { conn } = connect({ connectTimeoutMs: 100 });
			const p = conn.send("Page.enable");
			const assertion = expect(p).rejects.toThrow(/connect to ws:\/\/x timed out/);
			await vi.advanceTimersByTimeAsync(100);
			await assertion;
			// Connect failure marks the connection closed so later sends fail fast.
			expect(conn.isClosed()).toBe(true);
		});

		it("aborts during connect and leaves no listener on the signal", async () => {
			const { conn } = connect({ connectTimeoutMs: 60_000 });
			const controller = new AbortController();
			const removed: string[] = [];
			const origRemove = controller.signal.removeEventListener.bind(controller.signal);
			controller.signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
				removed.push(type);
				return (origRemove as (...args: unknown[]) => void)(type, ...rest);
			}) as typeof controller.signal.removeEventListener;
			// Socket is still mid-upgrade (no open emitted) when the caller aborts.
			const p = conn.send("Page.enable", {}, { signal: controller.signal });
			controller.abort();
			await expect(p).rejects.toThrow(/aborted/);
			// The abort path must detach its listener so the signal isn't leaked.
			expect(removed).toContain("abort");
		});

		it("leaves no connect timer pending on the happy path", async () => {
			vi.useFakeTimers();
			const { conn, ws } = connect({ connectTimeoutMs: 100 });
			const p = conn.send("Page.navigate", { url: "http://x" });
			ws.emit("open", {});
			// Drain the awaited ensureOpen so send() writes the command.
			await vi.advanceTimersByTimeAsync(0);
			const sent = JSON.parse(ws.sent[0]!);
			expect(sent.method).toBe("Page.navigate");
			ws.reply({ frameId: "f1" });
			await expect(p).resolves.toEqual({ frameId: "f1" });
			// The connect timer was cleared on open: advancing past it must not have
			// closed the connection (a leaked timer would flip closed via ws.close()).
			await vi.advanceTimersByTimeAsync(200);
			expect(conn.isClosed()).toBe(false);
		});
	});
});
