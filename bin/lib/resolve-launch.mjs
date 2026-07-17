import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * True as soon as ANY *.ts under `dir` (recursively) has mtimeMs > threshold.
 * Short-circuits on the first newer file. Missing dir → false (nothing newer).
 */
export function anyTsNewerThan(dir, thresholdMs) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			if (anyTsNewerThan(full, thresholdMs)) return true;
		} else if (e.name.endsWith(".ts")) {
			try {
				if (statSync(full).mtimeMs > thresholdMs) return true;
			} catch {}
		}
	}
	return false;
}

/**
 * deps: { bundleMtimeMs: number|null, srcDirs: string[], forceSrc: boolean, isNewer?: (dir,ms)=>boolean }
 * bundleMtimeMs === null means the bundle is missing. Returns "bundle" | "src".
 */
export function decideTarget({ bundleMtimeMs, srcDirs, forceSrc, isNewer = anyTsNewerThan }) {
	if (forceSrc) return "src";
	if (bundleMtimeMs === null) return "src";
	for (const dir of srcDirs) if (isNewer(dir, bundleMtimeMs)) return "src";
	return "bundle";
}
