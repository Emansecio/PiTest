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
	for (const dir of dirs) {
		const base = path.join(dir, command);
		if (process.platform === "win32") {
			// Bare name may already include an extension; try as-is first.
			if (isExecutable(base)) return base;
			for (const ext of WINDOWS_EXE_EXTS) {
				const candidate = base + ext;
				if (isExecutable(candidate)) return candidate;
			}
		} else if (isExecutable(base)) {
			return base;
		}
	}
	return null;
}

/** Sleep for `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/**
 * Parse a single `Content-Length`-framed JSON message from the head of `buffer`.
 * Returns the decoded JSON plus the unconsumed remainder, or null when a full
 * frame has not arrived yet. Bytes are sliced before UTF-8 decoding so the frame
 * boundary stays length-correct for multi-byte content.
 */
export function parseContentLengthFrame(buffer: Buffer): { json: unknown; remaining: Buffer } | null {
	const headerEndIndex = findHeaderEnd(buffer);
	if (headerEndIndex === -1) return null;
	const headerText = buffer.subarray(0, headerEndIndex).toString("ascii");
	const contentLengthMatch = headerText.match(/Content-Length: (\d+)/i);
	if (!contentLengthMatch) return null;
	const contentLength = Number.parseInt(contentLengthMatch[1], 10);
	const messageStart = headerEndIndex + 4;
	const messageEnd = messageStart + contentLength;
	if (buffer.length < messageEnd) return null;
	const messageText = buffer.subarray(messageStart, messageEnd).toString("utf-8");
	return { json: JSON.parse(messageText), remaining: buffer.subarray(messageEnd) };
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
