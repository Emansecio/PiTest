import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { shutdownAll } from "../../src/core/lsp/client.ts";
import { loadConfig } from "../../src/core/lsp/config.ts";
import { applyTextEditsToString } from "../../src/core/lsp/edits.ts";
import { needsWindowsShell, parseContentLengthFrame, quoteWindowsShellArg } from "../../src/core/lsp/internal.ts";
import { createLspToolDefinition } from "../../src/core/lsp/tool.ts";
import { detectLanguageId, fileToUri, resolveSymbolColumn, uriToFile } from "../../src/core/lsp/utils.ts";

function frame(json: unknown): Buffer {
	const body = JSON.stringify(json);
	return Buffer.from(`Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`, "utf-8");
}

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

	it("fileToUri encodes spaces, '#' and literal '%' and round-trips", () => {
		const target = join(process.cwd(), "my dir", "a#1 100%.ts");
		const uri = fileToUri(target);
		expect(uri).toContain("%20"); // space
		expect(uri).toContain("%23"); // #
		expect(uri).toContain("%25"); // literal percent
		expect(uri).not.toMatch(/[ #]/); // no raw space or '#' leaked into the URI
		const norm = (p: string) => p.replace(/\\/g, "/");
		expect(norm(uriToFile(uri))).toBe(norm(target));
	});

	it("fileToUri keeps pchar-legal chars (@scope, drive ':') unescaped", () => {
		const uri = fileToUri(join(process.cwd(), "node_modules", "@scope", "pkg.ts"));
		expect(uri).toContain("/@scope/");
		expect(uri).not.toContain("%40");
	});

	it("uriToFile tolerates malformed percent-encoding instead of throwing", () => {
		expect(() => uriToFile("file:///tmp/bad%path.ts")).not.toThrow();
		expect(uriToFile("file:///tmp/bad%path.ts")).toContain("bad%path.ts");
	});

	it("parseContentLengthFrame decodes a valid frame and returns the remainder", () => {
		const buf = Buffer.concat([frame({ jsonrpc: "2.0", id: 1, result: null }), Buffer.from("tail")]);
		const parsed = parseContentLengthFrame(buf);
		if (!parsed || "error" in parsed) throw new Error("expected a decoded frame");
		expect(parsed.json).toEqual({ jsonrpc: "2.0", id: 1, result: null });
		expect(parsed.remaining.toString("utf-8")).toBe("tail");
	});

	it("parseContentLengthFrame discards a malformed JSON body and advances past it", () => {
		const body = "{not json";
		const bad = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, "utf-8");
		const next = frame({ jsonrpc: "2.0", id: 2, result: 1 });
		const parsed = parseContentLengthFrame(Buffer.concat([bad, next]));
		if (!parsed || !("error" in parsed)) throw new Error("expected a malformed-frame result");
		// The remainder must be exactly the next frame, so the reader doesn't stall.
		const after = parseContentLengthFrame(parsed.remaining);
		if (!after || "error" in after) throw new Error("expected the following frame to parse");
		expect(after.json).toEqual({ jsonrpc: "2.0", id: 2, result: 1 });
	});

	it("parseContentLengthFrame returns null while a frame is still incomplete", () => {
		const full = frame({ jsonrpc: "2.0", id: 3, result: "x" });
		expect(parseContentLengthFrame(full.subarray(0, full.length - 3))).toBeNull();
	});

	it("parseContentLengthFrame buffers a short unframed run (still waiting for a header)", () => {
		// Below the scan cap with no `\r\n\r\n`: not garbage yet, keep buffering.
		const partial = Buffer.from("server starting up, no header yet...");
		expect(parseContentLengthFrame(partial)).toBeNull();
	});

	it("parseContentLengthFrame discards an unframed buffer past the header-scan cap (OOM guard)", () => {
		// A server dumping unframed text (banner/logs/crash) never closes a header.
		// Past the cap the parser must drop everything so the buffer can't grow to OOM.
		const garbage = Buffer.alloc(64 * 1024 + 1, 0x61); // > MAX_HEADER_SCAN_BYTES, no CRLFCRLF
		const parsed = parseContentLengthFrame(garbage);
		if (!parsed || !("error" in parsed)) throw new Error("expected the oversized unframed buffer to be discarded");
		expect(parsed.error.message).toContain("unframed output");
		// Remainder is empty: the whole garbage buffer is dropped, not retained.
		expect(parsed.remaining.length).toBe(0);
	});

	it("parseContentLengthFrame rejects an absurd Content-Length instead of awaiting it", () => {
		// A multi-GB declared length must be rejected up front, not buffered until full.
		const huge = 256 * 1024 * 1024; // > MAX_FRAME_BYTES (128MB)
		const buf = Buffer.from(`Content-Length: ${huge}\r\n\r\n{}`, "utf-8");
		const parsed = parseContentLengthFrame(buf);
		if (!parsed || !("error" in parsed)) throw new Error("expected the oversized frame to be rejected");
		expect(parsed.error.message).toContain("frame too large");
		// Resync past the header so the reader keeps draining subsequent frames.
		expect(parsed.remaining.toString("utf-8")).toBe("{}");
	});

	it("parseContentLengthFrame still decodes a normal frame unchanged (no regression)", () => {
		const buf = Buffer.concat([frame({ jsonrpc: "2.0", id: 7, result: { ok: true } }), Buffer.from("rest")]);
		const parsed = parseContentLengthFrame(buf);
		if (!parsed || "error" in parsed) throw new Error("expected a decoded frame");
		expect(parsed.json).toEqual({ jsonrpc: "2.0", id: 7, result: { ok: true } });
		expect(parsed.remaining.toString("utf-8")).toBe("rest");
	});

	it("quoteWindowsShellArg wraps whitespace/quotes only when needed", () => {
		expect(quoteWindowsShellArg("--stdio")).toBe("--stdio");
		expect(quoteWindowsShellArg("C:/Program Files/x.cmd")).toBe('"C:/Program Files/x.cmd"');
		expect(quoteWindowsShellArg('a"b')).toBe('"a""b"');
	});

	it("needsWindowsShell flags only .cmd/.bat on win32", () => {
		const expected = process.platform === "win32";
		expect(needsWindowsShell("foo.cmd")).toBe(expected);
		expect(needsWindowsShell("foo.bat")).toBe(expected);
		expect(needsWindowsShell("foo.exe")).toBe(false);
		expect(needsWindowsShell("rust-analyzer")).toBe(false);
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
