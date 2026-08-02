/**
 * PDF → markdown conversion, shared by any tool that needs to look inside a PDF
 * (today: `read`; the same helper is meant to back future PDF-aware tools).
 *
 * Backed by `@firecrawl/pdf-inspector` — a napi (Rust) parser that ships
 * prebuilt platform binaries as optionalDependencies. Two properties drive the
 * shape of this module:
 *
 *  - **Lazy.** The native addon is ~6MB and costs real time to dlopen; a session
 *    that never touches a PDF must not pay for it. The package is pulled in with
 *    a dynamic `import()` on first use and memoized (same pattern as
 *    `tools/ast-grep-napi.ts`).
 *  - **Never fatal.** A platform with no prebuilt binary, or a corrupted file,
 *    must degrade to a message — never an unhandled throw that takes the session
 *    down. Every failure comes back as a typed `{ ok: false, reason }` result, so
 *    callers handle it by exhaustive switch rather than by remembering to catch.
 *
 * There is deliberately no OCR here: the parser reads embedded text only. A
 * scanned/image-based PDF is reported as such (see {@link formatPdfNoTextNote})
 * instead of yielding a silently empty document.
 */

import { isTruthyEnvFlag } from "../utils/env-flags.ts";

/** `%PDF-` — the file-header magic every PDF starts with (ISO 32000-1 §7.5.2). */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;

/**
 * Whether these bytes start with the `%PDF-` header. Prefix-only (no scan for a
 * header buried after a preamble): the point is to route files that ARE PDFs,
 * and a scan would misroute any text file that merely mentions the magic.
 */
export function isPdf(bytes: Uint8Array): boolean {
	if (bytes.length < PDF_MAGIC.length) return false;
	for (let i = 0; i < PDF_MAGIC.length; i++) {
		if (bytes[i] !== PDF_MAGIC[i]) return false;
	}
	return true;
}

/** Document classification reported by the parser. */
export type PdfClassification = "TextBased" | "Scanned" | "ImageBased" | "Mixed";

/** Classifications with no usable embedded text layer — OCR territory, unsupported. */
const NO_TEXT_CLASSIFICATIONS: ReadonlySet<string> = new Set(["Scanned", "ImageBased"]);

/** True when this classification means "no embedded text to extract". */
export function isPdfWithoutText(classification: PdfClassification): boolean {
	return NO_TEXT_CLASSIFICATIONS.has(classification);
}

export interface PdfMarkdown {
	ok: true;
	classification: PdfClassification;
	/** Page count reported by the parser; absent if it could not be determined. */
	pageCount?: number;
	/** Markdown for the whole document (empty when the PDF has no text layer). */
	markdown: string;
	/** 1-indexed pages the parser flagged as needing OCR (never OCR'd here). */
	pagesNeedingOcr: number[];
}

export interface PdfFailure {
	ok: false;
	/**
	 * `unavailable` — the native addon could not be loaded (no prebuilt binary for
	 * this platform/arch, or the optional dependency was pruned). Callers should
	 * fall back to whatever they did before PDF support existed.
	 * `parse-error` — the addon loaded but rejected the bytes (corrupt/encrypted).
	 */
	reason: "unavailable" | "parse-error";
	/** Short human-readable cause, safe to show in tool output. */
	message: string;
}

export type PdfConversion = PdfMarkdown | PdfFailure;

/** Shape we actually use out of `@firecrawl/pdf-inspector` (see its index.d.ts). */
interface PdfInspectorModule {
	processPdf: (
		buffer: Buffer,
		pages?: number[] | null,
	) => {
		pdfType: string;
		markdown?: string;
		pageCount: number;
		pagesNeedingOcr: number[];
	};
}

let moduleState: { mod: PdfInspectorModule } | "unavailable" | "unloaded" = "unloaded";
let loadPromise: Promise<PdfInspectorModule | null> | null = null;
/** Cause of the load failure, surfaced so the user can tell "no binary" from a real bug. */
let loadError = "native module unavailable";

/**
 * Load (once) and memoize the native addon. Any failure — missing platform
 * package, dlopen error, unexpected export shape — is latched as "unavailable"
 * so later calls short-circuit without retrying a load that cannot succeed.
 */
function loadModule(): Promise<PdfInspectorModule | null> {
	if (moduleState === "unavailable") return Promise.resolve(null);
	if (moduleState !== "unloaded") return Promise.resolve(moduleState.mod);
	if (!loadPromise) {
		loadPromise = (async () => {
			try {
				const mod = (await import("@firecrawl/pdf-inspector")) as unknown as PdfInspectorModule;
				if (!mod || typeof mod.processPdf !== "function") {
					moduleState = "unavailable";
					loadError = "@firecrawl/pdf-inspector loaded without the expected exports";
					return null;
				}
				moduleState = { mod };
				return mod;
			} catch (err) {
				moduleState = "unavailable";
				loadError = err instanceof Error ? err.message : String(err);
				return null;
			}
		})();
	}
	return loadPromise;
}

/** Test seam: forget the memoized addon so a later call re-attempts the load. */
export function resetPdfModuleForTests(): void {
	moduleState = "unloaded";
	loadPromise = null;
	loadError = "native module unavailable";
}

/**
 * PDF reading is ON by default; `PIT_NO_PDF=1` restores the pre-PDF behavior
 * (a PDF is just an undisplayable binary). Mirrors the project's other
 * default-on features (`PIT_NO_JSON_CRUSH`, `PIT_NO_LIVING_REPO_MAP`, …).
 */
export function isPdfReadEnabled(): boolean {
	return !isTruthyEnvFlag(process.env.PIT_NO_PDF);
}

/**
 * Convert a PDF to markdown. Accepts the bytes directly (the common case — the
 * caller has usually already read the file) or a path to read them from.
 *
 * Never throws: a missing native binary or an unparseable document comes back as
 * a {@link PdfFailure}. A PDF with no text layer is NOT a failure — it resolves
 * with its `Scanned`/`ImageBased` classification and empty markdown, so the
 * caller can say so explicitly instead of showing an empty document.
 */
export async function pdfToMarkdown(source: Uint8Array | string): Promise<PdfConversion> {
	const mod = await loadModule();
	if (!mod) return { ok: false, reason: "unavailable", message: loadError };
	let buffer: Buffer;
	try {
		if (typeof source === "string") {
			const { readFile } = await import("node:fs/promises");
			buffer = await readFile(source);
		} else {
			buffer = Buffer.isBuffer(source) ? source : Buffer.from(source);
		}
	} catch (err) {
		return { ok: false, reason: "parse-error", message: err instanceof Error ? err.message : String(err) };
	}
	try {
		const result = mod.processPdf(buffer);
		return {
			ok: true,
			classification: normalizeClassification(result.pdfType),
			pageCount: typeof result.pageCount === "number" ? result.pageCount : undefined,
			markdown: result.markdown ?? "",
			pagesNeedingOcr: Array.isArray(result.pagesNeedingOcr) ? result.pagesNeedingOcr : [],
		};
	} catch (err) {
		// napi surfaces Rust panics/errors as thrown JS errors ("Invalid PDF
		// structure", …). Corrupt input is expected traffic, not a bug.
		return { ok: false, reason: "parse-error", message: err instanceof Error ? err.message : String(err) };
	}
}

/** Map the parser's `pdfType` string onto our union, defaulting to `Mixed`. */
function normalizeClassification(pdfType: string): PdfClassification {
	switch (pdfType) {
		case "TextBased":
		case "Scanned":
		case "ImageBased":
		case "Mixed":
			return pdfType;
		default:
			return "Mixed";
	}
}

/**
 * The short context line prefixed to converted markdown, so the model knows it
 * is reading a derived rendering (not file bytes), its classification, and the
 * page count when the parser reports one.
 */
export function formatPdfHeader(result: PdfMarkdown): string {
	const parts = [`PDF converted to markdown`, result.classification];
	if (result.pageCount !== undefined) {
		parts.push(`${result.pageCount} ${result.pageCount === 1 ? "page" : "pages"}`);
	}
	if (result.classification === "Mixed" && result.pagesNeedingOcr.length > 0) {
		parts.push(`${result.pagesNeedingOcr.length} page(s) without extractable text (no OCR)`);
	}
	return `[${parts.join(" · ")}]`;
}

/**
 * Message for a PDF whose pages are images: there is nothing to extract and no
 * OCR to fall back on, so say it outright rather than returning empty markdown.
 */
export function formatPdfNoTextNote(displayPath: string, result: PdfMarkdown): string {
	const pages = result.pageCount !== undefined ? `, ${result.pageCount} page(s)` : "";
	return `[${displayPath}: PDF has no embedded text layer (classified ${result.classification}${pages}) — its pages are images. OCR extraction is not supported, so there is nothing to read. Use \`inspect_image\` on a rendered page, or an external OCR tool via \`bash\`.]`;
}

/** Message for a PDF the parser could not read (corrupt, encrypted, truncated). */
export function formatPdfErrorNote(displayPath: string, failure: PdfFailure): string {
	if (failure.reason === "unavailable") {
		return `[PDF→markdown unavailable on this platform (${failure.message}). Set PIT_NO_PDF=1 to silence this.]`;
	}
	return `[${displayPath}: could not parse this PDF (${failure.message}). It may be corrupt, encrypted, or truncated. Use \`bash\` for metadata (e.g. \`file\`, \`pdfinfo\`).]`;
}
