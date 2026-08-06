/**
 * Browser routing is append-only on purpose: `setActiveTools` rewrites the
 * `Available tools:` section inside the CACHED system-prompt prefix, so removing a
 * tool on a later turn invalidates the whole prefix. These tests pin both halves of
 * the contract: the surface only grows, and the ambiguous vocabulary of a normal
 * code session ("url", "console", …) does not flip it.
 */

import { describe, expect, it } from "vitest";
import {
	createBrowserToolRoutingExtension,
	hasBrowserIntent,
	routeBrowserTools,
} from "../src/core/built-ins/browser-tool-routing-extension.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

const AVAILABLE = [
	"read",
	"bash",
	"chrome_devtools_list_pages",
	"chrome_devtools_select_page",
	"chrome_devtools_navigate",
	"chrome_devtools_screenshot",
	"chrome_devtools_snapshot",
	"chrome_devtools_get_text",
	"chrome_devtools_click",
	"chrome_devtools_fill",
	"chrome_devtools_evaluate",
	"chrome_devtools_read_console",
	"chrome_devtools_read_network",
	"preview",
];

type Handler = (event: any) => any;

function makeFakePi(active: string[]) {
	const handlers: Handler[] = [];
	const writes: string[][] = [];
	let current = [...active];
	const api = {
		on(event: string, handler: Handler) {
			if (event === "before_agent_start") handlers.push(handler);
		},
		getActiveTools: () => [...current],
		getAllTools: () => AVAILABLE.map((name) => ({ name })),
		setActiveTools(names: string[]) {
			current = [...names];
			writes.push([...names]);
		},
	} as unknown as ExtensionAPI;
	const turn = (prompt: string): any => {
		let result: any;
		for (const handler of handlers) {
			const r = handler({ type: "before_agent_start", prompt, systemPrompt: "BASE" });
			if (r !== undefined && result === undefined) result = r;
		}
		return result;
	};
	return { api, turn, writes, getActive: () => [...current] };
}

describe("browser intent detection", () => {
	it("ignores ambiguous words that are everyday code-session vocabulary", () => {
		expect(hasBrowserIntent("fix the URL parsing in the config loader")).toBe(false);
		expect(hasBrowserIntent("the console output of the test runner is noisy")).toBe(false);
		expect(hasBrowserIntent("retry the network request in the fetch helper")).toBe(false);
		expect(hasBrowserIntent("rename this DOM-ish selector variable")).toBe(false);
		expect(hasBrowserIntent("deploy the static site to the CDN")).toBe(false);
	});

	it("keeps the strong signals as solo triggers", () => {
		for (const prompt of [
			"open chrome and look",
			"inspect it in the browser",
			"use devtools for this",
			"the webpage looks broken",
			"take a screenshot",
			"compare the rendered output",
		]) {
			expect(hasBrowserIntent(prompt)).toBe(true);
		}
	});

	it("counts ambiguous words when a navigation signal is present", () => {
		expect(hasBrowserIntent("open the page at localhost:3000 and check the console")).toBe(true);
		expect(hasBrowserIntent("load https://example.com and read the network log")).toBe(true);
	});
});

describe("routeBrowserTools", () => {
	it("does not activate on an isolated URL mention", () => {
		const current = ["read", "bash"];
		expect(routeBrowserTools("fix the URL parsing in the config loader", AVAILABLE, current)).toEqual(current);
	});

	it("activates navigation plus diagnostics for a page + console prompt", () => {
		const next = routeBrowserTools("open the page at localhost:3000 and check the console", AVAILABLE, [
			"read",
			"bash",
		]);
		expect(next).toContain("chrome_devtools_navigate");
		expect(next).toContain("chrome_devtools_list_pages");
		expect(next).toContain("chrome_devtools_read_console");
		expect(next).toContain("chrome_devtools_evaluate");
		expect(next).not.toContain("chrome_devtools_fill");
		expect(next.slice(0, 2)).toEqual(["read", "bash"]);
	});

	it("never removes an already-activated tool (append-only)", () => {
		const activated = routeBrowserTools("take a screenshot of the browser", AVAILABLE, ["read", "bash"]);
		expect(activated).toContain("chrome_devtools_screenshot");

		const nextTurn = routeBrowserTools("now refactor the URL parser in utils.ts", AVAILABLE, activated);
		expect(nextTurn).toEqual(activated);

		const thirdTurn = routeBrowserTools("run the tests", AVAILABLE, nextTurn);
		expect(thirdTurn).toEqual(activated);
	});
});

describe("browser routing extension", () => {
	it("appends the turn note only on turns that matched browser intent", () => {
		const pi = makeFakePi(["read", "bash"]);
		createBrowserToolRoutingExtension()(pi.api);

		const first = pi.turn("take a screenshot of the rendered page");
		expect(first?.systemPrompt).toContain("Browser tools are enabled for this turn");
		expect(pi.getActive()).toContain("chrome_devtools_screenshot");

		// Tools stay active, but the note is per-turn and must not repeat.
		const second = pi.turn("now refactor the URL parser in utils.ts");
		expect(second).toBeUndefined();
		expect(pi.getActive()).toContain("chrome_devtools_screenshot");
		expect(pi.writes).toHaveLength(1);
	});

	it("leaves the surface untouched on a turn without browser intent", () => {
		const pi = makeFakePi(["read", "bash"]);
		createBrowserToolRoutingExtension()(pi.api);

		expect(pi.turn("fix the URL parsing in the config loader")).toBeUndefined();
		expect(pi.writes).toHaveLength(0);
		expect(pi.getActive()).toEqual(["read", "bash"]);
	});

	it("strips the chrome family once when the feature is disabled, then stops writing", () => {
		const pi = makeFakePi(["read", "bash", "chrome_devtools_navigate", "preview"]);
		createBrowserToolRoutingExtension({ isEnabled: () => false })(pi.api);

		pi.turn("open the browser and take a screenshot");
		expect(pi.getActive()).toEqual(["read", "bash"]);
		expect(pi.writes).toHaveLength(1);

		pi.turn("open the browser and take a screenshot");
		pi.turn("summarize this function");
		expect(pi.writes).toHaveLength(1);
		expect(pi.getActive()).toEqual(["read", "bash"]);
	});
});
