/**
 * bench/selftest — valida as funções puras da infra de métricas SEM chamar
 * nenhuma LLM (determinístico, segundos). Cobre os eixos novos: detecção do 1º
 * edit por formato de stream, syntax-gate (`node --check`), e custo estimado.
 *
 * Uso: npx tsx bench/selftest.mts   (exit 0 = tudo passou)
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentId, checkSyntax, estimateCostUsd, isEditLine, priceFor } from "./lib.mts";

let failures = 0;
function ok(cond: boolean, msg: string): void {
	if (cond) {
		console.log(`  ✓ ${msg}`);
	} else {
		console.log(`  ✗ ${msg}`);
		failures++;
	}
}

// ---------------------------------------------------------------------------
// 1) isEditLine: a 1ª edição é detectada no formato de cada agente, e eventos
//    de leitura/raciocínio NÃO disparam (latência-até-código só conta edits).
// ---------------------------------------------------------------------------
console.log("isEditLine (detecção do 1º edit por formato):");
const editLines: Record<Exclude<AgentId, "droid">, { edit: string; nonEdit: string }> = {
	pit: {
		edit: JSON.stringify({ type: "tool_execution_start", toolName: "edit" }),
		nonEdit: JSON.stringify({ type: "tool_execution_start", toolName: "read" }),
	},
	cc: {
		edit: JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit" }] } }),
		nonEdit: JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }),
	},
	codex: {
		edit: JSON.stringify({ type: "item.completed", item: { type: "file_change" } }),
		nonEdit: JSON.stringify({ type: "item.completed", item: { type: "command_execution" } }),
	},
	opencode: {
		edit: JSON.stringify({ type: "tool_use", part: { tool: "write" } }),
		nonEdit: JSON.stringify({ type: "tool_use", part: { tool: "grep" } }),
	},
};
for (const [agent, lines] of Object.entries(editLines) as [Exclude<AgentId, "droid">, { edit: string; nonEdit: string }][]) {
	ok(isEditLine(agent, lines.edit), `${agent}: evento de edit detectado`);
	ok(!isEditLine(agent, lines.nonEdit), `${agent}: evento de read/shell NÃO conta como edit`);
}
ok(!isEditLine("droid", JSON.stringify({ type: "result" })), "droid: sem stream por-tool → nunca detecta (n/d)");
ok(!isEditLine("pit", "lixo não-json {"), "linha inválida não quebra o detector");
ok(isEditLine("pit", JSON.stringify({ type: "tool_execution_start", toolName: "write_file" })), "write_file também conta como edit");

// ---------------------------------------------------------------------------
// 2) checkSyntax: arquivo JS válido passa, malformado é pego; não-JS ignorado.
// ---------------------------------------------------------------------------
console.log("\ncheckSyntax (node --check no diff):");
const sb = mkdtempSync(join(tmpdir(), "bench-selftest-"));
try {
	writeFileSync(join(sb, "good.mjs"), "export const x = 1;\nfunction f() { return x + 1; }\n");
	writeFileSync(join(sb, "bad.mjs"), "export const y = ;\nfunction (((\n");
	writeFileSync(join(sb, "notes.md"), "# not javascript\n");
	const all = checkSyntax(sb, ["good.mjs", "bad.mjs", "notes.md"]);
	ok(all.filesChecked === 2, `checou 2 arquivos JS (ignorou .md) — veio ${all.filesChecked}`);
	ok(all.syntaxErrors === 1, `pegou 1 malformado — veio ${all.syntaxErrors}`);
	ok(all.errorFiles.includes("bad.mjs"), "apontou bad.mjs como o malformado");
	const clean = checkSyntax(sb, ["good.mjs"]);
	ok(clean.syntaxErrors === 0 && clean.filesChecked === 1, "arquivo válido → 0 erros");
	const deleted = checkSyntax(sb, ["ghost.mjs"]);
	ok(deleted.filesChecked === 0, "arquivo deletado/ausente é pulado (não conta)");
} finally {
	rmSync(sb, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 3) estimateCostUsd / priceFor: tabela de preço por modelo, aritmética certa.
// ---------------------------------------------------------------------------
console.log("\nestimateCostUsd (preço de tabela × tokens):");
const m = {
	toolRaw: {}, toolByCat: { read: 0, edit: 0, write: 0, shell: 0, search: 0, list: 0, other: 0 },
	toolTotal: 0, toolErrors: 0, turns: 0, inTok: 1_000_000, outTok: 1_000_000, cacheReadTok: 0,
	rewrites: 0, rejects: 0, errorHints: 0, verifyPassed: 0, verifyFailed: 0, retries: 0, parseErrors: 0,
};
const opusCost = estimateCostUsd("claude-opus-4-8", m);
ok(opusCost === 15 + 75, `opus: 1M in + 1M out = $${opusCost} (esperado $90)`);
ok(estimateCostUsd("gpt-5.5", m) === 1.25 + 10, "codex/gpt-5: 1M+1M = $11.25");
ok(priceFor("anthropic/claude-opus-4-8") !== null, "modelo com prefixo de provider casa a tabela (opus)");
ok(estimateCostUsd("modelo-desconhecido-xyz", m) === null, "modelo fora da tabela → null (não inventa custo)");

console.log(failures === 0 ? "\nPASS: selftest da infra de métricas OK" : `\nFAIL: ${failures} checagem(ns)`);
process.exit(failures === 0 ? 0 : 1);
