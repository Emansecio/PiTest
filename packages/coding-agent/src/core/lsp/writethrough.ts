/**
 * Post-write diagnostics ("writethrough"): after a write/edit lands on disk,
 * sync the new content to the relevant language servers and collect fresh
 * diagnostics so the model sees type/lint errors the way an IDE would — without
 * a separate `lsp diagnostics` call.
 *
 * Best-effort by construction: gated behind a session flag, short timeout, and
 * fully swallowed on any failure so it can never break a write.
 */

import * as fs from "node:fs/promises";
import {
	getOrCreateClient,
	notifySaved,
	refreshFile,
	sendRequest,
	syncContent,
	waitForProjectLoaded,
} from "./client.ts";
import { getServersForFile } from "./config.ts";
import { applyTextEditsToString } from "./edits.ts";
import { getConfig, isProjectAwareLspServer } from "./manager.ts";
import type { Diagnostic, ServerConfig, TextEdit } from "./types.ts";
import {
	dedupeDiagnostics,
	fileToUri,
	formatDiagnostic,
	formatDiagnosticsSummary,
	formatPathRelativeToCwd,
	sortDiagnostics,
	waitForDiagnosticsResult,
} from "./utils.ts";

// =============================================================================
// Session gate
// =============================================================================

let diagnosticsOnWrite = false;

/** Enable/disable post-write diagnostics for the current session. */
export function setDiagnosticsOnWrite(enabled: boolean): void {
	diagnosticsOnWrite = enabled;
}

let enforceDiagnosticsOnWrite = true;

/**
 * Enable/disable imperative framing of error-severity post-write diagnostics.
 * When on (default), an edit that introduces a type error gets a firm directive
 * to fix it before proceeding instead of a neutral note the model skims past.
 */
export function setEnforceDiagnosticsOnWrite(enabled: boolean): void {
	enforceDiagnosticsOnWrite = enabled;
}

let formatOnWrite = false;

/** Enable/disable LSP format-on-write for the current session. */
export function setFormatOnWrite(enabled: boolean): void {
	formatOnWrite = enabled;
}

// =============================================================================
// Format-on-write
// =============================================================================

const FORMAT_TIMEOUT_MS = 4000;
const DEFAULT_FORMAT_OPTIONS = {
	tabSize: 4,
	insertSpaces: true,
	trimTrailingWhitespace: true,
	insertFinalNewline: true,
	trimFinalNewlines: true,
};

/**
 * Format `content` for `absolutePath` via the first language server that
 * advertises a document formatting provider. Returns the original content when
 * disabled, no formatter is available, or anything fails. Never throws.
 */
export async function maybeFormat(
	absolutePath: string,
	content: string,
	cwd: string,
	signal?: AbortSignal,
): Promise<{ content: string; formatted: boolean }> {
	if (!formatOnWrite) return { content, formatted: false };

	let servers: Array<[string, ServerConfig]>;
	try {
		servers = getServersForFile(getConfig(cwd), absolutePath);
	} catch {
		return { content, formatted: false };
	}
	if (servers.length === 0) return { content, formatted: false };

	const uri = fileToUri(absolutePath);
	const deadline = AbortSignal.timeout(FORMAT_TIMEOUT_MS);
	const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;

	for (const [, serverConfig] of servers) {
		try {
			const client = await getOrCreateClient(serverConfig, cwd);
			if (!client.serverCapabilities?.documentFormattingProvider) continue;
			await syncContent(client, absolutePath, content, combined);
			const edits = (await sendRequest(
				client,
				"textDocument/formatting",
				{ textDocument: { uri }, options: DEFAULT_FORMAT_OPTIONS },
				combined,
			)) as TextEdit[] | null;
			if (!edits || edits.length === 0) return { content, formatted: false };
			const formatted = applyTextEditsToString(content, edits);
			return { content: formatted, formatted: formatted !== content };
		} catch {
			// Try the next server.
		}
	}
	return { content, formatted: false };
}

const DEFAULT_WAIT_MS = 4000;
const DIAGNOSTIC_MESSAGE_LIMIT = 50;

function diagnosticFingerprint(diagnostic: Diagnostic): string {
	return [
		diagnostic.range.start.line,
		diagnostic.range.start.character,
		diagnostic.range.end.line,
		diagnostic.range.end.character,
		diagnostic.source ?? "",
		diagnostic.code ?? "",
		diagnostic.message,
	].join(":");
}

function filterBaselineDiagnostics(current: Diagnostic[], baseline: Diagnostic[]): Diagnostic[] {
	if (baseline.length === 0) return current;
	const baselineKeys = new Set(baseline.map(diagnosticFingerprint));
	return current.filter((diagnostic) => !baselineKeys.has(diagnosticFingerprint(diagnostic)));
}

// =============================================================================
// Public API
// =============================================================================

export interface PostWriteDiagnostics {
	server: string;
	summary: string;
	errored: boolean;
	messages: string[];
	baselineCompared: boolean;
}

export interface PreWriteDiagnosticsBaseline {
	diagnostics: Diagnostic[];
	fresh: boolean;
}

export interface PostWriteOptions {
	timeoutMs?: number;
	baseline?: PreWriteDiagnosticsBaseline;
}

export async function capturePreWriteDiagnostics(
	absolutePath: string,
	cwd: string,
	signal?: AbortSignal,
	options?: { timeoutMs?: number },
): Promise<PreWriteDiagnosticsBaseline | undefined> {
	if (!diagnosticsOnWrite) return undefined;

	let servers: Array<[string, ServerConfig]>;
	try {
		servers = getServersForFile(getConfig(cwd), absolutePath);
	} catch {
		return undefined;
	}
	if (servers.length === 0) return undefined;

	const exists = await fs
		.access(absolutePath)
		.then(() => true)
		.catch(() => false);
	if (!exists) return { diagnostics: [], fresh: true };

	const uri = fileToUri(absolutePath);
	const timeoutMs = options?.timeoutMs ?? DEFAULT_WAIT_MS;
	const deadline = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
	const all: Diagnostic[] = [];
	let freshServerCount = 0;

	await Promise.allSettled(
		servers.map(async ([, serverConfig]) => {
			const client = await getOrCreateClient(serverConfig, cwd);
			if (isProjectAwareLspServer(serverConfig)) await waitForProjectLoaded(client, combined);
			const minVersion = client.diagnosticsVersion;
			await refreshFile(client, absolutePath, combined);
			const expectedDocumentVersion = client.openFiles.get(uri)?.version;
			const result = await waitForDiagnosticsResult(client, uri, {
				timeoutMs,
				signal: combined,
				minVersion,
				expectedDocumentVersion,
			});
			if (!result.fresh) return;
			freshServerCount += 1;
			all.push(...result.diagnostics);
		}),
	);

	return { diagnostics: dedupeDiagnostics(all), fresh: freshServerCount > 0 };
}

/**
 * Collect post-write diagnostics for `absolutePath` after its content changed.
 * Returns undefined when disabled, no server handles the file, diagnostics are
 * stale, or anything goes wrong. Never throws.
 */
export async function getPostWriteDiagnostics(
	absolutePath: string,
	content: string,
	cwd: string,
	signal?: AbortSignal,
	options?: PostWriteOptions,
): Promise<PostWriteDiagnostics | undefined> {
	if (!diagnosticsOnWrite) return undefined;
	if (options?.baseline && !options.baseline.fresh) return undefined;

	let servers: Array<[string, ServerConfig]>;
	try {
		const config = getConfig(cwd);
		servers = getServersForFile(config, absolutePath);
	} catch {
		return undefined;
	}
	if (servers.length === 0) return undefined;

	const uri = fileToUri(absolutePath);
	const relPath = formatPathRelativeToCwd(absolutePath, cwd);
	const timeoutMs = options?.timeoutMs ?? DEFAULT_WAIT_MS;
	const deadline = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;

	const all: Diagnostic[] = [];
	// Copy: the fallback below pushes into this array, and mutating the caller's
	// baseline object would corrupt it for any reuse.
	const baseline = [...(options?.baseline?.diagnostics ?? [])];
	const baselineWasProvided = options?.baseline?.fresh === true;
	let baselineCompared = baselineWasProvided;
	const serverNames: string[] = [];

	await Promise.allSettled(
		servers.map(async ([name, serverConfig]) => {
			const client = await getOrCreateClient(serverConfig, cwd);
			if (isProjectAwareLspServer(serverConfig)) {
				await waitForProjectLoaded(client, combined);
			}
			// No fresh caller-provided baseline: EVERY server contributes its own
			// previously-published diagnostics. Gating on the shared mutable flag
			// here would let only the first server contribute, and the others' old
			// diagnostics would then be re-reported as "new".
			if (!baselineWasProvided) {
				const existing = client.diagnostics.get(uri);
				if (existing) {
					baselineCompared = true;
					baseline.push(...existing.diagnostics);
				}
			}
			const minVersion = client.diagnosticsVersion;
			await syncContent(client, absolutePath, content, combined);
			const expectedDocumentVersion = client.openFiles.get(uri)?.version;
			await notifySaved(client, absolutePath, combined);
			const result = await waitForDiagnosticsResult(client, uri, {
				timeoutMs,
				signal: combined,
				minVersion,
				expectedDocumentVersion,
			});
			if (!result.fresh) return;
			serverNames.push(name);
			all.push(...result.diagnostics);
		}),
	);

	if (serverNames.length === 0) return undefined;

	// Deduplicate by range + message (different servers may report the same issue).
	const unique = dedupeDiagnostics(all);
	const baselineUnique = baselineCompared ? dedupeDiagnostics(baseline) : [];
	const reportable = (baselineCompared ? filterBaselineDiagnostics(unique, baselineUnique) : unique).filter(
		(d) => (d.severity ?? 1) === 1,
	);

	if (reportable.length === 0) {
		return {
			server: serverNames.join(", "),
			summary: baselineCompared ? "no new issues" : "no issues",
			errored: false,
			messages: [],
			baselineCompared,
		};
	}

	sortDiagnostics(reportable);
	const messages = reportable.map((d) => formatDiagnostic(d, relPath, cwd)).slice(0, DIAGNOSTIC_MESSAGE_LIMIT);
	return {
		server: serverNames.join(", "),
		summary: formatDiagnosticsSummary(reportable),
		errored: reportable.some((d) => d.severity === 1),
		messages,
		baselineCompared,
	};
}

/**
 * Splice post-write diagnostics onto an already-built write/edit result. Call
 * this AFTER the file-mutation lock is released (i.e. after withFileMutationQueue
 * resolves) so collecting diagnostics never holds the per-path write lock.
 * `written` is the exact content that landed on disk, or undefined to skip
 * (preview / URL-scheme / abort paths).
 */
export async function attachPostWriteDiagnostics<R extends { content: Array<{ type: string; text?: string }> }>(
	result: R,
	absolutePath: string,
	written: string | undefined,
	cwd: string,
	signal?: AbortSignal,
	baseline?: PreWriteDiagnosticsBaseline,
): Promise<R> {
	if (written === undefined) return result;
	let diag: PostWriteDiagnostics | undefined;
	try {
		diag = await getPostWriteDiagnostics(absolutePath, written, cwd, signal, { baseline });
	} catch {
		return result;
	}
	if (!diag || diag.messages.length === 0) return result;
	const appendix = formatPostWriteAppendix(diag, absolutePath, cwd);
	if (appendix && result.content[0]?.type === "text") {
		result.content[0].text = (result.content[0].text ?? "") + appendix;
	}
	return result;
}

/**
 * Build the post-write diagnostics appendix. When the edit introduced an
 * ERROR-severity diagnostic and enforcement is on, frame it as an imperative
 * directive (active) rather than a neutral note (passive) the model can skim
 * past — closing the edit→error→fix loop within the turn instead of deferring
 * it to the slow project-wide check at the end. Warning-only diagnostics keep
 * the neutral framing; the file already landed on disk, so this never flips the
 * result to `isError` (that would make the model think the edit didn't apply).
 */
function formatPostWriteAppendix(diag: PostWriteDiagnostics, absolutePath: string, cwd: string): string {
	const body = diag.messages.join("\n");
	if (!enforceDiagnosticsOnWrite || !diag.errored) {
		const label = diag.baselineCompared ? "New LSP diagnostics" : "LSP diagnostics";
		return `\n${label} (${diag.summary}):\n${body}`;
	}
	const rel = formatPathRelativeToCwd(absolutePath, cwd);
	const source = diag.baselineCompared ? "This change introduced" : "LSP reported";
	return (
		`\nLSP check failed: ${source} ${diag.summary} in ${rel}. Fix the error(s) below before ` +
		`your next change or declaring the task done; do not keep editing while ` +
		`${rel} still has type errors:\n${body}`
	);
}
