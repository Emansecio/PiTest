/**
 * Auto-launch helpers for Chrome with the DevTools debug port — no external
 * deps. Discovery uses platform-known paths (+ PIT_CHROME_DEVTOOLS_BINARY
 * override, legacy PI_CHROME_DEVTOOLS_BINARY still honored for one release);
 * launch spawns Chrome detached so it survives the Pit process
 * (the user opted to leave the browser open); readiness is a poll of
 * `/json/version`. Everything is injectable for tests.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
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
	port: number;
	userDataDir: string;
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
	];
	const spawnImpl = opts.spawnImpl ?? ((c, a, o) => spawn(c, a, o));
	const child = spawnImpl(opts.binary, args, { detached: true, stdio: "ignore", windowsHide: false });
	// Detach from the Pit process so Chrome keeps running after Pit exits.
	child.unref?.();
	return child.pid ?? undefined;
}

export interface WaitForEndpointOptions {
	timeoutMs?: number;
	intervalMs?: number;
	fetchImpl?: FetchLike;
	sleep?: (ms: number) => Promise<void>;
}

/** Poll the DevTools HTTP endpoint until it responds, or until timeout. */
export async function waitForEndpoint(host: string, port: number, opts: WaitForEndpointOptions = {}): Promise<boolean> {
	const timeoutMs = opts.timeoutMs ?? 15_000;
	const intervalMs = opts.intervalMs ?? 250;
	const fetchImpl = opts.fetchImpl ?? defaultFetch;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));

	for (let i = 0; i < attempts; i++) {
		try {
			const res = await fetchImpl(`http://${host}:${port}/json/version`, {});
			if (res.ok) return true;
		} catch {
			// not up yet
		}
		await sleep(intervalMs);
	}
	return false;
}
