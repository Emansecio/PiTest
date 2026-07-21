/**
 * `eval` tool — runs code in a persistent Python or JavaScript kernel held
 * alive across tool calls within the same session. State (vars, imports,
 * defined functions) survives between calls of the same `lang`.
 */

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import { sliceSafe } from "../../utils/surrogate.ts";
import { getCurrentEvalKernelManager } from "../eval-kernel/index.ts";
import type { EvalLang } from "../eval-kernel/types.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { renderToolOutput, str } from "./render-utils.ts";
import { withOutputCap, wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { collapseRepeatedLines, formatSize, truncateTail } from "./truncate.ts";

const evalSchema = Type.Object(
	{
		lang: Type.Enum(["python", "javascript"], {
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

// Per-section budget for stdout/stderr (tail-kept independently, so a flood in
// one section never starves the other) — sized so stdout + stderr + a
// realistic error message stay comfortably under EVAL_OUTPUT_CAP_BYTES even
// without the wrapper's own headTail net ever having to step in.
const KERNEL_SECTION_MAX_BYTES = 16 * 1024;

// Overrides the wrapper's default 64KB HEAD-ONLY safety net with the same
// ceiling in headTail mode (see withOutputCap below): belt-and-suspenders for
// formatKernelResult's own per-section truncation — if a huge `error` alone
// ever pushed the composed text past this, the wrapper's re-cut still keeps
// the tail (where `error` is appended) instead of chopping it off.
export const EVAL_OUTPUT_CAP_BYTES = 64 * 1024;

async function spillFullOutput(full: string, label: string): Promise<string | undefined> {
	try {
		const id = randomBytes(8).toString("hex");
		const safeLabel = label.replace(/[^a-z0-9_-]/gi, "-");
		const path = join(tmpdir(), `pit-${safeLabel}-${id}.log`);
		await writeFile(path, full, "utf-8");
		return path;
	} catch {
		return undefined;
	}
}

export interface KernelResultInput {
	label: string;
	stdout: string;
	stderr: string;
	error?: string;
	durationMs: number;
}

/**
 * Shared stdout/stderr/error formatter for `eval` and `code-mode` — both run
 * inside the same persistent JS/Python kernel processes (see the shared-kernel
 * coupling note on both tool descriptions below) and hit the same unbounded-
 * output hazard: a runaway script can print many MB before erroring. Unlike
 * bash's streaming accumulator, the kernel hands back one complete string per
 * section, so each of stdout/stderr is truncated independently, TAIL-KEPT (the
 * decisive part — final prints, the traceback's immediate context — lands at
 * the end of a log). `error` is NEVER truncated here: a cut-off exception
 * message/stack actively hides the one thing the model needs to fix the bug.
 * When any section was truncated, the complete, untouched text is spilled to a
 * temp file — recoverable via `read`, mirroring bash's recovery path — and the
 * path is named in the truncation note.
 */
export async function formatKernelResult(input: KernelResultInput): Promise<string> {
	const { label, stdout, stderr, error, durationMs } = input;
	const head = `[${label}, dur=${durationMs}ms]`;
	const parts: string[] = [head];
	const sections: Array<{ name: string; body: string; truncatable: boolean }> = [];
	if (stdout) sections.push({ name: "stdout", body: stdout, truncatable: true });
	if (stderr && stderr !== error) sections.push({ name: "stderr", body: stderr, truncatable: true });
	if (error) sections.push({ name: "error", body: error, truncatable: false });

	let anyTruncated = false;
	const fullSections: string[] = [];
	for (const { name, body, truncatable } of sections) {
		// Spill keeps the RAW body (full, lossless recovery); the model-facing display
		// is collapsed then tail-cut.
		fullSections.push(`--- ${name} ---\n${body}`);
		let display = body;
		if (truncatable) {
			// Lossless-first: collapse identical/similar repeated lines BEFORE the byte
			// cut, so a runaway loop's near-identical output shrinks without spending
			// the tail budget on it. `error` (truncatable=false) is never collapsed —
			// its exact text is load-bearing. collapseRepeatedLines returns `body`
			// unchanged (same reference) when nothing collapses, so small outputs keep
			// the inline one-line rendering below.
			display = collapseRepeatedLines(body);
			const truncation = truncateTail(display, { maxBytes: KERNEL_SECTION_MAX_BYTES });
			if (truncation.truncated) {
				anyTruncated = true;
				display = truncation.content;
			}
		}
		const oneLine = display === body && !display.includes("\n") && display.length <= 80;
		if (oneLine) {
			parts.push(`${name}: ${display}`);
		} else {
			parts.push(`--- ${name} ---`);
			parts.push(display.replace(/\s+$/, ""));
		}
	}
	if (sections.length === 0) parts.push("(no output)");

	if (anyTruncated) {
		const spillPath = await spillFullOutput(fullSections.join("\n\n"), label);
		parts.push(
			spillPath
				? `[stdout/stderr truncated to the last ${formatSize(KERNEL_SECTION_MAX_BYTES)} per section (error kept in full); full output at ${spillPath} — read it for the complete text]`
				: `[stdout/stderr truncated to the last ${formatSize(KERNEL_SECTION_MAX_BYTES)} per section (error kept in full); full output could not be spilled to disk]`,
		);
	}
	return parts.join("\n");
}

export function createEvalToolDefinition(
	_cwd: string,
	_options?: EvalToolOptions,
): ToolDefinition<typeof evalSchema, EvalToolDetails> {
	const definition: ToolDefinition<typeof evalSchema, EvalToolDetails> = {
		name: "eval",
		label: "eval",
		description:
			"Run code in a persistent Python or JavaScript kernel. State (variables, imports, defined functions) survives across calls within the same session for the chosen lang. The javascript kernel process is shared with the `code` tool — aborting or timing out either one tears down that shared kernel and wipes both tools' persisted JS state.",
		promptSnippet: "Execute code in a persistent Python or JS kernel; state persists across calls.",
		promptGuidelines: [
			"Use eval for stateful computations or prototyping; state persists per language and session. JavaScript supports top-level await; Python preloads sys, os, and json.",
			"Print results to stdout/stderr. JavaScript shares a process with `code`; aborting or timing out either resets both tools' JS state.",
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
				const text = await formatKernelResult({
					label: `lang=${lang}`,
					stdout: result.stdout ?? "",
					stderr: result.stderr ?? "",
					error: result.error,
					durationMs: result.durationMs,
				});
				const hadError = Boolean(result.error);
				return {
					content: [{ type: "text" as const, text }],
					isError: hadError,
					details: { lang, durationMs: result.durationMs, hadError },
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
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
			const display = firstLine.length > 70 ? `${sliceSafe(firstLine, 0, 69)}…` : firstLine;
			text.setText(
				`${theme.fg("toolTitle", theme.bold("eval"))} ${theme.fg("accent", `[${lang}]`)} ${theme.fg(
					"toolOutput",
					display,
				)}`,
			);
			return text;
		},
		renderResult: renderToolOutput,
	};
	return withOutputCap(definition, { maxBytes: EVAL_OUTPUT_CAP_BYTES, mode: "headTail" });
}

export function createEvalTool(cwd: string, options?: EvalToolOptions): AgentTool<typeof evalSchema> {
	return wrapToolDefinition(createEvalToolDefinition(cwd, options));
}
