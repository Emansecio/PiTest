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

export interface EvalKernel {
	exec(req: EvalRequest, signal?: AbortSignal): Promise<EvalResult>;
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
