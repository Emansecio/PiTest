import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { shutdownAll } from "../../src/core/lsp/client.ts";
import { loadConfig } from "../../src/core/lsp/config.ts";
import { applyTextEditsToString } from "../../src/core/lsp/edits.ts";
import { createLspToolDefinition } from "../../src/core/lsp/tool.ts";
import { detectLanguageId, fileToUri, resolveSymbolColumn, uriToFile } from "../../src/core/lsp/utils.ts";

const FAKE_SERVER = fileURLToPath(new URL("./fake-lsp-server.mjs", import.meta.url));

type ToolResult = { content: Array<{ type: string; text?: string }>; details?: { success?: boolean } };

function text(result: unknown): string {
	return (result as ToolResult).content[0]?.text ?? "";
}

function makeProject(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pit-lsp-"));
	writeFileSync(
		join(cwd, "lsp.json"),
		JSON.stringify({
			servers: { fake: { command: "node", args: [FAKE_SERVER], fileTypes: [".txt"], rootMarkers: ["lsp.json"] } },
		}),
	);
	writeFileSync(join(cwd, "sample.txt"), "hello world\nfoo bar\n");
	return cwd;
}

async function run(cwd: string, params: Record<string, unknown>): Promise<string> {
	const def = createLspToolDefinition(cwd);
	const ctx = {} as Parameters<typeof def.execute>[4];
	const result = await def.execute("call-1", params as never, undefined, undefined, ctx);
	return text(result);
}

describe("lsp module — pure helpers", () => {
	it("fileToUri / uriToFile round-trips", () => {
		const cwd = process.cwd();
		const target = join(cwd, "a", "b.ts");
		const uri = fileToUri(target);
		expect(uri.startsWith("file://")).toBe(true);
		// URIs use forward slashes; on Windows uriToFile keeps them (Node fs accepts `/`).
		const norm = (p: string) => p.replace(/\\/g, "/");
		expect(norm(uriToFile(uri))).toBe(norm(target));
	});

	it("detectLanguageId maps extensions", () => {
		expect(detectLanguageId("x.ts")).toBe("typescript");
		expect(detectLanguageId("x.rs")).toBe("rust");
		expect(detectLanguageId("Dockerfile")).toBe("dockerfile");
		expect(detectLanguageId("x.unknownext")).toBe("plaintext");
	});

	it("applyTextEditsToString applies edits bottom-to-top", () => {
		const src = "alpha\nbeta\ngamma\n";
		const out = applyTextEditsToString(src, [
			{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "FIRST" },
			{ range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } }, newText: "THIRD" },
		]);
		expect(out).toBe("FIRST\nbeta\nTHIRD\n");
	});

	it("applyTextEditsToString throws on overlapping edits", () => {
		expect(() =>
			applyTextEditsToString("hello world", [
				{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "x" },
				{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 8 } }, newText: "y" },
			]),
		).toThrow(/overlapping/);
	});

	it("resolveSymbolColumn finds the symbol column and honors #N", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pit-lsp-col-"));
		writeFileSync(join(cwd, "f.txt"), "const foo = foo + foo;\n");
		const target = join(cwd, "f.txt");
		expect(await resolveSymbolColumn(target, 1, "foo")).toBe(6); // first foo
		expect(await resolveSymbolColumn(target, 1, "foo#2")).toBe(12); // second foo
		await expect(resolveSymbolColumn(target, 1, "missing")).rejects.toThrow(/not found/);
		rmSync(cwd, { recursive: true, force: true });
	});
});

describe("lsp config — override loading", () => {
	it("loads a project lsp.json override and resolves the binary", () => {
		const cwd = makeProject();
		const config = loadConfig(cwd);
		expect(config.servers.fake).toBeDefined();
		expect(config.servers.fake.fileTypes).toContain(".txt");
		expect(config.servers.fake.resolvedCommand).toBeTruthy();
		rmSync(cwd, { recursive: true, force: true });
	});
});

describe("lsp tool — end-to-end against a fake server", () => {
	const cwd = makeProject();

	afterAll(async () => {
		await shutdownAll();
		rmSync(cwd, { recursive: true, force: true });
	});

	it("status lists configured servers", async () => {
		const out = await run(cwd, { action: "status" });
		expect(out).toContain("fake");
	});

	it("hover returns server-provided content", async () => {
		const out = await run(cwd, { action: "hover", file: "sample.txt", line: 1, symbol: "hello" });
		expect(out).toContain("HOVER: fake type info");
	});

	it("definition returns a location with context", async () => {
		const out = await run(cwd, { action: "definition", file: "sample.txt", line: 1, symbol: "hello" });
		expect(out).toContain("definition(s)");
		expect(out).toContain("sample.txt:1:1");
	});

	it("references returns multiple locations", async () => {
		const out = await run(cwd, { action: "references", file: "sample.txt", line: 1, symbol: "hello" });
		expect(out).toContain("reference(s)");
		expect(out).toContain("sample.txt:1:1");
	});

	it("diagnostics surfaces server diagnostics", async () => {
		const out = await run(cwd, { action: "diagnostics", file: "sample.txt" });
		expect(out).toContain("fake diagnostic");
		expect(out).toContain("[error]");
	});

	it("document symbols are listed", async () => {
		const out = await run(cwd, { action: "symbols", file: "sample.txt" });
		expect(out).toContain("fakeSym");
		expect(out).toContain("[Function]");
	});

	it("workspace symbols search across servers", async () => {
		const out = await run(cwd, { action: "symbols", file: "*", query: "fakeSym" });
		expect(out).toContain("fakeSym");
	});

	it("code_actions lists available actions", async () => {
		const out = await run(cwd, { action: "code_actions", file: "sample.txt", line: 1 });
		expect(out).toContain("Fix the fake diagnostic");
	});

	it("rename preview formats edits without touching disk", async () => {
		const out = await run(cwd, {
			action: "rename",
			file: "sample.txt",
			line: 1,
			symbol: "hello",
			new_name: "HELLO",
			apply: false,
		});
		expect(out).toContain("Rename preview");
		expect(out).toContain("sample.txt");
	});

	it("capabilities dumps server capabilities", async () => {
		const out = await run(cwd, { action: "capabilities", file: "sample.txt" });
		expect(out).toContain("hoverProvider");
	});
});
