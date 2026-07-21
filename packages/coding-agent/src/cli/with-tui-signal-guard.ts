/**
 * Signal/crash guard for pre-interactive TUI surfaces (the --resume session
 * picker, `pit config`, the missing-cwd prompt). These run the terminal in raw
 * mode (cursor hidden, Kitty/bracketed-paste/modifyOtherKeys enabled) via
 * ui.start() BEFORE InteractiveMode exists, so none of InteractiveMode's own
 * signal/crash handlers are installed yet. Without this guard an external
 * SIGINT/SIGTERM/SIGHUP, an uncaught throw, or an unhandled rejection would
 * terminate the process with the terminal left broken until `reset`/`stty sane`.
 *
 * Handlers are prepended (so they run before any default) for the duration of
 * `run()` and ALL removed in the finally, restoring the process listener set to
 * its baseline. ui.stop() is idempotent, so a double call (selector already
 * settled + a racing signal) is safe.
 *
 * Unhandled rejections restore the terminal AND reject the guarded promise so
 * `run()` cannot hang forever after raw mode is already torn down (stdin paused).
 */
export async function withTuiSignalGuard<T>(ui: { stop(): void }, run: () => Promise<T>): Promise<T> {
	const restore = () => {
		try {
			ui.stop();
		} catch {
			// half-dead terminal — nothing else we can do
		}
	};
	const onSignal = (sig: NodeJS.Signals) => () => {
		restore();
		process.exit(sig === "SIGINT" ? 130 : 143);
	};
	const handlers: Array<[string, (...args: any[]) => void]> = [];
	const add = (ev: string, fn: (...args: any[]) => void) => {
		process.prependListener(ev as any, fn);
		handlers.push([ev, fn]);
	};

	let rejectGuard: ((err: Error) => void) | undefined;
	const guardAbort = new Promise<never>((_resolve, reject) => {
		rejectGuard = reject;
	});

	add("SIGINT", onSignal("SIGINT"));
	add("SIGTERM", onSignal("SIGTERM"));
	if (process.platform !== "win32") add("SIGHUP", onSignal("SIGHUP"));
	add("uncaughtException", (error: Error) => {
		restore();
		throw error;
	});
	add("unhandledRejection", (reason: unknown) => {
		restore();
		const err =
			reason instanceof Error
				? reason
				: new Error(`unhandledRejection: ${reason === undefined ? "undefined" : String(reason)}`);
		rejectGuard?.(err);
	});
	try {
		return await Promise.race([run(), guardAbort]);
	} finally {
		for (const [ev, fn] of handlers) process.off(ev as any, fn);
	}
}
