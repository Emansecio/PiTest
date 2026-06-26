/**
 * T1 #2: symbol and lsp navigation dead-ends now offer the next step using data
 * already in memory — `symbol` suggests the closest declaration name (typo/casing
 * recovery), and `resolveSymbolColumn` points at the real line when the supplied
 * line is stale. Both are additive: no close candidate / no nearby match keeps the
 * original message.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveSymbolColumn } from "../src/core/lsp/utils.ts";
import { createSymbolToolDefinition } from "../src/core/tools/symbol.ts";

let root: string;
let file: string;
const ctx = {} as Parameters<ReturnType<typeof createSymbolToolDefinition>["execute"]>[4];

beforeAll(() => {
	root = mkdtempSync(path.join(tmpdir(), "t1-nav-"));
	file = path.join(root, "a.ts");
	writeFileSync(
		file,
		["export function handleRequest() {", "  return 1;", "}", "", "export const fooBar = 2;"].join("\n"),
	);
});
afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

describe("T1 #2: navigation dead-ends suggest the real symbol/line", () => {
	it("symbol typo gets a 'Did you mean' suggestion", async () => {
		const def = createSymbolToolDefinition(root);
		await expect(
			def.execute("t", { path: "a.ts", name: "handleReqeust" }, undefined, undefined, ctx),
		).rejects.toThrow(/Did you mean: handleRequest/);
	});

	it("symbol with no close candidate keeps the plain message (byte-identical path)", async () => {
		const def = createSymbolToolDefinition(root);
		const p = def.execute("t", { path: "a.ts", name: "zzzCompletelyUnrelated" }, undefined, undefined, ctx);
		await expect(p).rejects.toThrow(/Try grep for cross-file lookup/);
		await expect(p).rejects.not.toThrow(/Did you mean/);
	});

	it("lsp resolveSymbolColumn points at the real line when the given line is stale", async () => {
		// handleRequest is on line 1; ask for line 3 (stale).
		await expect(resolveSymbolColumn(file, 3, "handleRequest")).rejects.toThrow(/found on line 1 — pass line=1/);
	});

	it("lsp resolveSymbolColumn keeps the plain message when the symbol is nowhere nearby", async () => {
		await expect(resolveSymbolColumn(file, 2, "noSuchSymbolAtAll")).rejects.toThrow(/not found on line 2$/);
	});
});
