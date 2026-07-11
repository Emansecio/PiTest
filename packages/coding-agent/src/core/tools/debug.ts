/**
 * `debug` tool — drive one Debug Adapter Protocol (DAP) session: launch/attach a
 * debugger, set breakpoints, step, inspect threads/stack/variables, evaluate
 * expressions, read/write memory, and capture output. Ported from oh-my-pi to
 * Pit's TypeBox ToolDefinition.
 */

import * as fs from "node:fs/promises";
import type { AgentTool } from "@pit/agent-core";
import { type Static, Type } from "typebox";
import {
	type DapBreakpointRecord,
	type DapCapabilities,
	type DapContinueOutcome,
	type DapDataBreakpointInfoResponse,
	type DapDataBreakpointRecord,
	type DapDisassembledInstruction,
	type DapEvaluateResponse,
	type DapFunctionBreakpointRecord,
	type DapInstructionBreakpointRecord,
	type DapModule,
	type DapScope,
	type DapSessionSummary,
	type DapSource,
	type DapStackFrame,
	type DapThread,
	type DapVariable,
	dapSessionManager,
	getAvailableAdapters,
	selectAttachAdapter,
	selectLaunchAdapter,
} from "../dap/index.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { isEnoent } from "../lsp/internal.ts";
import { formatPathRelativeToCwd } from "../lsp/utils.ts";
import { formatWatchpointBisect, runWatchpointBisect, type WatchpointBisectDeps } from "../watchpoint-bisect.ts";
import { resolveToCwd } from "./path-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { collapseRepeatedLines, DEFAULT_MAX_BYTES, formatSize, truncateTail } from "./truncate.ts";

/**
 * DAP debug actions that only read program state (no mutation, no execution).
 * Everything else (launch/attach/continue/step/pause/evaluate/breakpoints/
 * memory writes) is exec-tier and gets its own activity line.
 */
export const DEBUG_READONLY_ACTIONS: ReadonlySet<string> = new Set([
	"output",
	"threads",
	"stack_trace",
	"scopes",
	"variables",
	"disassemble",
	"read_memory",
	"loaded_sources",
	"modules",
	"sessions",
]);

const DEBUG_ACTIONS = [
	"launch",
	"attach",
	"set_breakpoint",
	"remove_breakpoint",
	"set_instruction_breakpoint",
	"remove_instruction_breakpoint",
	"data_breakpoint_info",
	"set_data_breakpoint",
	"remove_data_breakpoint",
	"watchpoint_bisect",
	"continue",
	"step_over",
	"step_in",
	"step_out",
	"pause",
	"evaluate",
	"stack_trace",
	"threads",
	"scopes",
	"variables",
	"disassemble",
	"read_memory",
	"write_memory",
	"modules",
	"loaded_sources",
	"custom_request",
	"output",
	"terminate",
	"sessions",
] as const;

const DEBUG_EVALUATE_CONTEXTS = ["watch", "repl", "hover", "variables", "clipboard"] as const;
const DEBUG_DATA_ACCESS_TYPES = ["read", "write", "readWrite"] as const;

const debugSchema = Type.Object(
	{
		action: Type.Enum(DEBUG_ACTIONS, { description: "Debug operation to perform." }),
		program: Type.Optional(Type.String({ description: "Launch target path (required for launch)." })),
		args: Type.Optional(Type.Array(Type.String(), { description: "Program arguments for launch." })),
		adapter: Type.Optional(Type.String({ description: "Debugger adapter (gdb, lldb-dap, debugpy, dlv, ...)." })),
		cwd: Type.Optional(Type.String({ description: "Launch/attach working directory." })),
		file: Type.Optional(Type.String({ description: "Source file for source breakpoints." })),
		line: Type.Optional(Type.Number({ description: "Source line for source breakpoints." })),
		function: Type.Optional(Type.String({ description: "Function breakpoint name." })),
		name: Type.Optional(Type.String({ description: "Variable or data name (data_breakpoint_info)." })),
		condition: Type.Optional(Type.String({ description: "Breakpoint condition." })),
		hit_condition: Type.Optional(Type.String({ description: "Hit-count condition." })),
		expression: Type.Optional(Type.String({ description: "Expression to evaluate (required for evaluate)." })),
		context: Type.Optional(Type.Enum(DEBUG_EVALUATE_CONTEXTS, { description: "Evaluate context (default repl)." })),
		frame_id: Type.Optional(Type.Number({ description: "Frame selector for evaluate/scopes." })),
		scope_id: Type.Optional(Type.Number({ description: "Scope variables reference." })),
		variable_ref: Type.Optional(Type.Number({ description: "Variable reference (preferred over scope_id)." })),
		pid: Type.Optional(Type.Number({ description: "Process id for local attach." })),
		port: Type.Optional(Type.Number({ description: "Remote attach port." })),
		host: Type.Optional(Type.String({ description: "Remote attach host." })),
		levels: Type.Optional(Type.Number({ description: "Max stack frames for stack_trace." })),
		memory_reference: Type.Optional(Type.String({ description: "Memory reference/address." })),
		instruction_reference: Type.Optional(Type.String({ description: "Instruction breakpoint reference." })),
		instruction_count: Type.Optional(Type.Number({ description: "Instruction count for disassemble." })),
		instruction_offset: Type.Optional(Type.Number({ description: "Instruction offset for disassemble." })),
		count: Type.Optional(Type.Number({ description: "Bytes to read (read_memory)." })),
		data: Type.Optional(Type.String({ description: "Base64 payload for write_memory." })),
		data_id: Type.Optional(Type.String({ description: "Data breakpoint id." })),
		access_type: Type.Optional(Type.Enum(DEBUG_DATA_ACCESS_TYPES, { description: "Data breakpoint access filter." })),
		command: Type.Optional(Type.String({ description: "Custom DAP request command." })),
		arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Custom DAP request body." })),
		offset: Type.Optional(Type.Number({ description: "Offset for breakpoints/disassembly/memory." })),
		resolve_symbols: Type.Optional(Type.Boolean({ description: "disassemble symbol-resolution flag." })),
		allow_partial: Type.Optional(Type.Boolean({ description: "write_memory partial-write allowance." })),
		start_module: Type.Optional(Type.Number({ description: "Modules pagination start." })),
		module_count: Type.Optional(Type.Number({ description: "Modules pagination count." })),
		timeout: Type.Optional(
			Type.Number({ description: "Per-request timeout in seconds (clamped 5-300, default 30)." }),
		),
	},
	{ additionalProperties: false },
);

export type DebugToolInput = Static<typeof debugSchema>;
export type DebugAction = DebugToolInput["action"];
export interface DebugToolOptions {}

export interface DebugToolDetails {
	action: DebugAction;
	success: boolean;
	snapshot?: DapSessionSummary;
	sessions?: DapSessionSummary[];
	stackFrames?: DapStackFrame[];
	threads?: DapThread[];
	scopes?: DapScope[];
	variables?: DapVariable[];
	sources?: DapSource[];
	modules?: DapModule[];
	evaluation?: DapEvaluateResponse;
	breakpoints?: DapBreakpointRecord[];
	functionBreakpoints?: DapFunctionBreakpointRecord[];
	instructionBreakpoints?: DapInstructionBreakpointRecord[];
	dataBreakpoints?: DapDataBreakpointRecord[];
	dataBreakpointInfo?: DapDataBreakpointInfoResponse;
	disassembly?: DapDisassembledInstruction[];
	memoryAddress?: string;
	memoryData?: string;
	unreadableBytes?: number;
	bytesWritten?: number;
	customBody?: unknown;
	output?: string;
	adapter?: string;
	state?: DapContinueOutcome["state"];
	timedOut?: boolean;
}

type TextResult = { content: Array<{ type: "text"; text: string }>; details: DebugToolDetails };

function textResult(text: string, details: DebugToolDetails): TextResult {
	return { content: [{ type: "text", text }], details };
}

function clampTimeout(timeout: number | undefined): number {
	const value = typeof timeout === "number" && Number.isFinite(timeout) ? Math.round(timeout) : 30;
	return Math.min(300, Math.max(5, value));
}

// =============================================================================
// Formatting helpers
// =============================================================================

function formatLocation(snapshot: DapSessionSummary | undefined): string | null {
	if (!snapshot?.source?.path || snapshot.line === undefined) return null;
	return `${snapshot.source.path}:${snapshot.line}${snapshot.column !== undefined ? `:${snapshot.column}` : ""}`;
}

function formatSessionSnapshot(snapshot: DapSessionSummary): string[] {
	const lines = [
		`Session ${snapshot.id}`,
		`Adapter: ${snapshot.adapter}`,
		`Status: ${snapshot.status}`,
		`CWD: ${snapshot.cwd}`,
	];
	if (snapshot.program) lines.push(`Program: ${snapshot.program}`);
	if (snapshot.stopReason) lines.push(`Stop reason: ${snapshot.stopReason}`);
	if (snapshot.frameName) lines.push(`Frame: ${snapshot.frameName}`);
	if (snapshot.instructionPointerReference) lines.push(`Instruction pointer: ${snapshot.instructionPointerReference}`);
	const location = formatLocation(snapshot);
	if (location) lines.push(`Location: ${location}`);
	if (snapshot.needsConfigurationDone) {
		lines.push("Configuration: pending configurationDone; set breakpoints, then continue.");
	}
	if (snapshot.exitCode !== undefined) lines.push(`Exit code: ${snapshot.exitCode}`);
	return lines;
}

function formatBreakpoints(filePath: string, breakpoints: DapBreakpointRecord[]): string {
	const lines = [`Breakpoints for ${filePath}:`];
	if (breakpoints.length === 0) return `${lines[0]}\n(none)`;
	for (const bp of breakpoints) {
		lines.push(
			`- line ${bp.line}: ${bp.verified ? "verified" : "pending"}${bp.condition ? ` if ${bp.condition}` : ""}${bp.message ? ` (${bp.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatFunctionBreakpoints(breakpoints: DapFunctionBreakpointRecord[]): string {
	const lines = ["Function breakpoints:"];
	if (breakpoints.length === 0) return "Function breakpoints:\n(none)";
	for (const bp of breakpoints) {
		lines.push(
			`- ${bp.name}: ${bp.verified ? "verified" : "pending"}${bp.condition ? ` if ${bp.condition}` : ""}${bp.message ? ` (${bp.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatStackFrames(frames: DapStackFrame[]): string {
	const lines = ["Stack trace:"];
	if (frames.length === 0) return "Stack trace:\n(empty)";
	for (const frame of frames) {
		const location = frame.source?.path
			? `${frame.source.path}:${frame.line}:${frame.column}`
			: `<unknown>:${frame.line}:${frame.column}`;
		lines.push(`- #${frame.id} ${frame.name} @ ${location}`);
	}
	return lines.join("\n");
}

function formatThreads(threads: DapThread[]): string {
	if (threads.length === 0) return "Threads:\n(none)";
	return ["Threads:", ...threads.map((thread) => `- ${thread.id}: ${thread.name}`)].join("\n");
}

function formatScopes(scopes: DapScope[]): string {
	if (scopes.length === 0) return "Scopes:\n(none)";
	return [
		"Scopes:",
		...scopes.map(
			(scope) =>
				`- ${scope.name}: ref=${scope.variablesReference}, expensive=${scope.expensive ? "yes" : "no"}${scope.presentationHint ? `, hint=${scope.presentationHint}` : ""}`,
		),
	].join("\n");
}

function formatVariables(variables: DapVariable[]): string {
	if (variables.length === 0) return "Variables:\n(none)";
	return [
		"Variables:",
		...variables.map(
			(v) =>
				`- ${v.name} = ${v.value}${v.type ? ` (${v.type})` : ""}${v.variablesReference > 0 ? ` [ref=${v.variablesReference}]` : ""}`,
		),
	].join("\n");
}

function formatSourceLabel(source: DapSource | undefined, line?: number, column?: number): string | null {
	if (!source?.path && !source?.name) return null;
	const base = source.path ?? source.name ?? "<unknown>";
	if (line === undefined) return base;
	return `${base}:${line}${column !== undefined ? `:${column}` : ""}`;
}

function formatDisassembly(instructions: DapDisassembledInstruction[]): string {
	if (instructions.length === 0) return "Disassembly:\n(empty)";
	const lines = ["Disassembly:"];
	const addressWidth = instructions.reduce((max, i) => Math.max(max, i.address.length), 0);
	const bytesWidth = instructions.reduce((max, i) => Math.max(max, i.instructionBytes?.length ?? 0), 2);
	for (const instruction of instructions) {
		const location = formatSourceLabel(instruction.location, instruction.line, instruction.column);
		const parts = [
			instruction.address.padEnd(addressWidth),
			(instruction.instructionBytes ?? "").padEnd(bytesWidth),
			instruction.instruction,
		];
		if (instruction.symbol) parts.push(`<${instruction.symbol}>`);
		if (location) parts.push(`[${location}]`);
		lines.push(
			parts
				.filter((part) => part.length > 0)
				.join("  ")
				.trimEnd(),
		);
	}
	return lines.join("\n");
}

function formatMemoryRead(address: string, data: string | undefined, unreadableBytes?: number): string {
	const lines = [`Memory at ${address}:`];
	const buffer = data ? Buffer.from(data, "base64") : Buffer.alloc(0);
	if (buffer.length === 0) {
		lines.push("(no readable bytes)");
	} else {
		for (let offset = 0; offset < buffer.length; offset += 16) {
			const chunk = buffer.subarray(offset, offset + 16);
			const hex = Array.from(chunk, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
			const ascii = Array.from(chunk, (byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : ".")).join(
				"",
			);
			lines.push(
				`${(offset === 0 ? address : `+0x${offset.toString(16)}`).padEnd(18)} ${hex.padEnd(47)} |${ascii}|`,
			);
		}
	}
	if (unreadableBytes !== undefined && unreadableBytes > 0) lines.push(`Unreadable bytes: ${unreadableBytes}`);
	return lines.join("\n");
}

function formatTable(headers: string[], rows: string[][]): string {
	const widths = headers.map((header, index) =>
		rows.reduce((max, row) => Math.max(max, (row[index] ?? "").length), header.length),
	);
	const formatRow = (row: string[]) => row.map((cell, index) => (cell ?? "").padEnd(widths[index])).join("  ");
	return [formatRow(headers), formatRow(widths.map((width) => "-".repeat(width))), ...rows.map(formatRow)].join("\n");
}

function formatModules(modules: DapModule[]): string {
	if (modules.length === 0) return "Modules:\n(none)";
	return [
		"Modules:",
		formatTable(
			["ID", "Name", "Path", "Symbols", "Range"],
			modules.map((m) => [String(m.id), m.name, m.path ?? "", m.symbolStatus ?? "", m.addressRange ?? ""]),
		),
	].join("\n");
}

function formatLoadedSources(sources: DapSource[]): string {
	if (sources.length === 0) return "Loaded sources:\n(none)";
	return [
		"Loaded sources:",
		...sources.map(
			(source) =>
				`- ${source.path ?? source.name ?? "<unknown>"}${source.sourceReference !== undefined ? ` [ref=${source.sourceReference}]` : ""}`,
		),
	].join("\n");
}

function formatInstructionBreakpoints(breakpoints: DapInstructionBreakpointRecord[]): string {
	if (breakpoints.length === 0) return "Instruction breakpoints:\n(none)";
	const lines = ["Instruction breakpoints:"];
	for (const bp of breakpoints) {
		const location = `${bp.instructionReference}${bp.offset !== undefined ? `+${bp.offset}` : ""}`;
		lines.push(
			`- ${location}: ${bp.verified ? "verified" : "pending"}${bp.condition ? ` if ${bp.condition}` : ""}${bp.hitCondition ? ` after ${bp.hitCondition}` : ""}${bp.message ? ` (${bp.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatDataBreakpointInfo(info: DapDataBreakpointInfoResponse): string {
	const lines = [`Data breakpoint info: ${info.description}`, `Data ID: ${info.dataId ?? "(not available)"}`];
	if (info.accessTypes && info.accessTypes.length > 0) lines.push(`Access types: ${info.accessTypes.join(", ")}`);
	if (info.canPersist !== undefined) lines.push(`Persistent: ${info.canPersist ? "yes" : "no"}`);
	return lines.join("\n");
}

function formatDataBreakpoints(breakpoints: DapDataBreakpointRecord[]): string {
	if (breakpoints.length === 0) return "Data breakpoints:\n(none)";
	const lines = ["Data breakpoints:"];
	for (const bp of breakpoints) {
		lines.push(
			`- ${bp.dataId}: ${bp.verified ? "verified" : "pending"}${bp.accessType ? ` (${bp.accessType})` : ""}${bp.condition ? ` if ${bp.condition}` : ""}${bp.hitCondition ? ` after ${bp.hitCondition}` : ""}${bp.message ? ` (${bp.message})` : ""}`,
		);
	}
	return lines.join("\n");
}

function formatCustomResponse(command: string, body: unknown): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(body, null, 2) ?? "null";
	} catch {
		serialized = String(body);
	}
	return `${command} response:\n${serialized}`;
}

function formatSessions(sessions: DapSessionSummary[]): string {
	if (sessions.length === 0) return "No debug sessions.";
	return sessions
		.map((session) => {
			const location = formatLocation(session);
			return [
				`${session.id}: ${session.status}`,
				`  adapter=${session.adapter}`,
				`  cwd=${session.cwd}`,
				...(session.program ? [`  program=${session.program}`] : []),
				...(location ? [`  location=${location}`] : []),
				...(session.stopReason ? [`  reason=${session.stopReason}`] : []),
			].join("\n");
		})
		.join("\n\n");
}

function formatEvaluation(evaluation: DapEvaluateResponse): string {
	const lines = [`Result: ${evaluation.result}`];
	if (evaluation.type) lines.push(`Type: ${evaluation.type}`);
	if (evaluation.variablesReference > 0) lines.push(`Variables ref: ${evaluation.variablesReference}`);
	return lines.join("\n");
}

function buildOutcomeText(outcome: DapContinueOutcome, timeoutSec: number, verb: string): string {
	const lines = formatSessionSnapshot(outcome.snapshot);
	if (outcome.timedOut) {
		lines.push(`Program is still running after ${timeoutSec}s. Use pause to interrupt and inspect state.`);
		return lines.join("\n");
	}
	if (outcome.state === "stopped") {
		lines.push(`${verb} stopped at ${formatLocation(outcome.snapshot) ?? "unknown location"}.`);
		return lines.join("\n");
	}
	if (outcome.state === "terminated") {
		lines.push(
			`Program terminated${outcome.snapshot.exitCode !== undefined ? ` with exit code ${outcome.snapshot.exitCode}` : ""}.`,
		);
		return lines.join("\n");
	}
	lines.push("Program is running.");
	return lines.join("\n");
}

function getConfiguredAdapters(cwd: string): string {
	const adapters = getAvailableAdapters(cwd).map((adapter) => adapter.name);
	return adapters.length > 0 ? adapters.join(", ") : "none";
}

async function validateLaunchProgram(program: string, cwd: string): Promise<void> {
	let isDirectory: boolean;
	try {
		isDirectory = (await fs.stat(program)).isDirectory();
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}
	if (!isDirectory) return;
	throw new Error(
		`launch program resolves to a directory: ${formatPathRelativeToCwd(program, cwd)}/. Pass an executable file path, or for Python use adapter "debugpy" with program set to the .py file.`,
	);
}

function getActiveSessionSnapshot(): DapSessionSummary {
	const snapshot = dapSessionManager.getActiveSession();
	if (!snapshot) throw new Error("No active debug session. Launch or attach first.");
	return snapshot;
}

function requireCapability(capability: keyof DapCapabilities, description: string): void {
	getActiveSessionSnapshot();
	if (dapSessionManager.getCapabilities()?.[capability] !== true) {
		throw new Error(`Current adapter does not support ${description}`);
	}
}

function resolveDisassemblyReference(memoryReference: string | undefined): string {
	if (memoryReference) return memoryReference;
	const snapshot = getActiveSessionSnapshot();
	if (snapshot.instructionPointerReference) return snapshot.instructionPointerReference;
	throw new Error(
		"disassemble requires memory_reference unless the current stop location has an instruction pointer reference",
	);
}

// =============================================================================
// Model-facing description
// =============================================================================

const DEBUG_DESCRIPTION = `Drives a debugger through the Debug Adapter Protocol (DAP): launch/attach, set breakpoints, step, inspect threads/stack/variables, evaluate expressions, capture output, and interrupt hung programs.

<instruction>
- Prefer over bash for program state, breakpoints, stepping, thread inspection, or interrupting a running process.
- launch starts a session; program is required, adapter optional (auto-selected from target path and workspace). For Python set adapter: "debugpy" and program to the .py file; put script flags in args.
- attach connects to an existing process: pid for local attach, port for remote attach; adapter to force a specific debugger.
- Breakpoints: set_breakpoint/remove_breakpoint with file+line or function; optional condition for conditional breakpoints.
- Flow control: continue (resumes; briefly waits to see whether it stops or keeps running), step_over/step_in/step_out (single-step), pause (interrupt a running program to inspect state).
- Inspect: threads, stack_trace (frames for the stopped thread), scopes (needs frame_id or current frame), variables (needs variable_ref or scope_id), evaluate (needs expression; context: "repl" for raw debugger commands), output (captured stdout/stderr), sessions, terminate.
- Timeouts apply per-request, not to the whole session.
</instruction>

<caution>
- Only one active debug session is supported at a time.
- Some adapters need a launched session to receive configurationDone before the target runs; if configuration is pending, set breakpoints then continue.
- Adapter availability depends on local binaries: gdb, lldb-dap, python -m debugpy.adapter (pip install debugpy), dlv dap.
- program must be an executable file or debug target, not a directory.
</caution>

<examples>
# Launch and inspect a hang
1. debug(action: "launch", program: "./my_app")
2. debug(action: "set_breakpoint", file: "src/main.c", line: 42)
3. debug(action: "continue")
4. If it appears hung: debug(action: "pause"), then threads / stack_trace / scopes / variables
# Python with debugpy
debug(action: "launch", adapter: "debugpy", program: "scripts/job.py", args: ["--flag"])
</examples>`;

const PROMPT_SNIPPET = "Drive a real debugger (DAP): breakpoints, stepping, variable/stack inspection, evaluate.";
const PROMPT_GUIDELINES = [
	"Use debug instead of print/bash when you need live program state: breakpoints, stepping, threads, stack, variables.",
];

// =============================================================================
// Tool Definition
// =============================================================================

export function createDebugToolDefinition(
	cwd: string,
	_options?: DebugToolOptions,
): ToolDefinition<typeof debugSchema, DebugToolDetails> {
	return {
		name: "debug",
		label: "debug",
		description: DEBUG_DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: debugSchema,
		// Debug sessions are stateful and single-instance — never run concurrently.
		executionMode: "sequential",
		activity: (args: { action?: string }) =>
			DEBUG_READONLY_ACTIONS.has(args?.action ?? "") ? "navigation" : "action",
		async execute(_toolCallId, params: DebugToolInput, callerSignal): Promise<TextResult> {
			const timeoutSec = clampTimeout(params.timeout);
			const timeoutSignal = AbortSignal.timeout(timeoutSec * 1000);
			const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
			const timeoutMs = timeoutSec * 1000;
			const details: DebugToolDetails = { action: params.action, success: true };

			switch (params.action) {
				case "launch": {
					if (!params.program) throw new Error("program is required for launch");
					const commandCwd = params.cwd ? resolveToCwd(params.cwd, cwd) : cwd;
					const program = resolveToCwd(params.program, commandCwd);
					await validateLaunchProgram(program, commandCwd);
					const adapter = selectLaunchAdapter(program, commandCwd, params.adapter);
					if (!adapter) {
						if (params.adapter === "debugpy")
							throw new Error("adapter 'debugpy' is not available: python not found in PATH");
						throw new Error(
							`No debugger adapter available. Installed adapters: ${getConfiguredAdapters(commandCwd)}`,
						);
					}
					const snapshot = await dapSessionManager.launch(
						{ adapter, program, args: params.args, cwd: commandCwd },
						signal,
						timeoutMs,
					);
					details.snapshot = snapshot;
					details.adapter = adapter.name;
					return textResult(formatSessionSnapshot(snapshot).join("\n"), details);
				}
				case "attach": {
					if (params.pid === undefined && params.port === undefined)
						throw new Error("attach requires pid or port");
					const commandCwd = params.cwd ? resolveToCwd(params.cwd, cwd) : cwd;
					const adapter = selectAttachAdapter(commandCwd, params.adapter, params.port);
					if (!adapter) {
						if (params.adapter === "debugpy")
							throw new Error("adapter 'debugpy' is not available: python not found in PATH");
						throw new Error(
							`No debugger adapter available. Installed adapters: ${getConfiguredAdapters(commandCwd)}`,
						);
					}
					const snapshot = await dapSessionManager.attach(
						{ adapter, cwd: commandCwd, pid: params.pid, port: params.port, host: params.host },
						signal,
						timeoutMs,
					);
					details.snapshot = snapshot;
					details.adapter = adapter.name;
					return textResult(formatSessionSnapshot(snapshot).join("\n"), details);
				}
				case "set_breakpoint": {
					if (params.function) {
						const response = await dapSessionManager.setFunctionBreakpoint(
							params.function,
							params.condition,
							signal,
							timeoutMs,
						);
						details.snapshot = response.snapshot;
						details.functionBreakpoints = response.breakpoints;
						return textResult(formatFunctionBreakpoints(response.breakpoints), details);
					}
					if (!params.file || params.line === undefined)
						throw new Error("set_breakpoint requires file+line or function");
					const file = resolveToCwd(params.file, cwd);
					const response = await dapSessionManager.setBreakpoint(
						file,
						params.line,
						params.condition,
						signal,
						timeoutMs,
					);
					details.snapshot = response.snapshot;
					details.breakpoints = response.breakpoints;
					return textResult(formatBreakpoints(response.sourcePath, response.breakpoints), details);
				}
				case "remove_breakpoint": {
					if (params.function) {
						const response = await dapSessionManager.removeFunctionBreakpoint(params.function, signal, timeoutMs);
						details.snapshot = response.snapshot;
						details.functionBreakpoints = response.breakpoints;
						return textResult(formatFunctionBreakpoints(response.breakpoints), details);
					}
					if (!params.file || params.line === undefined)
						throw new Error("remove_breakpoint requires file+line or function");
					const file = resolveToCwd(params.file, cwd);
					const response = await dapSessionManager.removeBreakpoint(file, params.line, signal, timeoutMs);
					details.snapshot = response.snapshot;
					details.breakpoints = response.breakpoints;
					return textResult(formatBreakpoints(response.sourcePath, response.breakpoints), details);
				}
				case "set_instruction_breakpoint": {
					requireCapability("supportsInstructionBreakpoints", "instruction breakpoints");
					if (!params.instruction_reference)
						throw new Error("instruction_reference is required for set_instruction_breakpoint");
					const response = await dapSessionManager.setInstructionBreakpoint(
						params.instruction_reference,
						params.offset,
						params.condition,
						params.hit_condition,
						signal,
						timeoutMs,
					);
					details.snapshot = response.snapshot;
					details.instructionBreakpoints = response.breakpoints;
					return textResult(formatInstructionBreakpoints(response.breakpoints), details);
				}
				case "remove_instruction_breakpoint": {
					requireCapability("supportsInstructionBreakpoints", "instruction breakpoints");
					if (!params.instruction_reference)
						throw new Error("instruction_reference is required for remove_instruction_breakpoint");
					const response = await dapSessionManager.removeInstructionBreakpoint(
						params.instruction_reference,
						params.offset,
						signal,
						timeoutMs,
					);
					details.snapshot = response.snapshot;
					details.instructionBreakpoints = response.breakpoints;
					return textResult(formatInstructionBreakpoints(response.breakpoints), details);
				}
				case "data_breakpoint_info": {
					requireCapability("supportsDataBreakpoints", "data breakpoints");
					if (!params.name) throw new Error("name is required for data_breakpoint_info");
					const response = await dapSessionManager.dataBreakpointInfo(
						params.name,
						params.variable_ref ?? params.scope_id,
						params.frame_id,
						signal,
						timeoutMs,
					);
					details.snapshot = response.snapshot;
					details.dataBreakpointInfo = response.info;
					return textResult(formatDataBreakpointInfo(response.info), details);
				}
				case "set_data_breakpoint": {
					requireCapability("supportsDataBreakpoints", "data breakpoints");
					if (!params.data_id) throw new Error("data_id is required for set_data_breakpoint");
					const response = await dapSessionManager.setDataBreakpoint(
						params.data_id,
						params.access_type,
						params.condition,
						params.hit_condition,
						signal,
						timeoutMs,
					);
					details.snapshot = response.snapshot;
					details.dataBreakpoints = response.breakpoints;
					return textResult(formatDataBreakpoints(response.breakpoints), details);
				}
				case "remove_data_breakpoint": {
					requireCapability("supportsDataBreakpoints", "data breakpoints");
					if (!params.data_id) throw new Error("data_id is required for remove_data_breakpoint");
					const response = await dapSessionManager.removeDataBreakpoint(params.data_id, signal, timeoutMs);
					details.snapshot = response.snapshot;
					details.dataBreakpoints = response.breakpoints;
					return textResult(formatDataBreakpoints(response.breakpoints), details);
				}
				case "watchpoint_bisect": {
					// "Who writes/corrupts X?" — arm a hardware write-watchpoint and capture
					// every writer's stack. Pure-additive and degrades on its own (conditional
					// breakpoint when the adapter lacks data breakpoints), so NO
					// requireCapability — but it still needs a live session to inspect.
					getActiveSessionSnapshot();
					const expr = params.expression ?? params.name;
					if (!expr) throw new Error("watchpoint_bisect requires expression or name");
					const deps: WatchpointBisectDeps = {
						supportsDataBreakpoints: () => dapSessionManager.getCapabilities()?.supportsDataBreakpoints === true,
						dataBreakpointInfo: (n, vref, fid, sig, t) =>
							dapSessionManager.dataBreakpointInfo(n, vref, fid, sig, t),
						setDataBreakpoint: (id, at, c, hc, sig, t) =>
							dapSessionManager.setDataBreakpoint(id, at, c, hc, sig, t),
						continue: (sig, t) => dapSessionManager.continue(sig, t),
						stackTrace: (n, sig, t) => dapSessionManager.stackTrace(n, sig, t),
						scopes: (fid, sig, t) => dapSessionManager.scopes(fid, sig, t),
						evaluate: (e, ctx, fid, sig, t) => dapSessionManager.evaluate(e, ctx, fid, sig, t),
						setBreakpoint: (f, l, c, sig, t) => dapSessionManager.setBreakpoint(f, l, c, sig, t),
						setFunctionBreakpoint: (nm, c, sig, t) => dapSessionManager.setFunctionBreakpoint(nm, c, sig, t),
					};
					const result = await runWatchpointBisect(deps, {
						expression: expr,
						variablesReference: params.variable_ref ?? params.scope_id,
						frameId: params.frame_id,
						accessType: params.access_type,
						fallbackFile: params.file ? resolveToCwd(params.file, cwd) : undefined,
						fallbackLine: params.line,
						fallbackFunction: params.function,
						timeoutMs,
					});
					details.snapshot = dapSessionManager.getActiveSession() ?? undefined;
					return textResult(formatWatchpointBisect(result), details);
				}
				case "continue": {
					const outcome = await dapSessionManager.continue(signal, timeoutMs);
					details.snapshot = outcome.snapshot;
					details.state = outcome.state;
					details.timedOut = outcome.timedOut;
					return textResult(buildOutcomeText(outcome, timeoutSec, "Continue"), details);
				}
				case "step_over": {
					const outcome = await dapSessionManager.stepOver(signal, timeoutMs);
					details.snapshot = outcome.snapshot;
					details.state = outcome.state;
					details.timedOut = outcome.timedOut;
					return textResult(buildOutcomeText(outcome, timeoutSec, "Step over"), details);
				}
				case "step_in": {
					const outcome = await dapSessionManager.stepIn(signal, timeoutMs);
					details.snapshot = outcome.snapshot;
					details.state = outcome.state;
					details.timedOut = outcome.timedOut;
					return textResult(buildOutcomeText(outcome, timeoutSec, "Step in"), details);
				}
				case "step_out": {
					const outcome = await dapSessionManager.stepOut(signal, timeoutMs);
					details.snapshot = outcome.snapshot;
					details.state = outcome.state;
					details.timedOut = outcome.timedOut;
					return textResult(buildOutcomeText(outcome, timeoutSec, "Step out"), details);
				}
				case "pause": {
					const snapshot = await dapSessionManager.pause(signal, timeoutMs);
					details.snapshot = snapshot;
					return textResult(formatSessionSnapshot(snapshot).concat("Program paused.").join("\n"), details);
				}
				case "evaluate": {
					if (!params.expression) throw new Error("expression is required for evaluate");
					const evaluationContext = params.context ?? "repl";
					const response = await dapSessionManager.evaluate(
						params.expression,
						evaluationContext,
						params.frame_id,
						signal,
						timeoutMs,
					);
					details.snapshot = response.snapshot;
					details.evaluation = response.evaluation;
					return textResult(formatEvaluation(response.evaluation), details);
				}
				case "stack_trace": {
					const response = await dapSessionManager.stackTrace(params.levels, signal, timeoutMs);
					details.snapshot = response.snapshot;
					details.stackFrames = response.stackFrames;
					return textResult(formatStackFrames(response.stackFrames), details);
				}
				case "threads": {
					const response = await dapSessionManager.threads(signal, timeoutMs);
					details.snapshot = response.snapshot;
					details.threads = response.threads;
					return textResult(formatThreads(response.threads), details);
				}
				case "scopes": {
					const response = await dapSessionManager.scopes(params.frame_id, signal, timeoutMs);
					details.snapshot = response.snapshot;
					details.scopes = response.scopes;
					return textResult(formatScopes(response.scopes), details);
				}
				case "variables": {
					const variableReference = params.variable_ref ?? params.scope_id;
					if (variableReference === undefined) throw new Error("variables requires variable_ref or scope_id");
					const response = await dapSessionManager.variables(variableReference, signal, timeoutMs);
					details.snapshot = response.snapshot;
					details.variables = response.variables;
					return textResult(formatVariables(response.variables), details);
				}
				case "disassemble": {
					requireCapability("supportsDisassembleRequest", "disassembly");
					if (params.instruction_count === undefined)
						throw new Error("instruction_count is required for disassemble");
					const response = await dapSessionManager.disassemble(
						resolveDisassemblyReference(params.memory_reference),
						params.instruction_count,
						params.offset,
						params.instruction_offset,
						params.resolve_symbols,
						signal,
						timeoutMs,
					);
					details.snapshot = response.snapshot;
					details.disassembly = response.instructions;
					return textResult(formatDisassembly(response.instructions), details);
				}
				case "read_memory": {
					requireCapability("supportsReadMemoryRequest", "memory reads");
					if (!params.memory_reference) throw new Error("memory_reference is required for read_memory");
					if (params.count === undefined) throw new Error("count is required for read_memory");
					const response = await dapSessionManager.readMemory(
						params.memory_reference,
						params.count,
						params.offset,
						signal,
						timeoutMs,
					);
					details.snapshot = response.snapshot;
					details.memoryAddress = response.address;
					// `details` is kept in the session's persisted history — mirror what the
					// wrapper caps the model text to rather than the raw base64 blob, whose
					// size scales with the model-supplied (unbounded) `count`. Small reads
					// (the common case) are unaffected.
					const memoryDataBytes = response.data ? Buffer.byteLength(response.data, "base64") : 0;
					details.memoryData = memoryDataBytes <= DEFAULT_MAX_BYTES ? response.data : undefined;
					details.unreadableBytes = response.unreadableBytes;
					return textResult(formatMemoryRead(response.address, response.data, response.unreadableBytes), details);
				}
				case "write_memory": {
					requireCapability("supportsWriteMemoryRequest", "memory writes");
					if (!params.memory_reference) throw new Error("memory_reference is required for write_memory");
					if (!params.data) throw new Error("data is required for write_memory");
					const response = await dapSessionManager.writeMemory(
						params.memory_reference,
						params.data,
						params.offset,
						params.allow_partial,
						signal,
						timeoutMs,
					);
					details.snapshot = response.snapshot;
					details.bytesWritten = response.bytesWritten;
					return textResult(
						[
							"Memory write completed.",
							...(response.bytesWritten !== undefined ? [`Bytes written: ${response.bytesWritten}`] : []),
							...(response.offset !== undefined ? [`Offset: ${response.offset}`] : []),
						].join("\n"),
						details,
					);
				}
				case "modules": {
					requireCapability("supportsModulesRequest", "module introspection");
					const response = await dapSessionManager.modules(
						params.start_module,
						params.module_count,
						signal,
						timeoutMs,
					);
					details.snapshot = response.snapshot;
					details.modules = response.modules;
					return textResult(formatModules(response.modules), details);
				}
				case "loaded_sources": {
					requireCapability("supportsLoadedSourcesRequest", "loaded sources");
					const response = await dapSessionManager.loadedSources(signal, timeoutMs);
					details.snapshot = response.snapshot;
					details.sources = response.sources;
					return textResult(formatLoadedSources(response.sources), details);
				}
				case "custom_request": {
					if (!params.command) throw new Error("command is required for custom_request");
					const response = await dapSessionManager.customRequest(
						params.command,
						params.arguments,
						signal,
						timeoutMs,
					);
					details.snapshot = response.snapshot;
					details.customBody = response.body;
					return textResult(formatCustomResponse(params.command, response.body), details);
				}
				case "output": {
					const response = dapSessionManager.getOutput();
					details.snapshot = response.snapshot;
					if (response.output.length === 0) return textResult("(no output captured)", details);
					// Debug output is an unbounded temporal stream (a logging loop / progress
					// spam can be megabytes). Collapse identical/similar repeated lines first
					// (lossless-first — a logging loop's near-identical lines carry no extra
					// signal), then cap keeping the TAIL — in a hang the most recent lines are
					// the relevant ones. `details.output` mirrors exactly what the model sees
					// (not the raw stream) — persisting the untruncated text in the session's
					// kept history would scale with the same unbounded megabytes-scale log the
					// cap below exists to avoid.
					const truncation = truncateTail(collapseRepeatedLines(response.output));
					const text = truncation.truncated
						? `[debug output truncated to the last ${formatSize(DEFAULT_MAX_BYTES)} — most recent lines shown]\n${truncation.content}`
						: truncation.content;
					details.output = text;
					return textResult(text, details);
				}
				case "terminate": {
					const snapshot = await dapSessionManager.terminate(signal, timeoutMs);
					if (!snapshot) return textResult("No debug session to terminate.", details);
					details.snapshot = snapshot;
					return textResult(
						formatSessionSnapshot(snapshot).concat("Debug session terminated.").join("\n"),
						details,
					);
				}
				case "sessions": {
					const sessions = dapSessionManager.listSessions();
					details.sessions = sessions;
					return textResult(formatSessions(sessions), details);
				}
				default:
					throw new Error(`Unsupported debug action: ${params.action}`);
			}
		},
	};
}

export function createDebugTool(cwd: string, options?: DebugToolOptions): AgentTool<typeof debugSchema> {
	return wrapToolDefinition(createDebugToolDefinition(cwd, options));
}
