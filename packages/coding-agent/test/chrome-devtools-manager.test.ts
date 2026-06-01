import { describe, expect, it, vi } from "vitest";
import type { CdpTarget } from "../src/core/chrome/cdp-client.js";
import { type CdpConnectionLike, ChromeDevtoolsManager } from "../src/core/chrome/chrome-devtools-manager.js";

class FakeConn implements CdpConnectionLike {
	sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
	responses: Record<string, unknown> = {};
	closed = false;
	private handlers = new Map<string, Array<(p: any) => void>>();
	send(method: string, params?: Record<string, unknown>): Promise<any> {
		this.sent.push({ method, params });
		return Promise.resolve(this.responses[method] ?? {});
	}
	on(event: string, handler: (p: any) => void): () => void {
		let arr = this.handlers.get(event);
		if (!arr) {
			arr = [];
			this.handlers.set(event, arr);
		}
		arr.push(handler);
		return () => {};
	}
	emit(event: string, params: unknown): void {
		for (const h of this.handlers.get(event) ?? []) h(params);
	}
	close(): void {
		this.closed = true;
	}
}

function setup(opts?: { preset?: Record<string, FakeConn> }) {
	const conns = new Map<string, FakeConn>(Object.entries(opts?.preset ?? {}));
	const targets: CdpTarget[] = [
		{ id: "p1", type: "page", title: "A", url: "http://a", webSocketDebuggerUrl: "ws://p1" },
		{ id: "bg", type: "background_page", title: "bg", url: "" },
	];
	const mgr = new ChromeDevtoolsManager({
		host: "h",
		port: 9222,
		list: async () => targets,
		create: async (url) => {
			const t: CdpTarget = { id: "new1", type: "page", title: "New", url, webSocketDebuggerUrl: "ws://new1" };
			targets.push(t);
			return t;
		},
		connect: (t) => {
			let c = conns.get(t.id);
			if (!c) {
				c = new FakeConn();
				conns.set(t.id, c);
			}
			return c;
		},
	});
	return { mgr, conns, targets };
}

describe("ChromeDevtoolsManager", () => {
	it("lists only page targets", async () => {
		const { mgr } = setup();
		const pages = await mgr.listPages();
		expect(pages.map((t) => t.id)).toEqual(["p1"]);
	});

	it("navigate with newTab creates a tab and selects it", async () => {
		const { mgr, conns } = setup();
		const res = await mgr.navigate({ url: "http://x", newTab: true });
		expect(res.created).toBe(true);
		expect(res.target.id).toBe("new1");
		expect(mgr.selectedPageId()).toBe("new1");
		expect(conns.get("new1")?.sent.map((s) => s.method)).toContain("Page.enable");
	});

	it("navigate without newTab navigates the selected page", async () => {
		const { mgr, conns } = setup();
		await mgr.selectPage("p1");
		const res = await mgr.navigate({ url: "http://b" });
		expect(res.created).toBe(false);
		const nav = conns.get("p1")?.sent.find((s) => s.method === "Page.navigate");
		expect(nav?.params).toEqual({ url: "http://b" });
	});

	it("evaluate returns the result value", async () => {
		const c = new FakeConn();
		c.responses["Runtime.evaluate"] = { result: { value: "Example" } };
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		expect(await mgr.evaluate("document.title")).toEqual({ value: "Example", description: undefined });
	});

	it("evaluate surfaces exceptions", async () => {
		const c = new FakeConn();
		c.responses["Runtime.evaluate"] = { exceptionDetails: { text: "ReferenceError: x is not defined" } };
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		expect((await mgr.evaluate("x")).error).toContain("ReferenceError");
	});

	it("screenshot returns base64 png data", async () => {
		const c = new FakeConn();
		c.responses["Page.captureScreenshot"] = { data: "iVBORw0KGgo=" };
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		expect(await mgr.screenshot({ fullPage: true })).toBe("iVBORw0KGgo=");
	});

	it("buffers console and network events", async () => {
		const { mgr, conns } = setup();
		await mgr.selectPage("p1");
		const c = conns.get("p1")!;
		c.emit("Runtime.consoleAPICalled", { type: "error", args: [{ value: "boom" }] });
		c.emit("Network.requestWillBeSent", { requestId: "r1", request: { method: "GET", url: "http://a/x" } });
		c.emit("Network.responseReceived", { requestId: "r1", response: { status: 200 } });

		expect(mgr.readConsole({}).map((l) => `${l.level}:${l.text}`)).toContain("error:boom");
		expect(mgr.readConsole({ level: "error" })).toHaveLength(1);
		const net = mgr.readNetwork({});
		expect(net[0]).toMatchObject({ method: "GET", url: "http://a/x", status: 200 });
	});

	it("requires a selected page for evaluate/console", async () => {
		const { mgr } = setup();
		await expect(mgr.evaluate("1")).rejects.toThrow(/No page selected/);
		expect(() => mgr.readConsole({})).toThrow(/No page selected/);
	});

	it("dispose closes all connections", async () => {
		const { mgr, conns } = setup();
		await mgr.selectPage("p1");
		mgr.dispose();
		expect(conns.get("p1")?.closed).toBe(true);
		expect(mgr.selectedPageId()).toBeUndefined();
	});
});

describe("ChromeDevtoolsManager.ensureBrowser", () => {
	it("reconnects without launching when Chrome is already up", async () => {
		const launch = vi.fn();
		const mgr = new ChromeDevtoolsManager({
			host: "h",
			port: 9222,
			launchBrowser: true,
			userDataDir: "/d",
			list: async () => [],
			launch,
			findBinary: () => "/bin/chrome",
			waitReady: async () => true,
		});
		const res = await mgr.ensureBrowser();
		expect(res.launched).toBe(false);
		expect(launch).not.toHaveBeenCalled();
	});

	it("launches Chrome when the port is unreachable", async () => {
		const launch = vi.fn();
		let up = false;
		const mgr = new ChromeDevtoolsManager({
			host: "h",
			port: 9222,
			launchBrowser: true,
			userDataDir: "/profile",
			list: async () => {
				if (!up) throw new Error("unreachable");
				return [];
			},
			launch: (o) => {
				up = true;
				launch(o);
			},
			findBinary: () => "/bin/chrome",
			waitReady: async () => true,
		});
		const res = await mgr.ensureBrowser();
		expect(res.launched).toBe(true);
		expect(launch).toHaveBeenCalledWith({ binary: "/bin/chrome", port: 9222, userDataDir: "/profile" });
		expect(mgr.wasLaunchedHere()).toBe(true);
	});

	it("errors with a hint when no Chrome binary is found", async () => {
		const mgr = new ChromeDevtoolsManager({
			host: "h",
			port: 9222,
			launchBrowser: true,
			userDataDir: "/d",
			list: async () => {
				throw new Error("unreachable");
			},
			findBinary: () => undefined,
		});
		await expect(mgr.ensureBrowser()).rejects.toThrow(/Chrome was not found/);
	});

	it("does not launch when launchBrowser is off (surfaces the unreachable error)", async () => {
		const launch = vi.fn();
		const mgr = new ChromeDevtoolsManager({
			host: "h",
			port: 9222,
			launchBrowser: false,
			list: async () => {
				throw new Error("Could not reach Chrome DevTools");
			},
			launch,
			findBinary: () => "/bin/chrome",
		});
		await expect(mgr.ensureBrowser()).rejects.toThrow(/Could not reach/);
		expect(launch).not.toHaveBeenCalled();
	});
});
