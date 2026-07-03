import { afterEach, describe, expect, it, vi } from "vitest";
import type { CdpTarget } from "../src/core/chrome/cdp-client.js";
import type { CdpConnectionLike } from "../src/core/chrome/chrome-devtools-manager.js";
import { ChromeDevtoolsManager, setCurrentChromeDevtoolsManager } from "../src/core/chrome/chrome-devtools-manager.js";
import {
	createChromeEvaluateDefinition,
	createChromeGetNetworkBodyDefinition,
	createChromeGetTextDefinition,
	createChromeListPagesDefinition,
	createChromeReadConsoleDefinition,
	createChromeWaitForDefinition,
} from "../src/core/tools/chrome-devtools.js";
import { TOOL_OUTPUT_HARD_CAP_BYTES } from "../src/core/tools/truncate.js";
import { createWebSearchToolDefinition } from "../src/core/tools/web-search.js";
import type { SearchProvider } from "../src/core/web-search/index.js";

afterEach(() => setCurrentChromeDevtoolsManager(undefined));

// ToolDefinition.execute takes (toolCallId, params, signal, onUpdate, ctx).
function runExec(def: { execute: (...args: any[]) => any }, input: unknown) {
	return def.execute("call", input, undefined, undefined, undefined);
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("");
}

/** Manager with a fully mocked CDP layer; overrides replace individual methods. */
function mockManager(over?: Partial<Record<string, any>>) {
	const mgr = new ChromeDevtoolsManager({
		host: "h",
		port: 9222,
		list: async () => [],
		create: async () => ({}) as any,
	});
	return Object.assign(mgr, over) as ChromeDevtoolsManager;
}

// --- 6.5 isError: every fail() path must flag the result -------------------

describe("chrome_devtools fail() paths set isError (6.5)", () => {
	it("flags the no-manager failure", async () => {
		setCurrentChromeDevtoolsManager(undefined);
		const res = await runExec(createChromeListPagesDefinition(), {});
		expect(res.isError).toBe(true);
		// details.ok is kept for logging, but the pipeline keys off isError.
		expect(res.details.ok).toBe(false);
		expect(text(res)).toMatch(/unavailable/i);
	});

	it("flags a thrown manager error", async () => {
		setCurrentChromeDevtoolsManager(
			mockManager({ evaluate: vi.fn().mockRejectedValue(new Error("No page selected.")) }),
		);
		const res = await runExec(createChromeEvaluateDefinition(), { expression: "1" });
		expect(res.isError).toBe(true);
		expect(text(res)).toContain("No page selected");
	});

	it("flags a wait_for timeout", async () => {
		setCurrentChromeDevtoolsManager(
			mockManager({ waitFor: vi.fn().mockResolvedValue({ found: false, elapsedMs: 5000 }) }),
		);
		const res = await runExec(createChromeWaitForDefinition(), { selector: "#nope" });
		expect(res.isError).toBe(true);
		expect(text(res)).toMatch(/Timed out/);
	});

	it("does NOT flag a successful result", async () => {
		setCurrentChromeDevtoolsManager(mockManager({ listPages: vi.fn().mockResolvedValue([]) }));
		const res = await runExec(createChromeListPagesDefinition(), {});
		expect(res.isError).toBeFalsy();
		expect(res.details.ok).toBe(true);
	});
});

// --- 6.3 read_console.level: case-insensitive normalization ----------------

describe("chrome_devtools_read_console level filtering (6.3)", () => {
	it("lowercases the level before handing it to the manager", async () => {
		const readConsole = vi.fn().mockReturnValue([{ level: "error", text: "boom" }]);
		setCurrentChromeDevtoolsManager(mockManager({ readConsole }));
		const res = await runExec(createChromeReadConsoleDefinition(), { level: "ERROR" });
		// The manager compares with a strict `===`, so an un-normalized "ERROR"
		// would silently return zero lines. The tool must pass "error".
		expect(readConsole).toHaveBeenCalledWith({ limit: undefined, level: "error" });
		expect(text(res)).toContain("[error] boom");
	});

	it("passes an absent level through untouched", async () => {
		const readConsole = vi.fn().mockReturnValue([]);
		setCurrentChromeDevtoolsManager(mockManager({ readConsole }));
		await runExec(createChromeReadConsoleDefinition(), {});
		expect(readConsole).toHaveBeenCalledWith({ limit: undefined, level: undefined });
	});

	it("matches a mixed-case filter against the real manager buffer end-to-end", async () => {
		const { mgr, conn } = setupRealManager();
		await mgr.selectPage("p1");
		setCurrentChromeDevtoolsManager(mgr);
		// consoleAPICalled stores level = p.type verbatim (CDP emits lowercase).
		conn.emit("Runtime.consoleAPICalled", { type: "error", args: [{ value: "boom" }] });
		conn.emit("Runtime.consoleAPICalled", { type: "warning", args: [{ value: "meh" }] });

		const res = await runExec(createChromeReadConsoleDefinition(), { level: "ERROR" });
		expect(text(res)).toContain("[error] boom");
		expect(text(res)).not.toContain("meh");
	});
});

// --- 6.2 limit schema clamped to the real effective cap --------------------

describe("chrome_devtools text limit is clamped to the real cap (6.2)", () => {
	it("advertises the 64KB tool-output ceiling, not a fictional 1M", () => {
		for (const def of [createChromeGetTextDefinition(), createChromeGetNetworkBodyDefinition()]) {
			const limit = (def.parameters as any).properties.limit;
			expect(limit.minimum).toBe(1);
			expect(limit.maximum).toBe(TOOL_OUTPUT_HARD_CAP_BYTES);
			expect(limit.maximum).toBeLessThan(1_000_000);
		}
	});

	it("clamps an over-cap limit at runtime so the output stays bounded", async () => {
		const huge = "x".repeat(200_000);
		setCurrentChromeDevtoolsManager(mockManager({ getPageText: vi.fn().mockResolvedValue(huge) }));
		const res = await runExec(createChromeGetTextDefinition(), { limit: 1_000_000 });
		const out = text(res);
		expect(out.length).toBeLessThanOrEqual(TOOL_OUTPUT_HARD_CAP_BYTES + 200);
		expect(out).toMatch(/truncated/);
	});
});

// --- 6.5 isError: web_search error returns ---------------------------------

describe("web_search error returns set isError (6.5)", () => {
	it("flags an empty query", async () => {
		const def = createWebSearchToolDefinition("/cwd");
		const res = await runExec(def, { query: "   " });
		expect(res.isError).toBe(true);
		expect(text(res)).toContain("empty query");
	});

	it("flags an unknown provider", async () => {
		const def = createWebSearchToolDefinition("/cwd");
		const res = await runExec(def, { query: "hi", provider: "bogus" });
		expect(res.isError).toBe(true);
		expect(text(res)).toMatch(/unknown provider/);
	});

	it("flags a missing provider configuration", async () => {
		const def = createWebSearchToolDefinition("/cwd", { providers: [] });
		const res = await runExec(def, { query: "hi" });
		expect(res.isError).toBe(true);
		expect(text(res)).toMatch(/no providers configured/);
	});

	it("does NOT flag a successful search", async () => {
		const fake: SearchProvider = {
			name: "fake",
			envKey: "FAKE",
			search: async () => [{ title: "Example", url: "https://example.com", snippet: "s" }],
		};
		const def = createWebSearchToolDefinition("/cwd", { providers: [fake], defaultProvider: "auto" });
		const res = await runExec(def, { query: "hi" });
		expect(res.isError).toBeFalsy();
		expect(text(res)).toContain("example.com");
	});
});

// --- helpers ---------------------------------------------------------------

class FakeConn implements CdpConnectionLike {
	closed = false;
	private handlers = new Map<string, Array<(p: any) => void>>();
	isClosed(): boolean {
		return this.closed;
	}
	send(_method: string, _params?: Record<string, unknown>): Promise<any> {
		return Promise.resolve({});
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

function setupRealManager() {
	const conn = new FakeConn();
	const targets: CdpTarget[] = [
		{ id: "p1", type: "page", title: "A", url: "http://a", webSocketDebuggerUrl: "ws://p1" },
	];
	const mgr = new ChromeDevtoolsManager({
		host: "h",
		port: 9222,
		list: async () => targets,
		create: async () => targets[0],
		connect: () => conn,
	});
	return { mgr, conn };
}
