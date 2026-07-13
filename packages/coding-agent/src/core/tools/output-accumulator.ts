import { randomBytes } from "node:crypto";
import { createWriteStream, readFileSync, type WriteStream, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactForDisk } from "../secret-redactor.ts";
import {
	DEFAULT_MAX_LINES,
	effectiveDefaultMaxBytes,
	formatSize,
	type TruncationResult,
	truncateHead,
	truncateTail,
} from "./truncate.ts";

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
	/**
	 * When both are > 0, retain the first `headLines`/`headBytes` of output so a
	 * truncated snapshot shows head + elided-middle + tail (command at the top,
	 * error at the bottom) instead of tail only. Default 0 = tail-only (legacy).
	 */
	headLines?: number;
	headBytes?: number;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
	/** Set when `content` is a head+tail composition (the middle was elided). */
	composed?: { headLines: number; tailLines: number; elidedLines: number };
}

function defaultTempFilePath(prefix: string): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `${prefix}-${id}.log`);
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	let n = 1;
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
	return n;
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly headLineLimit: number;
	private readonly headByteLimit: number;
	private readonly decoder = new TextDecoder();

	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private totalLines = 1;
	private currentLineBytes = 0;
	private finished = false;
	private headText = "";
	private headSealed = false;

	private tempFilePath: string | undefined;
	private tempFileStream: WriteStream | undefined;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? effectiveDefaultMaxBytes();
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
		this.headLineLimit = Math.max(0, options.headLines ?? 0);
		this.headByteLimit = Math.max(0, options.headBytes ?? 0);
		// Nothing to collect when head retention is disabled (both limits must be > 0).
		this.headSealed = !(this.headLineLimit > 0 && this.headByteLimit > 0);
	}

	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		if (this.tempFileStream || this.shouldUseTempFile()) {
			this.ensureTempFile();
			this.tempFileStream?.write(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
		if (this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;

		// When head retention is on and we actually truncated, show head + elided
		// middle + tail instead of tail only. Falls back to tail-only when the head
		// already fills the budget or there is no genuine middle to elide.
		let content = tailTruncation.content;
		let composed: OutputSnapshot["composed"];
		if (truncated && this.headEnabled() && this.headText.length > 0) {
			const headTail = this.composeHeadTail();
			if (headTail) {
				content = headTail.content;
				composed = {
					headLines: headTail.headLines,
					tailLines: headTail.tailLines,
					elidedLines: headTail.elidedLines,
				};
			}
		}

		const truncation: TruncationResult = {
			...tailTruncation,
			content,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (options.persistIfTruncated && truncation.truncated) {
			this.ensureTempFile();
		}

		return {
			content,
			truncation,
			fullOutputPath: this.tempFilePath,
			composed,
		};
	}

	private headEnabled(): boolean {
		return this.headLineLimit > 0 && this.headByteLimit > 0;
	}

	/**
	 * Compose a head+tail view: the retained head, an elision marker, then the tail
	 * fitted into the remaining budget. Returns undefined (caller falls back to
	 * tail-only) when the head already consumes the budget or head and tail would
	 * cover the whole output (no genuine middle) — that guard also guarantees the
	 * head and tail segments are disjoint, so no line is duplicated.
	 */
	private composeHeadTail():
		| { content: string; headLines: number; tailLines: number; elidedLines: number }
		| undefined {
		const head = this.headText;
		const headLines = countLines(head);
		const headBytes = byteLength(head);
		const markerReserve = 96;
		const tailLineBudget = this.maxLines - headLines - 1;
		const tailByteBudget = this.maxBytes - headBytes - markerReserve;
		if (tailLineBudget < 1 || tailByteBudget < 1) return undefined;
		const tail = truncateTail(this.getSnapshotText(), { maxLines: tailLineBudget, maxBytes: tailByteBudget });
		const tailLines = countLines(tail.content);
		const elidedLines = this.totalLines - headLines - tailLines;
		if (elidedLines <= 0) return undefined;
		const elidedBytes = Math.max(0, this.totalDecodedBytes - headBytes - byteLength(tail.content));
		const marker = `\n\n[... ${elidedLines} lines (${formatSize(elidedBytes)}) elided ...]\n\n`;
		return { content: head + marker + tail.content, headLines, tailLines, elidedLines };
	}

	async closeTempFile(): Promise<void> {
		if (!this.tempFileStream) {
			return;
		}

		const stream = this.tempFileStream;
		this.tempFileStream = undefined;

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				stream.off("finish", onFinish);
				reject(error);
			};
			const onFinish = () => {
				stream.off("error", onError);
				resolve();
			};
			stream.once("error", onError);
			stream.once("finish", onFinish);
			stream.end();
		});

		// The complete-output path is an artifact boundary. Sanitize only after the
		// stream is closed so matches spanning write chunks are handled as one value.
		// The path is never exposed to callers before closeTempFile resolves.
		if (this.tempFilePath) {
			const raw = readFileSync(this.tempFilePath, "utf8");
			writeFileSync(this.tempFilePath, redactForDisk(raw), "utf8");
		}
	}

	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		// Retain the head (first lines) until its budget fills, then seal it. The
		// rolling tail buffer below discards the start of large output, so the head
		// must be captured separately for head+tail snapshots.
		if (!this.headSealed) {
			this.headText += text;
			const clamped = truncateHead(this.headText, { maxLines: this.headLineLimit, maxBytes: this.headByteLimit });
			if (clamped.truncated) {
				this.headText = clamped.content;
				this.headSealed = true;
			}
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
		} else {
			this.totalLines += newlines;
			this.currentLineBytes = byteLength(text.slice(lastNewline + 1));
		}
	}

	private trimTail(): void {
		if (this.tailBytes <= this.maxRollingBytes) {
			return;
		}

		const buffer = Buffer.from(this.tailText, "utf-8");
		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = buffer.length - start;
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private ensureTempFile(): void {
		if (this.tempFilePath) {
			return;
		}
		this.tempFilePath = defaultTempFilePath(this.tempFilePrefix);
		this.tempFileStream = createWriteStream(this.tempFilePath);
		// Without a listener, a stream "error" (disk full, tmpdir permissions)
		// becomes an uncaught exception and crashes the whole process. Drop the
		// temp file and keep serving the bounded in-memory tail instead.
		this.tempFileStream.on("error", () => {
			this.tempFileStream = undefined;
			this.tempFilePath = undefined;
		});
		for (const chunk of this.rawChunks) {
			this.tempFileStream.write(chunk);
		}
		this.rawChunks = [];
	}
}
