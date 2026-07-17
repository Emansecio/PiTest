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
import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
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
import type { Diagnostic, LspClient, ServerConfig, TextEdit } from "./types.ts";
import {
	dedupeDiagnostics,
	diagnosticsSilenceKey,
	effectiveDiagnosticsWaitMs,
	fileToUri,
	formatDiagnostic,
	formatDiagnosticsSummary,
	formatPathRelativeToCwd,
	recordDiagnosticsWaitOutcome,
	resetDiagnosticsSilenceForClient,
	sortDiagnostics,
	uriToFile,
	waitForDiagnosticsResult,
} from "./utils.ts";

// Cap a cold-boot `initialize` handshake during writethrough. Without it, a
// server that hangs on initialize is bounded only by the 30s request default —
// up to 30s of stall per edit, default-on. Session warmup pre-warms every
// configured server (manager.warmupLspServers → getLspServers → all servers), so
// the client is normally already live here and this cap never bites; it only
// bounds the rare cold spawn (warmup skipped or the server died after warmup).
// A timed-out init throws a plain request-timeout error, which arms the
// boot-failure breaker in client.ts (a hang is treated as a boot failure).
const WRITETHROUGH_INIT_TIMEOUT_MS = 4000;

/**
 * On first sight of a client, reset its silence markers when its project-loaded
 * transition resolves: a file that produced no diagnostics *because the project
 * was still loading* must not stay suppressed once the server is actually ready.
 * The listener fires once per client (the transition is one-time); for an
 * already-loaded client it runs immediately and is a harmless no-op.
 */
const silenceProjectLoadHooked = new WeakSet<LspClient>();
function hookProjectLoadedSilenceReset(client: LspClient): void {
	if (silenceProjectLoadHooked.has(client)) return;
	silenceProjectLoadHooked.add(client);
	client.projectLoaded.then(() => resetDiagnosticsSilenceForClient(client.name)).catch(() => {});
}

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
			const client = await getOrCreateClient(
				serverConfig,
				cwd,
				Math.min(FORMAT_TIMEOUT_MS, WRITETHROUGH_INIT_TIMEOUT_MS),
				signal,
			);
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
// Cross-file diagnostics surfacing
// =============================================================================

// The client stores EVERY publishDiagnostics keyed by canonical URI — including
// package-level publishes for files OTHER than the one just edited (gopls et al.
// re-check the whole package on save). The edited-file path above only reads the
// edited URI's entry, so those cross-file entries sit unread. This surfaces the
// ones that gained a NEW error because of this write, best-effort: we read
// whatever is already in the map at collection time and NEVER add a wait for it.
const CROSS_FILE_MAX_FILES = 3;
const CROSS_FILE_MAX_DIAGS_PER_FILE = 2;

interface CrossFileGroup {
	uri: string;
	newErrors: Diagnostic[];
}

/** PIT_NO_LSP_CROSS_FILE_SURFACE=1 reverts the appendix to edited-file-only. */
function crossFileSurfaceDisabled(): boolean {
	return isTruthyEnvFlag(process.env.PIT_NO_LSP_CROSS_FILE_SURFACE);
}

/**
 * Fingerprint the diagnostics currently published for every URI OTHER than the
 * edited one. Taken BEFORE the write's didChange so a post-write publish can be
 * diffed against it — a URI absent here is treated as having had no diagnostics.
 */
function snapshotCrossFileBaseline(client: LspClient, editedUri: string): Map<string, Set<string>> {
	const snapshot = new Map<string, Set<string>>();
	for (const [uri, published] of client.diagnostics) {
		if (uri === editedUri) continue;
		snapshot.set(uri, new Set(published.diagnostics.map(diagnosticFingerprint)));
	}
	return snapshot;
}

/**
 * Scan the client's diagnostics for URIs (other than the edited file) that now
 * carry ERROR-severity diagnostics absent from `baseline` — the new errors this
 * write introduced elsewhere. Pre-existing errors (already in baseline) are never
 * resurfaced.
 */
function collectCrossFileNewErrors(
	client: LspClient,
	editedUri: string,
	baseline: Map<string, Set<string>>,
): CrossFileGroup[] {
	const groups: CrossFileGroup[] = [];
	for (const [uri, published] of client.diagnostics) {
		if (uri === editedUri) continue;
		const baselineKeys = baseline.get(uri);
		const newErrors = published.diagnostics.filter(
			(d) => (d.severity ?? 1) === 1 && !(baselineKeys?.has(diagnosticFingerprint(d)) ?? false),
		);
		if (newErrors.length > 0) groups.push({ uri, newErrors });
	}
	return groups;
}

/**
 * Render the bounded cross-file appendix lines: at most CROSS_FILE_MAX_FILES
 * files, CROSS_FILE_MAX_DIAGS_PER_FILE diagnostics each, paths relativized.
 * Groups from multiple servers are merged per URI.
 */
function buildCrossFileMessages(groups: CrossFileGroup[], cwd: string): string[] {
	if (groups.length === 0) return [];
	const byUri = new Map<string, Diagnostic[]>();
	for (const group of groups) {
		const existing = byUri.get(group.uri);
		if (existing) existing.push(...group.newErrors);
		else byUri.set(group.uri, [...group.newErrors]);
	}
	const lines: string[] = [];
	for (const [uri, diagnostics] of byUri) {
		if (lines.length >= CROSS_FILE_MAX_FILES) break;
		const unique = dedupeDiagnostics(diagnostics);
		if (unique.length === 0) continue;
		sortDiagnostics(unique);
		const relPath = formatPathRelativeToCwd(uriToFile(uri), cwd);
		const shown = unique.slice(0, CROSS_FILE_MAX_DIAGS_PER_FILE);
		const detail = shown.map((d) => `  ${formatDiagnostic(d, relPath, cwd)}`).join("\n");
		lines.push(`cross-file: ${relPath} — ${unique.length} new error(s):\n${detail}`);
	}
	return lines;
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
	/** Bounded cross-file "new error" lines (see buildCrossFileMessages). */
	crossFile: string[];
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
			const client = await getOrCreateClient(
				serverConfig,
				cwd,
				Math.min(timeoutMs, WRITETHROUGH_INIT_TIMEOUT_MS),
				signal,
			);
			hookProjectLoadedSilenceReset(client);
			if (isProjectAwareLspServer(serverConfig)) await waitForProjectLoaded(client, combined);
			const minVersion = client.diagnosticsVersion;
			await refreshFile(client, absolutePath, combined);
			const expectedDocumentVersion = client.openFiles.get(uri)?.version;
			const silenceKey = diagnosticsSilenceKey(client.name, uri);
			const result = await waitForDiagnosticsResult(client, uri, {
				timeoutMs: effectiveDiagnosticsWaitMs(silenceKey, timeoutMs),
				signal: combined,
				minVersion,
				expectedDocumentVersion,
			});
			recordDiagnosticsWaitOutcome(silenceKey, result.fresh);
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
	const crossFileEnabled = !crossFileSurfaceDisabled();
	const crossFileGroups: CrossFileGroup[] = [];

	await Promise.allSettled(
		servers.map(async ([name, serverConfig]) => {
			const client = await getOrCreateClient(
				serverConfig,
				cwd,
				Math.min(timeoutMs, WRITETHROUGH_INIT_TIMEOUT_MS),
				signal,
			);
			hookProjectLoadedSilenceReset(client);
			if (isProjectAwareLspServer(serverConfig)) {
				await waitForProjectLoaded(client, combined);
			}
			// Snapshot other-URI diagnostics BEFORE our didChange so post-write
			// cross-file publishes can be diffed against a stable pre-write baseline.
			const crossFileBaseline = crossFileEnabled ? snapshotCrossFileBaseline(client, uri) : undefined;
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
			const silenceKey = diagnosticsSilenceKey(client.name, uri);
			const result = await waitForDiagnosticsResult(client, uri, {
				timeoutMs: effectiveDiagnosticsWaitMs(silenceKey, timeoutMs),
				signal: combined,
				minVersion,
				expectedDocumentVersion,
			});
			recordDiagnosticsWaitOutcome(silenceKey, result.fresh);
			// Cross-file scan is independent of the edited-file wait outcome: read
			// whatever proactive package-level publishes already landed in the map.
			// No new wait is added — this is best-effort by design.
			if (crossFileBaseline) {
				crossFileGroups.push(...collectCrossFileNewErrors(client, uri, crossFileBaseline));
			}
			if (!result.fresh) return;
			serverNames.push(name);
			all.push(...result.diagnostics);
		}),
	);

	const crossFile = buildCrossFileMessages(crossFileGroups, cwd);

	if (serverNames.length === 0) {
		// No fresh edited-file diagnostics, but a cross-file publish may still have
		// arrived — surface it rather than dropping it.
		if (crossFile.length === 0) return undefined;
		return {
			server: "",
			summary: "no new issues",
			errored: false,
			messages: [],
			baselineCompared: false,
			crossFile,
		};
	}

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
			crossFile,
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
		crossFile,
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
	if (!diag || (diag.messages.length === 0 && diag.crossFile.length === 0)) return result;
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
	let appendix = "";
	if (diag.messages.length > 0) {
		const body = diag.messages.join("\n");
		if (!enforceDiagnosticsOnWrite || !diag.errored) {
			const label = diag.baselineCompared ? "New LSP diagnostics" : "LSP diagnostics";
			appendix = `\n${label} (${diag.summary}):\n${body}`;
		} else {
			const rel = formatPathRelativeToCwd(absolutePath, cwd);
			const source = diag.baselineCompared ? "This change introduced" : "LSP reported";
			appendix =
				`\nLSP check failed: ${source} ${diag.summary} in ${rel}. Fix the error(s) below before ` +
				`your next change or declaring the task done; do not keep editing while ` +
				`${rel} still has type errors:\n${body}`;
		}
	}
	// Cross-file errors this write introduced elsewhere in the package (bounded).
	if (diag.crossFile.length > 0) {
		appendix += `\nCross-file LSP errors introduced by this change (fix these too):\n${diag.crossFile.join("\n")}`;
	}
	return appendix;
}
