import { execFile } from "node:child_process";
import * as nodePath from "node:path";
import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { getCurrentPreviewQueue } from "../preview-queue.ts";
import { prepareWithPathAliases } from "./argument-prep.ts";
import { AST_GREP_INSTALL_HINT, isMissingBinaryError, parseJsonStream } from "./ast-grep-shared.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const astEditSchema = Type.Object(
	{
		pattern: Type.String({
			description: 'ast-grep structural pattern with $METAVAR captures. Example: "console.log($X)".',
		}),
		rewrite: Type.String({
			description: 'ast-grep rewrite template. References captures by $METAVAR. Example: "logger.debug($X)".',
		}),
		lang: Type.Optional(
			Type.String({ description: "Language id (e.g. ts, tsx, js, py, rs). Inferred from path when omitted." }),
		),
		path: Type.Optional(Type.String({ description: "File or directory to operate on. Default: cwd." })),
		preview: Type.Optional(
			Type.Boolean({
				description:
					"When true, stage the rewrite in the preview queue instead of applying. Use resolve to commit.",
			}),
		),
		dry_run: Type.Optional(
			Type.Boolean({
				description: "When true, return proposed rewrites without touching disk and without staging a preview.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type AstEditToolInput = Static<typeof astEditSchema>;

export interface AstEditToolDetails {
	replacementCount?: number;
	fileCount?: number;
	diff?: string;
}

export interface AstEditToolOptions {
	binaryPath?: string;
}

interface AstGrepRewriteMatch {
	file?: string;
	range?: {
		start?: { line?: number; column?: number };
		end?: { line?: number; column?: number };
	};
	text?: string;
	lines?: string;
	replacement?: string;
	replacement_offsets?: unknown;
}

function execAstGrep(
	binary: string,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string; missing?: boolean }> {
	return new Promise((resolve) => {
		execFile(binary, args, { cwd, signal, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				if (isMissingBinaryError(err)) {
					resolve({ code: -1, stdout: "", stderr: AST_GREP_INSTALL_HINT, missing: true });
					return;
				}
				const code = typeof (err as { code?: unknown }).code === "number" ? Number((err as any).code) : 1;
				resolve({
					code,
					stdout: stdout?.toString() ?? "",
					stderr: stderr?.toString() ?? String(err),
				});
				return;
			}
			resolve({ code: 0, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
		});
	});
}

function relFile(file: string, cwd: string): string {
	try {
		const rel = nodePath.relative(cwd, file);
		if (rel && !rel.startsWith("..") && !nodePath.isAbsolute(rel)) return rel.replace(/\\/g, "/");
	} catch {
		// ignore
	}
	return file;
}

function formatRewritePreview(matches: AstGrepRewriteMatch[], cwd: string): string {
	if (matches.length === 0) return "No matches found";
	const byFile = new Map<string, AstGrepRewriteMatch[]>();
	for (const m of matches) {
		const f = m.file || "<unknown>";
		const list = byFile.get(f);
		if (list) list.push(m);
		else byFile.set(f, [m]);
	}
	const out: string[] = [];
	for (const [file, items] of byFile) {
		out.push(relFile(file, cwd));
		for (const m of items) {
			const startLine = m.range?.start?.line;
			const loc = typeof startLine === "number" ? `${startLine + 1}` : "?";
			const before = (m.lines || m.text || "").replace(/\r/g, "").trimEnd();
			const after = (m.replacement || "").replace(/\r/g, "").trimEnd();
			out.push(`  @${loc}`);
			for (const l of before.split("\n")) out.push(`  - ${l}`);
			for (const l of after.split("\n")) out.push(`  + ${l}`);
		}
	}
	return out.join("\n");
}

function formatAstEditCall(
	args:
		| { pattern?: string; rewrite?: string; path?: string; lang?: string; preview?: boolean; dry_run?: boolean }
		| undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	cwd?: string,
): string {
	const pattern = str(args?.pattern);
	const rewrite = str(args?.rewrite);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".", cwd) : null;
	const invalidArg = invalidArgText(theme);
	let text = `${theme.fg("toolTitle", theme.bold("ast_edit"))} `;
	text += pattern === null ? invalidArg : theme.fg("accent", pattern || "");
	text += theme.fg("toolOutput", " -> ");
	text += rewrite === null ? invalidArg : theme.fg("accent", rewrite || "");
	text += theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (args?.dry_run) text += theme.fg("muted", " (dry-run)");
	else if (args?.preview) text += theme.fg("muted", " (preview)");
	return text;
}

function formatAstEditResult(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> },
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 20;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
	if (remaining > 0) text += `\n${theme.fg("muted", `... (${remaining} more lines)`)}`;
	return text;
}

function countFiles(matches: AstGrepRewriteMatch[]): number {
	const set = new Set<string>();
	for (const m of matches) if (m.file) set.add(m.file);
	return set.size;
}

export function createAstEditToolDefinition(
	cwd: string,
	options?: AstEditToolOptions,
): ToolDefinition<typeof astEditSchema, AstEditToolDetails | undefined> {
	const binary = options?.binaryPath ?? "ast-grep";
	return {
		name: "ast_edit",
		label: "ast_edit",
		description: `Structural code rewrite via ast-grep CLI. \`pattern\` captures with $METAVAR; \`rewrite\` references them. Modes: dry_run returns proposed changes only; preview stages a preview that the resolve tool commits; default applies in-place with --update-all. Requires the ast-grep CLI to be installed and on PATH — the tool errors with "${AST_GREP_INSTALL_HINT}" if it is absent. For single-file text edits use \`edit\`/\`edit_v2\` instead.`,
		promptSnippet:
			"Structural AST rewrite (ast-grep). pattern + rewrite use $METAVAR. Supports dry_run and preview modes.",
		parameters: astEditSchema,
		prepareArguments: prepareWithPathAliases,
		async execute(_toolCallId, input: AstEditToolInput, signal?: AbortSignal) {
			const { pattern, rewrite, lang, path: targetPath, preview, dry_run } = input;
			const target = resolveToCwd(targetPath || ".", cwd);
			const baseArgs: string[] = ["run", "--pattern", pattern, "--rewrite", rewrite];
			if (lang) baseArgs.push("--lang", lang);

			// Dry-run path: compute matches with --json=stream and --update-all combined? No — ast-grep accepts
			// --json without --update-all to preview rewrites in the JSON output.
			if (dry_run === true) {
				const args = [...baseArgs, "--json=stream", target];
				const res = await execAstGrep(binary, args, cwd, signal);
				if (res.missing) {
					return {
						content: [{ type: "text" as const, text: AST_GREP_INSTALL_HINT }],
						isError: true,
						details: undefined,
					};
				}
				if (res.code !== 0 && res.code !== 1) {
					return {
						content: [
							{ type: "text" as const, text: res.stderr.trim() || `ast-grep exited with code ${res.code}` },
						],
						isError: true,
						details: undefined,
					};
				}
				const matches = parseJsonStream<AstGrepRewriteMatch>(res.stdout);
				const text = formatRewritePreview(matches, cwd);
				return {
					content: [
						{
							type: "text" as const,
							text: `[dry-run] ${matches.length} replacement(s) in ${countFiles(matches)} file(s)\n${text}`,
						},
					],
					details: { replacementCount: matches.length, fileCount: countFiles(matches), diff: text },
				};
			}

			// Preview path: compute changes via JSON, stage in queue, apply on accept.
			const queue = getCurrentPreviewQueue();
			if (preview === true && queue) {
				const args = [...baseArgs, "--json=stream", target];
				const res = await execAstGrep(binary, args, cwd, signal);
				if (res.missing) {
					return {
						content: [{ type: "text" as const, text: AST_GREP_INSTALL_HINT }],
						isError: true,
						details: undefined,
					};
				}
				if (res.code !== 0 && res.code !== 1) {
					return {
						content: [
							{ type: "text" as const, text: res.stderr.trim() || `ast-grep exited with code ${res.code}` },
						],
						isError: true,
						details: undefined,
					};
				}
				const matches = parseJsonStream<AstGrepRewriteMatch>(res.stdout);
				if (matches.length === 0) {
					return {
						content: [{ type: "text" as const, text: "No matches found" }],
						details: { replacementCount: 0, fileCount: 0 },
					};
				}
				const previewText = formatRewritePreview(matches, cwd);
				const replacementCount = matches.length;
				const fileCount = countFiles(matches);
				const item = queue.add({
					kind: "ast_edit",
					path: targetPath || ".",
					apply: async () => {
						const applyArgs = [...baseArgs, "--update-all", target];
						const applyRes = await execAstGrep(binary, applyArgs, cwd);
						if (applyRes.missing) throw new Error(AST_GREP_INSTALL_HINT);
						if (applyRes.code !== 0 && applyRes.code !== 1) {
							throw new Error(applyRes.stderr.trim() || `ast-grep exited with code ${applyRes.code}`);
						}
					},
					summary: {
						description: `ast_edit ${targetPath || "."}: ${replacementCount} replacement(s) in ${fileCount} file(s)`,
						replacementCount,
						diff: previewText,
					},
				});
				return {
					content: [
						{
							type: "text" as const,
							text: `Preview staged. id=${item.id}. ${replacementCount} replacement(s) proposed in ${fileCount} file(s).\n${previewText}`,
						},
					],
					details: { replacementCount, fileCount, diff: previewText },
				};
			}

			// Default: apply with --update-all.
			const args = [...baseArgs, "--update-all", target];
			const res = await execAstGrep(binary, args, cwd, signal);
			if (res.missing) {
				return {
					content: [{ type: "text" as const, text: AST_GREP_INSTALL_HINT }],
					isError: true,
					details: undefined,
				};
			}
			if (res.code !== 0 && res.code !== 1) {
				return {
					content: [{ type: "text" as const, text: res.stderr.trim() || `ast-grep exited with code ${res.code}` }],
					isError: true,
					details: undefined,
				};
			}
			// ast-grep --update-all prints a human summary to stderr/stdout. Try to extract counts from
			// stderr; otherwise fall back to a generic success message. Run a follow-up --json=stream
			// to surface concrete numbers; this is cheap because patterns are usually localized.
			const summaryRes = await execAstGrep(binary, [...baseArgs, "--json=stream", target], cwd, signal);
			const matches = summaryRes.missing ? [] : parseJsonStream(summaryRes.stdout);
			const replacementCount = matches.length;
			const fileCount = countFiles(matches);
			// After --update-all the second pass shows zero remaining matches (the rewrite already
			// happened). That makes the count unreliable. Surface what the apply step itself printed
			// when we have it.
			const reportedFromCli = res.stdout.trim() || res.stderr.trim();
			const text = reportedFromCli
				? reportedFromCli
				: `Applied ${replacementCount} replacement(s) in ${fileCount} file(s).`;
			return {
				content: [{ type: "text" as const, text }],
				details: { replacementCount, fileCount },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatAstEditCall(args, theme, context.cwd));
			return text;
		},
		renderResult(result, opts, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatAstEditResult(result as any, opts, theme, context.showImages));
			return text;
		},
	};
}

export function createAstEditTool(cwd: string, options?: AstEditToolOptions): AgentTool<typeof astEditSchema> {
	return wrapToolDefinition(createAstEditToolDefinition(cwd, options));
}
