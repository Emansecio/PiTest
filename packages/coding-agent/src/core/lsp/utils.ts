/**
 * URI conversion, symbol/column resolution, diagnostic & symbol formatting,
 * and glob expansion for the LSP module. Output is plain ASCII (no theme
 * icons) since these strings are consumed by the model, not the TUI.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { globIterate } from "glob";
import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import { onDiagnosticsPublished } from "./diagnostics-events.ts";
import { isEnoent, throwIfAborted } from "./internal.ts";
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
	let resolved = path.resolve(filePath);
	if (process.platform === "win32") {
		// Canonical (uppercase) drive-letter case, so URIs built from any path
		// spelling produce the same string — these URIs are used as map keys and
		// compared for equality (see canonicalUriKey).
		if (/^[a-z]:/.test(resolved)) resolved = resolved[0].toUpperCase() + resolved.slice(1);
		return `file:///${encodeUriPath(resolved.replace(/\\/g, "/"))}`;
	}
	return `file://${encodeUriPath(resolved)}`;
}

/**
 * Canonical form of a file:// URI for map keys and equality checks. Servers may
 * re-normalize the URIs we send them (lowercase drive letter, `:` → `%3A`,
 * redundant percent-encoding) and echo that form back in publishDiagnostics /
 * locations; comparing those against our own fileToUri output by raw string
 * would silently miss. Round-tripping through uriToFile → fileToUri collapses
 * every spelling to the client's canonical one. Non-file URIs pass through.
 */
export function canonicalUriKey(uri: string): string {
	if (!uri.startsWith("file://")) return uri;
	return fileToUri(uriToFile(uri));
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

/** True when `filePath` resolves inside `cwd` (or equals it). */
export function isPathInsideCwd(filePath: string, cwd: string): boolean {
	const rel = path.relative(path.resolve(cwd), path.resolve(filePath));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
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
const MAX_RELATED_INFORMATION = 5;

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
		const visibleRelated = diagnostic.relatedInformation.slice(0, MAX_RELATED_INFORMATION);
		for (const related of visibleRelated) {
			const relFile = uriToFile(related.location.uri);
			const relPath = cwd !== undefined ? formatPathRelativeToCwd(relFile, cwd) : relFile.replace(/\\/g, "/");
			const relLine = related.location.range.start.line + 1;
			const relCol = related.location.range.start.character + 1;
			result += `\n  -> ${relPath}:${relLine}:${relCol} ${related.message}`;
		}
		const omitted = diagnostic.relatedInformation.length - visibleRelated.length;
		if (omitted > 0) result += `\n  -> ${omitted} related location(s) omitted`;
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
// Silent-diagnostics memory
// =============================================================================

// Writethrough waits up to the full budget (~4s) for a publishDiagnostics that
// only ever arrives from a *responsive* server — a silent linter, an
// openFilesOnly server, or an out-of-project temp file inside a marker'd cwd
// never publishes, so every such edit pays the full wait for nothing. This map
// remembers, per (file + server) identity, how many consecutive waits expired
// with no qualifying publish. Once the miss count crosses the threshold,
// subsequent waits for that key short-circuit to a tiny grace instead of the
// full budget. It is invalidated aggressively (any qualifying publish, a
// project-loaded transition, config reload, or a TTL) so a file that legitimately
// starts producing diagnostics is never permanently suppressed.
interface DiagnosticsSilenceEntry {
	misses: number;
	lastMissAt: number;
}
const diagnosticsSilence = new Map<string, DiagnosticsSilenceEntry>();

/** Consecutive silent waits before a key short-circuits to the grace window. */
const SILENCE_MISS_THRESHOLD = 2;
/** Grace wait (ms) once a key is deemed silent; responsive servers still early-exit sooner. */
const DEFAULT_SILENCE_GRACE_MS = 150;
/** A silence entry older than this is discarded so a stuck marker can't suppress forever. */
const SILENCE_TTL_MS = 5 * 60_000;

/** PIT_NO_LSP_SILENCE_MEMO=1 disables the short-circuit (always full wait). */
function silenceMemoDisabled(): boolean {
	return isTruthyEnvFlag(process.env.PIT_NO_LSP_SILENCE_MEMO);
}

/** Grace window in ms; test/tuning override via PIT_LSP_SILENCE_GRACE_MS. */
function silenceGraceMs(): number {
	const raw = process.env.PIT_LSP_SILENCE_GRACE_MS;
	if (raw !== undefined && raw.trim() !== "") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
	}
	return DEFAULT_SILENCE_GRACE_MS;
}

/** Stable identity for the silence marker: same (server + uri) the wait keys on. */
export function diagnosticsSilenceKey(clientName: string, uri: string): string {
	return `${clientName}:${uri}`;
}

/**
 * Effective wait budget for `silenceKey`: the full `fullTimeoutMs` unless the key
 * has crossed the silence threshold within the TTL, in which case a short grace
 * (capped by the full budget). Expired entries are dropped here.
 */
export function effectiveDiagnosticsWaitMs(silenceKey: string, fullTimeoutMs: number): number {
	if (silenceMemoDisabled()) return fullTimeoutMs;
	const entry = diagnosticsSilence.get(silenceKey);
	if (!entry) return fullTimeoutMs;
	if (Date.now() - entry.lastMissAt > SILENCE_TTL_MS) {
		diagnosticsSilence.delete(silenceKey);
		return fullTimeoutMs;
	}
	if (entry.misses >= SILENCE_MISS_THRESHOLD) return Math.min(silenceGraceMs(), fullTimeoutMs);
	return fullTimeoutMs;
}

/**
 * Record the outcome of a diagnostics wait for `silenceKey`. A qualifying publish
 * (`fresh`) clears the marker; a silent wait increments the miss counter.
 */
export function recordDiagnosticsWaitOutcome(silenceKey: string, fresh: boolean): void {
	if (silenceMemoDisabled()) return;
	if (fresh) {
		diagnosticsSilence.delete(silenceKey);
		return;
	}
	const entry = diagnosticsSilence.get(silenceKey);
	if (entry) {
		entry.misses += 1;
		entry.lastMissAt = Date.now();
	} else {
		diagnosticsSilence.set(silenceKey, { misses: 1, lastMissAt: Date.now() });
	}
}

/** Reset all silence markers for a server (its project-loaded transition). */
export function resetDiagnosticsSilenceForClient(clientName: string): void {
	const prefix = `${clientName}:`;
	for (const memoKey of diagnosticsSilence.keys()) {
		if (memoKey.startsWith(prefix)) diagnosticsSilence.delete(memoKey);
	}
}

/** Drop all silence markers (config reload / dispose). */
export function clearDiagnosticsSilenceMemo(): void {
	diagnosticsSilence.clear();
}

/** Test-only reset for the silent-diagnostics memory. */
export function _resetLspSilenceMemoryForTest(): void {
	diagnosticsSilence.clear();
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
	/**
	 * Optional pull-model probe (LSP 3.17) raced against the push stream. Injected
	 * rather than called directly because it needs `sendRequest` from client.ts,
	 * which imports this module — see `documentDiagnosticsPull` there.
	 *
	 * Resolving to `[]` is an answer ("clean"); resolving to `undefined` is not,
	 * and must never cut the push wait short.
	 */
	pull?: (signal: AbortSignal | undefined, timeoutMs: number) => Promise<Diagnostic[] | undefined>;
}

/**
 * How much a publish can be trusted.
 *
 * `authoritative` — the server stamped it with the document version we asked
 * about (or the caller gave us no version to check), so it provably describes
 * the content we synced. Accept at once.
 *
 * `provisional` — the server published without a version. It MIGHT describe the
 * content we synced, or it might be an analysis of the previous content that was
 * already in flight when our didChange landed. Indistinguishable on its own, so
 * it is held until the publish stream goes quiet (see the settle window).
 */
type DiagnosticsAcceptance = { tier: "authoritative" | "provisional"; diagnostics: Diagnostic[] };

function classifyPublished(
	published: PublishedDiagnostics | undefined,
	expectedDocumentVersion?: number,
	allowUnversioned = true,
): DiagnosticsAcceptance | undefined {
	if (!published) return undefined;
	if (expectedDocumentVersion === undefined) return { tier: "authoritative", diagnostics: published.diagnostics };
	if (published.version === expectedDocumentVersion) {
		return { tier: "authoritative", diagnostics: published.diagnostics };
	}
	if (allowUnversioned && published.version == null) {
		return { tier: "provisional", diagnostics: published.diagnostics };
	}
	// A version that is present but does not match is a publish for OTHER content —
	// never acceptable, at any tier.
	return undefined;
}

// =============================================================================
// Settle window for unversioned publishes
// =============================================================================

/**
 * Quiet window an unversioned publish must survive before it is accepted.
 *
 * Paid ONLY by servers that publish without a version — every linter in
 * `defaults.ts` (biome, eslint, ruff, rubocop, swiftlint). A server that echoes
 * the document version is accepted on arrival and never waits.
 *
 * Kept far below oh-my-pi's 250ms because this wait is woken by the publish
 * event (~1-2ms) rather than a 100ms poll: the window only has to outlast the
 * gap between an in-flight stale publish and the fresh one that supersedes it,
 * not a polling tick on top of it.
 */
const DEFAULT_UNVERSIONED_SETTLE_MS = 75;

/** PIT_NO_LSP_DIAG_SETTLE=1 accepts the first unversioned publish again (stale risk). */
function settleDisabled(): boolean {
	return isTruthyEnvFlag(process.env.PIT_NO_LSP_DIAG_SETTLE);
}

/** Settle window in ms; test/tuning override via PIT_LSP_DIAG_SETTLE_MS. */
function unversionedSettleMs(): number {
	if (settleDisabled()) return 0;
	const raw = process.env.PIT_LSP_DIAG_SETTLE_MS;
	if (raw !== undefined && raw.trim() !== "") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
	}
	return DEFAULT_UNVERSIONED_SETTLE_MS;
}

/** `fresh` is false when the budget expired without a qualifying publish. */
export interface WaitForDiagnosticsResult {
	diagnostics: Diagnostic[];
	fresh: boolean;
}

/**
 * True when the signal was aborted by an `AbortSignal.timeout` deadline rather
 * than by a cancellation. Writethrough hands the wait `AbortSignal.any([caller,
 * deadline])` where the deadline duplicates the wait's own budget, so a deadline
 * abort is "the budget expired with no publish" — an ordinary miss the caller
 * must see as `fresh: false` (it feeds the silence memo), NOT a thrown error.
 * The old poll loop got this for free by sampling the signal only every 100ms:
 * an abort inside the final tick was never observed. Waking instantly means the
 * distinction now has to be explicit.
 */
function isDeadlineAbort(signal?: AbortSignal): boolean {
	if (!signal?.aborted) return false;
	return (signal.reason as { name?: string } | undefined)?.name === "TimeoutError";
}

/** Throw only on a genuine cancellation; a deadline expiry is not one. */
function throwIfCancelled(signal?: AbortSignal): void {
	if (isDeadlineAbort(signal)) return;
	throwIfAborted(signal);
}

/**
 * Wait for a client's published diagnostics for `uri` to satisfy the version
 * constraints, or until `timeoutMs` elapses. Throws if the signal is cancelled
 * (a deadline expiry is not a cancellation — see isDeadlineAbort).
 *
 * Woken by event, not by polling: `publishDiagnostics` arrives as a push
 * notification and storing it (plus the `diagnosticsVersion` bump) is the ONLY
 * transition that can satisfy the predicate below — `client.diagnostics` is
 * otherwise only deleted, and `expectedDocumentVersion` is a number captured by
 * the caller before the wait. So subscribing to the publish stream is exactly
 * equivalent to the old `sleep(100)` loop, minus the ~50ms of average dead time
 * every wait used to pay after the publish had already landed (twice per edit,
 * on the critical path of the tool result).
 */
export async function waitForDiagnosticsResult(
	client: LspClient,
	uri: string,
	options: WaitForDiagnosticsOptions = {},
): Promise<WaitForDiagnosticsResult> {
	const { timeoutMs = 3000, signal, minVersion, expectedDocumentVersion, allowUnversioned = true, pull } = options;

	const classify = (): DiagnosticsAcceptance | undefined => {
		const versionOk = minVersion === undefined || client.diagnosticsVersion > minVersion;
		if (!versionOk) return undefined;
		return classifyPublished(client.diagnostics.get(uri), expectedDocumentVersion, allowUnversioned);
	};

	// A non-positive budget never entered the old loop, so it never observed the
	// abort either — it fell straight through to the final check. Preserved.
	if (timeoutMs > 0) throwIfCancelled(signal);
	const settleMs = unversionedSettleMs();
	// Only an authoritative publish short-circuits the wait. A provisional one has
	// to go through the settle window below — unless the window is switched off, in
	// which case this is exactly the pre-settle behaviour.
	const immediate = classify();
	if (immediate && (immediate.tier === "authoritative" || settleMs <= 0)) {
		return { diagnostics: immediate.diagnostics, fresh: true };
	}
	// Nothing left to wait on: no budget, or the caller's deadline already expired
	// during setup — waiting a fresh full budget past it would blow the very
	// latency cap writethrough combined that deadline in to enforce.
	if (timeoutMs <= 0 || signal?.aborted) return { diagnostics: [], fresh: false };

	// Fire the pull once, in parallel with the push wait. It shares the budget, so
	// it cannot extend the wait; it can only end it earlier.
	let pulled: Diagnostic[] | undefined;
	// Cancelled the moment the wait ends. Without this, a push that wins in a few
	// milliseconds would still leave a `textDocument/diagnostic` running against the
	// server for the rest of the budget — and servers that do BOTH (rust-analyzer)
	// would pay real analysis work on every edit for an answer nobody reads.
	// `sendRequest`'s abort path sends `$/cancelRequest`, so the server hears it.
	const pullAbort = pull ? new AbortController() : undefined;
	const pullSignal = pullAbort && signal ? AbortSignal.any([signal, pullAbort.signal]) : pullAbort?.signal;
	// `.catch` attached at creation, not inside the callback below: a probe that
	// rejects before the callback runs would otherwise be an unhandled rejection.
	const pullProbe = pull?.(pullSignal, timeoutMs).catch(() => undefined);
	try {
		await awaitDiagnosticsPublish(client, timeoutMs, signal, classify, settleMs, (wake) => {
			// Only a real answer wakes the wait. A pull that fails, aborts, or returns
			// an `unchanged` report resolves to undefined, and letting THAT end the wait
			// would abandon a push still due to arrive inside the remaining budget —
			// turning the pull from a fallback into a regression for servers that do both.
			pullProbe?.then((items) => {
				if (items === undefined) return;
				pulled = items;
				wake();
			});
		});
	} finally {
		pullAbort?.abort();
	}

	throwIfCancelled(signal);
	// Either tier is taken now. A provisional that never settled — the budget ran
	// out mid-window — is still the only answer the server gave us, and discarding
	// it would report a productive server as silent and arm the silence memo.
	const published = classify();
	// The push stream stays authoritative: it carries the server's own version
	// stamp, which the pull report does not.
	if (published) return { diagnostics: published.diagnostics, fresh: true };
	if (pulled === undefined) return { diagnostics: [], fresh: false };
	// Adopt the pull answer into the published map so everything downstream that
	// reads `client.diagnostics` — the cross-file baseline snapshot, the next
	// pre-write baseline — sees it exactly as if the server had pushed it.
	adoptPulledDiagnostics(client, uri, pulled, expectedDocumentVersion);
	return { diagnostics: pulled, fresh: true };
}

/**
 * Record a pull report as this client's published diagnostics for `uri`, mirroring
 * what the `publishDiagnostics` handler does, and bump `diagnosticsVersion` so a
 * concurrent `minVersion` wait counts it as a new observation. Versioned with the
 * document version the caller expected when it has one — a pull report carries no
 * version of its own, and `null` marks it unversioned for `getAcceptedDiagnostics`.
 */
function adoptPulledDiagnostics(
	client: LspClient,
	uri: string,
	diagnostics: Diagnostic[],
	expectedDocumentVersion?: number,
): void {
	client.diagnostics.set(canonicalUriKey(uri), {
		diagnostics,
		version: expectedDocumentVersion ?? null,
	});
	client.diagnosticsVersion += 1;
}

/**
 * Block until the publish stream yields an acceptable answer, the budget
 * expires, or the signal aborts. Every exit path removes the listener, both
 * timers and the abort handler: a leaked waiter would live as long as the
 * client, and a leaked abort handler accumulates on the long-lived caller signal
 * across edits.
 *
 * An `authoritative` classification ends the wait on arrival. A `provisional`
 * one (an unversioned publish) instead arms a `settleMs` quiet window, re-armed
 * by every subsequent publish, so an in-flight analysis of the pre-edit content
 * is superseded by the fresh one rather than accepted in its place. The overall
 * budget still caps everything — the settle can delay an answer, never extend
 * the wait past `timeoutMs`.
 */
async function awaitDiagnosticsPublish(
	client: LspClient,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	classify: () => DiagnosticsAcceptance | undefined,
	settleMs: number,
	registerExternalWake?: (wake: () => void) => void,
): Promise<void> {
	let unsubscribe: (() => void) | undefined;
	let timer: NodeJS.Timeout | undefined;
	let settleTimer: NodeJS.Timeout | undefined;
	let onAbort: (() => void) | undefined;
	try {
		await new Promise<void>((resolve) => {
			const check = () => {
				const acceptance = classify();
				if (!acceptance) return;
				if (acceptance.tier === "authoritative" || settleMs <= 0) {
					resolve();
					return;
				}
				// Restart the window: this publish may yet be superseded by a newer one.
				if (settleTimer) clearTimeout(settleTimer);
				settleTimer = setTimeout(resolve, settleMs);
				settleTimer.unref?.();
			};
			unsubscribe = onDiagnosticsPublished(client, check);
			timer = setTimeout(resolve, timeoutMs);
			timer.unref?.();
			if (signal) {
				onAbort = () => resolve();
				signal.addEventListener("abort", onAbort, { once: true });
			}
			// A second source that may satisfy the wait (the pull probe). Resolving an
			// already-settled promise is a no-op, so racing with the paths above is safe.
			registerExternalWake?.(resolve);
			// A provisional publish may already be sitting there from before the wait
			// (the caller's short-circuit only accepts authoritative ones), and no
			// further publish is guaranteed to arrive to trigger `check` for it.
			// Guarded on `settleMs > 0`: with no settle there is no provisional tier to
			// rescue, and callers that wait for the NEXT publish (settleMs 0) must not
			// be resolved by state that predates the wait.
			if (settleMs > 0) check();
		});
	} finally {
		unsubscribe?.();
		if (timer) clearTimeout(timer);
		if (settleTimer) clearTimeout(settleTimer);
		if (signal && onAbort) signal.removeEventListener("abort", onAbort);
	}
}

/**
 * Wait for the NEXT publish batch from `client` (whatever its URI), capped at
 * `timeoutMs`. Returns true when one arrived. Never throws — an abort or an
 * empty window is a normal, non-fatal outcome for the best-effort caller.
 *
 * Exists because a server answers one didChange with the edited file's
 * diagnostics and its package siblings' as SEPARATE stdout reads (~1ms apart,
 * measured against gopls-style fakes). The edited-file wait now returns on the
 * first of those instead of on a 100ms poll tick, so the trailing sibling
 * publishes need an explicit — and bounded — moment to land.
 */
export async function waitForNextDiagnosticsPublish(
	client: LspClient,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<boolean> {
	if (timeoutMs <= 0 || signal?.aborted) return false;
	let published = false;
	// This caller only cares THAT a publish landed, not what it said, so every
	// publish counts as authoritative and no settle window applies.
	await awaitDiagnosticsPublish(
		client,
		timeoutMs,
		signal,
		() => {
			published = true;
			return { tier: "authoritative", diagnostics: [] };
		},
		0,
	);
	return published;
}

export async function waitForDiagnostics(
	client: LspClient,
	uri: string,
	options: WaitForDiagnosticsOptions = {},
): Promise<Diagnostic[]> {
	return (await waitForDiagnosticsResult(client, uri, options)).diagnostics;
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

async function collectGlobMatches(
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
	if (!GLOB_PATTERN_CHARS.test(file)) {
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
			// Stale-line recovery: the symbol moved since the model last read the file
			// (the #1 grounding miss in line-based navigation). The whole file is
			// already in `lines`, so scan a small window around the given line and, if
			// the symbol is found nearby, point at the real line instead of dead-ending
			// — best-first by proximity. No nearby match → message unchanged.
			let nearbyLine = -1;
			for (let d = 1; d <= 8 && nearbyLine < 0; d++) {
				for (const candidate of [lineNumber - d, lineNumber + d]) {
					if (candidate < 1 || candidate > lines.length) continue;
					const lineText = lines[candidate - 1] ?? "";
					if (
						findSymbolMatchIndexes(lineText, symbol).length > 0 ||
						findSymbolMatchIndexes(lineText, symbol, true).length > 0
					) {
						nearbyLine = candidate;
						break;
					}
				}
			}
			const hint = nearbyLine > 0 ? `; found on line ${nearbyLine} — pass line=${nearbyLine}` : "";
			throw new Error(`Symbol "${symbol}" not found on line ${lineNumber}${hint}`);
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
