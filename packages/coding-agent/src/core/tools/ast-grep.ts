import { execFile } from "node:child_process";
import * as nodePath from "node:path";
import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import { expandKeyHint, moreLinesTrailer } from "../../modes/interactive/components/tool-activity.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { prepareWithPathAliases } from "./argument-prep.ts";
import { astGrepNapiSearch, isNapiSupportedLang } from "./ast-grep-napi.ts";
import {
	AST_GREP_INSTALL_HINT,
	isMissingBinaryError,
	noMatchesMessage,
	parseJsonStream,
	resolveAstGrepSpawnStrategy,
} from "./ast-grep-shared.ts";
import { resolveToCwd } from "./path-utils.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

// Extension → lang id, for the napi-supported subset only. The ast-grep CLI
// already infers language per file from `target` when `--lang` is omitted
// (so CLI-path args below are left untouched); this map exists solely to let
// a specific single-file `path` become napi-eligible without an explicit
// `lang`, so the schema's "Inferred from path when omitted" claim holds for
// the napi fast-path too, not just the CLI fallback.
const NAPI_EXT_TO_LANG: Record<string, string> = {
	".ts": "ts",
	".mts": "ts",
	".cts": "ts",
	".tsx": "tsx",
	".js": "js",
	".jsx": "js",
	".mjs": "js",
	".cjs": "js",
	".html": "html",
	".htm": "html",
	".css": "css",
};

const astGrepSchema = Type.Object(
	{
		pattern: Type.String({
			description: 'ast-grep structural pattern (NOT regex). Example: "console.log($X)".',
		}),
		lang: Type.Optional(
			Type.String({ description: "Language id (e.g. ts, tsx, js, py, rs). Inferred from path when omitted." }),
		),
		path: Type.Optional(Type.String({ description: "File or directory to search. Default: cwd." })),
		globs: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Glob filters to scope the search, e.g. ['src/**/*.ts'] or ['!**/*.test.ts'] to exclude. Forward slashes only.",
			}),
		),
		context: Type.Optional(Type.Number({ description: "Lines of context around each match (default: 0)." })),
		limit: Type.Optional(
			Type.Number({
				description: `Max matches to return (default ${DEFAULT_LIMIT}, hard cap ${MAX_LIMIT}).`,
				minimum: 1,
				maximum: MAX_LIMIT,
			}),
		),
	},
	{ additionalProperties: false },
);

export type AstGrepToolInput = Static<typeof astGrepSchema>;

export interface AstGrepToolDetails {
	matchCount?: number;
	matchLimitReached?: boolean;
}

export interface AstGrepToolOptions {
	/** Override the binary path. Default: "ast-grep" on PATH. */
	binaryPath?: string;
	/**
	 * Search backend. `"napi"` (default) runs the same Rust engine in-process via
	 * `@ast-grep/napi` — no process spawn, no PATH dependency — for its supported
	 * subset (built-in langs ts/tsx/js/html/css, no globs, no context), falling
	 * back to the CLI for everything else or when the native package is absent.
	 * `"cli"` forces the legacy `ast-grep` CLI for every query. Behavior-identical
	 * on the supported subset.
	 */
	engine?: "napi" | "cli";
}

export interface AstGrepMatch {
	file?: string;
	range?: {
		start?: { line?: number; column?: number };
		end?: { line?: number; column?: number };
	};
	text?: string;
	lines?: string;
}

function formatMatches(matches: AstGrepMatch[], cwd: string): string {
	const byFile = new Map<string, AstGrepMatch[]>();
	for (const m of matches) {
		const file = m.file || "<unknown>";
		const list = byFile.get(file);
		if (list) list.push(m);
		else byFile.set(file, [m]);
	}
	const out: string[] = [];
	for (const [file, items] of byFile) {
		// Prefer relative paths when inside cwd.
		let displayFile = file;
		try {
			const rel = nodePath.relative(cwd, file);
			if (rel && !rel.startsWith("..") && !nodePath.isAbsolute(rel)) displayFile = rel.replace(/\\/g, "/");
		} catch {
			// ignore
		}
		out.push(displayFile);
		for (const m of items) {
			const startLine = m.range?.start?.line;
			const startCol = m.range?.start?.column;
			const loc = typeof startLine === "number" ? `${startLine + 1}:${(startCol ?? 0) + 1}` : "?";
			const body = (m.lines || m.text || "").replace(/\r/g, "").trimEnd();
			const firstLine = body.split("\n")[0] ?? "";
			out.push(`  ${loc}: ${firstLine}`);
			if (body.includes("\n")) {
				const extra = body.split("\n").slice(1);
				for (const e of extra) out.push(`         ${e}`);
			}
		}
	}
	return out.join("\n");
}

function formatAstGrepCall(
	args: { pattern?: string; path?: string; lang?: string; limit?: number } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	cwd?: string,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".", cwd) : null;
	const lang = str(args?.lang);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("ast_grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", pattern || ""));
	text += theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (lang) text += theme.fg("toolOutput", ` (${lang})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}

function formatAstGrepResult(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> },
	options: ToolRenderResultOptions,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 15;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
	if (remaining > 0) text += `\n${moreLinesTrailer(remaining, expandKeyHint())}`;
	return text;
}

export function runAstGrep(
	binary: string,
	args: string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const strategy = resolveAstGrepSpawnStrategy(binary, args);
		const child = execFile(
			strategy.command,
			strategy.args,
			{ cwd, signal, maxBuffer: 64 * 1024 * 1024, shell: strategy.useShell, windowsHide: true },
			(err, stdout, stderr) => {
				if (err) {
					const e = err as NodeJS.ErrnoException & { code?: string | number };
					if (isMissingBinaryError(err)) {
						reject(Object.assign(new Error(AST_GREP_INSTALL_HINT), { __astGrepMissing: true }));
						return;
					}
					// Output exceeded maxBuffer: the child was killed and stdout is partial.
					// Surfacing the partial NDJSON as a complete result would silently truncate
					// the match set, so reject explicitly and let the caller narrow the search.
					if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /maxBuffer/.test(err.message ?? "")) {
						reject(
							Object.assign(new Error("ast-grep output exceeded the buffer limit"), { __astGrepOverflow: true }),
						);
						return;
					}
					// Non-zero exit code: still resolve with stderr so callers can choose what to do.
					const code = typeof e.code === "number" ? e.code : 1;
					resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? String(err) });
					return;
				}
				resolve({ code: 0, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
			},
		);
		// execFile already supports signal natively; nothing else to wire.
		void child;
	});
}

export function createAstGrepToolDefinition(
	cwd: string,
	options?: AstGrepToolOptions,
): ToolDefinition<typeof astGrepSchema, AstGrepToolDetails | undefined> {
	const binary = options?.binaryPath ?? "ast-grep";
	const engine = options?.engine ?? "napi";
	return {
		name: "ast_grep",
		activity: "navigation",
		label: "ast_grep",
		description: `Structural code search via ast-grep.\`pattern\` is an ast-grep pattern (not regex), e.g. "console.log($X)". Use $METAVAR to capture nodes. Optionally pin language with \`lang\` (ts, tsx, js, py, rs, ...). Returns matches grouped by file with line:col locations. Use only for structural/AST patterns; for literal text or regex, \`grep\` is faster. Runs in-process for built-in languages (ts/tsx/js/html/css); other languages (py, rs, go) use the ast-grep CLI, which must be on PATH — the tool errors with "${AST_GREP_INSTALL_HINT}" if it is absent.`,
		promptSnippet: "Structural AST search (ast-grep). Patterns like console.log($X). Capture with $METAVAR.",
		parameters: astGrepSchema,
		prepareArguments: prepareWithPathAliases,
		async execute(_toolCallId, input: AstGrepToolInput, signal?: AbortSignal) {
			const { pattern, lang, path: searchPath, globs, context, limit } = input;
			const target = resolveToCwd(searchPath || ".", cwd);
			const effectiveLimit = Math.min(MAX_LIMIT, Math.max(1, limit ?? DEFAULT_LIMIT));

			// Shared tail: cap, format, and shape the tool result the same way for
			// both the napi backend and the CLI so output is identical.
			const buildResult = (all: AstGrepMatch[]) => {
				const matchLimitReached = all.length > effectiveLimit;
				const capped = matchLimitReached ? all.slice(0, effectiveLimit) : all;
				if (capped.length === 0) {
					return {
						content: [{ type: "text" as const, text: noMatchesMessage(globs) }],
						details: { matchCount: 0 },
					};
				}
				let text = formatMatches(capped, cwd);
				if (matchLimitReached) {
					text += `\n\n[${effectiveLimit} matches limit reached. Use limit=${Math.min(MAX_LIMIT, effectiveLimit * 2)} or refine pattern]`;
				}
				return {
					content: [{ type: "text" as const, text }],
					details: { matchCount: capped.length, matchLimitReached },
				};
			};

			// napi backend: in-process, no spawn, no PATH dependency. Engaged when
			// opted in (default) AND the query is within napi's supported subset —
			// a built-in language, no globs, no context. Everything else, and any
			// napi failure (astGrepNapiSearch returns null, never throws), falls
			// through to the CLI below.
			// A specific single-file `path` whose extension maps to a napi built-in
			// language becomes eligible even when `lang` is omitted — the CLI already
			// infers per-file language from `target`, so this only widens the napi
			// fast-path to match the schema's documented inference behavior.
			const effectiveLang = lang ?? NAPI_EXT_TO_LANG[nodePath.extname(target).toLowerCase()];
			const napiEligible =
				engine === "napi" &&
				isNapiSupportedLang(effectiveLang) &&
				!(globs && globs.length > 0) &&
				!(context && context > 0);
			if (napiEligible && effectiveLang) {
				const napiMatches = await astGrepNapiSearch({ pattern, lang: effectiveLang, target });
				if (signal?.aborted) throw new Error("Operation aborted");
				if (napiMatches) return buildResult(napiMatches);
				// null → unsupported/failed at runtime → fall through to the CLI.
			}

			const args: string[] = ["run", "--pattern", pattern];
			if (lang) args.push("--lang", lang);
			if (globs) for (const g of globs) args.push("--globs", g);
			if (context && context > 0) args.push("--context", String(context));
			args.push("--json=stream");
			args.push(target);

			let res: { code: number; stdout: string; stderr: string };
			try {
				res = await runAstGrep(binary, args, cwd, signal);
			} catch (err) {
				if ((err as { __astGrepMissing?: boolean }).__astGrepMissing) {
					return {
						content: [{ type: "text" as const, text: AST_GREP_INSTALL_HINT }],
						isError: true,
						details: undefined,
					};
				}
				if ((err as { __astGrepOverflow?: boolean }).__astGrepOverflow) {
					return {
						content: [
							{
								type: "text" as const,
								text: "ast-grep produced more than 64MB of output and was truncated; results are incomplete. Narrow the search with a more specific pattern, a smaller `path`, `lang`, or `globs`.",
							},
						],
						isError: true,
						details: undefined,
					};
				}
				throw err;
			}

			if (res.code !== 0 && res.code !== 1) {
				const msg = res.stderr.trim() || `ast-grep exited with code ${res.code}`;
				return { content: [{ type: "text" as const, text: msg }], isError: true, details: undefined };
			}

			const all = parseJsonStream<AstGrepMatch>(res.stdout);
			return buildResult(all);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatAstGrepCall(args, theme, context.cwd));
			return text;
		},
		renderResult(result, opts, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatAstGrepResult(result, opts, theme, context.showImages));
			return text;
		},
	};
}

export function createAstGrepTool(cwd: string, options?: AstGrepToolOptions): AgentTool<typeof astGrepSchema> {
	return wrapToolDefinition(createAstGrepToolDefinition(cwd, options));
}
