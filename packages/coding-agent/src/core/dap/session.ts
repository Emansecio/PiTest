/**
 * DapSessionManager: owns the single active debug session — its lifecycle,
 * breakpoint cache, stop/continue/exit state, output ring, and the
 * configurationDone handshake. Ported from oh-my-pi for Node.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import * as timers from "node:timers/promises";
import { recordDiagnostic } from "@pit/ai";
import { waitForChildProcess } from "../../utils/child-process.ts";
import { trackDetachedChildPid } from "../../utils/shell.ts";
import { log, toErrorMessage, untilAborted } from "../lsp/internal.ts";
import { DapClient, NON_INTERACTIVE_ENV } from "./client.ts";
import type {
	DapAttachArguments,
	DapAttachSessionOptions,
	DapBreakpoint,
	DapBreakpointRecord,
	DapCapabilities,
	DapContinueArguments,
	DapContinueOutcome,
	DapContinueResponse,
	DapDataBreakpoint,
	DapDataBreakpointInfoArguments,
	DapDataBreakpointInfoResponse,
	DapDisassembleArguments,
	DapDisassembledInstruction,
	DapDisassembleResponse,
	DapEvaluateArguments,
	DapEvaluateResponse,
	DapExitedEventBody,
	DapFunctionBreakpoint,
	DapFunctionBreakpointRecord,
	DapInitializeArguments,
	DapInstructionBreakpoint,
	DapInstructionBreakpointRecord,
	DapLaunchArguments,
	DapLaunchSessionOptions,
	DapLoadedSourcesResponse,
	DapModule,
	DapModulesArguments,
	DapModulesResponse,
	DapOutputEventBody,
	DapPauseArguments,
	DapReadMemoryArguments,
	DapReadMemoryResponse,
	DapResolvedAdapter,
	DapRunInTerminalArguments,
	DapRunInTerminalResponse,
	DapScopesArguments,
	DapScopesResponse,
	DapSessionStatus,
	DapSessionSummary,
	DapSetDataBreakpointsArguments,
	DapSetInstructionBreakpointsArguments,
	DapSource,
	DapSourceBreakpoint,
	DapStackFrame,
	DapStackTraceArguments,
	DapStackTraceResponse,
	DapStartDebuggingArguments,
	DapStepArguments,
	DapStopLocation,
	DapStoppedEventBody,
	DapThread,
	DapThreadsResponse,
	DapVariablesArguments,
	DapVariablesResponse,
	DapWriteMemoryArguments,
	DapWriteMemoryResponse,
} from "./types.ts";

interface DapSession {
	id: string;
	adapter: DapResolvedAdapter;
	cwd: string;
	program?: string;
	client: DapClient;
	status: DapSessionStatus;
	launchedAt: number;
	lastUsedAt: number;
	breakpoints: Map<string, DapBreakpointRecord[]>;
	functionBreakpoints: DapFunctionBreakpointRecord[];
	instructionBreakpoints: DapInstructionBreakpoint[];
	dataBreakpoints: DapDataBreakpoint[];
	output: string;
	outputBytes: number;
	outputTruncated: boolean;
	stop: DapStopLocation;
	threads: DapThread[];
	lastStackFrames: DapStackFrame[];
	exitCode?: number;
	capabilities?: DapCapabilities;
	initializedSeen: boolean;
	needsConfigurationDone: boolean;
	configurationDoneSent: boolean;
}

export interface DapOutputSnapshot {
	snapshot: DapSessionSummary;
	output: string;
}

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 30 * 1000;
const HEARTBEAT_INTERVAL_MS = 5 * 1000;
export const MAX_OUTPUT_BYTES = 128 * 1024;
const STOP_CAPTURE_TIMEOUT_MS = 5_000;

interface DapStartRequestFailure {
	rejected: boolean;
	error?: unknown;
	settled?: Promise<void>;
}

function trackDapStartRequest<T>(promise: Promise<T>, failure: DapStartRequestFailure): Promise<T> {
	const tracked = promise.catch((error) => {
		failure.rejected = true;
		failure.error = error;
		throw error;
	});
	failure.settled = tracked.then(
		() => {},
		() => {},
	);
	return tracked;
}

function combineDapStartErrors(command: "launch" | "attach", startError: unknown, configurationError: unknown): Error {
	const startMessage = toErrorMessage(startError);
	const configurationMessage = toErrorMessage(configurationError);
	if (startMessage === configurationMessage) {
		return startError instanceof Error ? startError : new Error(startMessage);
	}
	return new Error(
		`DAP ${command} failed: ${startMessage}\nDAP configurationDone also failed: ${configurationMessage}`,
	);
}

async function throwPreferredDapStartError(
	command: "launch" | "attach",
	startFailure: DapStartRequestFailure,
	configurationError: unknown,
): Promise<never> {
	await Promise.race([startFailure.settled ?? Promise.resolve(), timers.setTimeout(50)]);
	if (startFailure.rejected) {
		throw combineDapStartErrors(command, startFailure.error, configurationError);
	}
	throw configurationError;
}

const DEBUGPY_MISSING_MODULE_RE = /No module named ['"]?debugpy['"]?/;

function mapDebugpyMissingModule(adapterName: string, error: unknown): Error | null {
	if (adapterName !== "debugpy") return null;
	if (!DEBUGPY_MISSING_MODULE_RE.test(toErrorMessage(error))) return null;
	return new Error("adapter 'debugpy' is not available: install with 'pip install debugpy'");
}

function normalizePath(filePath: string): string {
	return path.resolve(filePath);
}

// Mutable subset of DapSession that truncateOutput touches — exported so the
// retention algorithm can be exercised directly (byte-identity) from tests.
export interface DapOutputBuffer {
	output: string;
	outputBytes: number;
	outputTruncated: boolean;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

export function truncateOutput(session: DapOutputBuffer, output: string): void {
	if (!output) return;
	const wasTruncated = session.outputTruncated;
	session.output += output;
	session.outputBytes += Buffer.byteLength(output, "utf-8");
	// Drop fixed 1024-char slices off the front until under cap, tracking the
	// byte total incrementally (encode only the removed slice, not the whole
	// buffer) so a large burst stays O(n) instead of O(n²) on re-encode.
	let curBytes = Buffer.byteLength(session.output, "utf-8");
	while (curBytes > MAX_OUTPUT_BYTES) {
		const n = Math.min(1024, session.output.length);
		curBytes -= Buffer.byteLength(session.output.slice(0, n), "utf-8");
		// A 1024-char cut can split a surrogate pair: the head keeps a lone high
		// and the tail a lone low, each encoding to a 3-byte U+FFFD, so the 4-byte
		// astral char becomes 6 bytes. byteLength(head) then over-counts the removal
		// by 2 vs re-encoding the whole remainder — add it back to stay byte-exact.
		if (isHighSurrogate(session.output.charCodeAt(n - 1)) && isLowSurrogate(session.output.charCodeAt(n))) {
			curBytes += 2;
		}
		session.output = session.output.slice(n);
		session.outputTruncated = true;
	}
	// Record once per session, on the first false→true transition (not per chunk).
	if (!wasTruncated && session.outputTruncated) {
		recordDiagnostic({
			category: "output.cap",
			level: "info",
			source: "dap.truncateOutput",
			context: { bytes: MAX_OUTPUT_BYTES },
		});
	}
}

function summarizeBreakpointCount(breakpoints: Map<string, DapBreakpointRecord[]>): number {
	let total = 0;
	for (const entries of breakpoints.values()) total += entries.length;
	return total;
}

function buildSummary(session: DapSession): DapSessionSummary {
	return {
		id: session.id,
		adapter: session.adapter.name,
		cwd: session.cwd,
		program: session.program,
		status: session.status,
		launchedAt: new Date(session.launchedAt).toISOString(),
		lastUsedAt: new Date(session.lastUsedAt).toISOString(),
		threadId: session.stop.threadId,
		frameId: session.stop.frameId,
		stopReason: session.stop.reason,
		stopDescription: session.stop.description ?? session.stop.text,
		frameName: session.stop.frameName,
		instructionPointerReference: session.stop.instructionPointerReference,
		source: session.stop.source,
		line: session.stop.line,
		column: session.stop.column,
		breakpointFiles: session.breakpoints.size,
		breakpointCount: summarizeBreakpointCount(session.breakpoints),
		functionBreakpointCount: session.functionBreakpoints.length,
		outputBytes: session.outputBytes,
		outputTruncated: session.outputTruncated,
		exitCode: session.exitCode,
		needsConfigurationDone: session.needsConfigurationDone && !session.configurationDoneSent,
	};
}

/** Filter out matching breakpoints, optionally add a new one, and re-sort the list. */
function upsertBreakpoint<T>(
	list: readonly T[],
	matches: (entry: T) => boolean,
	added: T | null,
	compare: (a: T, b: T) => number,
): T[] {
	const next = list.filter((entry) => !matches(entry));
	if (added) next.push(added);
	next.sort(compare);
	return next;
}

/** Overlay the adapter's verification result (id/verified/message) onto a breakpoint entry. */
function withVerification<T extends object>(
	entry: T,
	bp: DapBreakpoint | undefined,
): T & { id?: number; verified: boolean; message?: string } {
	return { ...entry, id: bp?.id, verified: bp?.verified ?? false, message: bp?.message };
}

function compareInstructionBreakpoints(a: DapInstructionBreakpoint, b: DapInstructionBreakpoint): number {
	const order = a.instructionReference.localeCompare(b.instructionReference);
	return order !== 0 ? order : (a.offset ?? 0) - (b.offset ?? 0);
}

/** Instruction breakpoints also adopt the adapter's resolved reference/offset. */
function mapInstructionRecords(
	entries: DapInstructionBreakpoint[],
	response: DapBreakpoint[] | undefined,
): DapInstructionBreakpointRecord[] {
	return entries.map((entry, index) => {
		const bp = response?.[index];
		return {
			...withVerification(entry, bp),
			instructionReference: bp?.instructionReference ?? entry.instructionReference,
			offset: bp?.offset ?? entry.offset,
		};
	});
}

export class DapSessionManager {
	#sessions = new Map<string, DapSession>();
	#activeSessionId: string | null = null;
	#cleanupLoopPromise?: Promise<void>;
	#nextId = 0;

	getActiveSession(): DapSessionSummary | null {
		const session = this.#getActiveSessionOrNull();
		return session ? buildSummary(session) : null;
	}

	listSessions(): DapSessionSummary[] {
		return Array.from(this.#sessions.values()).map(buildSummary);
	}

	getCapabilities(): DapCapabilities | null {
		return this.#getActiveSessionOrNull()?.capabilities ?? null;
	}

	async launch(
		options: DapLaunchSessionOptions,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	): Promise<DapSessionSummary> {
		const requestArgs: DapLaunchArguments = {
			...options.adapter.launchDefaults,
			program: options.program,
			cwd: options.cwd,
			args: options.args,
		};
		return this.#startSession(
			"launch",
			options.adapter,
			options.cwd,
			options.program,
			requestArgs,
			signal,
			timeoutMs,
		);
	}

	async attach(
		options: DapAttachSessionOptions,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	): Promise<DapSessionSummary> {
		const requestArgs: DapAttachArguments = {
			...options.adapter.attachDefaults,
			cwd: options.cwd,
			...(options.pid !== undefined ? { pid: options.pid, processId: options.pid } : {}),
			...(options.port !== undefined ? { port: options.port } : {}),
			...(options.host ? { host: options.host } : {}),
		};
		return this.#startSession("attach", options.adapter, options.cwd, undefined, requestArgs, signal, timeoutMs);
	}

	/**
	 * Shared launch/attach lifecycle: spawn the adapter, initialize, fire the
	 * launch/attach request alongside the configurationDone handshake, then await
	 * the initial stop (or fall back to running/configuring). Disposes the session
	 * on any failure and maps the debugpy "module missing" case.
	 */
	async #startSession(
		command: "launch" | "attach",
		adapter: DapResolvedAdapter,
		cwd: string,
		program: string | undefined,
		requestArgs: DapLaunchArguments | DapAttachArguments,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	): Promise<DapSessionSummary> {
		await this.#ensureLaunchSlot();
		const client = await DapClient.spawn({ adapter, cwd });
		const session = this.#registerSession(client, adapter, cwd, program);
		try {
			session.capabilities = await client.initialize(this.#buildInitializeArguments(adapter), signal, timeoutMs);
			session.needsConfigurationDone = session.capabilities.supportsConfigurationDoneRequest === true;
			const initialStopPromise = this.#prepareStopOutcome(
				session,
				signal,
				Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS),
			);
			const startFailure: DapStartRequestFailure = { rejected: false };
			const startPromise = trackDapStartRequest(
				client.sendRequest(command, requestArgs, signal, timeoutMs),
				startFailure,
			);
			startPromise.catch(() => {});
			try {
				await this.#sendConfigurationDone(session, true, signal, timeoutMs);
			} catch (error) {
				await throwPreferredDapStartError(command, startFailure, error);
			}
			await startPromise;
			try {
				await untilAborted(signal, initialStopPromise);
				if (session.status === "stopped") {
					await this.#fetchTopFrame(session, signal, Math.min(timeoutMs, STOP_CAPTURE_TIMEOUT_MS));
				}
			} catch {
				if (session.initializedSeen && session.status === "launching") {
					session.status = session.configurationDoneSent ? "running" : "configuring";
				}
			}
			return buildSummary(session);
		} catch (error) {
			this.#disposeSession(session);
			const mapped = mapDebugpyMissingModule(adapter.name, error);
			if (mapped) throw mapped;
			throw error;
		}
	}

	async setBreakpoint(file: string, line: number, condition?: string, signal?: AbortSignal, timeoutMs = 30_000) {
		const session = this.#touchActiveSession();
		const sourcePath = normalizePath(file);
		const current = upsertBreakpoint<DapBreakpointRecord>(
			session.breakpoints.get(sourcePath) ?? [],
			(entry) => entry.line === line,
			{ verified: false, line, condition },
			(a, b) => a.line - b.line,
		);
		const response = await this.#sendSourceBreakpoints(session, sourcePath, current, signal, timeoutMs);
		session.breakpoints.set(
			sourcePath,
			current.map((entry, index) => withVerification(entry, response?.breakpoints?.[index])),
		);
		return { snapshot: buildSummary(session), breakpoints: session.breakpoints.get(sourcePath) ?? [], sourcePath };
	}

	async removeBreakpoint(file: string, line: number, signal?: AbortSignal, timeoutMs = 30_000) {
		const session = this.#touchActiveSession();
		const sourcePath = normalizePath(file);
		const current = upsertBreakpoint<DapBreakpointRecord>(
			session.breakpoints.get(sourcePath) ?? [],
			(entry) => entry.line === line,
			null,
			(a, b) => a.line - b.line,
		);
		const response = await this.#sendSourceBreakpoints(session, sourcePath, current, signal, timeoutMs);
		if (current.length === 0) session.breakpoints.delete(sourcePath);
		else
			session.breakpoints.set(
				sourcePath,
				current.map((entry, index) => withVerification(entry, response?.breakpoints?.[index])),
			);
		return { snapshot: buildSummary(session), breakpoints: session.breakpoints.get(sourcePath) ?? [], sourcePath };
	}

	#sendSourceBreakpoints(
		session: DapSession,
		sourcePath: string,
		breakpoints: DapBreakpointRecord[],
		signal?: AbortSignal,
		timeoutMs = 30_000,
	) {
		return this.#sendRequestWithConfig<{ breakpoints?: DapBreakpoint[] }>(
			session,
			"setBreakpoints",
			{
				source: { path: sourcePath, name: path.basename(sourcePath) },
				breakpoints: breakpoints.map<DapSourceBreakpoint>((entry) => ({
					line: entry.line,
					...(entry.condition ? { condition: entry.condition } : {}),
				})),
			},
			signal,
			timeoutMs,
		);
	}

	async setFunctionBreakpoint(name: string, condition?: string, signal?: AbortSignal, timeoutMs = 30_000) {
		const session = this.#touchActiveSession();
		const current = upsertBreakpoint<DapFunctionBreakpointRecord>(
			session.functionBreakpoints,
			(entry) => entry.name === name,
			{ verified: false, name, condition },
			(a, b) => a.name.localeCompare(b.name),
		);
		const response = await this.#sendFunctionBreakpoints(session, current, signal, timeoutMs);
		session.functionBreakpoints = current.map((entry, index) =>
			withVerification(entry, response?.breakpoints?.[index]),
		);
		return { snapshot: buildSummary(session), breakpoints: session.functionBreakpoints };
	}

	async removeFunctionBreakpoint(name: string, signal?: AbortSignal, timeoutMs = 30_000) {
		const session = this.#touchActiveSession();
		const current = upsertBreakpoint<DapFunctionBreakpointRecord>(
			session.functionBreakpoints,
			(entry) => entry.name === name,
			null,
			(a, b) => a.name.localeCompare(b.name),
		);
		const response = await this.#sendFunctionBreakpoints(session, current, signal, timeoutMs);
		session.functionBreakpoints = current.map((entry, index) =>
			withVerification(entry, response?.breakpoints?.[index]),
		);
		return { snapshot: buildSummary(session), breakpoints: session.functionBreakpoints };
	}

	#sendFunctionBreakpoints(
		session: DapSession,
		breakpoints: DapFunctionBreakpointRecord[],
		signal?: AbortSignal,
		timeoutMs = 30_000,
	) {
		return this.#sendRequestWithConfig<{ breakpoints?: DapBreakpoint[] }>(
			session,
			"setFunctionBreakpoints",
			{
				breakpoints: breakpoints.map<DapFunctionBreakpoint>((entry) => ({
					name: entry.name,
					...(entry.condition ? { condition: entry.condition } : {}),
				})),
			},
			signal,
			timeoutMs,
		);
	}

	async setInstructionBreakpoint(
		instructionReference: string,
		offset?: number,
		condition?: string,
		hitCondition?: string,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	) {
		const session = this.#touchActiveSession();
		const current = upsertBreakpoint<DapInstructionBreakpoint>(
			session.instructionBreakpoints,
			(entry) => entry.instructionReference === instructionReference && entry.offset === offset,
			{ instructionReference, offset, condition, hitCondition },
			compareInstructionBreakpoints,
		);
		const response = await this.#sendRequestWithConfig<{ breakpoints?: DapBreakpoint[] }>(
			session,
			"setInstructionBreakpoints",
			{ breakpoints: current } satisfies DapSetInstructionBreakpointsArguments,
			signal,
			timeoutMs,
		);
		session.instructionBreakpoints = current;
		return { snapshot: buildSummary(session), breakpoints: mapInstructionRecords(current, response?.breakpoints) };
	}

	async removeInstructionBreakpoint(
		instructionReference: string,
		offset?: number,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	) {
		const session = this.#touchActiveSession();
		const current = upsertBreakpoint<DapInstructionBreakpoint>(
			session.instructionBreakpoints,
			(entry) =>
				entry.instructionReference === instructionReference && (offset === undefined || entry.offset === offset),
			null,
			compareInstructionBreakpoints,
		);
		const response = await this.#sendRequestWithConfig<{ breakpoints?: DapBreakpoint[] }>(
			session,
			"setInstructionBreakpoints",
			{ breakpoints: current } satisfies DapSetInstructionBreakpointsArguments,
			signal,
			timeoutMs,
		);
		session.instructionBreakpoints = current;
		return { snapshot: buildSummary(session), breakpoints: mapInstructionRecords(current, response?.breakpoints) };
	}

	async dataBreakpointInfo(
		name: string,
		variablesReference?: number,
		frameId?: number,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	): Promise<{ snapshot: DapSessionSummary; info: DapDataBreakpointInfoResponse }> {
		const session = this.#touchActiveSession();
		const info = await this.#sendRequestWithConfig<DapDataBreakpointInfoResponse>(
			session,
			"dataBreakpointInfo",
			{
				name,
				...(variablesReference !== undefined ? { variablesReference } : {}),
				...(frameId !== undefined ? { frameId } : {}),
			} satisfies DapDataBreakpointInfoArguments,
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), info };
	}

	async setDataBreakpoint(
		dataId: string,
		accessType?: "read" | "write" | "readWrite",
		condition?: string,
		hitCondition?: string,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	) {
		const session = this.#touchActiveSession();
		const current = upsertBreakpoint<DapDataBreakpoint>(
			session.dataBreakpoints,
			(entry) => entry.dataId === dataId,
			{ dataId, accessType, condition, hitCondition },
			(a, b) => a.dataId.localeCompare(b.dataId),
		);
		const response = await this.#sendRequestWithConfig<{ breakpoints?: DapBreakpoint[] }>(
			session,
			"setDataBreakpoints",
			{ breakpoints: current } satisfies DapSetDataBreakpointsArguments,
			signal,
			timeoutMs,
		);
		session.dataBreakpoints = current;
		return {
			snapshot: buildSummary(session),
			breakpoints: current.map((entry, index) => withVerification(entry, response?.breakpoints?.[index])),
		};
	}

	async removeDataBreakpoint(dataId: string, signal?: AbortSignal, timeoutMs = 30_000) {
		const session = this.#touchActiveSession();
		const current = upsertBreakpoint<DapDataBreakpoint>(
			session.dataBreakpoints,
			(entry) => entry.dataId === dataId,
			null,
			(a, b) => a.dataId.localeCompare(b.dataId),
		);
		const response = await this.#sendRequestWithConfig<{ breakpoints?: DapBreakpoint[] }>(
			session,
			"setDataBreakpoints",
			{ breakpoints: current } satisfies DapSetDataBreakpointsArguments,
			signal,
			timeoutMs,
		);
		session.dataBreakpoints = current;
		return {
			snapshot: buildSummary(session),
			breakpoints: current.map((entry, index) => withVerification(entry, response?.breakpoints?.[index])),
		};
	}

	async disassemble(
		memoryReference: string,
		instructionCount: number,
		offset?: number,
		instructionOffset?: number,
		resolveSymbols?: boolean,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	): Promise<{ snapshot: DapSessionSummary; instructions: DapDisassembledInstruction[] }> {
		const session = this.#touchActiveSession();
		const response = await this.#sendRequestWithConfig<DapDisassembleResponse>(
			session,
			"disassemble",
			{
				memoryReference,
				instructionCount,
				...(offset !== undefined ? { offset } : {}),
				...(instructionOffset !== undefined ? { instructionOffset } : {}),
				...(resolveSymbols !== undefined ? { resolveSymbols } : {}),
			} satisfies DapDisassembleArguments,
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), instructions: response?.instructions ?? [] };
	}

	async readMemory(
		memoryReference: string,
		count: number,
		offset?: number,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	): Promise<{ snapshot: DapSessionSummary; address: string; data?: string; unreadableBytes?: number }> {
		const session = this.#touchActiveSession();
		const response = await this.#sendRequestWithConfig<DapReadMemoryResponse>(
			session,
			"readMemory",
			{ memoryReference, count, ...(offset !== undefined ? { offset } : {}) } satisfies DapReadMemoryArguments,
			signal,
			timeoutMs,
		);
		return {
			snapshot: buildSummary(session),
			address: response?.address ?? memoryReference,
			data: response?.data,
			unreadableBytes: response?.unreadableBytes,
		};
	}

	async writeMemory(
		memoryReference: string,
		data: string,
		offset?: number,
		allowPartial?: boolean,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	): Promise<{ snapshot: DapSessionSummary; offset?: number; bytesWritten?: number }> {
		const session = this.#touchActiveSession();
		const response = await this.#sendRequestWithConfig<DapWriteMemoryResponse>(
			session,
			"writeMemory",
			{
				memoryReference,
				data,
				...(offset !== undefined ? { offset } : {}),
				...(allowPartial !== undefined ? { allowPartial } : {}),
			} satisfies DapWriteMemoryArguments,
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), offset: response?.offset, bytesWritten: response?.bytesWritten };
	}

	async modules(
		startModule?: number,
		moduleCount?: number,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	): Promise<{ snapshot: DapSessionSummary; modules: DapModule[] }> {
		const session = this.#touchActiveSession();
		const response = await this.#sendRequestWithConfig<DapModulesResponse>(
			session,
			"modules",
			{
				...(startModule !== undefined ? { startModule } : {}),
				...(moduleCount !== undefined ? { moduleCount } : {}),
			} satisfies DapModulesArguments,
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), modules: response?.modules ?? [] };
	}

	async loadedSources(
		signal?: AbortSignal,
		timeoutMs = 30_000,
	): Promise<{ snapshot: DapSessionSummary; sources: DapSource[] }> {
		const session = this.#touchActiveSession();
		const response = await this.#sendRequestWithConfig<DapLoadedSourcesResponse>(
			session,
			"loadedSources",
			{},
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), sources: response?.sources ?? [] };
	}

	async customRequest(
		command: string,
		args?: Record<string, unknown>,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	): Promise<{ snapshot: DapSessionSummary; body: unknown }> {
		const session = this.#touchActiveSession();
		const body = await this.#sendRequestWithConfig<unknown>(session, command, args, signal, timeoutMs);
		return { snapshot: buildSummary(session), body };
	}

	async continue(signal?: AbortSignal, timeoutMs = 30_000): Promise<DapContinueOutcome> {
		const session = this.#touchActiveSession();
		const threadId = await this.#resolveThreadId(session, signal, timeoutMs);
		session.stop = {};
		session.lastStackFrames = [];
		session.status = "running";
		const outcomePromise = this.#prepareStopOutcome(session, signal, timeoutMs);
		await this.#sendRequestWithConfig<DapContinueResponse>(
			session,
			"continue",
			{ threadId } satisfies DapContinueArguments,
			signal,
			timeoutMs,
		);
		return this.#awaitStopOutcome(session, outcomePromise, signal, timeoutMs);
	}

	async pause(signal?: AbortSignal, timeoutMs = 30_000): Promise<DapSessionSummary> {
		const session = this.#touchActiveSession();
		if (session.status === "stopped") return buildSummary(session);
		const threadId = await this.#resolveThreadId(session, signal, timeoutMs);
		await this.#sendRequestWithConfig(session, "pause", { threadId } satisfies DapPauseArguments, signal, timeoutMs);
		try {
			await untilAborted(
				signal,
				session.client.waitForEvent<DapStoppedEventBody>("stopped", undefined, signal, timeoutMs),
			);
		} catch {
			// Timeout or abort — report current state regardless.
		}
		return buildSummary(session);
	}

	async stepIn(signal?: AbortSignal, timeoutMs = 30_000): Promise<DapContinueOutcome> {
		return this.#step("stepIn", signal, timeoutMs);
	}

	async stepOut(signal?: AbortSignal, timeoutMs = 30_000): Promise<DapContinueOutcome> {
		return this.#step("stepOut", signal, timeoutMs);
	}

	async stepOver(signal?: AbortSignal, timeoutMs = 30_000): Promise<DapContinueOutcome> {
		return this.#step("next", signal, timeoutMs);
	}

	async threads(
		signal?: AbortSignal,
		timeoutMs = 30_000,
	): Promise<{ snapshot: DapSessionSummary; threads: DapThread[] }> {
		const session = this.#touchActiveSession();
		const response = await this.#sendRequestWithConfig<DapThreadsResponse>(
			session,
			"threads",
			undefined,
			signal,
			timeoutMs,
		);
		session.threads = response?.threads ?? [];
		return { snapshot: buildSummary(session), threads: session.threads };
	}

	async stackTrace(
		frameCount: number | undefined,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	): Promise<{ snapshot: DapSessionSummary; stackFrames: DapStackFrame[]; totalFrames?: number }> {
		const session = this.#touchActiveSession();
		const threadId = await this.#resolveThreadId(session, signal, timeoutMs);
		const response = await this.#sendRequestWithConfig<DapStackTraceResponse>(
			session,
			"stackTrace",
			{ threadId, ...(frameCount !== undefined ? { levels: frameCount } : {}) } satisfies DapStackTraceArguments,
			signal,
			timeoutMs,
		);
		session.lastStackFrames = response?.stackFrames ?? [];
		this.#applyTopFrame(session, session.lastStackFrames[0]);
		return {
			snapshot: buildSummary(session),
			stackFrames: session.lastStackFrames,
			totalFrames: response?.totalFrames,
		};
	}

	async scopes(frameId: number | undefined, signal?: AbortSignal, timeoutMs = 30_000) {
		const session = this.#touchActiveSession();
		const resolvedFrameId = frameId ?? session.stop.frameId;
		if (resolvedFrameId === undefined) {
			throw new Error("No active stack frame. Run stack_trace first or supply frame_id.");
		}
		const response = await this.#sendRequestWithConfig<DapScopesResponse>(
			session,
			"scopes",
			{ frameId: resolvedFrameId } satisfies DapScopesArguments,
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), scopes: response?.scopes ?? [] };
	}

	async variables(variableReference: number, signal?: AbortSignal, timeoutMs = 30_000) {
		const session = this.#touchActiveSession();
		const response = await this.#sendRequestWithConfig<DapVariablesResponse>(
			session,
			"variables",
			{ variablesReference: variableReference } satisfies DapVariablesArguments,
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), variables: response?.variables ?? [] };
	}

	async evaluate(
		expression: string,
		context: DapEvaluateArguments["context"],
		frameId: number | undefined,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	) {
		const session = this.#touchActiveSession();
		const effectiveFrameId = frameId ?? session.stop.frameId;
		const response = await this.#sendRequestWithConfig<DapEvaluateResponse>(
			session,
			"evaluate",
			{
				expression,
				context,
				...(effectiveFrameId !== undefined ? { frameId: effectiveFrameId } : {}),
			} satisfies DapEvaluateArguments,
			signal,
			timeoutMs,
		);
		return { snapshot: buildSummary(session), evaluation: response };
	}

	getOutput(): DapOutputSnapshot {
		const session = this.#touchActiveSession();
		return { snapshot: buildSummary(session), output: session.output };
	}

	async terminate(signal?: AbortSignal, timeoutMs = 30_000): Promise<DapSessionSummary | null> {
		const session = this.#getActiveSessionOrNull();
		if (!session) return null;
		session.lastUsedAt = Date.now();
		if (session.status !== "terminated") {
			if (session.capabilities?.supportsTerminateRequest) {
				await untilAborted(
					signal,
					session.client.sendRequest("terminate", undefined, signal, timeoutMs).catch(() => undefined),
				);
			}
			await untilAborted(
				signal,
				session.client
					.sendRequest("disconnect", { terminateDebuggee: true }, signal, timeoutMs)
					.catch(() => undefined),
			);
		}
		session.status = "terminated";
		const summary = buildSummary(session);
		this.#disposeSession(session);
		return summary;
	}

	/** Terminate every tracked session (used at session teardown). */
	async disposeAll(): Promise<void> {
		const sessions = Array.from(this.#sessions.values());
		this.#sessions.clear();
		this.#activeSessionId = null;
		await Promise.allSettled(sessions.map((session) => session.client.dispose()));
	}

	#startCleanupTimer(): void {
		if (this.#cleanupLoopPromise) return;
		this.#cleanupLoopPromise = this.#runCleanupLoop();
	}

	async #runCleanupLoop(): Promise<void> {
		for await (const _ of timers.setInterval(CLEANUP_INTERVAL_MS, null, { ref: false })) {
			try {
				this.#cleanupIdleSessions();
			} catch (error) {
				log.error("DAP idle session cleanup failed", { error: toErrorMessage(error) });
			}
		}
	}

	#cleanupIdleSessions(): void {
		if (this.#sessions.size === 0) return;
		const now = Date.now();
		for (const session of this.#sessions.values()) {
			if (
				session.status === "terminated" ||
				now - session.lastUsedAt > IDLE_TIMEOUT_MS ||
				!session.client.isAlive()
			) {
				this.#disposeSession(session);
			}
		}
	}

	async #ensureLaunchSlot(): Promise<void> {
		const active = this.#getActiveSessionOrNull();
		if (!active) return;
		if (active.status === "terminated" || !active.client.isAlive()) {
			this.#disposeSession(active);
			return;
		}
		throw new Error(`Debug session ${active.id} is still active. Terminate it before launching another.`);
	}

	#registerSession(client: DapClient, adapter: DapResolvedAdapter, cwd: string, program?: string): DapSession {
		// Idle-session sweeper starts lazily on the first session (idempotent).
		this.#startCleanupTimer();
		const session: DapSession = {
			id: `debug-${++this.#nextId}`,
			adapter,
			cwd,
			program,
			client,
			status: "launching",
			launchedAt: Date.now(),
			lastUsedAt: Date.now(),
			breakpoints: new Map(),
			functionBreakpoints: [],
			instructionBreakpoints: [],
			dataBreakpoints: [],
			output: "",
			outputBytes: 0,
			outputTruncated: false,
			stop: {},
			threads: [],
			lastStackFrames: [],
			initializedSeen: false,
			needsConfigurationDone: false,
			configurationDoneSent: false,
		};
		client.onReverseRequest("runInTerminal", async (rawArgs) => {
			const args = (rawArgs ?? {}) as DapRunInTerminalArguments;
			if (!Array.isArray(args.args) || args.args.length === 0) {
				throw new Error("runInTerminal request did not include a command");
			}
			const extraEnv = Object.fromEntries(
				Object.entries(args.env ?? {}).filter((entry): entry is [string, string] => entry[1] !== null),
			);
			const [command, ...commandArgs] = args.args;
			const proc = spawn(command, commandArgs, {
				cwd: args.cwd ?? session.cwd,
				env: { ...process.env, ...NON_INTERACTIVE_ENV, ...extraEnv },
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (proc.pid) trackDetachedChildPid(proc.pid);
			proc.unref?.();
			return { processId: proc.pid } satisfies DapRunInTerminalResponse;
		});
		client.onReverseRequest("startDebugging", async (rawArgs) => {
			const startArgs = (rawArgs ?? {}) as Partial<DapStartDebuggingArguments>;
			const request = startArgs.request === "attach" ? "attach" : "launch";
			log.warn("Adapter requested child debug session (not spawned)", { adapter: session.adapter.name, request });
			return {};
		});
		client.onEvent("output", (body) => {
			truncateOutput(session, (body as DapOutputEventBody | undefined)?.output ?? "");
		});
		client.onEvent("initialized", () => {
			session.initializedSeen = true;
			session.status = session.configurationDoneSent ? session.status : "configuring";
		});
		client.onEvent("stopped", (body) => {
			this.#handleStoppedEvent(session, body as DapStoppedEventBody);
		});
		client.onEvent("continued", (body) => {
			const continued = body as { threadId?: number } | undefined;
			session.status = "running";
			session.stop = { threadId: continued?.threadId };
			session.lastStackFrames = [];
		});
		client.onEvent("exited", (body) => {
			session.exitCode = (body as DapExitedEventBody | undefined)?.exitCode;
		});
		client.onEvent("terminated", () => {
			session.status = "terminated";
		});
		this.#sessions.set(session.id, session);
		this.#activeSessionId = session.id;
		const heartbeat = setInterval(() => {
			if (!client.isAlive()) session.status = "terminated";
		}, HEARTBEAT_INTERVAL_MS);
		heartbeat.unref?.();
		waitForChildProcess(client.proc).finally(() => clearInterval(heartbeat));
		return session;
	}

	#buildInitializeArguments(adapter: DapResolvedAdapter): DapInitializeArguments {
		return {
			clientID: "pit",
			clientName: "Pit",
			adapterID: adapter.name,
			locale: "en-US",
			linesStartAt1: true,
			columnsStartAt1: true,
			pathFormat: "path",
			supportsRunInTerminalRequest: true,
			supportsStartDebuggingRequest: true,
			supportsMemoryReferences: true,
			supportsVariableType: true,
			supportsInvalidatedEvent: true,
		};
	}

	/**
	 * Send `configurationDone` once per session. During launch/attach the DAP
	 * ordering requires waiting for the `initialized` event first
	 * (waitForInitialized=true); later request paths that may race ahead of it
	 * fire it directly (waitForInitialized=false). No-op if not needed or already sent.
	 */
	async #sendConfigurationDone(
		session: DapSession,
		waitForInitialized: boolean,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	): Promise<void> {
		if (!session.needsConfigurationDone || session.configurationDoneSent) return;
		if (waitForInitialized && !session.initializedSeen) {
			try {
				await untilAborted(signal, session.client.waitForEvent("initialized", undefined, signal, timeoutMs));
			} catch {
				return;
			}
		}
		await session.client.sendRequest("configurationDone", {}, signal, timeoutMs);
		session.configurationDoneSent = true;
		if (session.status === "configuring") session.status = "running";
	}

	#handleStoppedEvent(session: DapSession, stopped: DapStoppedEventBody): void {
		session.status = "stopped";
		session.stop = {
			threadId: stopped.threadId,
			reason: stopped.reason,
			description: stopped.description,
			text: stopped.text,
		};
		session.lastStackFrames = [];
	}

	#applyTopFrame(session: DapSession, frame: DapStackFrame | undefined): void {
		if (!frame) return;
		session.stop.frameId = frame.id;
		session.stop.frameName = frame.name;
		session.stop.instructionPointerReference = frame.instructionPointerReference;
		session.stop.source = frame.source;
		session.stop.line = frame.line;
		session.stop.column = frame.column;
	}

	async #fetchTopFrame(session: DapSession, signal?: AbortSignal, timeoutMs = 5_000): Promise<void> {
		if (session.stop.threadId === undefined) return;
		try {
			const response = await session.client.sendRequest<DapStackTraceResponse>(
				"stackTrace",
				{ threadId: session.stop.threadId, levels: 1 } satisfies DapStackTraceArguments,
				signal,
				timeoutMs,
			);
			session.lastStackFrames = response?.stackFrames ?? [];
			this.#applyTopFrame(session, session.lastStackFrames[0]);
		} catch (error) {
			log.warn("Failed to capture stopped frame", { sessionId: session.id, error: toErrorMessage(error) });
		}
	}

	async #step(command: "stepIn" | "stepOut" | "next", signal?: AbortSignal, timeoutMs = 30_000) {
		const session = this.#touchActiveSession();
		const threadId = await this.#resolveThreadId(session, signal, timeoutMs);
		session.stop = {};
		session.lastStackFrames = [];
		session.status = "running";
		const outcomePromise = this.#prepareStopOutcome(session, signal, timeoutMs);
		await this.#sendRequestWithConfig(session, command, { threadId } satisfies DapStepArguments, signal, timeoutMs);
		return this.#awaitStopOutcome(session, outcomePromise, signal, timeoutMs);
	}

	#prepareStopOutcome(session: DapSession, signal?: AbortSignal, timeoutMs = 30_000): Promise<unknown> {
		// Internal controller cancels the race losers once a winner settles, so the
		// other two waiters release their event listener + timeout immediately instead
		// of lingering until their own 30s timeout (listener/timer leak under fast stepping).
		const raceController = new AbortController();
		const raceSignal = raceController.signal;
		const onCallerAbort = () => raceController.abort(signal?.reason);
		if (signal) {
			if (signal.aborted) raceController.abort(signal.reason);
			else signal.addEventListener("abort", onCallerAbort, { once: true });
		}
		const promises = [
			session.client.waitForEvent("stopped", undefined, raceSignal, timeoutMs),
			session.client.waitForEvent("terminated", undefined, raceSignal, timeoutMs),
			session.client.waitForEvent("exited", undefined, raceSignal, timeoutMs),
		];
		for (const p of promises) p.catch(() => {});
		const outcome = Promise.race(promises).finally(() => {
			signal?.removeEventListener("abort", onCallerAbort);
			raceController.abort();
		});
		outcome.catch(() => {});
		return outcome;
	}

	async #awaitStopOutcome(
		session: DapSession,
		outcomePromise: Promise<unknown>,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	): Promise<DapContinueOutcome> {
		try {
			await untilAborted(signal, outcomePromise);
			if (session.status === "stopped") {
				await this.#fetchTopFrame(session, signal, Math.min(timeoutMs, 5_000));
			}
			const state =
				session.status === "stopped" ? "stopped" : session.status === "terminated" ? "terminated" : "running";
			return { snapshot: buildSummary(session), state, timedOut: false };
		} catch (error) {
			if (signal?.aborted) throw error;
			return { snapshot: buildSummary(session), state: "running", timedOut: session.status === "running" };
		}
	}

	async #resolveThreadId(session: DapSession, signal?: AbortSignal, timeoutMs = 30_000): Promise<number> {
		if (session.stop.threadId !== undefined) return session.stop.threadId;
		if (session.threads.length > 0) return session.threads[0].id;
		const response = await session.client.sendRequest<DapThreadsResponse>("threads", undefined, signal, timeoutMs);
		session.threads = response?.threads ?? [];
		const threadId = session.threads[0]?.id;
		if (threadId === undefined) throw new Error("Debugger reported no threads.");
		return threadId;
	}

	async #sendRequestWithConfig<TBody>(
		session: DapSession,
		command: string,
		args: unknown,
		signal?: AbortSignal,
		timeoutMs = 30_000,
	): Promise<TBody> {
		await this.#sendConfigurationDone(session, false, signal, timeoutMs);
		const body = await session.client.sendRequest<TBody>(command, args, signal, timeoutMs);
		session.lastUsedAt = Date.now();
		return body;
	}

	#touchActiveSession(): DapSession {
		const session = this.#getActiveSessionOrThrow();
		session.lastUsedAt = Date.now();
		if (session.status !== "terminated" && !session.client.isAlive()) session.status = "terminated";
		return session;
	}

	#getActiveSessionOrNull(): DapSession | null {
		if (!this.#activeSessionId) return null;
		const session = this.#sessions.get(this.#activeSessionId) ?? null;
		if (!session) this.#activeSessionId = null;
		return session;
	}

	#getActiveSessionOrThrow(): DapSession {
		const session = this.#getActiveSessionOrNull();
		if (!session) throw new Error("No active debug session. Launch or attach first.");
		return session;
	}

	#disposeSession(session: DapSession): void {
		if (this.#activeSessionId === session.id) this.#activeSessionId = null;
		this.#sessions.delete(session.id);
		void session.client.dispose().catch(() => {});
	}
}

export const dapSessionManager = new DapSessionManager();
