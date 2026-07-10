import { isTruthyEnvFlag } from "../utils/env-flags.ts";

export type TaskRisk = "simple" | "low" | "medium" | "high";
export type RigorLevel = 0 | 1 | 2 | 3;

export interface TaskRigor {
	risk: TaskRisk;
	rigor: RigorLevel;
	reasons: string[];
}

/** Cleared at the start of each emitBeforeAgentStart so handlers share one classify. */
let turnRigorCache: Map<string, TaskRigor> | undefined;

export function clearTaskRigorTurnCache(): void {
	turnRigorCache = undefined;
}

const ACTION_PATTERN =
	/\b(implement|fix|change|add|remove|update|edit|create|patch|wire|debug|review|refactor|migrate|rename|implementar|corrigir|corrija|alterar|adicionar|remover|atualizar|editar|criar|crie|mexer|ajustar|revisar|refatorar|migrar|renomear)\b/i;

const DOCS_PATTERN = /\b(doc|docs|documentation|markdown|readme|relatorio|report|texto|copy|prompt)\b/i;

const MEDIUM_PATTERN =
	/\b(code|typescript|javascript|test|lint|build|bug|error|failure|failing|component|package|codigo|teste|erro|falha|componente|pacote)\b/i;

const HIGH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\b(refactor|refatorar|migrate|migrar|migration|rename|renomear)\b/i, reason: "refactor/migration" },
	{
		pattern: /\b(cross-file|multi-file|multiple files|varios arquivos|muitos arquivos|monorepo)\b/i,
		reason: "cross-file change",
	},
	{
		pattern: /\b(permission|permissions|auth|oauth|security|sandbox|permissao|permissoes|seguranca)\b/i,
		reason: "permission/security surface",
	},
	{
		pattern: /\b(lsp|provider|settings|config|agent loop|session|mcp|tools?|verification|verificacao)\b/i,
		reason: "agent/config surface",
	},
	{
		pattern: /\b(api contract|schema|database|breaking|release|public type|tipo publico)\b/i,
		reason: "contract surface",
	},
];

function unique(values: string[]): string[] {
	return Array.from(new Set(values));
}

function highReasons(prompt: string): string[] {
	return unique(HIGH_PATTERNS.filter(({ pattern }) => pattern.test(prompt)).map(({ reason }) => reason));
}

export function isTaskRigorDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(env.PIT_NO_TASK_RIGOR);
}

export function classifyTaskRigor(prompt: string): TaskRigor {
	const normalized = prompt.trim();
	if (normalized.length === 0) return { risk: "simple", rigor: 0, reasons: ["empty prompt"] };

	if (!turnRigorCache) turnRigorCache = new Map();
	const cached = turnRigorCache.get(normalized);
	if (cached) return cached;

	const hasAction = ACTION_PATTERN.test(normalized);
	const reasons = highReasons(normalized);
	let result: TaskRigor;
	if (hasAction && reasons.length > 0) {
		result = { risk: "high", rigor: 3, reasons };
	} else if (hasAction && MEDIUM_PATTERN.test(normalized)) {
		result = { risk: "medium", rigor: 2, reasons: ["code-affecting action"] };
	} else if (hasAction && DOCS_PATTERN.test(normalized)) {
		result = { risk: "low", rigor: 1, reasons: ["documentation/text action"] };
	} else if (hasAction) {
		result = { risk: "medium", rigor: 2, reasons: ["mutating action"] };
	} else {
		result = { risk: "simple", rigor: 0, reasons: ["read-only or answer-only prompt"] };
	}
	turnRigorCache.set(normalized, result);
	return result;
}

export function formatTaskRigorPrompt(rigor: TaskRigor): string {
	if (rigor.rigor === 0) return "";
	const reasonText = rigor.reasons.length > 0 ? ` Reason: ${rigor.reasons.join(", ")}.` : "";
	if (rigor.rigor === 1) {
		return `<task_rigor>\nRigor 1 (${rigor.risk}).${reasonText} Keep the change small, read the target before editing, and verify the touched output before saying done.\n</task_rigor>`;
	}
	if (rigor.rigor === 2) {
		return `<task_rigor>\nRigor 2 (${rigor.risk}).${reasonText} Make a short plan before patching, keep edits scoped, use LSP or a focused check after code changes, and do not report done while verification is red.\n</task_rigor>`;
	}
	return `<task_rigor>\nRigor 3 (${rigor.risk}).${reasonText} Expand context before editing, prefer small patches, run strong verification for the affected package/project, self-review the diff, and escalate to review/subagents only if the evidence requires it.\n</task_rigor>`;
}

export function appendTaskRigorPrompt(systemPrompt: string, rigor: TaskRigor): string {
	const block = formatTaskRigorPrompt(rigor);
	if (block.length === 0) return systemPrompt;
	return `${systemPrompt}\n\n${block}`;
}
