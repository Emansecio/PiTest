/**
 * `lsp` tool — query language servers for diagnostics, navigation, symbols,
 * renames, code actions, capabilities, and raw requests.
 *
 * Ported from oh-my-pi's LspTool to Pit's TypeBox `ToolDefinition`. The 14
 * actions and their output shapes mirror the upstream semantics; process and
 * filesystem I/O are Node-native.
 */

import { readFile } from "node:fs/promises";
import type { AgentTool } from "@pit/agent-core";
import { type Static, Type } from "typebox";
import { writeFileAtomic } from "../../utils/atomic-write.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { runRenameTransaction } from "../refactor-transaction.ts";
import { resolveToCwd } from "../tools/path-utils.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "../tools/truncate.ts";
import {
	ensureFileOpen,
	getOrCreateClient,
	killClient,
	sendNotification,
	sendRequest,
	syncContent,
	waitForProjectLoaded,
	withServerApplyEdit,
} from "./client.ts";
import { getServerForFile } from "./config.ts";
import { applyWorkspaceEdit, comparePosition } from "./edits.ts";
import { sleep, throwIfAborted } from "./internal.ts";
import { getConfig, getLspServers, isProjectAwareLspServer } from "./manager.ts";
import { rawRequest, renameFile, runCapabilities, runDiagnostics, workspaceSymbols } from "./tool-actions.ts";
import type {
	CodeAction,
	CodeActionContext,
	Command,
	Diagnostic,
	DocumentSymbol,
	Hover,
	Location,
	LocationLink,
	LspClient,
	LspToolDetails,
	Position,
	SymbolInformation,
	WorkspaceEdit,
} from "./types.ts";
import {
	applyCodeAction,
	extractHoverText,
	fileToUri,
	formatCodeAction,
	formatDiagnostic,
	formatDocumentSymbol,
	formatLocation,
	formatPathRelativeToCwd,
	formatWorkspaceEdit,
	isPathInsideCwd,
	readLocationContext,
	resolveSymbolColumn,
	symbolKindToName,
	type TextResult,
	textResult,
	uriToFile,
	waitForDiagnostics,
} from "./utils.ts";

// =============================================================================
// Schema
// =============================================================================

const LSP_ACTIONS = [
	"diagnostics",
	"definition",
	"references",
	"hover",
	"symbols",
	"rename",
	"rename_file",
	"code_actions",
	"type_definition",
	"implementation",
	"status",
	"reload",
	"capabilities",
	"request",
] as const;

/** Actions that don't mutate the workspace — surfaced as passive navigation in the TUI. */
const LSP_READONLY_ACTIONS = new Set<string>([
	"diagnostics",
	"definition",
	"type_definition",
	"implementation",
	"references",
	"hover",
	"symbols",
	"status",
	"capabilities",
]);

const lspSchema = Type.Object(
	{
		action: Type.Enum(LSP_ACTIONS, {
			description:
				"One of: diagnostics, definition, references, hover, symbols, rename, rename_file, code_actions, type_definition, implementation, status, reload, capabilities, request.",
		}),
		file: Type.Optional(
			Type.String({
				description: 'File path, glob (e.g. src/**/*.ts), or "*" for workspace scope; source path for rename_file.',
			}),
		),
		line: Type.Optional(Type.Number({ description: "1-indexed line number for position-based actions." })),
		symbol: Type.Optional(
			Type.String({ description: "Substring on the line to resolve the column. Append #N for the Nth occurrence." }),
		),
		query: Type.Optional(
			Type.String({
				description: "Workspace symbol query, code-action selector, or LSP method name (action=request).",
			}),
		),
		new_name: Type.Optional(
			Type.String({ description: "New symbol name (rename) or destination path (rename_file)." }),
		),
		apply: Type.Optional(
			Type.Boolean({ description: "Apply edits (rename/rename_file default true; code_actions opt-in)." }),
		),
		timeout: Type.Optional(Type.Number({ description: "Request timeout in seconds (clamped 5-60, default 20)." })),
		payload: Type.Optional(
			Type.String({ description: "JSON-encoded params for action=request (overrides auto-built)." }),
		),
	},
	{ additionalProperties: false },
);

export type LspToolInput = Static<typeof lspSchema>;
export interface LspToolOptions {}

// =============================================================================
// Constants
// =============================================================================

const LOCATION_CONTEXT_LINES = 1;
const REFERENCE_CONTEXT_LIMIT = 50;
const REFERENCES_RETRY_COUNT = 2;
const REFERENCES_RETRY_DELAY_MS = 250;
const CODE_ACTION_LIST_LIMIT = 50;
const DOCUMENT_SYMBOL_LINE_LIMIT = 200;

function clampTimeout(timeout: number | undefined): number {
	const value = typeof timeout === "number" && Number.isFinite(timeout) ? Math.round(timeout) : 20;
	return Math.min(60, Math.max(5, value));
}

// =============================================================================
// Location Normalization / Formatting
// =============================================================================

function rangeContainsPosition(range: Location["range"], position: Position): boolean {
	return comparePosition(range.start, position) <= 0 && comparePosition(position, range.end) <= 0;
}

function isOnlyQueriedDeclaration(locations: Location[], uri: string, position: Position): boolean {
	return locations.length === 1 && locations[0]?.uri === uri && rangeContainsPosition(locations[0].range, position);
}

function normalizeLocationResult(result: Location | Location[] | LocationLink | LocationLink[] | null): Location[] {
	if (!result) return [];
	const raw = Array.isArray(result) ? result : [result];
	return raw.flatMap((loc) => {
		if ("uri" in loc) return [loc as Location];
		if ("targetUri" in loc) {
			const link = loc as LocationLink;
			return [{ uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange }];
		}
		return [];
	});
}

async function formatLocationWithContext(location: Location, cwd: string): Promise<string> {
	const header = `  ${formatLocation(location, cwd)}`;
	const filePath = uriToFile(location.uri);
	if (!isPathInsideCwd(filePath, cwd)) return header;
	const context = await readLocationContext(filePath, location.range.start.line + 1, LOCATION_CONTEXT_LINES);
	if (context.length === 0) return header;
	return `${header}\n${context.map((lineText) => `    ${lineText}`).join("\n")}`;
}

// =============================================================================
// Reload helper
// =============================================================================

async function reloadServer(client: LspClient, serverName: string, signal?: AbortSignal): Promise<string> {
	let output = `Restarted ${serverName}`;
	// rust-analyzer/reloadWorkspace is a request (server responds); try it first.
	try {
		await sendRequest(client, "rust-analyzer/reloadWorkspace", null, signal);
		output = `Reloaded ${serverName}`;
	} catch {
		// Method not supported. Fall back to a config-change notification, which
		// is fire-and-forget per LSP (no id, no response) — never await as a request.
		await sendNotification(client, "workspace/didChangeConfiguration", { settings: {} }).catch(() => {});
	}
	if (output.startsWith("Restarted")) killClient(client);
	return output;
}

// =============================================================================
// Model-facing description
// =============================================================================

const LSP_DESCRIPTION = `Interacts with Language Server Protocol servers for code intelligence.

<operations>
- diagnostics: Errors/warnings for a file, a glob of files, or the whole workspace (file: "*")
- definition: Go to symbol definition -> file path + position + source context
- type_definition: Go to symbol type definition -> file path + position + source context
- implementation: Find concrete implementations -> file path + position + source context
- references: Find references -> locations with source context (first 50), rest location-only
- hover: Type info and documentation -> type signature + docs
- symbols: List symbols in a file, or search workspace with file: "*" and a query
- rename: Rename a symbol across the codebase -> preview or apply edits
- rename_file: Rename/move a file or directory; sends workspace/willRenameFiles so servers update import paths -> preview or apply edits + filesystem rename
- code_actions: List quick-fixes/refactors/imports; apply one when apply: true and query matches title or index
- status: Show configured language servers
- capabilities: Dump per-server capabilities for discovery
- request: Send a raw LSP request - query is the method name (e.g. rust-analyzer/expandMacro); use payload for arbitrary JSON params
- reload: Restart a specific server (via file) or all servers with file: "*"
</operations>

<parameters>
- file: File path, glob pattern (e.g. src/**/*.ts), or "*" for workspace scope. "*" routes diagnostics/symbols/reload to their workspace-wide form.
- line: 1-indexed line number for position-based actions
- symbol: Substring on the target line used to resolve the column. Append #N to pick the Nth occurrence (1-indexed) - e.g. foo#2.
- query: Symbol search query, code-action selector, or LSP method name when action=request
- new_name: Required for rename (new identifier) and rename_file (destination path)
- apply: Apply edits for rename/rename_file/code_actions (default true for rename/rename_file; list mode for code_actions unless true)
- payload: JSON-encoded params for action=request
- timeout: Request timeout in seconds (clamped 5-60, default 20)
</parameters>

<critical>
- USE lsp for symbol-aware operations (rename, find references, go to definition/implementation, code actions) whenever a language server is available - it is safer and more accurate than text search.
- NEVER perform cross-file renames with ast_edit, sed, or manual edits when lsp rename can do it. Text-based renames miss shadowing, re-exports, and usages in other files.
- For project-aware references/rename/definition, pass symbol=<name> so the column resolves to the right identifier.
</critical>`;

const PROMPT_SNIPPET = "Query language servers for diagnostics, definitions, references, renames, and code actions.";
const PROMPT_GUIDELINES = [
	"Prefer lsp rename for cross-file symbol renames; it follows re-exports and aliases that text search misses.",
	"Use lsp diagnostics after edits to catch type errors the way an IDE would.",
	"For definition/references/rename, pass symbol=<name> (optionally symbol#N) so the column lands on the right token.",
];

// =============================================================================
// Tool Definition
// =============================================================================

export function createLspToolDefinition(
	cwd: string,
	_options?: LspToolOptions,
): ToolDefinition<typeof lspSchema, LspToolDetails | undefined> {
	return {
		name: "lsp",
		label: "lsp",
		description: LSP_DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: lspSchema,
		activity: (args: { action?: string }) => (LSP_READONLY_ACTIONS.has(args?.action ?? "") ? "navigation" : "action"),
		async execute(_toolCallId, params: LspToolInput, callerSignal): Promise<TextResult> {
			const { action, file, line, symbol, query, new_name, apply } = params;
			const req = params as unknown as Record<string, unknown>;
			const timeoutSec = clampTimeout(params.timeout);
			const timeoutSignal = AbortSignal.timeout(timeoutSec * 1000);
			const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
			throwIfAborted(signal);

			const config = getConfig(cwd);

			// ---- status -------------------------------------------------------
			if (action === "status") {
				const servers = Object.keys(config.servers);
				const text =
					servers.length > 0
						? `Active language servers: ${servers.join(", ")}`
						: "No language servers configured for this project";
				return textResult(text, { action, success: true, request: req });
			}

			// ---- standalone (multi-server / workspace) actions ----------------
			if (action === "diagnostics") {
				return runDiagnostics(cwd, config, params, req, signal, timeoutSec);
			}
			if (action === "rename_file") {
				return renameFile(cwd, config, params, req, signal);
			}
			if (action === "capabilities") {
				return runCapabilities(cwd, config, params, req, signal);
			}
			if (action === "request") {
				return rawRequest(cwd, config, params, req, signal);
			}

			// ---- workspace symbols / reload-all -------------------------------
			const isWorkspace = file === "*";
			const requiresFile = !file && action !== "reload";
			if (requiresFile) {
				throw new Error("file parameter required. Use `*` for workspace scope where supported.");
			}
			const resolvedFile = file && !isWorkspace ? resolveToCwd(file, cwd) : null;

			if (action === "symbols" && (isWorkspace || !resolvedFile)) {
				return workspaceSymbols(cwd, config, query, req, signal);
			}

			if (action === "reload" && (isWorkspace || !resolvedFile)) {
				const servers = getLspServers(config);
				if (servers.length === 0) {
					throw new Error("No language server found for this action");
				}
				const outputs: string[] = [];
				for (const [serverName, serverConfig] of servers) {
					throwIfAborted(signal);
					try {
						const client = await getOrCreateClient(serverConfig, cwd);
						outputs.push(await reloadServer(client, serverName, signal));
					} catch (err) {
						if (signal?.aborted) throw err;
						outputs.push(`Failed to reload ${serverName}: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
				return textResult(outputs.join("\n"), {
					action,
					serverName: servers.map(([name]) => name).join(", "),
					success: true,
					request: req,
				});
			}

			// ---- single-file actions -----------------------------------------
			const serverInfo = resolvedFile ? getServerForFile(config, resolvedFile) : null;
			if (!serverInfo) {
				throw new Error("No language server found for this action");
			}
			const [serverName, serverConfig] = serverInfo;

			try {
				const client = await getOrCreateClient(serverConfig, cwd);
				const targetFile = resolvedFile;
				if (targetFile) await ensureFileOpen(client, targetFile, signal);

				if (
					targetFile &&
					line !== undefined &&
					!symbol &&
					(action === "references" || action === "rename" || action === "definition") &&
					isProjectAwareLspServer(serverConfig)
				) {
					throw new Error(
						`symbol is required for project-aware ${action}; pass symbol=<name>, optionally symbol#N for repeated occurrences`,
					);
				}

				const uri = targetFile ? fileToUri(targetFile) : "";
				const resolvedLine = line ?? 1;
				const resolvedCharacter = targetFile ? await resolveSymbolColumn(targetFile, resolvedLine, symbol) : 0;
				const position = { line: resolvedLine - 1, character: resolvedCharacter };

				const crossFileActions = new Set([
					"definition",
					"type_definition",
					"implementation",
					"references",
					"rename",
				]);
				if (crossFileActions.has(action)) await waitForProjectLoaded(client, signal);

				let output: string;
				switch (action) {
					case "definition":
					case "type_definition":
					case "implementation": {
						const method =
							action === "definition"
								? "textDocument/definition"
								: action === "type_definition"
									? "textDocument/typeDefinition"
									: "textDocument/implementation";
						const label =
							action === "definition"
								? "definition"
								: action === "type_definition"
									? "type definition"
									: "implementation";
						const result = (await sendRequest(client, method, { textDocument: { uri }, position }, signal)) as
							| Location
							| Location[]
							| LocationLink
							| LocationLink[]
							| null;
						const locations = normalizeLocationResult(result);
						if (locations.length === 0) {
							output = `No ${label} found`;
						} else {
							const lines = await Promise.all(locations.map((loc) => formatLocationWithContext(loc, cwd)));
							output = `Found ${locations.length} ${label}(s):\n${lines.join("\n")}`;
						}
						break;
					}

					case "references": {
						let result: Location[] | null = null;
						for (let attempt = 0; attempt <= REFERENCES_RETRY_COUNT; attempt++) {
							result = (await sendRequest(
								client,
								"textDocument/references",
								{ textDocument: { uri }, position, context: { includeDeclaration: true } },
								signal,
							)) as Location[] | null;
							const locations = result ?? [];
							if (!isProjectAwareLspServer(serverConfig) || attempt === REFERENCES_RETRY_COUNT) break;
							if (locations.length > 0 && !isOnlyQueriedDeclaration(locations, uri, position)) break;
							await waitForProjectLoaded(client, signal);
							throwIfAborted(signal);
							await sleep(REFERENCES_RETRY_DELAY_MS);
						}
						if (!result || result.length === 0) {
							output = "No references found";
						} else {
							const contextual = result.slice(0, REFERENCE_CONTEXT_LIMIT);
							const plain = result.slice(REFERENCE_CONTEXT_LIMIT);
							const contextualLines = await Promise.all(
								contextual.map((loc) => formatLocationWithContext(loc, cwd)),
							);
							const plainLines = plain.map((loc) => `  ${formatLocation(loc, cwd)}`);
							const lines = plainLines.length
								? [
										...contextualLines,
										`  ... ${plainLines.length} additional reference(s) shown without context`,
										...plainLines,
									]
								: contextualLines;
							const refsOutput = `Found ${result.length} reference(s):\n${lines.join("\n")}`;
							const refsTruncation = truncateHead(refsOutput, { maxBytes: DEFAULT_MAX_BYTES });
							output = refsTruncation.truncated
								? `${refsTruncation.content}\n\n[references truncated at ${refsTruncation.outputLines} of ${refsTruncation.totalLines} lines (${formatSize(DEFAULT_MAX_BYTES)} limit); refine with grep or a narrower scope]`
								: refsOutput;
						}
						break;
					}

					case "hover": {
						const result = (await sendRequest(
							client,
							"textDocument/hover",
							{ textDocument: { uri }, position },
							signal,
						)) as Hover | null;
						output = result?.contents ? extractHoverText(result.contents) : "No hover information";
						break;
					}

					case "code_actions": {
						const diagnostics = client.diagnostics.get(uri)?.diagnostics ?? [];
						const context: CodeActionContext = {
							diagnostics,
							only: !apply && query ? [query] : undefined,
							triggerKind: 1,
						};
						const result = (await sendRequest(
							client,
							"textDocument/codeAction",
							{ textDocument: { uri }, range: { start: position, end: position }, context },
							signal,
						)) as (CodeAction | Command)[] | null;

						if (!result || result.length === 0) {
							output = "No code actions available";
							break;
						}
						if (apply === true && query) {
							const normalizedQuery = query.trim();
							if (normalizedQuery.length === 0) {
								output = "Error: query parameter required when apply=true for code_actions";
								break;
							}
							const parsedIndex = /^\d+$/.test(normalizedQuery) ? Number.parseInt(normalizedQuery, 10) : null;
							const selected = result.find(
								(item, index) =>
									(parsedIndex !== null && index === parsedIndex) ||
									item.title.toLowerCase().includes(normalizedQuery.toLowerCase()),
							);
							if (!selected) {
								const actionLines = result.map((item, index) => `  ${formatCodeAction(item, index)}`);
								output = `No code action matches "${normalizedQuery}". Available actions:\n${actionLines.join("\n")}`;
								break;
							}
							const applied = await applyCodeAction(selected, {
								resolveCodeAction: async (item) =>
									(await sendRequest(client, "codeAction/resolve", item, signal)) as CodeAction,
								applyWorkspaceEdit: async (edit) => applyWorkspaceEdit(edit, cwd),
								executeCommand: async (commandItem) => {
									await withServerApplyEdit(client, () =>
										sendRequest(
											client,
											"workspace/executeCommand",
											{ command: commandItem.command, arguments: commandItem.arguments ?? [] },
											signal,
										),
									);
								},
							});
							if (!applied) {
								output = `Action "${selected.title}" has no workspace edit or command to apply`;
								break;
							}
							const summaryLines: string[] = [];
							if (applied.edits.length > 0) {
								summaryLines.push("  Workspace edit:");
								summaryLines.push(...applied.edits.map((item) => `    ${item}`));
							}
							if (applied.executedCommands.length > 0) {
								summaryLines.push("  Executed command(s):");
								summaryLines.push(...applied.executedCommands.map((name) => `    ${name}`));
							}
							output = `Applied "${applied.title}":\n${summaryLines.join("\n")}`;
							break;
						}
						const visibleActions = result.slice(0, CODE_ACTION_LIST_LIMIT);
						const actionLines = visibleActions.map((item, index) => `  ${formatCodeAction(item, index)}`);
						const omitted = result.length - visibleActions.length;
						const omittedLine = omitted > 0 ? `\n  ... ${omitted} additional code action(s) omitted` : "";
						output = `${result.length} code action(s):\n${actionLines.join("\n")}${omittedLine}`;
						break;
					}

					case "symbols": {
						if (!targetFile) {
							output = "Error: file parameter required for document symbols";
							break;
						}
						const result = (await sendRequest(
							client,
							"textDocument/documentSymbol",
							{ textDocument: { uri } },
							signal,
						)) as (DocumentSymbol | SymbolInformation)[] | null;
						if (!result || result.length === 0) {
							output = "No symbols found";
						} else {
							const relPath = formatPathRelativeToCwd(targetFile, cwd);
							if ("selectionRange" in result[0]) {
								const lines = (result as DocumentSymbol[]).flatMap((s) => formatDocumentSymbol(s));
								const visibleLines = lines.slice(0, DOCUMENT_SYMBOL_LINE_LIMIT);
								const omitted = lines.length - visibleLines.length;
								const omittedLine = omitted > 0 ? `\n... ${omitted} additional symbol line(s) omitted` : "";
								output = `Symbols in ${relPath}:\n${visibleLines.join("\n")}${omittedLine}`;
							} else {
								const lines = (result as SymbolInformation[]).map((s) => {
									const ln = s.location.range.start.line + 1;
									return `[${symbolKindToName(s.kind)}] ${s.name} @ line ${ln}`;
								});
								const visibleLines = lines.slice(0, DOCUMENT_SYMBOL_LINE_LIMIT);
								const omitted = lines.length - visibleLines.length;
								const omittedLine = omitted > 0 ? `\n... ${omitted} additional symbol line(s) omitted` : "";
								output = `Symbols in ${relPath}:\n${visibleLines.join("\n")}${omittedLine}`;
							}
						}
						break;
					}

					case "rename": {
						if (!new_name) {
							throw new Error("new_name parameter required for rename");
						}
						const result = (await sendRequest(
							client,
							"textDocument/rename",
							{ textDocument: { uri }, position, newName: new_name },
							signal,
						)) as WorkspaceEdit | null;
						if (!result) {
							output = "Rename returned no edits";
						} else if (apply !== false) {
							// Atomic rename transaction: snapshot affected files, apply, recheck
							// diagnostics (versionOk so we wait for the FRESH push, not the stale
							// one), and roll back if the edit introduced any NEW error. Degrades
							// to a plain commit when no project-aware server / recheck is
							// available (fail-safe — never reverts a wanted rename on a timeout).
							// Escape hatch: PIT_NO_REFACTOR_TX (handled inside the transaction).
							let applied: string[] = [];
							const tx = await runRenameTransaction(result, {
								captureDiagnosticsBaseline: async (uris) =>
									new Map(uris.map((u) => [u, client.diagnostics.get(u)?.diagnostics ?? []] as const)),
								readFile: (fileUri) => readFile(uriToFile(fileUri), "utf-8"),
								applyWorkspaceEdit: async (e) => {
									applied = await applyWorkspaceEdit(e, cwd);
									return applied;
								},
								recheckDiagnostics: async (uris) => {
									const out = new Map<string, Diagnostic[]>();
									for (const u of uris) {
										const file = uriToFile(u);
										const minVersion = client.diagnosticsVersion;
										let content: string;
										try {
											content = await readFile(file, "utf-8");
										} catch {
											continue;
										}
										await syncContent(client, file, content, signal);
										const expectedDocumentVersion = client.openFiles.get(u)?.version;
										out.set(
											u,
											await waitForDiagnostics(client, u, {
												timeoutMs: 4000,
												signal,
												minVersion,
												expectedDocumentVersion,
											}),
										);
									}
									return out;
								},
								restoreFiles: async (snaps) => {
									for (const s of snaps) await writeFileAtomic(uriToFile(s.uri), s.content);
								},
							});
							if (tx.rolledBack) {
								const errLines = tx.newErrors
									.map(
										(e) =>
											`  ${formatDiagnostic(e.diagnostic, formatPathRelativeToCwd(uriToFile(e.uri), cwd), cwd)}`,
									)
									.join("\n");
								output = `Rename ROLLED BACK — it introduced ${tx.newErrors.length} new error(s):\n${errLines}\nThe workspace was restored to its pre-rename state.`;
							} else {
								output = `Applied rename:\n${applied.map((a) => `  ${a}`).join("\n")}`;
							}
						} else {
							const preview = formatWorkspaceEdit(result, cwd);
							output = `Rename preview:\n${preview.map((p) => `  ${p}`).join("\n")}`;
						}
						break;
					}

					case "reload": {
						output = await reloadServer(client, serverName, signal);
						break;
					}

					default:
						output = `Unknown action: ${action}`;
				}

				return textResult(output, { serverName, action, success: true, request: req });
			} catch (err) {
				if (signal?.aborted) {
					if (timeoutSignal.aborted && !callerSignal?.aborted) {
						throw new Error(
							`LSP ${action} timed out after ${timeoutSec}s on ${serverName}. The server may still be indexing; try again or pass timeout=<larger>.`,
						);
					}
					throw new Error("aborted");
				}
				throw new Error(`LSP error on ${serverName}: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	};
}

// =============================================================================
// Workspace / multi-server actions live in tool-actions.ts.
// =============================================================================

export function createLspTool(cwd: string, options?: LspToolOptions): AgentTool<typeof lspSchema> {
	return wrapToolDefinition(createLspToolDefinition(cwd, options));
}
