/**
 * URI conversion, symbol/column resolution, diagnostic & symbol formatting,
 * and glob expansion for the LSP module. Output is plain ASCII (no theme
 * icons) since these strings are consumed by the model, not the TUI.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { globIterate } from "glob";
import { isEnoent, sleep, throwIfAborted } from "./internal.ts";
import type {
	CodeAction,
	Command,
	Diagnostic,
	DiagnosticSeverity,
	DocumentSymbol,
	Location,
	LspClient,
	LspToolDetails,
	PublishedDiagnostics,
	SymbolInformation,
	SymbolKind,
	WorkspaceEdit,
} from "./types.ts";
import { SYMBOL_KIND_NAMES } from "./types.ts";

// =============================================================================
// Tool Result
// =============================================================================

export type TextResult = {
	content: Array<{ type: "text"; text: string }>;
	details: LspToolDetails;
};

export function textResult(text: string, details: LspToolDetails): TextResult {
	return { content: [{ type: "text", text }], details };
}

// =============================================================================
// URI Handling (Cross-Platform)
// =============================================================================

// Characters that must NOT be percent-encoded in a file URI path: the RFC 3986
// unreserved set plus the sub-delims and ':'/'@' that are legal in a path
// segment. Keeping these verbatim makes common paths (incl. `node_modules/@scope`
// and the Windows drive letter `C:`) byte-identical to the previous output;
// everything else — space, '#', '?', '%', non-ASCII — is encoded. The `u` flag
// keeps surrogate pairs (emoji, CJK supplementary) intact through the encoder.
const UNSAFE_URI_PATH_CHARS = /[^A-Za-z0-9\-._~!$&'()*+,;=:@/]/gu;

function encodeUriPath(forwardSlashPath: string): string {
	return forwardSlashPath.replace(UNSAFE_URI_PATH_CHARS, (ch) => encodeURIComponent(ch));
}

/** Convert a file path to a file:// URI. Handles Windows drive letters. */
export function fileToUri(filePath: string): string {
	const resolved = path.resolve(filePath);
	if (process.platform === "win32") {
		return `file:///${encodeUriPath(resolved.replace(/\\/g, "/"))}`;
	}
	return `file://${encodeUriPath(resolved)}`;
}

/** Convert a file:// URI back to a file path. Handles Windows drive letters. */
export function uriToFile(uri: string): string {
	if (!uri.startsWith("file://")) return uri;
	const raw = uri.slice(7);
	let filePath: string;
	try {
		filePath = decodeURIComponent(raw);
	} catch {
		// Malformed percent-encoding from a misbehaving server: fall back to raw.
		filePath = raw;
	}
	if (process.platform === "win32" && filePath.startsWith("/") && /^[A-Za-z]:/.test(filePath.slice(1))) {
		filePath = filePath.slice(1);
	}
	return filePath;
}

/** Format a path relative to cwd, using forward slashes; absolute fallback. */
export function formatPathRelativeToCwd(filePath: string, cwd: string): string {
	const rel = path.relative(cwd, filePath);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
		return filePath.replace(/\\/g, "/");
	}
	return rel.split(path.sep).join("/");
}

// =============================================================================
// Language ID Detection
// =============================================================================

const LANGUAGE_BY_EXT: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescriptreact",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascriptreact",
	".mjs": "javascript",
	".cjs": "javascript",
	".rs": "rust",
	".go": "go",
	".mod": "go.mod",
	".sum": "go.sum",
	".py": "python",
	".pyi": "python",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".cc": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hxx": "cpp",
	".m": "objective-c",
	".mm": "objective-cpp",
	".zig": "zig",
	".java": "java",
	".kt": "kotlin",
	".kts": "kotlin",
	".scala": "scala",
	".sbt": "scala",
	".sc": "scala",
	".hs": "haskell",
	".lhs": "haskell",
	".ml": "ocaml",
	".mli": "ocaml",
	".ex": "elixir",
	".exs": "elixir",
	".heex": "elixir",
	".eex": "elixir",
	".erl": "erlang",
	".hrl": "erlang",
	".gleam": "gleam",
	".rb": "ruby",
	".rake": "ruby",
	".gemspec": "ruby",
	".erb": "eruby",
	".sh": "shellscript",
	".bash": "shellscript",
	".zsh": "shellscript",
	".lua": "lua",
	".php": "php",
	".phtml": "php",
	".cs": "csharp",
	".csx": "csharp",
	".yaml": "yaml",
	".yml": "yaml",
	".tf": "terraform",
	".tfvars": "terraform",
	".tpl": "helm",
	".nix": "nix",
	".odin": "odin",
	".dart": "dart",
	".md": "markdown",
	".markdown": "markdown",
	".tex": "latex",
	".bib": "bibtex",
	".sty": "latex",
	".cls": "latex",
	".graphql": "graphql",
	".gql": "graphql",
	".prisma": "prisma",
	".vim": "vim",
	".vimrc": "vim",
	".html": "html",
	".htm": "html",
	".css": "css",
	".scss": "scss",
	".sass": "sass",
	".less": "less",
	".json": "json",
	".jsonc": "jsonc",
	".vue": "vue",
	".svelte": "svelte",
	".astro": "astro",
	".swift": "swift",
	".tla": "tlaplus",
	".tlaplus": "tlaplus",
	".dockerfile": "dockerfile",
};

/** Map a file path to an LSP languageId based on its extension/basename. */
export function detectLanguageId(filePath: string): string {
	const base = path.basename(filePath).toLowerCase();
	if (base === "dockerfile") return "dockerfile";
	const ext = path.extname(filePath).toLowerCase();
	return LANGUAGE_BY_EXT[ext] ?? "plaintext";
}

// =============================================================================
// Diagnostic Formatting
// =============================================================================

const SEVERITY_NAMES: Record<DiagnosticSeverity, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

export function severityToString(severity?: DiagnosticSeverity): string {
	return SEVERITY_NAMES[severity ?? 1] ?? "unknown";
}

export function sortDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
	return diagnostics.sort((a, b) => {
		const aSeverity = a.severity ?? 1;
		const bSeverity = b.severity ?? 1;
		if (aSeverity !== bSeverity) return aSeverity - bSeverity;
		const aLine = a.range.start.line;
		const bLine = b.range.start.line;
		if (aLine !== bLine) return aLine - bLine;
		const aCol = a.range.start.character;
		const bCol = b.range.start.character;
		if (aCol !== bCol) return aCol - bCol;
		return a.message.localeCompare(b.message);
	});
}

function stripDiagnosticNoise(message: string): string {
	return message
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim();
			if (trimmed.startsWith("for further information visit")) return false;
			if (/^https?:\/\//.test(trimmed)) return false;
			return true;
		})
		.join("\n")
		.trim();
}

const DIAGNOSTIC_TAG_NAMES: Record<number, string> = { 1: "unnecessary", 2: "deprecated" };

function formatDiagnosticTags(tags?: number[]): string {
	if (!tags || tags.length === 0) return "";
	const names: string[] = [];
	for (const tag of tags) {
		const name = DIAGNOSTIC_TAG_NAMES[tag];
		if (name) names.push(`[${name}]`);
	}
	return names.length > 0 ? ` ${names.join("")}` : "";
}

export function formatDiagnostic(diagnostic: Diagnostic, filePath: string, cwd?: string): string {
	const severity = severityToString(diagnostic.severity);
	const line = diagnostic.range.start.line + 1;
	const col = diagnostic.range.start.character + 1;
	const source = diagnostic.source ? `[${diagnostic.source}] ` : "";
	const code = diagnostic.code ? ` (${diagnostic.code})` : "";
	const tags = formatDiagnosticTags(diagnostic.tags);
	const message = stripDiagnosticNoise(diagnostic.message);
	let result = `${filePath}:${line}:${col} [${severity}] ${source}${message}${tags}${code}`;
	if (diagnostic.relatedInformation && diagnostic.relatedInformation.length > 0) {
		for (const related of diagnostic.relatedInformation) {
			const relFile = uriToFile(related.location.uri);
			const relPath = cwd !== undefined ? formatPathRelativeToCwd(relFile, cwd) : relFile.replace(/\\/g, "/");
			const relLine = related.location.range.start.line + 1;
			const relCol = related.location.range.start.character + 1;
			result += `\n  -> ${relPath}:${relLine}:${relCol} ${related.message}`;
		}
	}
	return result;
}

/** Join pre-formatted diagnostic messages (already path-prefixed). */
export function formatGroupedDiagnosticMessages(messages: string[]): string {
	return messages.join("\n");
}

export function formatDiagnosticsSummary(diagnostics: Diagnostic[]): string {
	const counts = { error: 0, warning: 0, info: 0, hint: 0 };
	for (const d of diagnostics) {
		const sev = severityToString(d.severity);
		if (sev in counts) counts[sev as keyof typeof counts]++;
	}
	const parts: string[] = [];
	if (counts.error > 0) parts.push(`${counts.error} error(s)`);
	if (counts.warning > 0) parts.push(`${counts.warning} warning(s)`);
	if (counts.info > 0) parts.push(`${counts.info} info(s)`);
	if (counts.hint > 0) parts.push(`${counts.hint} hint(s)`);
	return parts.length > 0 ? parts.join(", ") : "no issues";
}

/** Drop diagnostics with an identical range + message (e.g. reported by two servers). */
export function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
	const seen = new Set<string>();
	const unique: Diagnostic[] = [];
	for (const d of diagnostics) {
		const key = `${d.range.start.line}:${d.range.start.character}:${d.range.end.line}:${d.range.end.character}:${d.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(d);
	}
	return unique;
}

// =============================================================================
// Diagnostics Waiting
// =============================================================================

export interface WaitForDiagnosticsOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	minVersion?: number;
	expectedDocumentVersion?: number;
	allowUnversioned?: boolean;
}

function getAcceptedDiagnostics(
	published: PublishedDiagnostics | undefined,
	expectedDocumentVersion?: number,
	allowUnversioned = true,
): Diagnostic[] | undefined {
	if (!published) return undefined;
	if (expectedDocumentVersion === undefined) return published.diagnostics;
	if (published.version === expectedDocumentVersion) return published.diagnostics;
	if (allowUnversioned && published.version == null) return published.diagnostics;
	return undefined;
}

/**
 * Poll a client's published diagnostics for `uri` until they satisfy the version
 * constraints or `timeoutMs` elapses. Throws if the signal aborts.
 */
export async function waitForDiagnostics(
	client: LspClient,
	uri: string,
	options: WaitForDiagnosticsOptions = {},
): Promise<Diagnostic[]> {
	const { timeoutMs = 3000, signal, minVersion, expectedDocumentVersion, allowUnversioned = true } = options;
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		throwIfAborted(signal);
		const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
		const diagnostics = getAcceptedDiagnostics(
			client.diagnostics.get(uri),
			expectedDocumentVersion,
			allowUnversioned,
		);
		if (diagnostics !== undefined && versionOk) return diagnostics;
		await sleep(100);
	}
	const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
	if (!versionOk) return [];
	return getAcceptedDiagnostics(client.diagnostics.get(uri), expectedDocumentVersion, allowUnversioned) ?? [];
}

// =============================================================================
// Location Formatting
// =============================================================================

export function formatLocation(location: Location, cwd: string): string {
	const file = formatPathRelativeToCwd(uriToFile(location.uri), cwd);
	const line = location.range.start.line + 1;
	const col = location.range.start.character + 1;
	return `${file}:${line}:${col}`;
}

// =============================================================================
// WorkspaceEdit Formatting
// =============================================================================

export function formatWorkspaceEdit(edit: WorkspaceEdit, cwd: string): string[] {
	const results: string[] = [];
	if (edit.changes) {
		for (const [uri, textEdits] of Object.entries(edit.changes)) {
			const file = formatPathRelativeToCwd(uriToFile(uri), cwd);
			results.push(`${file}: ${textEdits.length} edit${textEdits.length > 1 ? "s" : ""}`);
		}
	}
	if (edit.documentChanges) {
		for (const change of edit.documentChanges) {
			if ("edits" in change && change.textDocument) {
				const file = formatPathRelativeToCwd(uriToFile(change.textDocument.uri), cwd);
				results.push(`${file}: ${change.edits.length} edit${change.edits.length > 1 ? "s" : ""}`);
			} else if ("kind" in change) {
				switch (change.kind) {
					case "create":
						results.push(`CREATE: ${formatPathRelativeToCwd(uriToFile(change.uri), cwd)}`);
						break;
					case "rename":
						results.push(
							`RENAME: ${formatPathRelativeToCwd(uriToFile(change.oldUri), cwd)} -> ${formatPathRelativeToCwd(uriToFile(change.newUri), cwd)}`,
						);
						break;
					case "delete":
						results.push(`DELETE: ${formatPathRelativeToCwd(uriToFile(change.uri), cwd)}`);
						break;
				}
			}
		}
	}
	return results;
}

// =============================================================================
// Symbol Formatting
// =============================================================================

export function symbolKindToName(kind: SymbolKind): string {
	return SYMBOL_KIND_NAMES[kind] ?? "Unknown";
}

export function formatDocumentSymbol(symbol: DocumentSymbol, indent = 0): string[] {
	const prefix = "  ".repeat(indent);
	const kind = symbolKindToName(symbol.kind);
	const line = symbol.range.start.line + 1;
	const detail = symbol.detail ? ` ${symbol.detail}` : "";
	const results = [`${prefix}[${kind}] ${symbol.name}${detail} @ line ${line}`];
	if (symbol.children) {
		for (const child of symbol.children) {
			results.push(...formatDocumentSymbol(child, indent + 1));
		}
	}
	return results;
}

export function formatSymbolInformation(symbol: SymbolInformation, cwd: string): string {
	const kind = symbolKindToName(symbol.kind);
	const location = formatLocation(symbol.location, cwd);
	const container = symbol.containerName ? ` (${symbol.containerName})` : "";
	return `[${kind}] ${symbol.name}${container} @ ${location}`;
}

export function filterWorkspaceSymbols(symbols: SymbolInformation[], query: string): SymbolInformation[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return symbols;
	return symbols.filter((symbol) => {
		const fields = [symbol.name, symbol.containerName ?? "", uriToFile(symbol.location.uri)];
		return fields.some((field) => field.toLowerCase().includes(needle));
	});
}

export function dedupeWorkspaceSymbols(symbols: SymbolInformation[]): SymbolInformation[] {
	const seen = new Set<string>();
	const unique: SymbolInformation[] = [];
	for (const symbol of symbols) {
		const key = [
			symbol.name,
			symbol.containerName ?? "",
			symbol.kind,
			symbol.location.uri,
			symbol.location.range.start.line,
			symbol.location.range.start.character,
		].join(":");
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(symbol);
	}
	return unique;
}

export function formatCodeAction(action: CodeAction | Command, index: number): string {
	const kind = "kind" in action && action.kind ? action.kind : "action";
	const preferred = "isPreferred" in action && action.isPreferred ? " (preferred)" : "";
	const disabled = "disabled" in action && action.disabled ? ` (disabled: ${action.disabled.reason})` : "";
	return `${index}: [${kind}] ${action.title}${preferred}${disabled}`;
}

export interface CodeActionApplyDependencies {
	resolveCodeAction?: (action: CodeAction) => Promise<CodeAction>;
	applyWorkspaceEdit: (edit: WorkspaceEdit) => Promise<string[]>;
	executeCommand: (command: Command) => Promise<void>;
}

export interface AppliedCodeActionResult {
	title: string;
	edits: string[];
	executedCommands: string[];
}

function isCommandItem(action: CodeAction | Command): action is Command {
	return typeof action.command === "string";
}

export async function applyCodeAction(
	action: CodeAction | Command,
	dependencies: CodeActionApplyDependencies,
): Promise<AppliedCodeActionResult | null> {
	if (isCommandItem(action)) {
		await dependencies.executeCommand(action);
		return { title: action.title, edits: [], executedCommands: [action.command] };
	}

	let resolvedAction = action;
	if (!resolvedAction.edit && dependencies.resolveCodeAction) {
		try {
			resolvedAction = await dependencies.resolveCodeAction(resolvedAction);
		} catch {
			// Resolve is optional; continue with unresolved action.
		}
	}

	const edits = resolvedAction.edit ? await dependencies.applyWorkspaceEdit(resolvedAction.edit) : [];
	const executedCommands: string[] = [];
	if (resolvedAction.command) {
		await dependencies.executeCommand(resolvedAction.command);
		executedCommands.push(resolvedAction.command.command);
	}

	if (edits.length === 0 && executedCommands.length === 0) {
		return null;
	}
	return { title: resolvedAction.title, edits, executedCommands };
}

// =============================================================================
// Glob Expansion
// =============================================================================

const GLOB_PATTERN_CHARS = /[*?[{]/;

export function hasGlobPattern(value: string): boolean {
	return GLOB_PATTERN_CHARS.test(value);
}

export async function collectGlobMatches(
	pattern: string,
	cwd: string,
	maxMatches: number,
): Promise<{ matches: string[]; truncated: boolean }> {
	const normalizedLimit = Number.isFinite(maxMatches) ? Math.max(1, Math.trunc(maxMatches)) : 1;
	const matches: string[] = [];
	for await (const match of globIterate(pattern, { cwd, nodir: true, dot: false })) {
		if (matches.length >= normalizedLimit) {
			return { matches, truncated: true };
		}
		matches.push(match);
	}
	return { matches, truncated: false };
}

export async function resolveDiagnosticTargets(
	file: string,
	cwd: string,
	maxMatches: number,
): Promise<{ matches: string[]; truncated: boolean }> {
	if (!hasGlobPattern(file)) {
		return { matches: [file], truncated: false };
	}
	const resolved = path.isAbsolute(file) ? file : path.resolve(cwd, file);
	try {
		const stat = await fs.stat(resolved);
		if (stat.isFile()) {
			return { matches: [file], truncated: false };
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	return collectGlobMatches(file, cwd, maxMatches);
}

// =============================================================================
// Hover Content Extraction
// =============================================================================

export function extractHoverText(
	contents: string | { kind: string; value: string } | { language: string; value: string } | unknown[],
): string {
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents)) {
		return contents.map((c) => extractHoverText(c as string | { kind: string; value: string })).join("\n\n");
	}
	if (typeof contents === "object" && contents !== null) {
		if ("value" in contents && typeof contents.value === "string") {
			return contents.value;
		}
	}
	return String(contents);
}

// =============================================================================
// Symbol Column Resolution
// =============================================================================

function firstNonWhitespaceColumn(lineText: string): number {
	const match = lineText.match(/\S/);
	return match ? (match.index ?? 0) : 0;
}

const BARE_IDENTIFIER_RE = /^[$A-Za-z_][\w$]*$/;
const IDENTIFIER_CHAR_RE = /[A-Za-z0-9_$]/;

function findSymbolMatchIndexes(lineText: string, symbol: string, caseInsensitive = false): number[] {
	if (symbol.length === 0) return [];
	const haystack = caseInsensitive ? lineText.toLowerCase() : lineText;
	const needle = caseInsensitive ? symbol.toLowerCase() : symbol;
	const requireWordBoundary = BARE_IDENTIFIER_RE.test(symbol);
	const indexes: number[] = [];
	let fromIndex = 0;
	while (fromIndex <= haystack.length - needle.length) {
		const matchIndex = haystack.indexOf(needle, fromIndex);
		if (matchIndex === -1) break;
		if (requireWordBoundary) {
			const before = matchIndex > 0 ? haystack[matchIndex - 1] : "";
			const afterIdx = matchIndex + needle.length;
			const after = afterIdx < haystack.length ? haystack[afterIdx] : "";
			if (IDENTIFIER_CHAR_RE.test(before) || IDENTIFIER_CHAR_RE.test(after)) {
				fromIndex = matchIndex + 1;
				continue;
			}
		}
		indexes.push(matchIndex);
		fromIndex = matchIndex + needle.length;
	}
	return indexes;
}

/**
 * Parse a symbol spec of the form `name` or `name#N` (N = 1-indexed occurrence
 * on the target line). Greedy on `.+` so `#name#2` parses as symbol=`#name`,
 * occurrence 2.
 */
function parseSymbolSpec(spec: string): { symbol: string; occurrence: number } {
	const match = spec.match(/^(.+)#(\d+)$/);
	if (!match) return { symbol: spec, occurrence: 1 };
	const occurrence = Math.max(1, Number.parseInt(match[2], 10));
	return { symbol: match[1], occurrence };
}

export async function resolveSymbolColumn(filePath: string, line: number, symbolSpec?: string): Promise<number> {
	const lineNumber = Math.max(1, line);
	try {
		const fileText = await fs.readFile(filePath, "utf-8");
		const lines = fileText.split("\n");
		const targetLine = lines[lineNumber - 1] ?? "";
		if (!symbolSpec) {
			return firstNonWhitespaceColumn(targetLine);
		}
		const { symbol, occurrence } = parseSymbolSpec(symbolSpec);
		const exactIndexes = findSymbolMatchIndexes(targetLine, symbol);
		const fallbackIndexes = exactIndexes.length > 0 ? exactIndexes : findSymbolMatchIndexes(targetLine, symbol, true);
		if (fallbackIndexes.length === 0) {
			throw new Error(`Symbol "${symbol}" not found on line ${lineNumber}`);
		}
		if (occurrence > fallbackIndexes.length) {
			throw new Error(
				`Symbol "${symbol}" occurrence ${occurrence} is out of bounds on line ${lineNumber} (found ${fallbackIndexes.length})`,
			);
		}
		return fallbackIndexes[occurrence - 1];
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`File not found: ${filePath}`);
		}
		throw error;
	}
}

export async function readLocationContext(filePath: string, line: number, contextLines = 1): Promise<string[]> {
	const targetLine = Math.max(1, line);
	const surrounding = Math.max(0, contextLines);
	try {
		const fileText = await fs.readFile(filePath, "utf-8");
		const lines = fileText.split("\n");
		if (lines.length === 0) return [];
		const startLine = Math.max(1, targetLine - surrounding);
		const endLine = Math.min(lines.length, targetLine + surrounding);
		const context: string[] = [];
		for (let currentLine = startLine; currentLine <= endLine; currentLine++) {
			const content = lines[currentLine - 1] ?? "";
			context.push(`${currentLine}: ${content}`);
		}
		return context;
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}
