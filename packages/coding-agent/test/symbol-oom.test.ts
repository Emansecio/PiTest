import { describe, expect, it } from "vitest";
import { createSymbolTool } from "../src/core/tools/symbol.js";

/**
 * The symbol tool buffers the whole file to regex for one declaration; a
 * multi-MB minified/generated source would OOM. It must refuse above the 10MB
 * cap with an actionable hint instead of reading — but stay byte-identical for
 * files below the cap.
 */
describe("symbol tool OOM guard", () => {
	it("extracts a symbol normally for files below the cap", async () => {
		let readFileCalled = false;
		const tool = createSymbolTool("/cwd", {
			operations: {
				access: async () => {},
				stat: async () => ({ size: 64 }),
				readFile: async () => {
					readFileCalled = true;
					return Buffer.from("export function target() {\n\treturn 1;\n}\n", "utf-8");
				},
			},
		});
		const res = await tool.execute("t", { path: "small.ts", name: "target" });
		const c = res.content[0];
		const text = c?.type === "text" ? c.text : "";
		expect(readFileCalled).toBe(true);
		expect(text).toContain("function target()");
		expect(text).not.toContain("exceeds");
	});

	it("flags ambiguity when a name is declared more than once in the file", async () => {
		const tool = createSymbolTool("/cwd", {
			operations: {
				access: async () => {},
				stat: async () => ({ size: 128 }),
				// `target` is declared twice (overload-like): the tool returns the first
				// but must signal the other so the model doesn't edit the wrong one.
				readFile: async () =>
					Buffer.from(
						"export function target(a: number): void;\nexport function target(a: string): void {\n\treturn;\n}\n",
						"utf-8",
					),
			},
		});
		const res = await tool.execute("t", { path: "overloads.ts", name: "target" });
		const c = res.content[0];
		const text = c?.type === "text" ? c.text : "";
		expect(text).toContain("2 declarations");
		expect(text).toContain("lines 1, 2");
	});

	it("does not add an ambiguity note for a unique symbol", async () => {
		const tool = createSymbolTool("/cwd", {
			operations: {
				access: async () => {},
				stat: async () => ({ size: 64 }),
				readFile: async () => Buffer.from("export function only() {\n\treturn 1;\n}\n", "utf-8"),
			},
		});
		const res = await tool.execute("t", { path: "u.ts", name: "only" });
		const c = res.content[0];
		const text = c?.type === "text" ? c.text : "";
		expect(text).not.toContain("declarations in this file");
	});

	it("refuses oversized files without buffering them", async () => {
		let readFileCalled = false;
		const tool = createSymbolTool("/cwd", {
			operations: {
				access: async () => {},
				stat: async () => ({ size: 11 * 1024 * 1024 }),
				readFile: async () => {
					readFileCalled = true;
					return Buffer.from("");
				},
			},
		});
		const res = await tool.execute("t", { path: "bundle.min.js", name: "target" });
		const c = res.content[0];
		const text = c?.type === "text" ? c.text : "";
		expect(text).toContain("exceeds");
		expect(text).toContain("grep");
		expect(text).toContain("target");
		expect(readFileCalled).toBe(false); // never buffered the giant file
	});
});
