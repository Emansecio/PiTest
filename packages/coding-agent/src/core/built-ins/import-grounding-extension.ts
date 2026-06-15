/**
 * Built-in import-grounding extension (thin adapter).
 *
 * Pre-exec counterpart for RELATIVE import paths in a `write`/`edit`: when the
 * NEW content names a relative module (`./x`, `../y`) that does not resolve on
 * disk, this blocks with the close filename candidates from the target dir —
 * BEFORE the write lands and the import fails at type-check / runtime. The #1
 * real error in generated code is a wrong relative import path; this catches it
 * one round-trip earlier. All the decision logic (the resolve cascade, the
 * relative-only / block-only / fail-open invariants) lives in the pure
 * `../import-grounding.ts`; this adapter only wires the fs deps + fuzzy matcher
 * and harvests {targetFile, content} from the tool input.
 *
 * For a `write`, content = the full `content` arg (the complete new file body).
 * For an `edit`, there is no whole-file content at pre-exec, so content = the
 * concatenation of edits[].newText — where a newly-added import line appears.
 *
 * Session state: a fire-once set so an insistent model re-issuing the identical
 * blocked call runs it (the guard advises, never wedges). The whole handler is
 * wrapped in try/catch because `emitToolCall` has no per-handler isolation and a
 * throw out of beforeToolCall would hard-block the call — fail-open is
 * load-bearing. Opt out with PIT_NO_IMPORT_GROUNDING.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { recordDiagnostic, suggestClosest } from "@pit/ai";
import type { ExtensionAPI } from "../extensions/index.js";
import { groundImports, IMPORT_GROUNDING_DEFAULTS, isImportGroundingDisabled } from "../import-grounding.ts";
import { extractEdits, extractPathArg, resolveToolPath } from "../tools/argument-prep.ts";

/** Aliases the write tool accepts for the content body (WRITE_KEY_ALIASES in write.ts). */
const CONTENT_KEYS = ["content", "text", "body", "data"] as const;

function readFileSafe(absPath: string): string | undefined {
	try {
		return readFileSync(absPath, "utf-8");
	} catch {
		return undefined;
	}
}

/**
 * Reconstruct the full edited LINE so a surgical edit that swaps ONLY the
 * specifier (newText without the `import` keyword) still presents a complete
 * import statement to the regex. Find oldText in the file, expand to its whole
 * line, and apply newText in place. Falls back to the raw newText when the file
 * or oldText can't be located (fail-open — exported for tests).
 */
export function reconstructEditedRegion(fileContent: string | undefined, oldText: string, newText: string): string {
	if (fileContent === undefined) return newText;
	const idx = fileContent.indexOf(oldText);
	if (idx < 0) return newText;
	const lineStart = fileContent.lastIndexOf("\n", idx) + 1;
	const matchEnd = idx + oldText.length;
	const nextNewline = fileContent.indexOf("\n", matchEnd);
	const lineEnd = nextNewline < 0 ? fileContent.length : nextNewline;
	return `${fileContent.slice(lineStart, idx)}${newText}${fileContent.slice(matchEnd, lineEnd)}`;
}

/** New content to scan: a write's full body, or an edit's reconstructed lines. */
function extractContent(toolName: string, input: Record<string, unknown>, targetFile: string): string | undefined {
	if (toolName === "write") {
		for (const key of CONTENT_KEYS) {
			const value = input[key];
			if (typeof value === "string") return value;
		}
		return undefined;
	}
	const edits = extractEdits(input);
	if (!edits) return undefined;
	const fileContent = readFileSafe(targetFile);
	return edits.map((edit) => reconstructEditedRegion(fileContent, edit.oldText, edit.newText)).join("\n");
}

export function createImportGroundingExtension(options: { cwd: string }) {
	return (pi: ExtensionAPI) => {
		const fired = new Set<string>();

		pi.on("tool_call", async (event) => {
			try {
				if (isImportGroundingDisabled()) return undefined;
				if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

				const input = event.input as Record<string, unknown>;
				const path = extractPathArg(input);
				if (path === undefined) return undefined;

				// Only TS/JS targets carry the import forms we resolve.
				if (!/\.(?:[cm]?[jt]sx?)$/i.test(path)) return undefined;

				const targetFile = resolveToolPath(path, options.cwd);
				const content = extractContent(event.toolName, input, targetFile);
				if (content === undefined || content.length === 0) return undefined;
				const decision = groundImports(
					{ targetFile, content },
					{
						fileExists: (absPath) => existsSync(absPath),
						listDir: (absDir) => readdirSync(absDir),
						fuzzy: suggestClosest,
						maxDistance: IMPORT_GROUNDING_DEFAULTS.maxDistance,
						prefixMinOverlap: IMPORT_GROUNDING_DEFAULTS.prefixMinOverlap,
						// Wires the named-export validation pass: read a resolved module's
						// source so a `import { nope } from "./mod"` of a non-existent member
						// is caught one round-trip before type-check.
						readFile: readFileSafe,
					},
				);

				if (decision.action === "block") {
					// Stable key (sorted top-level arg keys) so a verbatim re-issue with
					// reordered keys still matches the fire-once escape.
					const key = `${event.toolName}:${JSON.stringify(input, Object.keys(input).sort())}`;
					// `note` carries the block KIND (path vs export) + the tool so the
					// acceptance rate can be read per-kind from the diagnostics buffer.
					const note = `${decision.kind}:${event.toolName}`;
					if (fired.has(key)) {
						// The model is OVERRIDING the fire-once advisory by re-issuing the
						// identical call — record the acceptance so override-rate is
						// measurable against the blocks below.
						recordDiagnostic({
							category: "guard.import-grounding",
							level: "info",
							source: "import-grounding-extension",
							context: { note, outcome: "overridden" },
						});
						return undefined; // already advised once -> let it run
					}
					fired.add(key);
					recordDiagnostic({
						category: "guard.import-grounding",
						level: "info",
						source: "import-grounding-extension",
						context: { note, outcome: "blocked" },
					});
					return { block: true, reason: decision.message };
				}
				return undefined;
			} catch {
				// emitToolCall has no per-handler try/catch; a throw out of beforeToolCall
				// would hard-block the call. Fail-open is the invariant -> swallow.
				return undefined;
			}
		});
	};
}
