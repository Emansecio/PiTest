/**
 * Small local helpers shared by the LSP and DAP modules. These replace the
 * `@oh-my-pi/pi-utils` primitives the upstream implementation relied on, keeping
 * both subsystems self-contained and dependency-light.
 */

import { accessSync, constants } from "node:fs";
import * as path from "node:path";

/** True when an error is a Node ENOENT (file/dir not found). */
export function isEnoent(err: unknown): boolean {
	return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/** True for plain object records (non-null, non-array objects). */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract a human-readable message from any thrown value. */
export function toErrorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

const WINDOWS_EXE_EXTS = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
	.split(";")
	.map((ext) => ext.trim().toLowerCase())
	.filter(Boolean);

function isExecutable(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Resolve a bare command name to an absolute path by scanning `$PATH`
 * (and `PATHEXT` on Windows). Mirrors `which`/`$which`. Absolute paths are
 * returned as-is when they exist. Returns null when nothing is found.
 */
export function which(command: string): string | null {
	if (!command) return null;
	if (path.isAbsolute(command) || command.includes(path.sep) || command.includes("/")) {
		return isExecutable(command) ? command : null;
	}

	const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const commandExt = path.extname(command).toLowerCase();
	const commandHasExeExt = commandExt !== "" && WINDOWS_EXE_EXTS.includes(commandExt);
	for (const dir of dirs) {
		const base = path.join(dir, command);
		if (process.platform === "win32") {
			// If the name already carries a known executable extension, use it as-is.
			// Otherwise prefer PATHEXT variants (e.g. the `.cmd` launcher) over the
			// extensionless Unix shell wrapper npm drops next to it — that wrapper
			// can't be spawned by Node and would otherwise shadow the real binary.
			if (commandHasExeExt) {
				if (isExecutable(base)) return base;
			} else {
				for (const ext of WINDOWS_EXE_EXTS) {
					const candidate = base + ext;
					if (isExecutable(candidate)) return candidate;
				}
				if (isExecutable(base)) return base;
			}
		} else if (isExecutable(base)) {
			return base;
		}
	}
	return null;
}

// Executable extensions Node cannot `spawn()` directly on Windows: since
// Node ≥ 20.12, spawning a `.cmd`/`.bat` with args throws `EINVAL`. They must
// go through a shell. Native binaries (`.exe`, `.com`) and POSIX spawn directly.
const WINDOWS_SHELL_REQUIRED_EXTS = [".cmd", ".bat"];

/** True when `command` is a Windows batch/cmd script that must run via a shell. */
export function needsWindowsShell(command: string): boolean {
	if (process.platform !== "win32") return false;
	return WINDOWS_SHELL_REQUIRED_EXTS.includes(path.extname(command).toLowerCase());
}

/**
 * Quote one command/arg for a Windows `cmd.exe` shell spawn. Node joins the argv
 * with spaces and wraps the whole line in `"…"` (windowsVerbatimArguments), so
 * any element containing whitespace or quotes must be quoted here or the shell
 * re-splits it — e.g. a `node_modules/.bin` path under `C:\Users\Jane Doe\…`.
 */
export function quoteWindowsShellArg(value: string): string {
	if (value.length > 0 && !/[\s"]/.test(value)) return value;
	return `"${value.replace(/"/g, '""')}"`;
}

// Re-export the shared sleep helper instead of keeping a local duplicate.
export { sleep } from "../../utils/sleep.ts";

/** Throw a uniform abort error when the signal has fired. */
export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) {
		const reason = signal.reason;
		if (reason instanceof Error) throw reason;
		throw new Error("aborted");
	}
}

/**
 * Race a promise (or promise-producing function) against an abort signal.
 * Rejects with an abort error if the signal fires first; otherwise
 * resolves/rejects with the source promise.
 */
export async function untilAborted<T>(
	signal: AbortSignal | undefined,
	source: Promise<T> | (() => Promise<T>),
): Promise<T> {
	const start = (): Promise<T> => (typeof source === "function" ? source() : source);
	if (!signal) return start();
	throwIfAborted(signal);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			const reason = signal.reason;
			reject(reason instanceof Error ? reason : new Error("aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		start().then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(err) => {
				signal.removeEventListener("abort", onAbort);
				reject(err);
			},
		);
	});
}

// =============================================================================
// Content-Length framing (shared by the LSP and DAP stdio transports)
// =============================================================================

/** Index of the first `\r\n\r\n` header terminator, or -1 if not present yet. */
function findHeaderEnd(buffer: Buffer): number {
	for (let i = 0; i < buffer.length - 3; i += 1) {
		if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
			return i;
		}
	}
	return -1;
}

// Caps that stop a misbehaving server from growing the frame buffer to OOM.
// A server dumping unframed text (banner/logs/REPL/stacktrace, or one that
// crashed into raw stdout) never closes a header, so the buffer would otherwise
// grow forever. Mirrors the stderr cap (MAX_STDERR_BYTES) on the framed path.
/** Max bytes to scan for a header terminator before declaring the stream unframed. */
const MAX_HEADER_SCAN_BYTES = 64 * 1024;
/** Max declared Content-Length to honour; larger is treated as garbage, not awaited. */
const MAX_FRAME_BYTES = 128 * 1024 * 1024;

/**
 * Parse a single `Content-Length`-framed JSON message from the head of `buffer`.
 * Returns the decoded JSON plus the unconsumed remainder, or null when a full
 * frame has not arrived yet. Bytes are sliced before UTF-8 decoding so the frame
 * boundary stays length-correct for multi-byte content.
 */
export type ContentLengthFrame = { json: unknown; remaining: Buffer } | { error: Error; remaining: Buffer };

export function parseContentLengthFrame(buffer: Buffer): ContentLengthFrame | null {
	const headerEndIndex = findHeaderEnd(buffer);
	if (headerEndIndex === -1) {
		// No header terminator yet. While the unframed run stays under the scan cap
		// we keep buffering for more bytes; past it the stream is unframed garbage —
		// discard everything so the buffer can't grow without bound (OOM guard).
		if (buffer.length > MAX_HEADER_SCAN_BYTES) {
			return { error: new Error("unframed output (no Content-Length header)"), remaining: Buffer.alloc(0) };
		}
		return null;
	}
	const headerText = buffer.subarray(0, headerEndIndex).toString("ascii");
	const messageStart = headerEndIndex + 4;
	const contentLengthMatch = headerText.match(/Content-Length: (\d+)/i);
	if (!contentLengthMatch) {
		// A completed header block with no Content-Length is unrecoverable: drop it
		// and resync past the terminator so one bad frame can't wedge the reader.
		return { error: new Error("missing Content-Length header"), remaining: buffer.subarray(messageStart) };
	}
	const contentLength = Number.parseInt(contentLengthMatch[1], 10);
	if (contentLength > MAX_FRAME_BYTES) {
		// Absurd declared length: reject now instead of waiting for the buffer to
		// fill to a multi-GB frame. Resync past the header so the reader continues.
		return { error: new Error(`frame too large (${contentLength} bytes)`), remaining: buffer.subarray(messageStart) };
	}
	const messageEnd = messageStart + contentLength;
	if (buffer.length < messageEnd) return null;
	const messageText = buffer.subarray(messageStart, messageEnd).toString("utf-8");
	const remaining = buffer.subarray(messageEnd);
	try {
		return { json: JSON.parse(messageText), remaining };
	} catch (err) {
		// Malformed JSON body: discard exactly this frame (header + declared length)
		// and advance, rather than re-parsing the same bytes forever and stalling.
		return { error: err instanceof Error ? err : new Error(String(err)), remaining };
	}
}

const DEBUG = process.env.PIT_DEBUG === "1" || process.env.PIT_LSP_DEBUG === "1";

/** Lightweight stderr logger, gated behind PIT_DEBUG / PIT_LSP_DEBUG. */
export const log = {
	warn(message: string, meta?: Record<string, unknown>): void {
		if (DEBUG) process.stderr.write(`[lsp] WARN ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}\n`);
	},
	error(message: string, meta?: Record<string, unknown>): void {
		if (DEBUG) process.stderr.write(`[lsp] ERROR ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}\n`);
	},
};
