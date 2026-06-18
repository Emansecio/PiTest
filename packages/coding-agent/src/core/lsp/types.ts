/**
 * LSP protocol types and client state shapes.
 *
 * Ported from the upstream oh-my-pi LSP module, adapted to Node's
 * child_process (instead of Bun's spawn) and to the Pit tool surface.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";

// =============================================================================
// Tool Details
// =============================================================================

export interface LspToolDetails {
	serverName?: string;
	action: string;
	success: boolean;
	request?: Record<string, unknown>;
}

// =============================================================================
// Core LSP Protocol Types
// =============================================================================

export interface Position {
	line: number;
	character: number;
}

export interface Range {
	start: Position;
	end: Position;
}

export interface Location {
	uri: string;
	range: Range;
}

export interface LocationLink {
	originSelectionRange?: Range;
	targetUri: string;
	targetRange: Range;
	targetSelectionRange: Range;
}

// =============================================================================
// Diagnostics
// =============================================================================

export type DiagnosticSeverity = 1 | 2 | 3 | 4; // error, warning, info, hint

export interface DiagnosticRelatedInformation {
	location: Location;
	message: string;
}

export interface Diagnostic {
	range: Range;
	severity?: DiagnosticSeverity;
	code?: string | number;
	codeDescription?: { href: string };
	source?: string;
	message: string;
	tags?: number[];
	relatedInformation?: DiagnosticRelatedInformation[];
	data?: unknown;
}

export interface PublishedDiagnostics {
	diagnostics: Diagnostic[];
	version: number | null;
}

export interface PublishDiagnosticsParams {
	uri: string;
	diagnostics: Diagnostic[];
	version?: number | null;
}

// =============================================================================
// Text Edits
// =============================================================================

export interface TextEdit {
	range: Range;
	newText: string;
}

export interface AnnotatedTextEdit extends TextEdit {
	annotationId?: string;
}

export interface TextDocumentIdentifier {
	uri: string;
}

export interface VersionedTextDocumentIdentifier extends TextDocumentIdentifier {
	version: number | null;
}

export interface OptionalVersionedTextDocumentIdentifier extends TextDocumentIdentifier {
	version?: number | null;
}

export interface TextDocumentEdit {
	textDocument: OptionalVersionedTextDocumentIdentifier;
	edits: (TextEdit | AnnotatedTextEdit)[];
}

// =============================================================================
// Resource Operations
// =============================================================================

export interface CreateFileOptions {
	overwrite?: boolean;
	ignoreIfExists?: boolean;
}

export interface CreateFile {
	kind: "create";
	uri: string;
	options?: CreateFileOptions;
}

export interface RenameFileOptions {
	overwrite?: boolean;
	ignoreIfExists?: boolean;
}

export interface RenameFile {
	kind: "rename";
	oldUri: string;
	newUri: string;
	options?: RenameFileOptions;
}

export interface DeleteFileOptions {
	recursive?: boolean;
	ignoreIfNotExists?: boolean;
}

export interface DeleteFile {
	kind: "delete";
	uri: string;
	options?: DeleteFileOptions;
}

export type DocumentChange = TextDocumentEdit | CreateFile | RenameFile | DeleteFile;

export interface WorkspaceEdit {
	changes?: Record<string, TextEdit[]>;
	documentChanges?: DocumentChange[];
	changeAnnotations?: Record<string, { label: string; needsConfirmation?: boolean; description?: string }>;
}

// =============================================================================
// Code Actions
// =============================================================================

export type CodeActionKind =
	| "quickfix"
	| "refactor"
	| "refactor.extract"
	| "refactor.inline"
	| "refactor.rewrite"
	| "source"
	| "source.organizeImports"
	| "source.fixAll"
	| string;

export interface Command {
	title: string;
	command: string;
	arguments?: unknown[];
}

export interface CodeAction {
	title: string;
	kind?: CodeActionKind;
	diagnostics?: Diagnostic[];
	isPreferred?: boolean;
	disabled?: { reason: string };
	edit?: WorkspaceEdit;
	command?: Command;
	data?: unknown;
}

export interface CodeActionContext {
	diagnostics: Diagnostic[];
	only?: CodeActionKind[];
	triggerKind?: 1 | 2; // Invoked = 1, Automatic = 2
}

// =============================================================================
// Symbols
// =============================================================================

export type SymbolKind =
	| 1
	| 2
	| 3
	| 4
	| 5
	| 6
	| 7
	| 8
	| 9
	| 10
	| 11
	| 12
	| 13
	| 14
	| 15
	| 16
	| 17
	| 18
	| 19
	| 20
	| 21
	| 22
	| 23
	| 24
	| 25
	| 26;

export const SYMBOL_KIND_NAMES: Record<SymbolKind, string> = {
	1: "File",
	2: "Module",
	3: "Namespace",
	4: "Package",
	5: "Class",
	6: "Method",
	7: "Property",
	8: "Field",
	9: "Constructor",
	10: "Enum",
	11: "Interface",
	12: "Function",
	13: "Variable",
	14: "Constant",
	15: "String",
	16: "Number",
	17: "Boolean",
	18: "Array",
	19: "Object",
	20: "Key",
	21: "Null",
	22: "EnumMember",
	23: "Struct",
	24: "Event",
	25: "Operator",
	26: "TypeParameter",
};

export interface DocumentSymbol {
	name: string;
	detail?: string;
	kind: SymbolKind;
	tags?: number[];
	deprecated?: boolean;
	range: Range;
	selectionRange: Range;
	children?: DocumentSymbol[];
}

export interface SymbolInformation {
	name: string;
	kind: SymbolKind;
	tags?: number[];
	deprecated?: boolean;
	location: Location;
	containerName?: string;
}

// =============================================================================
// Hover
// =============================================================================

export interface MarkupContent {
	kind: "plaintext" | "markdown";
	value: string;
}

export type MarkedString = string | { language: string; value: string };

export interface Hover {
	contents: MarkupContent | MarkedString | MarkedString[];
	range?: Range;
}

// =============================================================================
// Server Configuration
// =============================================================================

export interface ServerCapabilities {
	flycheck?: boolean;
	ssr?: boolean;
	expandMacro?: boolean;
	runnables?: boolean;
	relatedTests?: boolean;
}

export interface ServerConfig {
	command: string;
	args?: string[];
	fileTypes: string[];
	rootMarkers: string[];
	initOptions?: Record<string, unknown>;
	settings?: Record<string, unknown>;
	disabled?: boolean;
	/** Per-server warmup timeout in milliseconds. Overrides the global default during startup. */
	warmupTimeoutMs?: number;
	capabilities?: ServerCapabilities;
	/** If true, this is a linter/formatter server - used only for diagnostics, not type intelligence. */
	isLinter?: boolean;
	/** Resolved absolute path to the command binary (set during config loading). */
	resolvedCommand?: string;
}

// =============================================================================
// Client State
// =============================================================================

export interface OpenFile {
	version: number;
	languageId: string;
}

export interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	method: string;
}

export interface LspServerCapabilities {
	renameProvider?: boolean | { prepareProvider?: boolean };
	codeActionProvider?: boolean | { resolveProvider?: boolean };
	hoverProvider?: boolean;
	definitionProvider?: boolean;
	referencesProvider?: boolean;
	documentSymbolProvider?: boolean;
	workspaceSymbolProvider?: boolean;
	documentFormattingProvider?: boolean;
	[key: string]: unknown;
}

export interface LspClient {
	name: string;
	cwd: string;
	config: ServerConfig;
	proc: ChildProcessWithoutNullStreams;
	requestId: number;
	diagnostics: Map<string, PublishedDiagnostics>;
	diagnosticsVersion: number;
	openFiles: Map<string, OpenFile>;
	pendingRequests: Map<number, PendingRequest>;
	messageBuffer: Buffer;
	/** Raw chunks awaiting coalesce into `messageBuffer` (avoids per-chunk O(B²) concat). */
	pendingChunks: Buffer[];
	isReading: boolean;
	serverCapabilities?: LspServerCapabilities;
	lastActivity: number;
	/** Serializes outbound JSON-RPC writes to the server process. */
	writeQueue: Promise<void>;
	/** Tracks active work-done progress tokens from the server. */
	activeProgressTokens: Set<string | number>;
	/** Resolves when the server's initial project loading completes (or after timeout). */
	projectLoaded: Promise<void>;
	/** Call to signal that project loading has completed. */
	resolveProjectLoaded: () => void;
	/** Accumulated stderr text (kept bounded) for crash diagnostics. */
	stderrBuffer: string;
	/** Resolved exit info, populated when the process exits. */
	exitCode: number | null;
}

// =============================================================================
// JSON-RPC Protocol Types
// =============================================================================

export interface LspJsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params: unknown;
}

export interface LspJsonRpcResponse {
	jsonrpc: "2.0";
	id?: number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

export interface LspJsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}
