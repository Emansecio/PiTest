/**
 * `eval` tool — runs code in a persistent Python or JavaScript kernel held
 * alive across tool calls within the same session. State (vars, imports,
 * defined functions) survives between calls of the same `lang`.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { getCurrentEvalKernelManager } from "../eval-kernel/index.ts";
import type { EvalLang, EvalResult } from "../eval-kernel/types.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { getTextOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const evalSchema = Type.Object(
	{
		lang: Type.Union([Type.Literal("python"), Type.Literal("javascript")], {
			description: "Language kernel to execute code in. State persists per-lang across calls.",
		}),
		code: Type.String({ description: "Source code to execute in the persistent kernel." }),
		timeout_ms: Type.Optional(
			Type.Number({
				description: "Kill the call after N ms (default 30000). The kernel is respawned on timeout, losing state.",
				minimum: 1,
			}),
		),
	},
	{ additionalProperties: false },
);

export type EvalToolInput = Static<typeof evalSchema>;

export interface EvalToolDetails {
	lang: EvalLang;
	durationMs: number;
	hadError: boolean;
}

export interface EvalToolOptions {
	enabled?: boolean;
}

function formatResult(lang: EvalLang, r: EvalResult): string {
	const head = `[lang=${lang}, dur=${r.durationMs}ms]`;
	const parts: string[] = [head];
	const stdout = r.stdout ?? "";
	const stderr = r.stderr ?? "";
	const err = r.error ?? "";
	const sections: Array<[string, string]> = [];
	if (stdout) sections.push(["stdout", stdout]);
	if (stderr && stderr !== err) sections.push(["stderr", stderr]);
	if (err) sections.push(["error", err]);
	if (r.value !== undefined) sections.push(["value", r.value]);
	for (const [label, body] of sections) {
		const oneLine = !body.includes("\n") && body.length <= 80;
		if (oneLine) {
			parts.push(`${label}: ${body}`);
		} else {
			parts.push(`--- ${label} ---`);
			parts.push(body.replace(/\s+$/, ""));
		}
	}
	if (sections.length === 0) {
		parts.push("(no output)");
	}
	return parts.join("\n");
}

export function createEvalToolDefinition(
	_cwd: string,
	_options?: EvalToolOptions,
): ToolDefinition<typeof evalSchema, EvalToolDetails> {
	return {
		name: "eval",
		label: "eval",
		description:
			"Run code in a persistent Python or JavaScript kernel. State (variables, imports, defined functions) survives across calls within the same session for the chosen lang.",
		promptSnippet: "Execute code in a persistent Python or JS kernel; state persists across calls.",
		promptGuidelines: [
			"Use for quick computations, data exploration, or stateful prototyping where you want vars to survive.",
			"State is per-lang and per-session; the same lang sees the same globals across calls.",
			"Top-level await works in JavaScript; standard imports (sys, os, json) are preloaded in Python.",
			"Output is captured via stdout/stderr — print results, do not rely on returned values.",
		],
		parameters: evalSchema,
		async execute(_toolCallId, input: EvalToolInput, signal) {
			const manager = getCurrentEvalKernelManager();
			if (!manager) {
				return {
					content: [{ type: "text" as const, text: "Eval kernel not available in this session." }],
					isError: true,
					details: { lang: input.lang, durationMs: 0, hadError: true },
				};
			}
			const lang: EvalLang = input.lang;
			const kernel = manager.get(lang);
			try {
				const result = await kernel.exec({ lang, code: input.code, timeoutMs: input.timeout_ms }, signal);
				const text = formatResult(lang, result);
				const hadError = Boolean(result.error);
				return {
					content: [{ type: "text" as const, text }],
					isError: hadError,
					details: { lang, durationMs: result.durationMs, hadError },
				};
			} catch (err) {
				const msg = (err as Error).message ?? String(err);
				return {
					content: [{ type: "text" as const, text: `eval error: ${msg}` }],
					isError: true,
					details: { lang, durationMs: 0, hadError: true },
				};
			}
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const lang = str(args?.lang) || "?";
			const code = str(args?.code) || "";
			const firstLine = code.split(/\r?\n/, 1)[0] ?? "";
			const display = firstLine.length > 70 ? `${firstLine.slice(0, 69)}…` : firstLine;
			text.setText(
				`${theme.fg("toolTitle", theme.bold("eval"))} ${theme.fg("accent", `[${lang}]`)} ${theme.fg(
					"toolOutput",
					display,
				)}`,
			);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result as any, context.showImages).trim();
			text.setText(output ? `\n${theme.fg("toolOutput", output)}` : "");
			return text;
		},
	};
}

export function createEvalTool(cwd: string, options?: EvalToolOptions): AgentTool<typeof evalSchema> {
	return wrapToolDefinition(createEvalToolDefinition(cwd, options));
}
