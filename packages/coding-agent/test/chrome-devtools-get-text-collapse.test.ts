/**
 * N2 (residual) — chrome_devtools_get_text collapses repeated consecutive lines
 * BEFORE the limit/cap. Pages whose useful signal is buried under a duplicated
 * chrome (nav/sidebar/footer rows, list boilerplate) spend their char budget on
 * content instead of repetition. Upgrade-only: text with no collapsible run is
 * byte-identical. The fuzzy `×N similar` collapse (masked numeric/hex tokens)
 * rides along for free.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeDevtoolsManager, setCurrentChromeDevtoolsManager } from "../src/core/chrome/chrome-devtools-manager.js";
import { createChromeGetTextDefinition } from "../src/core/tools/chrome-devtools.js";

afterEach(() => setCurrentChromeDevtoolsManager(undefined));

function runExec(def: { execute: (...args: any[]) => any }, input: unknown) {
	return def.execute("call", input, undefined, undefined, undefined);
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("");
}

function mockManager(over?: Partial<Record<string, any>>) {
	const mgr = new ChromeDevtoolsManager({
		host: "h",
		port: 9222,
		list: async () => [],
		create: async () => ({}) as any,
	});
	return Object.assign(mgr, over) as ChromeDevtoolsManager;
}

describe("chrome_devtools_get_text collapses repeated lines (N2)", () => {
	it("collapses a run of identical consecutive nav/boilerplate lines", async () => {
		const page = `Main Article Title\n${"Ad placeholder\n".repeat(6)}The real content paragraph.`;
		setCurrentChromeDevtoolsManager(mockManager({ getPageText: vi.fn().mockResolvedValue(page) }));

		const out = text(await runExec(createChromeGetTextDefinition(), {}));

		expect(out).toContain("Ad placeholder … (×6)");
		expect(out).toContain("Main Article Title");
		expect(out).toContain("The real content paragraph.");
		expect(out.length).toBeLessThan(page.length);
		// Only one surviving copy of the boilerplate line's leading text.
		expect(out.split("Ad placeholder").length - 1).toBe(1);
	});

	it("collapses fuzzy-similar lines (masked numeric tokens) with a ×N similar marker", async () => {
		const page = `Header\nLoading item 1 of 500\nLoading item 2 of 500\nLoading item 3 of 500\nLoading item 4 of 500\nLoading item 5 of 500\nFooter`;
		setCurrentChromeDevtoolsManager(mockManager({ getPageText: vi.fn().mockResolvedValue(page) }));

		const out = text(await runExec(createChromeGetTextDefinition(), {}));

		expect(out).toMatch(/×5 similar/);
		expect(out).toContain("Header");
		expect(out).toContain("Footer");
	});

	it("is byte-identical for page text with no repeated run (upgrade-only)", async () => {
		const page = "Alpha section\nBeta section\nGamma section\nDelta section";
		setCurrentChromeDevtoolsManager(mockManager({ getPageText: vi.fn().mockResolvedValue(page) }));

		const out = text(await runExec(createChromeGetTextDefinition(), {}));

		expect(out).toBe(page);
	});

	it("collapses BEFORE the limit so a boilerplate-heavy page avoids truncation", async () => {
		// 10k identical lines (~60KB) far exceed the 20k default limit; after collapse
		// the page is a few dozen chars and returns whole, with no truncation note.
		const page = `HEAD\n${"repeated spam line\n".repeat(10_000)}TAIL`;
		setCurrentChromeDevtoolsManager(mockManager({ getPageText: vi.fn().mockResolvedValue(page) }));

		const out = text(await runExec(createChromeGetTextDefinition(), {}));

		expect(out).toContain("repeated spam line … (×10000)");
		expect(out).toContain("HEAD");
		expect(out).toContain("TAIL");
		expect(out).not.toMatch(/truncated/);
	});
});
