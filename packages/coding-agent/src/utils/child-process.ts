import {
	type ChildProcess,
	type ChildProcessByStdio,
	spawn as nodeSpawn,
	spawnSync as nodeSpawnSync,
	type SpawnOptions,
	type SpawnOptionsWithStdioTuple,
	type SpawnSyncOptionsWithStringEncoding,
	type SpawnSyncReturns,
	type StdioNull,
	type StdioPipe,
} from "node:child_process";
import type { Readable } from "node:stream";
import crossSpawn from "cross-spawn";

// Base grace after `exit` fires but stdout/stderr `end` has not yet arrived.
// Windows daemonized descendants can inherit the child's stdout/stderr pipe
// handles, so `close` may never fire even though the original process is gone.
// We wait this long for a final flush, then finalize. Historically a flat 100ms
// was paid on EVERY command — a tax on the common case (no detached descendant,
// nothing more to flush). Now the base is short (25ms) and is only EXTENDED
// toward the full window while output is still actively arriving (the exact
// daemon-flush signal), so a fast command finalizes in ~25ms while a trailing
// flush is never clipped. Override the base with PIT_EXIT_STDIO_GRACE_MS.
const EXIT_STDIO_BASE_GRACE_MS = 25;
// Absolute cap on the post-exit wait. The grace is extended (see above) only up
// to this ceiling, so a descendant that holds the pipe open forever without
// producing output can never hang finalize past it. Kept at the original 100ms
// (or the base, if that was raised above it via the env override).
const EXIT_STDIO_MAX_GRACE_MS = 100;

function resolveExitStdioBaseGraceMs(): number {
	const raw = process.env.PIT_EXIT_STDIO_GRACE_MS;
	if (raw === undefined || raw === "") return EXIT_STDIO_BASE_GRACE_MS;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : EXIT_STDIO_BASE_GRACE_MS;
}

export function spawnProcess(
	command: string,
	args: string[],
	options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess;
export function spawnProcess(command: string, args: string[], options: SpawnOptions): ChildProcess {
	return process.platform === "win32" ? crossSpawn(command, args, options) : nodeSpawn(command, args, options);
}

export function spawnProcessSync(
	command: string,
	args: string[],
	options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string> {
	return process.platform === "win32"
		? crossSpawn.sync(command, args, options)
		: nodeSpawnSync(command, args, options);
}

/**
 * Wait for a child process to terminate without hanging on inherited stdio handles.
 *
 * On Windows, daemonized descendants can inherit the child's stdout/stderr pipe
 * handles. In that case the child emits `exit`, but `close` can hang forever even
 * though the original process is already gone. We wait briefly for stdio to end,
 * then forcibly stop tracking the inherited handles.
 */
export function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;
		// Timestamp of the most recent stdout/stderr chunk, used to keep the
		// post-exit grace open only while a flush is actively arriving.
		let lastDataAt = 0;

		const cleanup = () => {
			if (postExitTimer) {
				clearTimeout(postExitTimer);
				postExitTimer = undefined;
			}
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
			child.stdout?.removeListener("data", onData);
			child.stderr?.removeListener("data", onData);
		};

		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};

		const maybeFinalizeAfterExit = () => {
			if (!exited || settled) return;
			if (stdoutEnded && stderrEnded) {
				finalize(exitCode);
			}
		};

		const onStdoutEnd = () => {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		};

		const onStderrEnd = () => {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		};

		// Passive observer of output chunks (does not consume — data events fan out
		// to every listener). Only records WHEN output last arrived so the grace can
		// tell "still flushing" from "quiet".
		const onData = () => {
			lastDataAt = Date.now();
		};

		// Adaptive post-exit grace. `exit` has fired but stdout/stderr `end` has not
		// (a descendant may still hold the pipe). Wait a short base window; if output
		// was still arriving when it elapses, extend in base-sized slices up to the
		// max cap. A quiet child finalizes after one base window (~25ms); a trailing
		// daemon flush keeps extending until it goes quiet or the cap is hit, so no
		// trailing bytes are clipped.
		const baseGraceMs = resolveExitStdioBaseGraceMs();
		const maxGraceMs = Math.max(baseGraceMs, EXIT_STDIO_MAX_GRACE_MS);
		let graceStartedAt = 0;
		const graceTick = () => {
			if (settled) return;
			const now = Date.now();
			// Cap reached, or no output during the last base window: give up waiting.
			if (now - graceStartedAt >= maxGraceMs || now - lastDataAt >= baseGraceMs) {
				finalize(exitCode);
				return;
			}
			// Output arrived recently — wait out the remainder of its base window,
			// bounded so we never overshoot the max cap.
			const nextDelay = Math.min(baseGraceMs - (now - lastDataAt), maxGraceMs - (now - graceStartedAt));
			postExitTimer = setTimeout(graceTick, Math.max(nextDelay, 0));
		};

		const onError = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const onExit = (code: number | null) => {
			exited = true;
			exitCode = code;
			maybeFinalizeAfterExit();
			if (!settled) {
				graceStartedAt = Date.now();
				postExitTimer = setTimeout(graceTick, baseGraceMs);
			}
		};

		const onClose = (code: number | null) => {
			finalize(code);
		};

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}
