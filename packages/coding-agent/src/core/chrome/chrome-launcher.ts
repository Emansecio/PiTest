/**
 * Auto-launch helpers for Chrome with the DevTools debug port — no external
 * deps. Discovery uses platform-known paths (+ PIT_CHROME_DEVTOOLS_BINARY
 * override, legacy PI_CHROME_DEVTOOLS_BINARY still honored for one release);
 * launch spawns Chrome detached so it survives the Pit process
 * (the user opted to leave the browser open); readiness is a poll of
 * `/json/version`. Ownership of an auto-launched browser is proven via the
 * profile's `DevToolsActivePort` file (Chrome only writes it for ephemeral
 * `--remote-debugging-port=0`), never by "something answered on 9222".
 * Everything is injectable for tests.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchLike } from "./cdp-client.ts";

const defaultFetch: FetchLike = (input, init) => fetch(input, init) as unknown as ReturnType<FetchLike>;

export interface FindChromeOptions {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
	exists?: (path: string) => boolean;
}

function candidatePaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
	if (platform === "win32") {
		const bases = [
			env.PROGRAMFILES ?? "C:\\Program Files",
			env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
			env.LOCALAPPDATA ?? "",
		].filter(Boolean);
		const paths: string[] = [];
		for (const base of bases) {
			paths.push(join(base, "Google\\Chrome\\Application\\chrome.exe"));
		}
		// Edge (Chromium) as a fallback — same CDP.
		for (const base of bases) {
			paths.push(join(base, "Microsoft\\Edge\\Application\\msedge.exe"));
		}
		return paths;
	}
	if (platform === "darwin") {
		return [
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		];
	}
	// linux + others
	return [
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/snap/bin/chromium",
		"/usr/bin/microsoft-edge",
	];
}

/** Locate a Chrome/Chromium/Edge binary, or undefined if none is found. */
export function findChromeBinary(opts: FindChromeOptions = {}): string | undefined {
	const env = opts.env ?? process.env;
	const platform = opts.platform ?? process.platform;
	const exists = opts.exists ?? existsSync;

	// PIT_* is the canonical prefix; the legacy PI_* name is read as a fallback.
	const override = env.PIT_CHROME_DEVTOOLS_BINARY || env.PI_CHROME_DEVTOOLS_BINARY;
	if (override) return exists(override) ? override : undefined;

	for (const candidate of candidatePaths(platform, env)) {
		if (candidate && exists(candidate)) return candidate;
	}
	return undefined;
}

export interface LaunchChromeOptions {
	binary: string;
	/**
	 * Remote-debugging port. Use `0` when auto-launching so Chrome picks an
	 * ephemeral port and writes `DevToolsActivePort` into `userDataDir` (the
	 * ownership fingerprint). A fixed port does not write that file on modern
	 * Chrome and must not be treated as "ours" just because it answers.
	 */
	port: number;
	userDataDir: string;
	/** Extra Chrome flags appended after our defaults (caller args win last). */
	extraArgs?: string[];
	spawnImpl?: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;
	mkdir?: (dir: string) => void;
}

/** Spawn Chrome detached with the debug port + a dedicated profile. Returns the pid. */
export function launchChrome(opts: LaunchChromeOptions): number | undefined {
	const mkdir = opts.mkdir ?? ((dir: string) => void mkdirSync(dir, { recursive: true }));
	mkdir(opts.userDataDir);
	const args = [
		`--remote-debugging-port=${opts.port}`,
		`--user-data-dir=${opts.userDataDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		// Background-tab rAF throttling silently stalls the double-rAF input-ready
		// gate (see ChromeDevtoolsManager.ensureInputReady) and delays synthetic
		// input on any tab that isn't foregrounded. These three flags remove that
		// failure mode at the source for browsers WE launch; ensureInputReady stays
		// as defense-in-depth for attach-mode Chromes started without them.
		"--disable-background-timer-throttling",
		"--disable-renderer-backgrounding",
		"--disable-backgrounding-occluded-windows",
		// Deterministic default viewport so screenshots / layout are reproducible.
		"--window-size=1280,800",
		// Caller-supplied extra args win last (append/override our defaults).
		...(opts.extraArgs ?? []),
	];
	const spawnImpl = opts.spawnImpl ?? ((c, a, o) => spawn(c, a, o));
	const child = spawnImpl(opts.binary, args, { detached: true, stdio: "ignore", windowsHide: false });
	// A detached child with no 'error' listener turns a spawn failure (binary
	// present but not executable, EACCES/ENOEXEC) into an uncaughtException that
	// would kill Pit. Swallow it — the failure surfaces later via the missing
	// DevTools endpoint (waitForEndpoint times out).
	child.on("error", () => {});
	// Detach from the Pit process so Chrome keeps running after Pit exits.
	child.unref?.();
	return child.pid ?? undefined;
}

export interface WaitForEndpointOptions {
	timeoutMs?: number;
	intervalMs?: number;
	fetchImpl?: FetchLike;
	sleep?: (ms: number) => Promise<void>;
	/** When aborted, polling stops immediately (Esc / verification cancel). */
	signal?: AbortSignal;
}

function sleepAbortable(ms: number, sleep: (ms: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
	if (!signal) return sleep(ms);
	if (signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		void sleep(ms).then(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		});
	});
}

/** Poll the DevTools HTTP endpoint until it responds, or until timeout. */
export async function waitForEndpoint(host: string, port: number, opts: WaitForEndpointOptions = {}): Promise<boolean> {
	const timeoutMs = opts.timeoutMs ?? 15_000;
	const intervalMs = opts.intervalMs ?? 250;
	const fetchImpl = opts.fetchImpl ?? defaultFetch;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));

	for (let i = 0; i < attempts; i++) {
		if (opts.signal?.aborted) return false;
		try {
			const res = await fetchImpl(`http://${host}:${port}/json/version`, {
				signal: opts.signal
					? AbortSignal.any([opts.signal, AbortSignal.timeout(intervalMs)])
					: AbortSignal.timeout(intervalMs),
			});
			if (res.ok) return true;
		} catch {
			// not up yet / aborted
		}
		if (opts.signal?.aborted) return false;
		await sleepAbortable(intervalMs, sleep, opts.signal);
	}
	return false;
}

// ---------------------------------------------------------------------------
// Profile ownership (DevToolsActivePort)
// ---------------------------------------------------------------------------

/** Port + browser-level WS path Chrome writes into the profile for automation. */
export interface DevToolsActivePort {
	port: number;
	/** e.g. `/devtools/browser/<guid>` — must match `/json/version`'s WS URL. */
	browserPath: string;
}

const DEVTOOLS_ACTIVE_PORT_FILE = "DevToolsActivePort";

/** Parse the two-line `DevToolsActivePort` file contents. */
export function parseDevToolsActivePort(content: string): DevToolsActivePort | undefined {
	const lines = content
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length < 2) return undefined;
	const port = Number(lines[0]);
	const browserPath = lines[1]!;
	if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
	if (!browserPath.startsWith("/")) return undefined;
	return { port, browserPath };
}

export interface ReadDevToolsActivePortOptions {
	readFile?: (path: string, encoding: "utf8") => string;
}

/** Read + parse `userDataDir/DevToolsActivePort`, or undefined if missing/invalid. */
export function readDevToolsActivePort(
	userDataDir: string,
	opts: ReadDevToolsActivePortOptions = {},
): DevToolsActivePort | undefined {
	if (!userDataDir) return undefined;
	const readFile = opts.readFile ?? ((p, enc) => readFileSync(p, enc));
	try {
		return parseDevToolsActivePort(readFile(join(userDataDir, DEVTOOLS_ACTIVE_PORT_FILE), "utf8"));
	} catch {
		return undefined;
	}
}

export interface OwnedEndpointOptions {
	fetchImpl?: FetchLike;
	signal?: AbortSignal;
}

/**
 * True when `host:port` is live AND `/json/version`'s browser WS path matches
 * the path from our profile's `DevToolsActivePort`. A foreign Chrome that
 * reused the port fails the path check (different browser GUID).
 */
export async function isOwnedEndpoint(
	host: string,
	port: number,
	browserPath: string,
	opts: OwnedEndpointOptions = {},
): Promise<boolean> {
	const fetchImpl = opts.fetchImpl ?? defaultFetch;
	try {
		const timeout = AbortSignal.timeout(2_000);
		const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
		const res = await fetchImpl(`http://${host}:${port}/json/version`, { signal });
		if (!res.ok) return false;
		const data = (await res.json()) as { webSocketDebuggerUrl?: unknown };
		const ws = data?.webSocketDebuggerUrl;
		if (typeof ws !== "string" || !ws) return false;
		// Match path suffix so host/port formatting in the URL cannot false-negative.
		try {
			const pathname = new URL(ws).pathname;
			return pathname === browserPath || pathname.endsWith(browserPath);
		} catch {
			return ws.endsWith(browserPath);
		}
	} catch {
		return false;
	}
}

export interface WaitForOwnedProfileOptions extends WaitForEndpointOptions {
	readFile?: (path: string, encoding: "utf8") => string;
}

/**
 * After launching with `--remote-debugging-port=0`, poll until the profile's
 * `DevToolsActivePort` appears and the endpoint's browser WS path matches.
 */
export async function waitForOwnedProfile(
	host: string,
	userDataDir: string,
	opts: WaitForOwnedProfileOptions = {},
): Promise<DevToolsActivePort | undefined> {
	const timeoutMs = opts.timeoutMs ?? 15_000;
	const intervalMs = opts.intervalMs ?? 250;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));

	for (let i = 0; i < attempts; i++) {
		if (opts.signal?.aborted) return undefined;
		const active = readDevToolsActivePort(userDataDir, { readFile: opts.readFile });
		if (
			active &&
			(await isOwnedEndpoint(host, active.port, active.browserPath, {
				fetchImpl: opts.fetchImpl,
				signal: opts.signal,
			}))
		) {
			return active;
		}
		if (opts.signal?.aborted) return undefined;
		await sleepAbortable(intervalMs, sleep, opts.signal);
	}
	return undefined;
}
