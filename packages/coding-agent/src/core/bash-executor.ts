/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripAnsi } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import type { BashOperations } from "./tools/bash.ts";
import { BASH_MAX_BYTES, BASH_MAX_LINES, collapseRepeatedLines, truncateTail } from "./tools/truncate.ts";

// ============================================================================
// Types
// ============================================================================

export interface BashExecutorOptions {
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = BASH_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let totalBytes = 0;
	// Set once a temp-file write stream errored out (disk full, permissions).
	// After that point the in-memory rolling buffer has likely already discarded
	// early output, so re-creating a temp file would yield a silently truncated
	// "full output". When this is set we refuse to (re-)create a temp file and
	// leave fullOutputPath undefined — no path is more honest than a partial one.
	let tempFileFailed = false;

	const ensureTempFile = () => {
		if (tempFilePath || tempFileFailed) {
			return;
		}
		const id = randomBytes(8).toString("hex");
		tempFilePath = join(tmpdir(), `pi-bash-${id}.log`);
		tempFileStream = createWriteStream(tempFilePath);
		// Without a listener, a stream "error" (disk full, tmpdir permissions)
		// becomes an uncaught exception and crashes the whole process. Drop the
		// temp file and keep going with the in-memory rolling buffer instead.
		tempFileStream.on("error", () => {
			tempFileStream = undefined;
			tempFilePath = undefined;
			tempFileFailed = true;
		});
		for (const chunk of outputChunks) {
			tempFileStream.write(chunk);
		}
	};

	const decoder = new TextDecoder();

	const onData = (data: Buffer) => {
		totalBytes += data.length;

		// Sanitize: strip ANSI, replace binary garbage, normalize newlines
		const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");

		// Start writing to temp file if exceeds threshold
		if (totalBytes > BASH_MAX_BYTES) {
			ensureTempFile();
		}

		if (tempFileStream) {
			tempFileStream.write(text);
		}

		// Keep rolling buffer
		outputChunks.push(text);
		outputBytes += Buffer.byteLength(text);
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= Buffer.byteLength(removed);
		}

		// Stream to callback. Guard it: a throwing callback (e.g. injected by an
		// extension) would otherwise kill the child-process data handler and leave
		// the exec promise hanging.
		if (options?.onChunk) {
			try {
				options.onChunk(text);
			} catch {
				// Ignore: output is still captured in the rolling buffer/temp file.
			}
		}
	};

	// Apply the same output budget the agent's bash tool uses (BASH_MAX_LINES /
	// BASH_MAX_BYTES, tail-only) and collapse runs of identical consecutive lines.
	// Without this the user's `!` command kept the 2000-line/50KB default and skipped
	// collapse, so verbose output bloated the context and persisted in history.
	const finalizeOutput = (): { output: string; truncated: boolean } => {
		// Flush the streaming decoder once: if the last data chunk ended mid
		// multibyte sequence, the leading bytes are buffered inside the decoder
		// and would otherwise be dropped from the captured output. The flush
		// returns "" when output does not end on a split boundary.
		const tail = sanitizeBinaryOutput(stripAnsi(decoder.decode())).replace(/\r/g, "");
		if (tail) {
			outputChunks.push(tail);
			if (tempFileStream) {
				tempFileStream.write(tail);
			}
		}
		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput, { maxLines: BASH_MAX_LINES, maxBytes: BASH_MAX_BYTES });
		if (truncationResult.truncated) {
			ensureTempFile();
		}
		if (tempFileStream) {
			tempFileStream.end();
		}
		const content = truncationResult.truncated ? truncationResult.content : fullOutput;
		return { output: collapseRepeatedLines(content), truncated: truncationResult.truncated };
	};

	try {
		const result = await operations.exec(command, cwd, {
			onData,
			signal: options?.signal,
		});

		const finalized = finalizeOutput();
		const cancelled = options?.signal?.aborted ?? false;

		return {
			output: finalized.output,
			exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
			cancelled,
			truncated: finalized.truncated,
			fullOutputPath: tempFilePath,
		};
	} catch (err) {
		// Check if it was an abort
		if (options?.signal?.aborted) {
			const finalized = finalizeOutput();
			return {
				output: finalized.output,
				exitCode: undefined,
				cancelled: true,
				truncated: finalized.truncated,
				fullOutputPath: tempFilePath,
			};
		}

		if (tempFileStream) {
			tempFileStream.end();
		}

		throw err;
	}
}
