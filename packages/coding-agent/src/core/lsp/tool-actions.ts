/**
 * Standalone `lsp` actions that operate across servers or the whole workspace
 * (diagnostics, capabilities, workspace symbols, raw requests, file renames),
 * kept out of tool.ts so the dispatcher stays a thin router and the single-file
 * position pipeline stays focused. Each handler takes (cwd, config, params, req,
 * signal) and returns a TextResult.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeFileAtomic } from "../../utils/atomic-write.ts";
import { killProcessTree } from "../../utils/shell.ts";
import { isHighSurrogate } from "../../utils/surrogate.ts";
import { resolveToCwd } from "../tools/path-utils.ts";
import { formatSize, truncateHead } from "../tools/truncate.ts";
import {
	ensureFileOpen,
	getOrCreateClient,
	refreshFile,
	sendNotification,
	sendRequest,
	waitForProjectLoaded,
} from "./client.ts";
import type { LspConfig } from "./config.ts";
import { getServerForFile, getServersForFile } from "./config.ts";
import { applyTextEdits, flattenWorkspaceTextEdits, rangesOverlap } from "./edits.ts";
import { log, throwIfAborted } from "./internal.ts";
import { getLspServers, isProjectAwareLspServer } from "./manager.ts";
import type { LspToolInput } from "./tool.ts";
import type { Diagnostic, ServerConfig, SymbolInformation, TextEdit, WorkspaceEdit } from "./types.ts";
import {
	dedupeDiagnostics,
	dedupeWorkspaceSymbols,
	fileToUri,
	filterWorkspaceSymbols,
	formatDiagnostic,
	formatDiagnosticsSummary,
	formatGroupedDiagnosticMessages,
	formatPathRelativeToCwd,
	formatSymbolInformation,
	formatWorkspaceEdit,
	resolveDiagnosticTargets,
	resolveSymbolColumn,
	sortDiagnostics,
	type TextResult,
	textResult,
	uriToFile,
	waitForDiagnosticsResult,
} from "./utils.ts";

const SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS = 3000;
const BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS = 400;
const MAX_GLOB_DIAGNOSTIC_TARGETS = 20;
const WORKSPACE_SYMBOL_LIMIT = 200;
const MAX_RENAME_PAIRS = 1000;
const LSP_JSON_OUTPUT_MAX_BYTES = 16 * 1024;
const LSP_JSON_OUTPUT_MAX_LINES = 400;

function capLspPayload(text: string, label: string): string {
	const truncation = truncateHead(text, { maxBytes: LSP_JSON_OUTPUT_MAX_BYTES, maxLines: LSP_JSON_OUTPUT_MAX_LINES });
	if (!truncation.truncated) return text;
	return `${truncation.content}\n\n[${label} truncated at ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(LSP_JSON_OUTPUT_MAX_BYTES)} limit); narrow the request]`;
}

// =============================================================================
// Rename helpers
// =============================================================================

function isMethodNotFoundError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message.toLowerCase();
	return (
		msg.includes("method not found") ||
		msg.includes("unhandled method") ||
		msg.includes("not supported") ||
		msg.includes("-32601")
	);
}

interface FileRenamePair {
	oldUri: string;
	newUri: string;
}

async function enumerateRenamePairs(
	source: string,
	dest: string,
): Promise<{ pairs: FileRenamePair[]; directory: boolean; exceeded: boolean }> {
	const stat = await fs.stat(source);
	if (!stat.isDirectory()) {
		return { pairs: [{ oldUri: fileToUri(source), newUri: fileToUri(dest) }], directory: false, exceeded: false };
	}
	// Stream entries instead of materializing the whole subtree: a directory
	// containing node_modules or a huge generated tree would allocate the full
	// Dirent list up front, defeating the MAX_RENAME_PAIRS cap (the very OOM the
	// cap exists to prevent). opendir lets the cap short-circuit and close the
	// handle before reading the rest of the tree.
	const dir = await fs.opendir(source, { recursive: true });
	const pairs: FileRenamePair[] = [];
	try {
		for await (const entry of dir) {
			if (!entry.isFile()) continue;
			if (pairs.length >= MAX_RENAME_PAIRS) return { pairs, directory: true, exceeded: true };
			const parent = entry.parentPath ?? source;
			const absOld = path.join(parent, entry.name);
			const rel = path.relative(source, absOld);
			pairs.push({ oldUri: fileToUri(absOld), newUri: fileToUri(path.join(dest, rel)) });
		}
	} finally {
		// The for-await loop closes the Dir on normal completion, but an early
		// return (cap hit) leaves it open; closeSync-equivalent via close() here.
		// Closing an already-closed Dir rejects, so guard with a no-op catch.
		await dir.close().catch(() => {});
	}
	return { pairs, directory: true, exceeded: false };
}

// =============================================================================
// Workspace diagnostics (subprocess: cargo / tsc / go / pyright)
// =============================================================================

interface ProjectType {
	type: "rust" | "typescript" | "go" | "python" | "unknown";
	command?: string[];
	description: string;
}

function detectProjectType(cwd: string): ProjectType {
	const exists = (f: string) => existsSync(path.join(cwd, f));
	if (exists("Cargo.toml"))
		return { type: "rust", command: ["cargo", "check", "--message-format=short"], description: "Rust (cargo check)" };
	if (exists("tsconfig.json"))
		return { type: "typescript", command: ["npx", "tsc", "--noEmit"], description: "TypeScript (tsc --noEmit)" };
	if (exists("go.mod")) return { type: "go", command: ["go", "build", "./..."], description: "Go (go build)" };
	if (exists("pyproject.toml") || exists("pyrightconfig.json"))
		return { type: "python", command: ["pyright"], description: "Python (pyright)" };
	return { type: "unknown", description: "Unknown project type" };
}

function runSubprocess(command: string[], cwd: string, signal?: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command[0], command.slice(1), {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
			windowsHide: true,
		});
		let out = "";
		// Cap accumulation: only the first 50 lines are kept downstream, so a
		// chatty compiler (thousands of diagnostics) must not grow the heap. Stop
		// appending once over the cap; the head is what we report.
		const MAX_OUTPUT_BYTES = 512 * 1024;
		let capped = false;
		// Keep a single streaming decoder across chunks so a multibyte UTF-8
		// sequence split across two data events (e.g. an accented path in a
		// compiler diagnostic) is not corrupted into U+FFFD at the boundary.
		const decoder = new TextDecoder();
		const append = (c: Buffer) => {
			if (capped) return;
			out += decoder.decode(c, { stream: true });
			if (out.length > MAX_OUTPUT_BYTES) {
				// Avoid splitting a surrogate pair at the cut: if the last kept
				// code unit is a lone high surrogate, drop it so the head never
				// renders as U+FFFD.
				const cut =
					isHighSurrogate(out.charCodeAt(MAX_OUTPUT_BYTES - 1)) === true ? MAX_OUTPUT_BYTES - 1 : MAX_OUTPUT_BYTES;
				out = out.slice(0, cut);
				capped = true;
			}
		};
		const onAbort = () => {
			try {
				// On Windows shell:true wraps the compiler in cmd.exe; child.kill only
				// signals the wrapper and leaves tsc/cargo running. Tear down the tree.
				if (child.pid !== undefined) killProcessTree(child.pid);
				else child.kill();
			} catch {
				// ignore
			}
		};
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort);
			reject(err);
		});
		child.on("close", () => {
			signal?.removeEventListener("abort", onAbort);
			// Flush any trailing bytes held by the streaming decoder. If we already
			// hit the byte cap the head is what we report, so skip the flush.
			if (!capped) out += decoder.decode();
			resolve(out);
		});
	});
}

async function runWorkspaceDiagnostics(
	cwd: string,
	signal?: AbortSignal,
): Promise<{ output: string; projectType: ProjectType }> {
	throwIfAborted(signal);
	const projectType = detectProjectType(cwd);
	if (!projectType.command) {
		return {
			output:
				"Cannot detect project type. Supported: Rust (Cargo.toml), TypeScript (tsconfig.json), Go (go.mod), Python (pyproject.toml)",
			projectType,
		};
	}
	try {
		const combined = (await runSubprocess(projectType.command, cwd, signal)).trim();
		throwIfAborted(signal);
		if (!combined) return { output: "No issues found", projectType };
		const lines = combined.split("\n");
		if (lines.length > 50) {
			return { output: `${lines.slice(0, 50).join("\n")}\n... and ${lines.length - 50} more lines`, projectType };
		}
		return { output: combined, projectType };
	} catch (e) {
		if (signal?.aborted) throw new Error("aborted");
		return { output: `Failed to run ${projectType.command.join(" ")}: ${e}`, projectType };
	}
}

// =============================================================================
// Action handlers
// =============================================================================

export async function runDiagnostics(
	cwd: string,
	config: LspConfig,
	params: LspToolInput,
	req: Record<string, unknown>,
	signal: AbortSignal,
	timeoutSec: number,
): Promise<TextResult> {
	const action = "diagnostics";
	const { file } = params;
	if (file === "*") {
		const result = await runWorkspaceDiagnostics(cwd, signal);
		return textResult(`Workspace diagnostics (${result.projectType.description}):\n${result.output}`, {
			action,
			success: true,
			request: req,
		});
	}
	if (!file) {
		throw new Error(
			"file parameter required. Use `*` for workspace-wide diagnostics or a path/glob for specific files.",
		);
	}

	const resolvedTargets = await resolveDiagnosticTargets(file, cwd, MAX_GLOB_DIAGNOSTIC_TARGETS);
	const targets = resolvedTargets.matches;
	const truncatedGlobTargets = resolvedTargets.truncated;
	if (targets.length === 0) {
		return textResult(`No files matched pattern: ${file}`, { action, success: true, request: req });
	}

	const detailed = targets.length > 1 || truncatedGlobTargets;
	const diagnosticsWaitTimeoutMs = detailed
		? Math.min(BATCH_DIAGNOSTICS_WAIT_TIMEOUT_MS, timeoutSec * 1000)
		: Math.min(SINGLE_DIAGNOSTICS_WAIT_TIMEOUT_MS, timeoutSec * 1000);
	const results: string[] = [];
	const allServerNames = new Set<string>();
	if (truncatedGlobTargets) {
		results.push(
			`Pattern matched more than ${MAX_GLOB_DIAGNOSTIC_TARGETS} files; showing first ${MAX_GLOB_DIAGNOSTIC_TARGETS}. Narrow the glob or use workspace diagnostics.`,
		);
	}

	for (const target of targets) {
		throwIfAborted(signal);
		const resolved = resolveToCwd(target, cwd);
		const servers = getServersForFile(config, resolved);
		if (servers.length === 0) {
			results.push(`${target}: No language server found`);
			continue;
		}
		const uri = fileToUri(resolved);
		const relPath = formatPathRelativeToCwd(resolved, cwd);
		const allDiagnostics: Diagnostic[] = [];
		const serverIssues: string[] = [];
		let freshServerCount = 0;

		for (const [serverName, serverConfig] of servers) {
			allServerNames.add(serverName);
			try {
				throwIfAborted(signal);
				const client = await getOrCreateClient(serverConfig, cwd);
				if (isProjectAwareLspServer(serverConfig)) {
					await waitForProjectLoaded(client, signal);
					throwIfAborted(signal);
				}
				const minVersion = client.diagnosticsVersion;
				await refreshFile(client, resolved, signal);
				const expectedDocumentVersion = client.openFiles.get(uri)?.version;
				const result = await waitForDiagnosticsResult(client, uri, {
					timeoutMs: diagnosticsWaitTimeoutMs,
					signal,
					minVersion,
					expectedDocumentVersion,
				});
				if (!result.fresh) {
					serverIssues.push(`${serverName}: no fresh diagnostics published`);
					continue;
				}
				freshServerCount += 1;
				allDiagnostics.push(...result.diagnostics);
			} catch (err) {
				if (signal?.aborted) throw err;
				serverIssues.push(`${serverName}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		const uniqueDiagnostics = dedupeDiagnostics(allDiagnostics);
		sortDiagnostics(uniqueDiagnostics);
		const issueNote = serverIssues.length > 0 ? ` (${serverIssues.join("; ")})` : "";

		if (!detailed && targets.length === 1) {
			if (freshServerCount === 0) {
				return textResult(
					`Diagnostics unavailable for ${relPath}: ${serverIssues.join("; ") || "no fresh diagnostics"}`,
					{
						action,
						serverName: Array.from(allServerNames).join(", "),
						success: true,
					},
				);
			}
			if (uniqueDiagnostics.length === 0) {
				return textResult(`OK${issueNote}`, {
					action,
					serverName: Array.from(allServerNames).join(", "),
					success: true,
				});
			}
			const summary = formatDiagnosticsSummary(uniqueDiagnostics);
			const formatted = uniqueDiagnostics.map((d) => formatDiagnostic(d, relPath, cwd));
			return textResult(`${summary}${issueNote}:\n${formatGroupedDiagnosticMessages(formatted)}`, {
				action,
				serverName: Array.from(allServerNames).join(", "),
				success: true,
			});
		}

		if (freshServerCount === 0) {
			results.push(`${relPath}: diagnostics unavailable${issueNote}`);
		} else if (uniqueDiagnostics.length === 0) {
			results.push(`${relPath}: no issues${issueNote}`);
		} else {
			const summary = formatDiagnosticsSummary(uniqueDiagnostics);
			results.push(`${relPath}: ${summary}${issueNote}`);
			results.push(formatGroupedDiagnosticMessages(uniqueDiagnostics.map((d) => formatDiagnostic(d, relPath, cwd))));
		}
	}

	return textResult(results.join("\n"), {
		action,
		serverName: Array.from(allServerNames).join(", "),
		success: true,
	});
}

export async function runCapabilities(
	cwd: string,
	config: LspConfig,
	params: LspToolInput,
	req: Record<string, unknown>,
	signal: AbortSignal,
): Promise<TextResult> {
	const action = "capabilities";
	const { file } = params;
	let serverList: Array<[string, ServerConfig]>;
	if (file && file !== "*") {
		serverList = getServersForFile(config, resolveToCwd(file, cwd));
		if (serverList.length === 0) {
			throw new Error("No language server found for this file");
		}
	} else {
		serverList = getLspServers(config);
	}
	if (serverList.length === 0) {
		throw new Error("No language servers configured");
	}
	const sections: string[] = [];
	const responding = new Set<string>();
	for (const [serverName, serverConfig] of serverList) {
		throwIfAborted(signal);
		try {
			const client = await getOrCreateClient(serverConfig, cwd);
			responding.add(serverName);
			const caps = client.serverCapabilities ?? {};
			const capped = capLspPayload(JSON.stringify(caps, null, 2), `${serverName} capabilities`);
			sections.push(`${serverName}:`);
			sections.push(`  capabilities: ${capped.split("\n").join("\n  ")}`);
		} catch (err) {
			if (signal?.aborted) throw err;
			sections.push(`${serverName}: failed to start (${err instanceof Error ? err.message : String(err)})`);
		}
	}
	return textResult(sections.join("\n"), {
		action,
		serverName: Array.from(responding).join(", "),
		success: true,
		request: req,
	});
}

export async function workspaceSymbols(
	cwd: string,
	config: LspConfig,
	query: string | undefined,
	req: Record<string, unknown>,
	signal: AbortSignal,
): Promise<TextResult> {
	const action = "symbols";
	const normalizedQuery = query?.trim();
	if (!normalizedQuery) {
		throw new Error("query parameter required for workspace symbol search");
	}
	const servers = getLspServers(config);
	if (servers.length === 0) {
		throw new Error("No language server found for this action");
	}
	const aggregated: SymbolInformation[] = [];
	const responding = new Set<string>();
	for (const [serverName, serverConfig] of servers) {
		throwIfAborted(signal);
		try {
			const client = await getOrCreateClient(serverConfig, cwd);
			const result = (await sendRequest(client, "workspace/symbol", { query: normalizedQuery }, signal)) as
				| SymbolInformation[]
				| null;
			if (!result || result.length === 0) continue;
			responding.add(serverName);
			aggregated.push(...filterWorkspaceSymbols(result, normalizedQuery));
		} catch (err) {
			if (signal?.aborted) throw err;
		}
	}
	const deduped = dedupeWorkspaceSymbols(aggregated);
	if (deduped.length === 0) {
		return textResult(`No symbols matching "${normalizedQuery}"`, {
			action,
			serverName: Array.from(responding).join(", "),
			success: true,
			request: req,
		});
	}
	const limited = deduped.slice(0, WORKSPACE_SYMBOL_LIMIT);
	const lines = limited.map((s) => formatSymbolInformation(s, cwd));
	const truncationLine =
		deduped.length > WORKSPACE_SYMBOL_LIMIT
			? `\n... ${deduped.length - WORKSPACE_SYMBOL_LIMIT} additional symbol(s) omitted`
			: "";
	return textResult(
		`Found ${deduped.length} symbol(s) matching "${normalizedQuery}":\n${lines.map((l) => `  ${l}`).join("\n")}${truncationLine}`,
		{ action, serverName: Array.from(responding).join(", "), success: true, request: req },
	);
}

export async function rawRequest(
	cwd: string,
	config: LspConfig,
	params: LspToolInput,
	req: Record<string, unknown>,
	signal: AbortSignal,
): Promise<TextResult> {
	const action = "request";
	const { file, line, symbol, query, payload } = params;
	const method = query?.trim();
	if (!method) {
		throw new Error(
			"action=request requires `query` to specify the LSP method name (e.g. 'rust-analyzer/expandMacro')",
		);
	}
	let chosenServer: [string, ServerConfig] | null = null;
	let resolvedTarget: string | null = null;
	if (file && file !== "*") {
		resolvedTarget = resolveToCwd(file, cwd);
		chosenServer = getServerForFile(config, resolvedTarget);
		if (!chosenServer) {
			throw new Error("No language server found for this file");
		}
	} else {
		const all = getLspServers(config);
		if (all.length === 0) {
			throw new Error("No language servers configured");
		}
		chosenServer = all[0];
	}

	const [chosenName, chosenConfig] = chosenServer;
	let requestParams: unknown;
	if (payload !== undefined) {
		try {
			requestParams = JSON.parse(payload);
		} catch (err) {
			throw new Error(`invalid JSON in payload: ${err instanceof Error ? err.message : String(err)}`);
		}
	} else if (resolvedTarget) {
		const uri = fileToUri(resolvedTarget);
		if (line !== undefined) {
			const character = await resolveSymbolColumn(resolvedTarget, line, symbol);
			requestParams = { textDocument: { uri }, position: { line: line - 1, character } };
		} else {
			requestParams = { textDocument: { uri } };
		}
	} else {
		requestParams = {};
	}

	try {
		const client = await getOrCreateClient(chosenConfig, cwd);
		if (resolvedTarget) await ensureFileOpen(client, resolvedTarget, signal);
		const result = await sendRequest(client, method, requestParams, signal);
		const formatted =
			result === null || result === undefined
				? "null"
				: typeof result === "string"
					? result
					: JSON.stringify(result, null, 2);
		return textResult(`${chosenName} <- ${method}:\n${capLspPayload(formatted, method)}`, {
			action,
			serverName: chosenName,
			success: true,
			request: req,
		});
	} catch (err) {
		if (signal?.aborted) throw new Error("aborted");
		throw new Error(`LSP error from ${chosenName} on ${method}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

export async function renameFile(
	cwd: string,
	config: LspConfig,
	params: LspToolInput,
	req: Record<string, unknown>,
	signal: AbortSignal,
): Promise<TextResult> {
	const action = "rename_file";
	const { file, new_name, apply } = params;
	if (!file || !new_name) {
		throw new Error("rename_file requires both `file` (source path) and `new_name` (destination path)");
	}
	const source = resolveToCwd(file, cwd);
	const dest = resolveToCwd(new_name, cwd);
	if (source === dest) {
		throw new Error("source and destination paths are identical");
	}

	let sourceStat: Awaited<ReturnType<typeof fs.stat>>;
	try {
		sourceStat = await fs.stat(source);
	} catch {
		throw new Error(`source path does not exist: ${formatPathRelativeToCwd(source, cwd)}`);
	}
	let destExists = false;
	try {
		await fs.stat(dest);
		destExists = true;
	} catch {
		// expected
	}
	if (destExists) {
		throw new Error(`destination already exists: ${formatPathRelativeToCwd(dest, cwd)}`);
	}

	const enumerated = await enumerateRenamePairs(source, dest);
	if (enumerated.exceeded) {
		throw new Error(
			`directory contains more than ${MAX_RENAME_PAIRS} files; rename in smaller batches to keep LSP edits accurate`,
		);
	}
	const { pairs } = enumerated;
	if (pairs.length === 0) {
		throw new Error("no files to rename");
	}

	const lspParams = { files: pairs };
	const servers = getLspServers(config);
	const respondingServers = new Set<string>();
	const perServerEdits: Array<{ serverName: string; edit: WorkspaceEdit }> = [];
	const serverNotes: string[] = [];

	for (const [serverName, serverConfig] of servers) {
		throwIfAborted(signal);
		try {
			const client = await getOrCreateClient(serverConfig, cwd);
			if (isProjectAwareLspServer(serverConfig)) await waitForProjectLoaded(client, signal);
			const result = (await sendRequest(
				client,
				"workspace/willRenameFiles",
				lspParams,
				signal,
			)) as WorkspaceEdit | null;
			respondingServers.add(serverName);
			if (result && (result.changes || result.documentChanges)) perServerEdits.push({ serverName, edit: result });
		} catch (err) {
			if (signal?.aborted) throw err;
			if (!isMethodNotFoundError(err)) {
				serverNotes.push(`  ${serverName}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	const sourceLabel = formatPathRelativeToCwd(source, cwd);
	const destLabel = formatPathRelativeToCwd(dest, cwd);
	const fileCountLabel = sourceStat.isDirectory()
		? `${pairs.length} file${pairs.length !== 1 ? "s" : ""} under ${sourceLabel}`
		: sourceLabel;

	if (apply === false) {
		const lines: string[] = [`Rename preview: ${fileCountLabel} -> ${destLabel}`];
		if (perServerEdits.length === 0) {
			lines.push("  No LSP edits would be applied");
		} else {
			for (const { serverName, edit } of perServerEdits) {
				const edits = formatWorkspaceEdit(edit, cwd);
				if (edits.length === 0) continue;
				lines.push(`  ${serverName}:`);
				for (const e of edits) lines.push(`    ${e}`);
			}
		}
		if (serverNotes.length > 0) {
			lines.push("  Server notes:");
			lines.push(...serverNotes);
		}
		return textResult(lines.join("\n"), {
			action,
			serverName: Array.from(respondingServers).join(", "),
			success: true,
			request: req,
		});
	}

	// Apply: coalesce per-URI edits across servers (prefer project-primary on overlap).
	const summary: string[] = [];
	const serverConfigByName = new Map(servers);
	interface AcceptedBucket {
		primaryServer: string;
		edits: TextEdit[];
		discarded: number;
		conflictServers: Set<string>;
	}
	const acceptedByUri = new Map<string, AcceptedBucket>();
	for (const { serverName, edit } of perServerEdits) {
		const cfg = serverConfigByName.get(serverName);
		const incomingPrimary = cfg ? isProjectAwareLspServer(cfg) : false;
		const flat = flattenWorkspaceTextEdits(edit);
		for (const [uri, edits] of flat) {
			const existing = acceptedByUri.get(uri);
			if (!existing) {
				acceptedByUri.set(uri, {
					primaryServer: serverName,
					edits: [...edits],
					discarded: 0,
					conflictServers: new Set(),
				});
				continue;
			}
			const existingCfg = serverConfigByName.get(existing.primaryServer);
			const existingIsPrimary = existingCfg ? isProjectAwareLspServer(existingCfg) : false;
			if (incomingPrimary && !existingIsPrimary) {
				const keptOld: TextEdit[] = [];
				let discardedOld = 0;
				for (const oe of existing.edits) {
					if (edits.some((ne) => rangesOverlap(ne.range, oe.range))) discardedOld++;
					else keptOld.push(oe);
				}
				if (discardedOld > 0) existing.conflictServers.add(existing.primaryServer);
				existing.discarded += discardedOld;
				existing.primaryServer = serverName;
				existing.edits = [...edits, ...keptOld];
			} else {
				let discardedNew = 0;
				for (const ne of edits) {
					if (existing.edits.some((ae) => rangesOverlap(ae.range, ne.range))) discardedNew++;
					else existing.edits.push(ne);
				}
				if (discardedNew > 0) {
					existing.conflictServers.add(serverName);
					existing.discarded += discardedNew;
				}
			}
		}
	}

	// Snapshot every file we are about to edit so a partial failure (a bad edit, or
	// fs.rename failing with EXDEV/EBUSY/EPERM mid-operation) rolls back instead of
	// leaving the workspace hybrid — importers rewritten but the file not moved.
	const renameSnapshots = new Map<string, string>();
	for (const uri of acceptedByUri.keys()) {
		const filePath = uriToFile(uri);
		try {
			renameSnapshots.set(filePath, await fs.readFile(filePath, "utf-8"));
		} catch {
			// Missing/unreadable — applyTextEdits surfaces the real error below.
		}
	}
	let renamed = false;
	try {
		for (const [uri, bucket] of acceptedByUri) {
			const filePath = uriToFile(uri);
			await applyTextEdits(filePath, bucket.edits);
			const rel = formatPathRelativeToCwd(filePath, cwd);
			summary.push(`  ${bucket.primaryServer}: applied ${bucket.edits.length} edit(s) to ${rel}`);
			if (bucket.discarded > 0) {
				const others = Array.from(bucket.conflictServers).join(", ");
				summary.push(
					`    note: discarded ${bucket.discarded} overlapping edit(s) from ${others} (kept ${bucket.primaryServer})`,
				);
				log.warn(`rename_file discarded overlapping edits on ${rel}`, { discarded: bucket.discarded, others });
			}
		}

		await fs.mkdir(path.dirname(dest), { recursive: true });
		await fs.rename(source, dest);
		renamed = true;
		summary.push(`  Renamed ${sourceLabel} -> ${destLabel}`);
	} catch (err) {
		// Roll back the edited files and undo the rename if it already happened.
		for (const [filePath, content] of renameSnapshots) {
			try {
				await writeFileAtomic(filePath, content);
			} catch {
				// best-effort restore
			}
		}
		if (renamed) {
			try {
				await fs.rename(dest, source);
			} catch {
				// best-effort un-rename
			}
		}
		throw new Error(`rename_file failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`);
	}

	for (const [serverName, serverConfig] of servers) {
		try {
			const client = await getOrCreateClient(serverConfig, cwd);
			for (const { oldUri } of pairs) {
				if (client.openFiles.has(oldUri)) {
					await sendNotification(client, "textDocument/didClose", { textDocument: { uri: oldUri } });
					client.openFiles.delete(oldUri);
				}
			}
			await sendNotification(client, "workspace/didRenameFiles", lspParams);
		} catch (err) {
			if (signal?.aborted) throw err;
			serverNotes.push(`  ${serverName}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	if (serverNotes.length > 0) {
		summary.push("  Server notes:");
		summary.push(...serverNotes);
	}

	return textResult(`Renamed ${fileCountLabel} -> ${destLabel}\n${summary.join("\n")}`, {
		action,
		serverName: Array.from(respondingServers).join(", "),
		success: true,
		request: req,
	});
}
