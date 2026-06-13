/**
 * Persistent eval kernel — shared types for the Python and JavaScript kernels
 * spawned per agent session. The kernel keeps a long-running child process
 * alive so consecutive `eval` tool calls within the same `lang` share state
 * (variables, imports, defined functions).
 */

export type EvalLang = "python" | "javascript";

export interface EvalRequest {
	lang: EvalLang;
	code: string;
	timeoutMs?: number;
}

export interface EvalResult {
	stdout: string;
	stderr: string;
	value?: string;
	error?: string;
	durationMs: number;
}

/**
 * A single tool call emitted by a code-mode program from inside the vm. The
 * driver assigns `callId`; `name`/`args` come from `tools.x(args)`.
 */
export interface CodeModeToolCall {
	callId: string;
	name: string;
	args: unknown;
}

/** The result the bridge ships back for a `CodeModeToolCall`, matched by callId. */
export interface CodeModeToolResult {
	callId: string;
	content: Array<{ type: string; text?: string }>;
	isError: boolean;
}

/**
 * Bidirectional channel for one code-mode run. The kernel emits tool calls from
 * the vm via `onToolCall`; the bridge pushes results back via `sendToolResult`.
 * `runProgram` executes the model's source inside the vm with the `tools` proxy
 * installed, resolving once the program finishes. Closing the channel is the
 * caller's responsibility (the kernel keeps the channel scoped to one run).
 */
export interface CodeModeChannel {
	/**
	 * Run the model's program; resolves with captured stdout/stderr/error.
	 *
	 * @param code      The model's JavaScript program.
	 * @param toolNames Active tool names exposed on the vm-side `tools` proxy.
	 * @param timeoutMs Per-run timeout (parent backstop).
	 * @param signal    Abort signal for the run.
	 */
	runProgram(
		code: string,
		toolNames: string[],
		timeoutMs: number | undefined,
		signal: AbortSignal | undefined,
	): Promise<EvalResult>;
	/** Subscribe to tool calls from the vm. Returns an unsubscribe function. */
	onToolCall(handler: (call: CodeModeToolCall) => void): () => void;
	/** Push a tool result back into the vm, resolving the matching `tools.x()` promise. */
	sendToolResult(result: CodeModeToolResult): void;
}

export interface EvalKernel {
	exec(req: EvalRequest, signal?: AbortSignal): Promise<EvalResult>;
	/**
	 * Open a code-mode channel on this kernel for a single program run. Only the
	 * JavaScript kernel implements this (returns undefined otherwise). The vm-side
	 * `tools` proxy and the JSON-RPC pump for tool calls live in the driver.
	 */
	openCodeMode?(): CodeModeChannel | undefined;
	close(): Promise<void>;
	isAlive(): boolean;
}

export interface EvalKernelManager {
	get(lang: EvalLang): EvalKernel;
	closeAll(): Promise<void>;
}

let currentManager: EvalKernelManager | undefined;

export function getCurrentEvalKernelManager(): EvalKernelManager | undefined {
	return currentManager;
}

export function setCurrentEvalKernelManager(m: EvalKernelManager | undefined): void {
	currentManager = m;
}
