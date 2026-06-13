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
	if (newContent === undefined) return result;
	if (!isOmissionCheckEnabled()) return result;
	let warning = "";
	try {
		const detection = detectCodeOmission(oldContent ?? "", newContent);
		if (!detection.detected) return result;
		warning = formatOmissionWarning(detection, formatPathRelativeToCwd(absolutePath, cwd));
	} catch {
		return result;
	}
	if (warning && result.content[0]?.type === "text") {
		result.content[0].text = (result.content[0].text ?? "") + warning;
	}
	return result;
}
