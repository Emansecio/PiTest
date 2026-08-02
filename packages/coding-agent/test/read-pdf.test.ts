import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPdf, pdfToMarkdown, resetPdfModuleForTests } from "../src/core/pdf.js";
import { createReadToolDefinition } from "../src/core/tools/read.js";

/**
 * `read` converts PDFs to markdown through `@firecrawl/pdf-inspector` (napi).
 *
 * The fixtures below are assembled byte-by-byte instead of committed as binary
 * blobs: a one-page PDF is under 1KB, and a builder makes the interesting cases
 * (text vs image-only vs corrupt) readable in the diff rather than opaque. These
 * tests exercise the REAL native binary — no network, still hermetic.
 */

/** Wrap PDF objects in a header + body + xref table with correct byte offsets. */
function assemblePdf(objects: string[]): Buffer {
	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (let i = 0; i < objects.length; i++) {
		offsets.push(Buffer.byteLength(body, "latin1"));
		body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
	}
	const xrefOffset = Buffer.byteLength(body, "latin1");
	let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
	body += `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
	return Buffer.from(body, "latin1");
}

/** A one-page, text-based PDF with one Helvetica line per entry. */
function buildTextPdf(lines: string[]): Buffer {
	let stream = "";
	let y = 720;
	for (const line of lines) {
		stream += `BT /F1 12 Tf 72 ${y} Td (${line}) Tj ET\n`;
		y -= 24;
	}
	return assemblePdf([
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	]);
}

/** A one-page PDF whose only content is an image — i.e. a "scanned" document. */
function buildImageOnlyPdf(): Buffer {
	const stream = "q 612 0 0 792 0 0 cm /Im1 Do Q\n";
	return assemblePdf([
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>",
		`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`,
		"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\n\xff\nendstream",
	]);
}

const SAMPLE_LINES = ["Alpha line one", "Bravo line two", "Charlie line three", "Delta line four"];

describe("isPdf magic detection", () => {
	it("accepts the %PDF- header", () => {
		expect(isPdf(buildTextPdf(["Hello Pit"]))).toBe(true);
		expect(isPdf(Buffer.from("%PDF-1.7\n"))).toBe(true);
	});

	it("rejects non-PDF, too-short, and offset headers", () => {
		expect(isPdf(Buffer.from("hello world"))).toBe(false);
		expect(isPdf(Buffer.from("%PD"))).toBe(false);
		expect(isPdf(Buffer.from(""))).toBe(false);
		// Prefix-only on purpose: a text file that merely mentions %PDF- must not
		// be routed into the PDF converter.
		expect(isPdf(Buffer.from("see the %PDF- header spec"))).toBe(false);
	});
});

describe("pdfToMarkdown", () => {
	it("converts a text-based PDF and reports its classification", async () => {
		const result = await pdfToMarkdown(buildTextPdf(SAMPLE_LINES));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.classification).toBe("TextBased");
		expect(result.pageCount).toBe(1);
		expect(result.markdown).toContain("Alpha line one");
		expect(result.markdown).toContain("Delta line four");
	});

	it("classifies an image-only PDF as Scanned with no markdown", async () => {
		const result = await pdfToMarkdown(buildImageOnlyPdf());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.classification).toBe("Scanned");
		expect(result.markdown).toBe("");
	});

	it("returns a typed failure (never throws) for corrupt bytes", async () => {
		const result = await pdfToMarkdown(Buffer.from("%PDF-1.4\nthis is not a real pdf\n"));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe("parse-error");
		expect(result.message.length).toBeGreaterThan(0);
	});

	it("accepts a path as well as bytes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-pdf-src-"));
		try {
			const file = join(dir, "doc.pdf");
			writeFileSync(file, buildTextPdf(["Hello Pit"]));
			const result = await pdfToMarkdown(file);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.markdown).toContain("Hello Pit");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("read tool: PDF support", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-read-pdf-"));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
		delete process.env.PIT_NO_PDF;
	});

	async function runRead(fileName: string, args: { offset?: number; limit?: number } = {}): Promise<string> {
		const def = createReadToolDefinition(tempRoot);
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute(
			"call-pdf",
			{ path: join(tempRoot, fileName), ...args } as never,
			undefined,
			undefined,
			ctx,
		)) as { content: Array<{ type: string; text?: string }> };
		return result.content[0]?.text ?? "";
	}

	function write(fileName: string, bytes: Buffer): void {
		writeFileSync(join(tempRoot, fileName), bytes);
	}

	it("converts a .pdf to markdown behind a short context line", async () => {
		write("doc.pdf", buildTextPdf(SAMPLE_LINES));
		const text = await runRead("doc.pdf");
		expect(text.split("\n")[0]).toBe("[PDF converted to markdown · TextBased · 1 page]");
		for (const line of SAMPLE_LINES) expect(text).toContain(line);
		// The body is derived, not the file's bytes: hashline anchors would point
		// edit_v2 at content no file contains.
		expect(text).not.toContain("<anchors>");
		expect(text).not.toContain("%PDF-");
	});

	it("detects a PDF by magic bytes even without the .pdf extension", async () => {
		write("report.bin", buildTextPdf(SAMPLE_LINES));
		const text = await runRead("report.bin");
		expect(text).toContain("[PDF converted to markdown");
		expect(text).toContain("Alpha line one");
		// Previously this file was reported as an undisplayable binary.
		expect(text).not.toContain("Not displayable as text");
	});

	it("says a scanned PDF has no text layer instead of showing empty markdown", async () => {
		write("scan.pdf", buildImageOnlyPdf());
		const text = await runRead("scan.pdf");
		expect(text).toContain("no embedded text layer");
		expect(text).toContain("Scanned");
		expect(text).toContain("OCR extraction is not supported");
	});

	it("reports a corrupt PDF with a friendly message instead of throwing", async () => {
		write("broken.pdf", Buffer.from("%PDF-1.4\nthis is not a real pdf\n"));
		const text = await runRead("broken.pdf");
		expect(text).toContain("could not parse this PDF");
		expect(text).toContain("corrupt, encrypted, or truncated");
	});

	it("applies offset/limit to the markdown lines, not to the context line", async () => {
		write("doc.pdf", buildTextPdf(SAMPLE_LINES));
		const fullLines = (await runRead("doc.pdf")).split("\n");
		const header = fullLines[0];
		const markdownLines = fullLines.slice(1);
		expect(markdownLines.length).toBeGreaterThan(2);

		const sliced = await runRead("doc.pdf", { offset: 2, limit: 1 });
		const slicedLines = sliced.split("\n");
		// The context line is always prefixed; offset=2 selects the SECOND markdown
		// line (not the second line of the rendered output).
		expect(slicedLines[0]).toBe(header);
		expect(slicedLines[1]).toBe(markdownLines[1]);
		expect(sliced).toContain("more lines in file. Use offset=3 to continue.");

		const fromThird = await runRead("doc.pdf", { offset: 3, limit: 2 });
		expect(fromThird.split("\n").slice(1, 3)).toEqual(markdownLines.slice(2, 4));
	});

	it("rejects an offset past the end of the converted markdown", async () => {
		write("doc.pdf", buildTextPdf(SAMPLE_LINES));
		await expect(runRead("doc.pdf", { offset: 9999 })).rejects.toThrow(/beyond end of file/);
	});

	it("PIT_NO_PDF=1 restores the pre-PDF behavior", async () => {
		process.env.PIT_NO_PDF = "1";
		write("doc.pdf", buildTextPdf(SAMPLE_LINES));
		const text = await runRead("doc.pdf");
		expect(text).not.toContain("PDF converted to markdown");
		// The kill-switch path treats the file as it did before: raw bytes, decoded
		// as text (this fixture is pure ASCII, so no binary note fires).
		expect(text).toContain("%PDF-1.4");
		expect(text).toContain("/Type /Catalog");
	});
});

/**
 * Platform without a prebuilt napi binary: the addon fails to load, and `read`
 * must degrade to the old "binary file" note plus a diagnosable reason — never
 * an unhandled throw. Kept last and self-resetting because the load result is
 * latched process-wide in `core/pdf.ts`.
 */
describe("read tool: native binary unavailable", () => {
	afterAll(() => {
		vi.doUnmock("@firecrawl/pdf-inspector");
		vi.resetModules();
		resetPdfModuleForTests();
	});

	it("falls back to the binary note with the load failure appended", async () => {
		vi.doMock("@firecrawl/pdf-inspector", () => {
			throw new Error("no prebuilt binary for this platform");
		});
		resetPdfModuleForTests();
		const tempRoot = mkdtempSync(join(tmpdir(), "pi-read-pdf-na-"));
		try {
			writeFileSync(join(tempRoot, "doc.pdf"), buildTextPdf(SAMPLE_LINES));
			const def = createReadToolDefinition(tempRoot);
			const ctx = {} as Parameters<typeof def.execute>[4];
			const result = (await def.execute(
				"call-na",
				{ path: join(tempRoot, "doc.pdf") } as never,
				undefined,
				undefined,
				ctx,
			)) as { content: Array<{ type: string; text?: string }> };
			const text = result.content[0]?.text ?? "";
			expect(text).toContain("Binary file: doc.pdf");
			expect(text).toContain("PDF→markdown unavailable on this platform");
			expect(text).toContain("PIT_NO_PDF=1");
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});
