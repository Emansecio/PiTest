import { afterEach, describe, expect, it, vi } from "vitest";
import { highlight, renderHighlightedHtml, supportsLanguage } from "../src/utils/syntax-highlight.js";

type SyntaxHighlightModule = typeof import("../src/utils/syntax-highlight.js");

/** Fresh module registry copy so each test starts with hljs unloaded. */
async function importFreshModule(): Promise<SyntaxHighlightModule> {
	vi.resetModules();
	return import("../src/utils/syntax-highlight.js");
}

describe("syntax highlight renderer", () => {
	it("renders highlighted spans with the provided theme", () => {
		const rendered = renderHighlightedHtml('<span class="hljs-keyword">const</span> value', {
			keyword: (text) => `[keyword:${text}]`,
		});
		expect(rendered).toBe("[keyword:const] value");
	});

	it("decodes HTML entities emitted by highlight.js", () => {
		const rendered = renderHighlightedHtml("&lt;tag attr=&quot;value&quot;&gt;&amp;#x41;&#65;&lt;/tag&gt;");
		expect(rendered).toBe('<tag attr="value">&#x41;A</tag>');
	});

	it("inherits parent formatting for unmapped nested scopes", () => {
		const interpolation = "$" + "{x}";
		const rendered = renderHighlightedHtml(
			`<span class="hljs-string">a<span class="hljs-subst">${interpolation}</span>b</span>`,
			{
				string: (text) => `[string:${text}]`,
			},
		);
		expect(rendered).toBe(`[string:a][string:${interpolation}][string:b]`);
	});

	it("keeps parent formatting across unscoped nested spans", () => {
		const rendered = renderHighlightedHtml('<span class="hljs-string">a<span class="language-xml">b</span>c</span>', {
			string: (text) => `[string:${text}]`,
		});
		expect(rendered).toBe("[string:a][string:b][string:c]");
	});

	it("highlights code through highlight.js", () => {
		expect(supportsLanguage("typescript")).toBe(true);
		const rendered = highlight("const value = 1", {
			language: "typescript",
			ignoreIllegals: true,
			theme: {
				keyword: (text) => `[keyword:${text}]`,
				number: (text) => `[number:${text}]`,
			},
		});
		expect(rendered).toContain("[keyword:const]");
		expect(rendered).toContain("[number:1]");
	});
});

describe("prewarmHljs", () => {
	afterEach(() => {
		delete process.env.PIT_NO_HLJS_PREWARM;
	});

	it("loads highlight.js ahead of the first highlight call", async () => {
		const mod = await importFreshModule();
		expect(mod.isHljsLoaded()).toBe(false);
		mod.prewarmHljs();
		expect(mod.isHljsLoaded()).toBe(true);
	});

	it("is idempotent and keeps the lazy path working", async () => {
		const mod = await importFreshModule();
		mod.prewarmHljs();
		mod.prewarmHljs();
		expect(mod.isHljsLoaded()).toBe(true);
		const rendered = mod.highlight("const value = 1", {
			language: "typescript",
			theme: { keyword: (text) => `[keyword:${text}]` },
		});
		expect(rendered).toContain("[keyword:const]");
	});

	it("skips the prewarm when PIT_NO_HLJS_PREWARM is set", async () => {
		process.env.PIT_NO_HLJS_PREWARM = "1";
		const mod = await importFreshModule();
		mod.prewarmHljs();
		expect(mod.isHljsLoaded()).toBe(false);
		// The on-demand path stays intact even with the prewarm disabled.
		expect(mod.supportsLanguage("typescript")).toBe(true);
		expect(mod.isHljsLoaded()).toBe(true);
	});
});
