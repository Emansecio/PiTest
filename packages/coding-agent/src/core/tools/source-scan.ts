import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { detectKind } from "./symbol.js";

// Directories never worth walking for source symbols.
export const SCAN_SKIP_DIRS: Record<string, true> = {
	".git": true,
	node_modules: true,
	dist: true,
	build: true,
	out: true,
	".next": true,
	".turbo": true,
	coverage: true,
	".cache": true,
	vendor: true,
	__pycache__: true,
	".venv": true,
	target: true,
	bin: true,
	obj: true,
};

const DEFAULT_MAX_FILES = 2000;

/** DFS-walk (LIFO stack) source files (known languages only), respecting skip dirs. */
export async function scanSourceFiles(
	root: string,
	opts?: { maxFiles?: number; signal?: AbortSignal },
): Promise<string[]> {
	const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;
	const out: string[] = [];
	const stack: string[] = [root];
	while (stack.length > 0) {
		if (opts?.signal?.aborted) break;
		const dir = stack.pop();
		if (dir === undefined) break;
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
		if (entries === null) continue;
		for (const e of entries) {
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (!SCAN_SKIP_DIRS[e.name] && !e.name.startsWith(".")) stack.push(full);
			} else if (e.isFile() && detectKind(full) !== "unknown") {
				out.push(full);
				if (out.length >= maxFiles) return out;
			}
		}
	}
	return out;
}
