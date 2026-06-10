/**
 * Cleanup of stale tool-output temp logs.
 *
 * bash-executor and OutputAccumulator persist full tool output to
 * `pi-bash-*.log` / `pi-output-*.log` files in the OS tmpdir so truncated
 * output stays recoverable during the session. Nothing deletes them afterwards
 * and Windows never cleans %TEMP% on its own, so without a sweep they
 * accumulate without bound across sessions.
 */

import { readdir, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEMP_LOG_PATTERN = /^pi-(bash|output)-[0-9a-f]{16}\.log$/;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete tool-output temp logs older than `maxAgeMs` (default 7 days).
 * Best-effort: every failure is ignored — the sweep must never affect startup.
 */
export async function sweepStaleTempLogs(maxAgeMs: number = DEFAULT_MAX_AGE_MS): Promise<void> {
	const dir = tmpdir();
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	const cutoff = Date.now() - maxAgeMs;
	for (const entry of entries) {
		if (!TEMP_LOG_PATTERN.test(entry)) {
			continue;
		}
		const filePath = join(dir, entry);
		try {
			const info = await stat(filePath);
			if (info.mtimeMs < cutoff) {
				await unlink(filePath);
			}
		} catch {
			// Already gone or locked by a live session — skip.
		}
	}
}
