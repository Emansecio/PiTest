/**
 * Splice a lazy-omission warning onto an already-built write/edit result, using
 * the SAME channel as post-write LSP diagnostics (appending to the first text
 * block). Default-on; disabled with `PIT_NO_OMISSION_CHECK=1`. Alerts the model,
 * never blocks the write — the file already landed on disk.
 *
 * Kept in its own module (not lazy-omission.ts) so the pure detector stays
 * dependency-free and trivially unit-testable, while the wiring lives next to
 * the tools that call it.
 */

import { formatPathRelativeToCwd } from "../lsp/utils.ts";
import { detectCodeOmission, formatOmissionWarning, isOmissionCheckEnabled } from "./lazy-omission.ts";

/**
 * Compute the omission-warning appendix for an edit/write, or "" when nothing is
 * flagged (or the check is disabled, inputs are absent, or the scan throws). This
 * is the CPU-bound half of {@link attachOmissionWarning} — split out so callers
 * on a latency-sensitive path (e.g. the `edit` tool) can kick it off concurrently
 * with the file write and await it at result-assembly time. Never throws.
 *
 * `newContent === undefined` (preview / URL-scheme / abort path) yields "".
 */
export function computeOmissionWarning(
	oldContent: string | undefined,
	newContent: string | undefined,
	absolutePath: string,
	cwd: string,
): string {
	if (newContent === undefined) return "";
	if (!isOmissionCheckEnabled()) return "";
	try {
		const detection = detectCodeOmission(oldContent ?? "", newContent);
		if (!detection.detected) return "";
		return formatOmissionWarning(detection, formatPathRelativeToCwd(absolutePath, cwd));
	} catch {
		return "";
	}
}

/**
 * Kick off {@link computeOmissionWarning} on a microtask so its CPU work overlaps
 * the caller's in-flight write I/O instead of running serially after it. The
 * returned promise resolves to the warning string (possibly ""); await it at
 * result-assembly time and splice with {@link applyOmissionWarning}. Cheap when
 * disabled (returns a resolved "" without scheduling a scan).
 */
export function startOmissionWarning(
	oldContent: string | undefined,
	newContent: string | undefined,
	absolutePath: string,
	cwd: string,
): Promise<string> {
	if (newContent === undefined || !isOmissionCheckEnabled()) return Promise.resolve("");
	return Promise.resolve().then(() => computeOmissionWarning(oldContent, newContent, absolutePath, cwd));
}

/**
 * Splice a pre-computed warning (from {@link computeOmissionWarning} /
 * {@link startOmissionWarning}) onto `result`, appending to the first text block —
 * the SAME channel as post-write LSP diagnostics. No-op when `warning` is "".
 */
export function applyOmissionWarning<R extends { content: Array<{ type: string; text?: string }> }>(
	result: R,
	warning: string,
): R {
	if (warning && result.content[0]?.type === "text") {
		result.content[0].text = (result.content[0].text ?? "") + warning;
	}
	return result;
}

/**
 * Append an omission warning to `result` when `newContent` contains elision
 * placeholder comments that are new relative to `oldContent`. For a brand-new
 * file (write of a non-existent path) pass `oldContent = ""`.
 *
 * `newContent === undefined` (preview / URL-scheme / abort path) skips the scan.
 * Never throws.
 */
export function attachOmissionWarning<R extends { content: Array<{ type: string; text?: string }> }>(
	result: R,
	absolutePath: string,
	oldContent: string | undefined,
	newContent: string | undefined,
	cwd: string,
): R {
	return applyOmissionWarning(result, computeOmissionWarning(oldContent, newContent, absolutePath, cwd));
}
