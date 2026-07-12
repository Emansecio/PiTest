/**
 * Regressions da auditoria LSP:
 *  1. TextEdits inseridos na MESMA posição devem sair na ordem do array
 *     (LSP 3.17): inserts [X, Y] em (0,1) sobre "ab" → "aXYb", não "aYXb".
 *  2. URIs de diagnostics publicados pelo servidor devem casar com os lookups
 *     do cliente mesmo quando o servidor normaliza a URI de outra forma
 *     (drive minúsculo / `:` percent-encoded no Windows, %XX redundante).
 */

import { describe, expect, it } from "vitest";
import { routeMessage } from "../../src/core/lsp/client.js";
import { applyTextEditsToString } from "../../src/core/lsp/edits.js";
import type { LspClient } from "../../src/core/lsp/types.js";
import { canonicalUriKey, fileToUri } from "../../src/core/lsp/utils.js";

const IS_WIN = process.platform === "win32";

function insertAt(line: number, character: number, newText: string) {
	return { range: { start: { line, character }, end: { line, character } }, newText };
}

describe("applyTextEditsToString — ordem de inserções na mesma posição", () => {
	it("mantém a ordem do array para inserts no mesmo ponto (LSP 3.17)", () => {
		const out = applyTextEditsToString("ab", [insertAt(0, 1, "X"), insertAt(0, 1, "Y")]);
		expect(out).toBe("aXYb");
	});

	it("três inserts no mesmo ponto preservam a ordem do array", () => {
		const out = applyTextEditsToString("ab", [insertAt(0, 1, "1"), insertAt(0, 1, "2"), insertAt(0, 1, "3")]);
		expect(out).toBe("a123b");
	});

	it("não regride a aplicação bottom-up de edits em posições distintas", () => {
		const out = applyTextEditsToString("abc", [insertAt(0, 1, "X"), insertAt(0, 2, "Y")]);
		expect(out).toBe("aXbYc");
	});
});

describe("canonicalUriKey — normalização de URI", () => {
	it("normaliza percent-encoding redundante para a forma canônica do cliente", () => {
		const filePath = IS_WIN ? "C:\\tmp\\a-b.ts" : "/tmp/a-b.ts";
		const canonical = fileToUri(filePath);
		// `-` não precisa de encoding; um servidor que o encode gera outra string.
		const encodedVariant = canonical.replace("a-b.ts", "a%2Db.ts");
		expect(encodedVariant).not.toBe(canonical);
		expect(canonicalUriKey(encodedVariant)).toBe(canonical);
	});

	it.runIf(IS_WIN)("normaliza drive minúsculo e %3A para a forma canônica (Windows)", () => {
		const canonical = fileToUri("C:\\tmp\\x.ts");
		expect(canonicalUriKey("file:///c%3A/tmp/x.ts")).toBe(canonical);
		expect(canonicalUriKey("file:///c:/tmp/x.ts")).toBe(canonical);
	});

	it("passa adiante URIs não-file sem alterar", () => {
		expect(canonicalUriKey("untitled:Untitled-1")).toBe("untitled:Untitled-1");
	});
});

describe("routeMessage — diagnostics indexados por chave canônica", () => {
	function stubClient(): LspClient {
		return {
			diagnostics: new Map(),
			diagnosticsVersion: 0,
			activeProgressTokens: new Set(),
			resolveProjectLoaded: () => {},
			pendingRequests: new Map(),
		} as unknown as LspClient;
	}

	it("um publishDiagnostics com URI re-encodada é encontrado pelo lookup canônico", async () => {
		const client = stubClient();
		const filePath = IS_WIN ? "C:\\tmp\\diag.ts" : "/tmp/diag.ts";
		const canonical = fileToUri(filePath);
		// Variante que um servidor normalizador emitiria (encoding diferente).
		const serverUri = IS_WIN
			? canonical.replace(/^file:\/\/\/C:/, "file:///c%3A")
			: canonical.replace("diag.ts", "diag%2Ets");
		expect(serverUri).not.toBe(canonical);

		await routeMessage(client, {
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: {
				uri: serverUri,
				diagnostics: [
					{
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
						message: "boom",
						severity: 1,
					},
				],
			},
		});

		const entry = client.diagnostics.get(canonical);
		expect(entry).toBeDefined();
		expect(entry?.diagnostics[0]?.message).toBe("boom");
	});
});
