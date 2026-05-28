/**
 * Jupyter notebook (.ipynb) formatter for the read tool.
 *
 * Parses the cells[] array of an ipynb JSON document and emits a flat text
 * rendering suitable for an LLM context window. Each cell becomes a labelled
 * block; code-cell outputs are inlined under an `--- Output ---` separator.
 *
 * Offset/limit are applied at the cell level (not the line level) so a notebook
 * with 200 cells can be paged the same way a 200-line text file would be —
 * `offset: 5, limit: 10` returns cells 5..14. Per-cell output is truncated to
 * 1 KB to keep one runaway print statement from blowing the budget.
 */

const MAX_OUTPUT_BYTES = 1024;

interface NotebookCellOutputStream {
	output_type?: string;
	name?: string;
	text?: string | string[];
}

interface NotebookCellOutputData {
	output_type?: string;
	data?: Record<string, unknown>;
	text?: string | string[];
	ename?: string;
	evalue?: string;
	traceback?: string[];
}

type NotebookCellOutput = NotebookCellOutputStream & NotebookCellOutputData;

interface NotebookCell {
	cell_type?: string;
	source?: string | string[];
	outputs?: NotebookCellOutput[];
}

interface NotebookDocument {
	cells?: NotebookCell[];
}

export interface FormatNotebookOptions {
	/** 1-indexed cell offset (matches read tool semantics). Default: 1. */
	offset?: number;
	/** Maximum cells to render. Default: all from offset. */
	limit?: number;
	/** Display name (typically basename of the file). */
	name?: string;
}

export interface FormatNotebookResult {
	text: string;
	totalCells: number;
	renderedCells: number;
}

/** Stringify ipynb `source` (sometimes string, sometimes string[]). */
function flattenSource(source: string | string[] | undefined): string {
	if (source === undefined) return "";
	if (typeof source === "string") return source;
	return source.join("");
}

/** Clip a string to MAX_OUTPUT_BYTES UTF-8 bytes, appending a truncation note. */
function clipOutput(text: string): string {
	const bytes = Buffer.byteLength(text, "utf-8");
	if (bytes <= MAX_OUTPUT_BYTES) return text;
	// Slice conservatively in code units so the cut never lands mid-codepoint.
	// Worst case truncates ~3 bytes early; acceptable for an LLM preview.
	const buf = Buffer.from(text, "utf-8").subarray(0, MAX_OUTPUT_BYTES);
	let safe = buf.toString("utf-8");
	// `Buffer.toString` may have emitted a replacement char at the boundary —
	// drop one trailing char if so, then append the truncation marker.
	if (safe.charCodeAt(safe.length - 1) === 0xfffd) {
		safe = safe.slice(0, -1);
	}
	return `${safe}\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`;
}

/** Extract text for a single code-cell output entry. Returns null when nothing renderable. */
function formatCellOutput(output: NotebookCellOutput): string | null {
	if (!output) return null;
	const kind = output.output_type;

	// Error / traceback: emit ename:evalue plus the joined traceback.
	if (kind === "error" && (output.ename || output.evalue || output.traceback)) {
		const header = [output.ename, output.evalue].filter(Boolean).join(": ");
		const trace = Array.isArray(output.traceback) ? output.traceback.join("\n") : "";
		const combined = [header, trace].filter((part) => part.length > 0).join("\n");
		return combined.length > 0 ? combined : null;
	}

	// Streams: `text` field directly.
	if (typeof output.text === "string" || Array.isArray(output.text)) {
		const text = flattenSource(output.text as string | string[]);
		if (text.length > 0) return text;
	}

	// Rich displays: prefer text/plain, surface image placeholders.
	if (output.data && typeof output.data === "object") {
		const data = output.data;
		const plain = data["text/plain"];
		if (typeof plain === "string") return plain;
		if (Array.isArray(plain)) return (plain as string[]).join("");
		// Images / svgs / html — emit a placeholder so the model knows the cell
		// produced something visual rather than silently dropping the output.
		const hasImage = Object.keys(data).some((mime) => mime.startsWith("image/"));
		if (hasImage) return "[image output omitted]";
	}

	return null;
}

/**
 * Format a parsed ipynb document for inline display. Returns the rendered text
 * plus cell totals so the caller can build offset/limit continuation hints.
 * Empty `raw` cells (cell_type === "raw" with no source) are skipped per spec.
 */
export function formatNotebookCells(doc: NotebookDocument, options?: FormatNotebookOptions): FormatNotebookResult {
	const rawCells = Array.isArray(doc.cells) ? doc.cells : [];
	// Skip empty raw cells — they're typically metadata scaffolding.
	const cells = rawCells.filter((cell) => {
		if (cell?.cell_type !== "raw") return true;
		return flattenSource(cell.source).trim().length > 0;
	});
	const total = cells.length;
	const startIndex = Math.max(0, (options?.offset ?? 1) - 1);
	const endIndex = options?.limit !== undefined ? Math.min(startIndex + options.limit, total) : total;
	const slice = cells.slice(startIndex, endIndex);

	const lines: string[] = [];
	const name = options?.name ?? "notebook";
	lines.push(`Notebook: ${name} (${total} cells, offset/limit address cells not lines)`);

	for (let i = 0; i < slice.length; i++) {
		const cell = slice[i];
		const cellNumber = startIndex + i + 1;
		const kind = cell.cell_type ?? "unknown";
		lines.push("");
		lines.push(`═══ Cell ${cellNumber} (${kind}) ═══`);
		const source = flattenSource(cell.source);
		lines.push(source.length > 0 ? source : "[empty cell]");
		if (kind === "code" && Array.isArray(cell.outputs) && cell.outputs.length > 0) {
			const rendered: string[] = [];
			for (const out of cell.outputs) {
				const piece = formatCellOutput(out);
				if (piece !== null && piece.length > 0) rendered.push(clipOutput(piece));
			}
			if (rendered.length > 0) {
				lines.push("");
				lines.push("--- Output ---");
				lines.push(rendered.join("\n"));
			}
		}
	}

	return {
		text: lines.join("\n"),
		totalCells: total,
		renderedCells: slice.length,
	};
}

/** Parse + format a `.ipynb` file body. Throws on invalid JSON. */
export function formatNotebookSource(body: string, options?: FormatNotebookOptions): FormatNotebookResult {
	const parsed = JSON.parse(body) as NotebookDocument;
	return formatNotebookCells(parsed, options);
}
