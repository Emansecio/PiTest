import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { prepareWithPathAliases } from "./argument-prep.js";
import { resolveReadPath } from "./path-utils.js";
import { getTextOutput, invalidArgText, replaceTabs, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const symbolSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file (relative or absolute)" }),
		name: Type.String({ description: "Symbol name to extract (function, class, type, const, def)" }),
	},
	{ additionalProperties: false },
);

export type SymbolToolInput = Static<typeof symbolSchema>;

export interface SymbolToolDetails {
	startLine: number;
	endLine: number;
	totalLines: number;
}

export interface SymbolOperations {
	readFile: (absolutePath: string) => Promise<Buffer>;
	access: (absolutePath: string) => Promise<void>;
}

const defaultSymbolOperations: SymbolOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
};

export interface SymbolToolOptions {
	operations?: SymbolOperations;
}

type SymbolKind = "brace" | "indent" | "unknown";

function detectKind(path: string): SymbolKind {
	const lower = path.toLowerCase();
	if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|java|c|cc|cpp|h|hpp|cs|go|rs|swift|kt|kts|scala|php|m|mm)$/.test(lower)) {
		return "brace";
	}
	if (/\.(py|pyi|rb)$/.test(lower)) return "indent";
	return "unknown";
}

const declarationPatternCache = new Map<string, RegExp[]>();
const MAX_DECLARATION_PATTERN_CACHE = 256;

function buildDeclarationPatterns(name: string, kind: SymbolKind): RegExp[] {
	const key = `${kind}:${name}`;
	const cached = declarationPatternCache.get(key);
	if (cached) return cached;
	const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const patterns: RegExp[] = [];
	if (kind === "brace") {
		patterns.push(
			new RegExp(
				`^\\s*(export\\s+(default\\s+)?)?(async\\s+)?(function\\*?|class|interface|type|enum|namespace|const|let|var)\\s+${esc}\\b`,
			),
			new RegExp(`^\\s*(public|private|protected|static|async|readonly|abstract|override|\\s)*\\s${esc}\\s*[(<]`),
			new RegExp(`^\\s*${esc}\\s*[:=]\\s*(async\\s*)?(\\([^)]*\\)|<[^>]*>|function\\b)`),
			new RegExp(`^\\s*func\\s+(\\([^)]*\\)\\s+)?${esc}\\s*[(<]`),
		);
	} else if (kind === "indent") {
		patterns.push(new RegExp(`^\\s*(async\\s+)?(def|class)\\s+${esc}\\b`));
	} else {
		patterns.push(new RegExp(`\\b${esc}\\b`));
	}
	if (declarationPatternCache.size >= MAX_DECLARATION_PATTERN_CACHE) {
		const firstKey = declarationPatternCache.keys().next().value;
		if (firstKey !== undefined) declarationPatternCache.delete(firstKey);
	}
	declarationPatternCache.set(key, patterns);
	return patterns;
}

function findDeclarationLine(lines: string[], name: string, kind: SymbolKind): number {
	const patterns = buildDeclarationPatterns(name, kind);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		for (const pattern of patterns) {
			if (pattern.test(line)) return i;
		}
	}
	return -1;
}

function stripTrailingComment(line: string): string {
	let inString: string | null = null;
	for (let j = 0; j < line.length; j++) {
		const ch = line[j];
		const next = line[j + 1];
		if (inString) {
			if (ch === "\\") {
				j++;
				continue;
			}
			if (ch === inString) inString = null;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") {
			inString = ch;
			continue;
		}
		if (ch === "/" && next === "/") return line.slice(0, j);
	}
	return line;
}

function findBraceBlockEnd(lines: string[], startLine: number): number {
	let bodyOpenLine = -1;
	let bodyOpenCol = -1;
	for (let i = startLine; i < lines.length && i < startLine + 30; i++) {
		const noComment = stripTrailingComment(lines[i]!);
		const trimmedRight = noComment.replace(/\s+$/, "");
		if (trimmedRight === "") continue;
		const lastChar = trimmedRight[trimmedRight.length - 1];
		if (lastChar === "{") {
			bodyOpenLine = i;
			bodyOpenCol = noComment.lastIndexOf("{");
			break;
		}
		if (lastChar === ";") return i;
	}
	if (bodyOpenLine === -1) return Math.min(startLine + 20, lines.length - 1);

	let depth = 0;
	let inString: string | null = null;
	let inLineComment = false;
	let inBlockComment = false;
	let templateDepth = 0;
	for (let i = bodyOpenLine; i < lines.length; i++) {
		const line = lines[i]!;
		inLineComment = false;
		const startCol = i === bodyOpenLine ? bodyOpenCol : 0;
		for (let j = startCol; j < line.length; j++) {
			const ch = line[j]!;
			const next = line[j + 1];
			if (inLineComment) break;
			if (inBlockComment) {
				if (ch === "*" && next === "/") {
					inBlockComment = false;
					j++;
				}
				continue;
			}
			if (inString) {
				if (ch === "\\") {
					j++;
					continue;
				}
				if (inString === "`" && ch === "$" && next === "{") {
					templateDepth++;
					j++;
					continue;
				}
				if (ch === inString) inString = null;
				continue;
			}
			if (templateDepth > 0 && ch === "}") {
				templateDepth--;
				inString = "`";
				continue;
			}
			if (ch === "/" && next === "/") {
				inLineComment = true;
				break;
			}
			if (ch === "/" && next === "*") {
				inBlockComment = true;
				j++;
				continue;
			}
			if (ch === '"' || ch === "'" || ch === "`") {
				inString = ch;
				continue;
			}
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) return i;
			}
		}
	}
	return lines.length - 1;
}

function getIndent(line: string): number {
	let n = 0;
	for (const ch of line) {
		if (ch === " ") n++;
		else if (ch === "\t") n += 8;
		else break;
	}
	return n;
}

function findIndentBlockEnd(lines: string[], startLine: number): number {
	const baseIndent = getIndent(lines[startLine]!);
	let lastContent = startLine;
	for (let i = startLine + 1; i < lines.length; i++) {
		const line = lines[i]!;
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		if (getIndent(line) <= baseIndent) return lastContent;
		lastContent = i;
	}
	return lastContent;
}

type SymbolRenderArgs = { path?: string; file_path?: string; name?: string };

function formatSymbolCall(args: SymbolRenderArgs | undefined, theme: Theme, cwd?: string): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const path = rawPath !== null ? shortenPath(rawPath, cwd) : null;
	const name = str(args?.name);
	const invalidArg = invalidArgText(theme);
	const pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
	const nameDisplay = name === null ? invalidArg : name ? theme.fg("accent", `:${name}`) : "";
	return `${theme.fg("toolTitle", theme.bold("symbol"))} ${pathDisplay}${nameDisplay}`;
}

function formatSymbolResult(
	args: SymbolRenderArgs | undefined,
	result: { content: (TextContent | ImageContent)[]; details?: SymbolToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const rawPath = str(args?.file_path ?? args?.path);
	const output = getTextOutput(result, showImages);
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	const maxLines = options.expanded ? renderedLines.length : 15;
	const displayLines = renderedLines.slice(0, maxLines);
	const remaining = renderedLines.length - maxLines;
	let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
	}
	const details = result.details;
	if (details) {
		text += `\n${theme.fg("muted", `[lines ${details.startLine}-${details.endLine} of ${details.totalLines}]`)}`;
	}
	return text;
}

export function createSymbolToolDefinition(
	cwd: string,
	options?: SymbolToolOptions,
): ToolDefinition<typeof symbolSchema, SymbolToolDetails | undefined> {
	const ops = options?.operations ?? defaultSymbolOperations;
	return {
		name: "symbol",
		label: "symbol",
		description:
			"Extract one named symbol (function/class/type/const/def) from a source file — cheaper than read for one declaration. Supports brace (JS/TS, Java, C/C++, Go, Rust, etc.) and indent (Python, Ruby) languages. Heuristic regex, not AST. Use read with offset/limit for line ranges.",
		promptSnippet: "Extract a named symbol from a file (cheaper than reading the full file)",
		parameters: symbolSchema,
		prepareArguments: prepareWithPathAliases,
		async execute(_toolCallId, { path, name }: { path: string; name: string }, signal?: AbortSignal) {
			const absolutePath = resolveReadPath(path, cwd);
			if (signal?.aborted) throw new Error("Operation aborted");
			await ops.access(absolutePath);
			if (signal?.aborted) throw new Error("Operation aborted");
			const buffer = await ops.readFile(absolutePath);
			const text = buffer.toString("utf-8");
			const lines = text.split("\n");
			const kind = detectKind(absolutePath);
			const declLine = findDeclarationLine(lines, name, kind);
			if (declLine < 0) {
				throw new Error(`Symbol "${name}" not found in ${path}. Try grep for cross-file lookup.`);
			}
			let endLine: number;
			if (kind === "indent") {
				endLine = findIndentBlockEnd(lines, declLine);
			} else if (kind === "brace") {
				endLine = findBraceBlockEnd(lines, declLine);
			} else {
				endLine = Math.min(declLine + 20, lines.length - 1);
			}
			const startDisplay = declLine + 1;
			const endDisplay = endLine + 1;
			const body = lines.slice(declLine, endLine + 1).join("\n");
			return {
				content: [{ type: "text", text: body }] as (TextContent | ImageContent)[],
				details: { startLine: startDisplay, endLine: endDisplay, totalLines: lines.length },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSymbolCall(args, theme, context.cwd));
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatSymbolResult(context.args, result, options, theme, context.showImages));
			return text;
		},
	};
}

export function createSymbolTool(cwd: string, options?: SymbolToolOptions): AgentTool<typeof symbolSchema> {
	return wrapToolDefinition(createSymbolToolDefinition(cwd, options));
}
