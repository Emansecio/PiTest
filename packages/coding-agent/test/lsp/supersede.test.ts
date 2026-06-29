import { describe, expect, it } from "vitest";
import { isLspSupersedeEligible, lspSupersededResourceKey } from "../../src/core/lsp/supersede.ts";

describe("lsp supersede fingerprints", () => {
	it("keys readonly navigation by action + file + line + symbol", () => {
		const key = lspSupersededResourceKey({
			action: "references",
			file: "src/a.ts",
			line: 10,
			symbol: "foo",
		});
		expect(key).toBe("lsp\u0000references\u0000src/a.ts\u000010\u0000foo");
		expect(isLspSupersedeEligible({ action: "references", file: "src/a.ts", line: 10, symbol: "foo" })).toBe(true);
	});

	it("keys workspace diagnostics by file pattern", () => {
		const key = lspSupersededResourceKey({ action: "diagnostics", file: "src/**/*.ts" });
		expect(key).toBe("lsp\u0000diagnostics\u0000src/**/*.ts");
	});

	it("distinguishes diagnostics by timeout when present", () => {
		const short = lspSupersededResourceKey({ action: "diagnostics", file: "a.ts", timeout: 5 });
		const long = lspSupersededResourceKey({ action: "diagnostics", file: "a.ts", timeout: 60 });
		expect(short).not.toBe(long);
		expect(short).toBe("lsp\u0000diagnostics\u0000a.ts\u00005");
		expect(long).toBe("lsp\u0000diagnostics\u0000a.ts\u000060");
	});

	it("does not supersede rename or applied code_actions", () => {
		expect(lspSupersededResourceKey({ action: "rename", file: "a.ts", line: 1, symbol: "x", new_name: "y" })).toBe(
			undefined,
		);
		expect(
			lspSupersededResourceKey({ action: "code_actions", file: "a.ts", line: 1, symbol: "x", apply: true }),
		).toBe(undefined);
		expect(lspSupersededResourceKey({ action: "request", query: "rust-analyzer/expandMacro" })).toBe(undefined);
	});
});
