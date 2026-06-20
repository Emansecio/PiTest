import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/**
 * Serialize a single strict JSONL record.
 *
 * Framing is LF-only. Payload strings may contain other Unicode separators such as
 * U+2028 and U+2029. Clients must split records on `\n` only.
 */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/**
 * Maximum number of buffered characters allowed for a single unterminated line.
 *
 * A peer that streams a very long line without an LF (a wedged/malformed agent
 * subprocess on stdout, or an external RPC host writing to stdin) would otherwise
 * grow the reader buffer until the process OOMs. When the pending buffer exceeds
 * this cap with no newline yet, the buffer is dropped and a framing error is
 * surfaced instead of growing without bound. JSONL records are normally well
 * under this size; a few MB leaves ample headroom for legitimate payloads.
 */
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * Attach an LF-only JSONL reader to a stream.
 *
 * This intentionally does not use Node readline. Readline splits on additional
 * Unicode separators that are valid inside JSON strings and therefore does not
 * implement strict JSONL framing.
 *
 * `onError`, when provided, is invoked if a single line exceeds `MAX_LINE_BYTES`
 * without a terminating newline; the offending buffer is discarded so the reader
 * can resynchronize on the next newline rather than growing without bound.
 */
export function attachJsonlLineReader(
	stream: Readable,
	onLine: (line: string) => void,
	onError?: (error: Error) => void,
): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	const emitLine = (line: string) => {
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	const onData = (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);

		let offset = 0;
		while (true) {
			const newlineIndex = buffer.indexOf("\n", offset);
			if (newlineIndex === -1) {
				break;
			}

			emitLine(buffer.slice(offset, newlineIndex));
			offset = newlineIndex + 1;
		}
		if (offset > 0) {
			buffer = buffer.slice(offset);
		}

		// Guard against an unterminated line growing the buffer without bound.
		// Anything still pending here has no newline; if it has exceeded the cap
		// we drop it and surface a framing error rather than risking OOM.
		if (buffer.length > MAX_LINE_BYTES) {
			const droppedChars = buffer.length;
			buffer = "";
			onError?.(
				new Error(
					`JSONL line exceeded ${MAX_LINE_BYTES} bytes without a newline; dropped ${droppedChars} buffered characters`,
				),
			);
		}
	};

	const onEnd = () => {
		buffer += decoder.end();
		if (buffer.length > 0) {
			emitLine(buffer);
			buffer = "";
		}
	};

	stream.on("data", onData);
	stream.on("end", onEnd);

	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
