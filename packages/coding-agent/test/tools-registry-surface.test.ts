/**
 * Regression coverage for the registry/wiring findings in the tools-subsystem
 * review, sections 4.2 and 6.4:
 *  - createReadOnlyTools must honor coding gates like createCodingTools does
 *    (a closed chromeDevtools gate must not leak the chrome_devtools tools or
 *    preview into a read-only surface just because they are non-mutating).
 *  - preview/recall/reflect readOnly reclassification.
 *  - grep/find/ls join the SDK's createCodingTools output (registry gate
 *    aligned with the TUI's always-on core surface).
 *  - the SDK `code` gate requires a harness dispatcher to be wired.
 *  - web_search's `webSearch.defaultProvider` merge is honored by every
 *    builder, not just createCodingTools.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createAllToolDefinitions,
	createAllTools,
	createCodingTools,
	createReadOnlyTools,
	createTool,
} from "../src/core/tools/index.js";

const CWD = process.cwd();

describe("createReadOnlyTools honors coding gates", () => {
	it("omits chrome_devtools_*/preview when chromeDevtools is not enabled", () => {
		const names = createReadOnlyTools(CWD).map((t) => t.name);
		expect(names.some((n) => n.startsWith("chrome_devtools"))).toBe(false);
		expect(names).not.toContain("preview");
	});

	it("includes the readOnly chrome_devtools_* tools once chromeDevtools is enabled", () => {
		const names = createReadOnlyTools(CWD, { chromeDevtools: { enabled: true } }).map((t) => t.name);
		expect(names).toContain("chrome_devtools_list_pages");
		expect(names).toContain("chrome_devtools_screenshot");
	});

	it("never includes preview (a real side-effecting tool, not a read)", () => {
		const names = createReadOnlyTools(CWD, { chromeDevtools: { enabled: true } }).map((t) => t.name);
		expect(names).not.toContain("preview");
	});

	it("gates recall/reflect on hindsight.enabled now that they are read-only", () => {
		expect(createReadOnlyTools(CWD).map((t) => t.name)).not.toContain("recall");
		const withHindsight = createReadOnlyTools(CWD, { hindsight: { enabled: true } }).map((t) => t.name);
		expect(withHindsight).toContain("recall");
		expect(withHindsight).toContain("reflect");
	});

	it("still includes coding:false read-only tools unconditionally (unaffected by the gate check)", () => {
		const names = createReadOnlyTools(CWD).map((t) => t.name);
		expect(names).toContain("repo_map");
		expect(names).toContain("recall_tool_output");
		expect(names).toContain("recall_history");
	});
});

describe("createCodingTools: grep/find/ls aligned with the TUI core surface", () => {
	it("includes grep, find, and ls", () => {
		const names = createCodingTools(CWD).map((t) => t.name);
		expect(names).toContain("grep");
		expect(names).toContain("find");
		expect(names).toContain("ls");
	});

	it("leaves repo_map off the default coding surface (unchanged)", () => {
		const names = createCodingTools(CWD).map((t) => t.name);
		expect(names).not.toContain("repo_map");
	});
});

describe("createCodingTools: `code` gate requires a harness dispatcher", () => {
	it("omits `code` when no dispatcher is supplied (SDK build with no wiring)", () => {
		const names = createCodingTools(CWD).map((t) => t.name);
		expect(names).not.toContain("code");
	});

	it("includes `code` once a dispatcher is supplied", () => {
		const names = createCodingTools(CWD, {
			code: { dispatcher: async () => ({ content: [], isError: false }) },
		}).map((t) => t.name);
		expect(names).toContain("code");
	});
});

describe("web_search defaultProvider merge is shared across every builder", () => {
	// Force the fast, network-free failure path in braveProvider.search
	// (missing-env-key throw) so the assertion is deterministic regardless of
	// whether the host environment happens to have real Brave credentials —
	// the point under test is option merging, not a live search result.
	const savedKey = process.env.BRAVE_SEARCH_API_KEY;
	beforeEach(() => {
		delete process.env.BRAVE_SEARCH_API_KEY;
	});
	afterEach(() => {
		if (savedKey !== undefined) process.env.BRAVE_SEARCH_API_KEY = savedKey;
	});

	it("createTool honors options.webSearch.defaultProvider (previously createCodingTools-only)", async () => {
		const tool = createTool("web_search", CWD, { webSearch: { defaultProvider: "brave" } });
		const res = (await tool.execute("t", { query: "test query" }, undefined, undefined, undefined as never)) as {
			details?: { provider?: string };
		};
		expect(res.details?.provider).toBe("brave");
	});

	it("createAllTools honors options.webSearch.defaultProvider too", async () => {
		const tools = createAllTools(CWD, { webSearch: { defaultProvider: "brave" } });
		const res = (await tools.web_search.execute(
			"t",
			{ query: "test query" },
			undefined,
			undefined,
			undefined as never,
		)) as { details?: { provider?: string } };
		expect(res.details?.provider).toBe("brave");
	});
});

describe("createAllToolDefinitions skips gated-off optional families", () => {
	it("omits chrome_devtools_*/preview when chromeDevtools is not enabled", () => {
		const names = Object.keys(createAllToolDefinitions(CWD, { chromeDevtools: { enabled: false } }));
		expect(names.some((n) => n.startsWith("chrome_devtools"))).toBe(false);
		expect(names).not.toContain("preview");
	});

	it("includes chrome tools once chromeDevtools is enabled", () => {
		const names = Object.keys(createAllToolDefinitions(CWD, { chromeDevtools: { enabled: true } }));
		expect(names).toContain("chrome_devtools_list_pages");
		expect(names).toContain("preview");
	});

	it("omits lsp/debug when their gates are closed", () => {
		const names = Object.keys(
			createAllToolDefinitions(CWD, {
				lsp: { enabled: false },
				debug: { enabled: false },
			}),
		);
		expect(names).not.toContain("lsp");
		expect(names).not.toContain("debug");
	});
});
