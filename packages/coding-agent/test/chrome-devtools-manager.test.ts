import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CdpTarget } from "../src/core/chrome/cdp-client.js";
import { type CdpConnectionLike, ChromeDevtoolsManager } from "../src/core/chrome/chrome-devtools-manager.js";

class FakeConn implements CdpConnectionLike {
	sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
	responses: Record<string, unknown> = {};
	closed = false;
	isClosed(): boolean {
		return this.closed;
	}
	private handlers = new Map<string, Array<(p: any) => void>>();
	send(method: string, params?: Record<string, unknown>): Promise<any> {
		this.sent.push({ method, params });
		const res = this.responses[method];
		if (res instanceof Error) return Promise.reject(res);
		return Promise.resolve(res ?? {});
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
	const closed: string[] = [];
	const close = vi.fn(async (id: string) => {
		closed.push(id);
		const idx = targets.findIndex((t) => t.id === id);
		if (idx >= 0) targets.splice(idx, 1);
	});
	const mgr = new ChromeDevtoolsManager({
		host: "h",
		port: 9222,
		list: async () => targets,
		create: async (url) => {
			const t: CdpTarget = { id: "new1", type: "page", title: "New", url, webSocketDebuggerUrl: "ws://new1" };
			targets.push(t);
			return t;
		},
		close,
		connect: (t) => {
			let c = conns.get(t.id);
			if (!c) {
				c = new FakeConn();
				conns.set(t.id, c);
			}
			return c;
		},
	});
	return { mgr, conns, targets, close, closed };
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

	it("navigate without newTab reports the new URL, not the stale selected-target URL", async () => {
		const { mgr } = setup();
		await mgr.selectPage("p1"); // target url is http://a at selection time
		const res = await mgr.navigate({ url: "http://b" });
		expect(res.target.url).toBe("http://b");
	});

	it("evaluate prefers exception.description over the generic text", async () => {
		const c = new FakeConn();
		c.responses["Runtime.evaluate"] = {
			exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom\n    at <anonymous>:1:7" } },
		};
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		expect((await mgr.evaluate("throw new Error('boom')")).error).toContain("Error: boom");
	});

	it("reconnects when the cached CDP connection is closed (dead socket auto-recovery)", async () => {
		const { mgr, conns, targets } = setup();
		await mgr.selectPage("p1");
		const first = conns.get("p1")!;
		// Simulate the WS dropping (tab closed / Chrome restarted with same id).
		first.closed = true;
		// Force the factory to hand out a NEW conn for p1 on the next connect.
		conns.delete("p1");
		const res = await mgr.evaluate("1");
		expect(res.error).toBeUndefined();
		const second = conns.get("p1")!;
		expect(second).not.toBe(first);
		// Fresh connection re-enabled its domains.
		expect(second.sent.map((s) => s.method)).toContain("Runtime.enable");
		expect(targets.find((t) => t.id === "p1")).toBeDefined();
	});

	it("click resolves the element center and dispatches press/release", async () => {
		const c = new FakeConn();
		c.responses["Runtime.evaluate"] = { result: { value: { x: 10, y: 20 } } };
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		await mgr.click("#btn");
		const mouse = c.sent.filter((s) => s.method === "Input.dispatchMouseEvent");
		expect(mouse.map((s) => s.params?.type)).toEqual(["mousePressed", "mouseReleased"]);
		expect(mouse[0]?.params).toMatchObject({ x: 10, y: 20, button: "left", clickCount: 1 });
	});

	it("click throws a clear error when the selector matches nothing", async () => {
		const c = new FakeConn();
		c.responses["Runtime.evaluate"] = { result: { value: null } };
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		await expect(mgr.click("#missing")).rejects.toThrow(/No element matches/);
		expect(c.sent.some((s) => s.method === "Input.dispatchMouseEvent")).toBe(false);
	});

	it("fill focuses the element and inserts the text", async () => {
		const c = new FakeConn();
		c.responses["Runtime.evaluate"] = { result: { value: true } };
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		await mgr.fill("#q", "hello");
		const insert = c.sent.find((s) => s.method === "Input.insertText");
		expect(insert?.params).toEqual({ text: "hello" });
	});

	it("pressKey dispatches keyDown/keyUp for named keys and rejects unknown ones", async () => {
		const c = new FakeConn();
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		await mgr.pressKey("Enter");
		const keys = c.sent.filter((s) => s.method === "Input.dispatchKeyEvent");
		expect(keys.map((s) => s.params?.type)).toEqual(["keyDown", "keyUp"]);
		expect(keys[0]?.params).toMatchObject({ key: "Enter", windowsVirtualKeyCode: 13 });
		await expect(mgr.pressKey("NotAKey")).rejects.toThrow(/Unsupported key/);
	});

	it("getPageText returns the body innerText", async () => {
		const c = new FakeConn();
		c.responses["Runtime.evaluate"] = { result: { value: "Hello world" } };
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		expect(await mgr.getPageText()).toBe("Hello world");
	});

	it("waitFor returns found immediately when the condition holds and times out otherwise", async () => {
		const c = new FakeConn();
		c.responses["Runtime.evaluate"] = { result: { value: true } };
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		expect((await mgr.waitFor({ selector: "#ready" })).found).toBe(true);

		c.responses["Runtime.evaluate"] = { result: { value: false } };
		const r = await mgr.waitFor({ text: "never", timeoutMs: 1 });
		expect(r.found).toBe(false);
		await expect(mgr.waitFor({})).rejects.toThrow(/selector or text/);
	});

	it("hover dispatches a mouse move at the element center", async () => {
		const c = new FakeConn();
		c.responses["Runtime.evaluate"] = { result: { value: { x: 5, y: 6 } } };
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		await mgr.hover("#menu");
		const move = c.sent.find((s) => s.method === "Input.dispatchMouseEvent");
		expect(move?.params).toMatchObject({ type: "mouseMoved", x: 5, y: 6 });
	});

	it("selectOption returns the selection and surfaces available values on miss", async () => {
		const c = new FakeConn();
		c.responses["Runtime.evaluate"] = { result: { value: { value: "b", label: "Bravo" } } };
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		expect(await mgr.selectOption("#sel", "Bravo")).toEqual({ value: "b", label: "Bravo" });

		c.responses["Runtime.evaluate"] = { result: { value: { error: "no-option", options: ["a", "b"] } } };
		await expect(mgr.selectOption("#sel", "zz")).rejects.toThrow(/Available values: a, b/);
		c.responses["Runtime.evaluate"] = { result: { value: { error: "not-select" } } };
		await expect(mgr.selectOption("#div", "a")).rejects.toThrow(/not a <select>/);
	});

	it("uploadFile resolves the node and sets the input files", async () => {
		const c = new FakeConn();
		c.responses["DOM.getDocument"] = { root: { nodeId: 1 } };
		c.responses["DOM.querySelector"] = { nodeId: 42 };
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		const real = path.resolve(__dirname, "chrome-devtools-manager.test.ts");
		await mgr.uploadFile("#file", [real]);
		const set = c.sent.find((s) => s.method === "DOM.setFileInputFiles");
		expect(set?.params).toEqual({ files: [real], nodeId: 42 });
		await expect(mgr.uploadFile("#file", ["Z:/nope/missing.bin"])).rejects.toThrow(/File not found/);
	});

	it("a11ySnapshot renders roles and names indented, flattening unnamed generics", async () => {
		const c = new FakeConn();
		c.responses["Accessibility.getFullAXTree"] = {
			nodes: [
				{ nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Home" }, childIds: ["2"] },
				{ nodeId: "2", parentId: "1", role: { value: "generic" }, childIds: ["3", "4"] },
				{ nodeId: "3", parentId: "2", role: { value: "button" }, name: { value: "Go" } },
				{ nodeId: "4", parentId: "2", role: { value: "textbox" }, name: { value: "q" }, value: { value: "abc" } },
			],
		};
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		const snap = await mgr.a11ySnapshot();
		expect(snap.split("\n")).toEqual(['RootWebArea "Home"', '  button "Go"', '  textbox "q" = "abc"']);
	});

	it("a11ySnapshot with selector scopes to that element's subtree", async () => {
		const c = new FakeConn();
		c.responses["DOM.getDocument"] = { root: { nodeId: 1 } };
		c.responses["DOM.querySelector"] = { nodeId: 7 };
		c.responses["DOM.describeNode"] = { node: { backendNodeId: 77 } };
		c.responses["Accessibility.getFullAXTree"] = {
			nodes: [
				{ nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Home" }, childIds: ["2", "3"] },
				{ nodeId: "2", parentId: "1", role: { value: "navigation" }, name: { value: "nav" } },
				{ nodeId: "3", parentId: "1", role: { value: "form" }, backendDOMNodeId: 77, childIds: ["4"] },
				{ nodeId: "4", parentId: "3", role: { value: "button" }, name: { value: "Send" } },
			],
		};
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		const snap = await mgr.a11ySnapshot("form");
		// Ancestors render as a breadcrumb so the region's location stays visible.
		expect(snap.split("\n")).toEqual(['RootWebArea "Home"', "  form", '    button "Send"']);
		expect(snap).not.toContain("navigation");

		c.responses["DOM.describeNode"] = { node: { backendNodeId: 999 } };
		await expect(mgr.a11ySnapshot("#hidden")).rejects.toThrow(/no accessibility node/);
	});

	it("getResponseBody returns the body and base64 flag", async () => {
		const c = new FakeConn();
		c.responses["Network.getResponseBody"] = { body: '{"ok":true}', base64Encoded: false };
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		expect(await mgr.getResponseBody("r1")).toEqual({ body: '{"ok":true}', base64Encoded: false });
	});

	it("getResponseBody truncates a body larger than the cap (no full-blob retention)", async () => {
		const cap = 10 * 1024 * 1024;
		const huge = "x".repeat(cap + 5000);
		const c = new FakeConn();
		c.responses["Network.getResponseBody"] = { body: huge, base64Encoded: false };
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		const r = await mgr.getResponseBody("r1");
		// Capped to cap + marker, never the full giant string.
		expect(r.body.length).toBeLessThan(huge.length);
		expect(r.body.startsWith("x".repeat(cap))).toBe(true);
		expect(r.body).toContain(`[corpo truncado: ${cap} de ${huge.length} bytes]`);
	});

	it("evaluate truncates an oversized string result", async () => {
		const cap = 10 * 1024 * 1024;
		const huge = "y".repeat(cap + 5000);
		const c = new FakeConn();
		c.responses["Runtime.evaluate"] = { result: { value: huge } };
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		const r = await mgr.evaluate("bigString()");
		const value = r.value as string;
		expect(value.length).toBeLessThan(huge.length);
		expect(value).toContain(`[corpo truncado: ${cap} de ${huge.length} bytes]`);
	});

	it("evaluate leaves a normal result untouched", async () => {
		const c = new FakeConn();
		c.responses["Runtime.evaluate"] = { result: { value: { a: 1, b: "ok" } } };
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		expect(await mgr.evaluate("obj()")).toEqual({ value: { a: 1, b: "ok" }, description: undefined });
	});

	it("closePage closes the selected page, evicts its connection and deselects", async () => {
		const { mgr, conns, close, closed } = setup();
		await mgr.navigate({ url: "http://x", newTab: true });
		expect(mgr.selectedPageId()).toBe("new1");
		const conn = conns.get("new1")!;

		const res = await mgr.closePage();
		expect(res).toEqual({ closedId: "new1" });
		// closeTargetImpl was called for the right id...
		expect(close).toHaveBeenCalledWith("new1", undefined);
		expect(closed).toEqual(["new1"]);
		// ...the cached connection was torn down (evictConn -> close)...
		expect(conn.closed).toBe(true);
		// ...and the page is no longer selected, so the next navigate opens a new tab.
		expect(mgr.selectedPageId()).toBeUndefined();
		// listPages no longer shows the closed tab.
		expect((await mgr.listPages()).map((t) => t.id)).not.toContain("new1");
	});

	it("closePage with an explicit id keeps a different selected page selected", async () => {
		const { mgr, close } = setup();
		await mgr.selectPage("p1");
		const res = await mgr.closePage("bg");
		expect(res).toEqual({ closedId: "bg" });
		expect(close).toHaveBeenCalledWith("bg", undefined);
		// p1 was the selected page and was NOT the one closed -> stays selected.
		expect(mgr.selectedPageId()).toBe("p1");
	});

	it("closePage throws a clear error when there is nothing to close", async () => {
		const { mgr } = setup();
		await expect(mgr.closePage()).rejects.toThrow(/No page to close/);
	});

	it("dispose closes all connections", async () => {
		const { mgr, conns } = setup();
		await mgr.selectPage("p1");
		mgr.dispose();
		expect(conns.get("p1")?.closed).toBe(true);
		expect(mgr.selectedPageId()).toBeUndefined();
	});
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ChromeDevtoolsManager network body cache", () => {
	async function fireRequest(
		c: FakeConn,
		opts: {
			requestId: string;
			url?: string;
			mimeType?: string;
			type?: string;
			body?: string;
			base64Encoded?: boolean;
		},
	) {
		c.emit("Network.requestWillBeSent", {
			requestId: opts.requestId,
			request: { method: "GET", url: opts.url ?? "http://a/api" },
		});
		c.emit("Network.responseReceived", {
			requestId: opts.requestId,
			type: opts.type,
			response: { status: 200, mimeType: opts.mimeType ?? "application/json" },
		});
		c.responses["Network.getResponseBody"] = {
			body: opts.body ?? '{"ok":true}',
			base64Encoded: !!opts.base64Encoded,
		};
		c.emit("Network.loadingFinished", { requestId: opts.requestId });
		await flush();
	}

	it("caches a text body on loadingFinished and serves it without a live fetch", async () => {
		const c = new FakeConn();
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		await fireRequest(c, { requestId: "r1", body: '{"cached":1}' });
		// Live CDP would now return a different body; the cache must win.
		c.responses["Network.getResponseBody"] = { body: "LIVE-NOT-USED", base64Encoded: false };
		expect(await mgr.getResponseBody("r1")).toEqual({ body: '{"cached":1}', base64Encoded: false });
	});

	it("does not cache binary or script bodies (falls back to a live fetch)", async () => {
		const c = new FakeConn();
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		await fireRequest(c, { requestId: "img", mimeType: "image/png", body: "PNGDATA", base64Encoded: true });
		c.responses["Network.getResponseBody"] = { body: "LIVE-IMG", base64Encoded: true };
		expect(await mgr.getResponseBody("img")).toEqual({ body: "LIVE-IMG", base64Encoded: true });
	});

	it("surfaces a clear error when an uncached body was evicted", async () => {
		const c = new FakeConn();
		c.responses["Network.getResponseBody"] = new Error("No resource with given identifier found");
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		await expect(mgr.getResponseBody("gone")).rejects.toThrow(/Chrome may have evicted it/);
	});

	it("drops a cached body when its request is evicted from the ring buffer", async () => {
		const c = new FakeConn();
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		await fireRequest(c, { requestId: "old", body: '{"old":1}' });
		// Push past BUFFER_MAX (200) so "old" is shifted out of the ring.
		for (let i = 0; i < 201; i++) {
			c.emit("Network.requestWillBeSent", { requestId: `n${i}`, request: { method: "GET", url: "http://a/x" } });
		}
		c.responses["Network.getResponseBody"] = new Error("No resource with given identifier found");
		await expect(mgr.getResponseBody("old")).rejects.toThrow(/evicted/);
	});
});

describe("ChromeDevtoolsManager readNetwork filters", () => {
	function seed(c: FakeConn) {
		const rows = [
			{ id: "a", method: "GET", url: "http://a/api/users", type: "XHR", status: 200 },
			{ id: "b", method: "POST", url: "http://a/api/login", type: "Fetch", status: 401 },
			{ id: "c", method: "GET", url: "http://cdn/tracker.gif", type: "Image", status: 200 },
			{ id: "d", method: "GET", url: "http://a/api/missing", type: "Fetch", status: 404 },
		];
		for (const r of rows) {
			c.emit("Network.requestWillBeSent", {
				requestId: r.id,
				type: r.type,
				request: { method: r.method, url: r.url },
			});
			c.emit("Network.responseReceived", { requestId: r.id, type: r.type, response: { status: r.status } });
		}
	}

	it("filters by urlPattern, method, type and captures resourceType", async () => {
		const c = new FakeConn();
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		seed(c);
		expect(mgr.readNetwork({ urlPattern: "/api" }).map((e) => e.requestId)).toEqual(["a", "b", "d"]);
		expect(mgr.readNetwork({ method: "post" }).map((e) => e.requestId)).toEqual(["b"]);
		expect(mgr.readNetwork({ type: "fetch" }).map((e) => e.requestId)).toEqual(["b", "d"]);
		expect(mgr.readNetwork({})[0]?.resourceType).toBe("XHR");
	});

	it("filters by status (exact, class and comparison) and rejects a bad spec", async () => {
		const c = new FakeConn();
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		seed(c);
		expect(mgr.readNetwork({ status: 404 }).map((e) => e.requestId)).toEqual(["d"]);
		expect(mgr.readNetwork({ status: "4xx" }).map((e) => e.requestId)).toEqual(["b", "d"]);
		expect(mgr.readNetwork({ status: ">=400" }).map((e) => e.requestId)).toEqual(["b", "d"]);
		expect(mgr.readNetwork({ status: "<300" }).map((e) => e.requestId)).toEqual(["a", "c"]);
		expect(() => mgr.readNetwork({ status: "bogus" })).toThrow(/Invalid status filter/);
	});

	it("applies filters across the whole buffer before the limit", async () => {
		const c = new FakeConn();
		const { mgr } = setup({ preset: { p1: c } });
		await mgr.selectPage("p1");
		seed(c);
		expect(mgr.readNetwork({ type: "fetch", limit: 1 }).map((e) => e.requestId)).toEqual(["d"]);
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
