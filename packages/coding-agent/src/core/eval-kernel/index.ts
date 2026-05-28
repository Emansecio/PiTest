/**
 * Eval kernel manager — holds one persistent Python and one persistent
 * JavaScript kernel per agent session. Kernels are spawned lazily on first
 * `get(lang)` and torn down on `closeAll()` (called from session dispose).
 */

import { createJsKernel } from "./javascript.ts";
import { createPyKernel } from "./python.ts";
import {
	type EvalKernel,
	type EvalKernelManager,
	type EvalLang,
	getCurrentEvalKernelManager,
	setCurrentEvalKernelManager,
} from "./types.ts";

export { createJsKernel, createPyKernel, getCurrentEvalKernelManager, setCurrentEvalKernelManager };
export type { EvalKernel, EvalKernelManager, EvalLang };
export type { EvalRequest, EvalResult } from "./types.ts";

class KernelManager implements EvalKernelManager {
	private kernels = new Map<EvalLang, EvalKernel>();
	private cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	get(lang: EvalLang): EvalKernel {
		let k = this.kernels.get(lang);
		if (!k || !k.isAlive()) {
			k = lang === "python" ? createPyKernel(this.cwd) : createJsKernel(this.cwd);
			this.kernels.set(lang, k);
		}
		return k;
	}

	async closeAll(): Promise<void> {
		const all = Array.from(this.kernels.values());
		this.kernels.clear();
		await Promise.all(all.map((k) => k.close().catch(() => undefined)));
	}
}

export function createEvalKernelManager(cwd: string): EvalKernelManager {
	return new KernelManager(cwd);
}
