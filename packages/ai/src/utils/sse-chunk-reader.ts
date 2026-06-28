/** Prefix growth threshold before compacting an SSE scan buffer. */
export const SSE_COMPACT_THRESHOLD = 65_536;

/**
 * Cursor-based SSE byte buffer. Providers append decoded chunks and scan for
 * delimiters without rewriting the buffer on every read; compact only when the
 * consumed prefix grows past {@link SSE_COMPACT_THRESHOLD}.
 */
export class SseChunkBuffer {
	buffer = "";
	cursor = 0;

	append(text: string): void {
		this.buffer += text;
	}

	findFromCursor(needle: string): number {
		return this.buffer.indexOf(needle, this.cursor);
	}

	sliceFromCursor(end?: number): string {
		return this.buffer.slice(this.cursor, end);
	}

	advanceTo(newCursor: number): void {
		this.cursor = newCursor;
	}

	compactIfNeeded(threshold: number = SSE_COMPACT_THRESHOLD): void {
		if (this.cursor > threshold) {
			this.buffer = this.buffer.slice(this.cursor);
			this.cursor = 0;
		}
	}
}
