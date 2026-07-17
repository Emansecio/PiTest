import { describe, expect, it, vi } from "vitest";
import {
	findChromeBinary,
	isOwnedEndpoint,
	launchChrome,
	parseDevToolsActivePort,
	readDevToolsActivePort,
	waitForEndpoint,
	waitForOwnedProfile,
} from "../src/core/chrome/chrome-launcher.js";

describe("findChromeBinary", () => {
	it("honors the PIT_CHROME_DEVTOOLS_BINARY override", () => {
		const found = findChromeBinary({
			env: { PIT_CHROME_DEVTOOLS_BINARY: "/custom/chrome" },
			platform: "linux",
			exists: (p) => p === "/custom/chrome",
		});
		expect(found).toBe("/custom/chrome");
	});

	it("falls back to the legacy PI_CHROME_DEVTOOLS_BINARY override", () => {
		const found = findChromeBinary({
			env: { PI_CHROME_DEVTOOLS_BINARY: "/legacy/chrome" },
			platform: "linux",
			exists: (p) => p === "/legacy/chrome",
		});
		expect(found).toBe("/legacy/chrome");
	});

	it("prefers PIT_CHROME_DEVTOOLS_BINARY over the legacy PI_ name", () => {
		const found = findChromeBinary({
			env: { PIT_CHROME_DEVTOOLS_BINARY: "/new/chrome", PI_CHROME_DEVTOOLS_BINARY: "/legacy/chrome" },
			platform: "linux",
			exists: (p) => p === "/new/chrome",
		});
		expect(found).toBe("/new/chrome");
	});

	it("finds Chrome on Windows under Program Files", () => {
		const target = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
		const found = findChromeBinary({
			env: { PROGRAMFILES: "C:\\Program Files" },
			platform: "win32",
			exists: (p) => p === target,
		});
		expect(found).toBe(target);
	});

	it("finds Chrome on macOS", () => {
		const target = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
		const found = findChromeBinary({ env: {}, platform: "darwin", exists: (p) => p === target });
		expect(found).toBe(target);
	});

	it("finds Chrome on Linux", () => {
		const found = findChromeBinary({ env: {}, platform: "linux", exists: (p) => p === "/usr/bin/google-chrome" });
		expect(found).toBe("/usr/bin/google-chrome");
	});

	it("returns undefined when nothing is found", () => {
		expect(findChromeBinary({ env: {}, platform: "linux", exists: () => false })).toBeUndefined();
	});
});

describe("launchChrome", () => {
	it("spawns the binary detached with the debug flags and returns the pid", () => {
		const child = { pid: 4321, unref: vi.fn(), on: vi.fn() };
		const spawnImpl = vi.fn().mockReturnValue(child);
		const mkdir = vi.fn();
		const pid = launchChrome({
			binary: "/bin/chrome",
			port: 0,
			userDataDir: "/data/chrome",
			spawnImpl: spawnImpl as any,
			mkdir,
		});
		expect(pid).toBe(4321);
		expect(mkdir).toHaveBeenCalledWith("/data/chrome");
		expect(child.unref).toHaveBeenCalled();
		// A spawn-error listener must be attached so a failed launch can't crash Pit
		// with an uncaughtException.
		expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
		const [bin, args, options] = spawnImpl.mock.calls[0]!;
		expect(bin).toBe("/bin/chrome");
		expect(args).toContain("--remote-debugging-port=0");
		expect(args).toContain("--user-data-dir=/data/chrome");
		expect(options).toMatchObject({ detached: true, stdio: "ignore" });
	});

	it("passes the background-throttling + window-size flags at launch", () => {
		const child = { pid: 1, unref: vi.fn(), on: vi.fn() };
		const spawnImpl = vi.fn().mockReturnValue(child);
		launchChrome({
			binary: "/bin/chrome",
			port: 0,
			userDataDir: "/data/chrome",
			spawnImpl: spawnImpl as any,
			mkdir: vi.fn(),
		});
		const args = spawnImpl.mock.calls[0]![1] as string[];
		expect(args).toContain("--disable-background-timer-throttling");
		expect(args).toContain("--disable-renderer-backgrounding");
		expect(args).toContain("--disable-backgrounding-occluded-windows");
		expect(args).toContain("--window-size=1280,800");
	});

	it("appends caller extraArgs last so they win", () => {
		const child = { pid: 1, unref: vi.fn(), on: vi.fn() };
		const spawnImpl = vi.fn().mockReturnValue(child);
		launchChrome({
			binary: "/bin/chrome",
			port: 0,
			userDataDir: "/data/chrome",
			extraArgs: ["--window-size=800,600", "--proxy-server=127.0.0.1:8080"],
			spawnImpl: spawnImpl as any,
			mkdir: vi.fn(),
		});
		const args = spawnImpl.mock.calls[0]![1] as string[];
		expect(args).toContain("--proxy-server=127.0.0.1:8080");
		// Caller's window-size comes after our default, so a later-wins parser honors it.
		expect(args.lastIndexOf("--window-size=800,600")).toBeGreaterThan(args.indexOf("--window-size=1280,800"));
	});
});

describe("DevToolsActivePort ownership", () => {
	it("parses port + browser path from the Chrome profile file", () => {
		expect(parseDevToolsActivePort("36638\n/devtools/browser/abc-123\n")).toEqual({
			port: 36638,
			browserPath: "/devtools/browser/abc-123",
		});
		expect(parseDevToolsActivePort("bogus\n/x")).toBeUndefined();
		expect(parseDevToolsActivePort("")).toBeUndefined();
	});

	it("reads DevToolsActivePort from the user-data-dir", () => {
		const readFile = vi.fn().mockReturnValue("9225\n/devtools/browser/owned\n");
		expect(readDevToolsActivePort("/profile", { readFile })).toEqual({
			port: 9225,
			browserPath: "/devtools/browser/owned",
		});
		expect(readFile).toHaveBeenCalledWith(expect.stringMatching(/DevToolsActivePort$/), "utf8");
		expect(
			readDevToolsActivePort("/missing", {
				readFile: () => {
					throw new Error("ENOENT");
				},
			}),
		).toBeUndefined();
	});

	it("isOwnedEndpoint requires the live /json/version WS path to match", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				webSocketDebuggerUrl: "ws://127.0.0.1:9225/devtools/browser/owned",
			}),
		});
		expect(await isOwnedEndpoint("127.0.0.1", 9225, "/devtools/browser/owned", { fetchImpl })).toBe(true);
		expect(await isOwnedEndpoint("127.0.0.1", 9225, "/devtools/browser/other", { fetchImpl })).toBe(false);
	});

	it("isOwnedEndpoint composes caller signal with a 2s timeout", async () => {
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				webSocketDebuggerUrl: "ws://127.0.0.1:9225/devtools/browser/owned",
			}),
		});
		const caller = new AbortController();
		await isOwnedEndpoint("127.0.0.1", 9225, "/devtools/browser/owned", {
			fetchImpl,
			signal: caller.signal,
		});
		const init = fetchImpl.mock.calls[0]?.[1] as { signal?: AbortSignal };
		expect(init?.signal).toBeDefined();
		expect(init!.signal!.aborted).toBe(false);
		caller.abort();
		expect(init!.signal!.aborted).toBe(true);
	});

	it("waitForOwnedProfile resolves once the file appears and the endpoint matches", async () => {
		let tick = 0;
		const readFile = vi.fn().mockImplementation(() => {
			tick += 1;
			if (tick < 2) throw new Error("ENOENT");
			return "9333\n/devtools/browser/live\n";
		});
		const fetchImpl = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/live",
			}),
		});
		const owned = await waitForOwnedProfile("127.0.0.1", "/profile", {
			readFile,
			fetchImpl,
			sleep: async () => {},
			timeoutMs: 1000,
			intervalMs: 10,
		});
		expect(owned).toEqual({ port: 9333, browserPath: "/devtools/browser/live" });
	});

	it("waitForOwnedProfile returns undefined immediately when the signal aborts", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		const owned = await waitForOwnedProfile("127.0.0.1", "/profile", {
			readFile: () => {
				throw new Error("ENOENT");
			},
			fetchImpl: vi.fn(),
			sleep: async () => {},
			timeoutMs: 10_000,
			intervalMs: 250,
			signal: ctrl.signal,
		});
		expect(owned).toBeUndefined();
	});
});

describe("waitForEndpoint", () => {
	const noSleep = () => Promise.resolve();

	it("resolves true once the endpoint responds", async () => {
		const fetchImpl = vi
			.fn()
			.mockRejectedValueOnce(new Error("down"))
			.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
		const ok = await waitForEndpoint("127.0.0.1", 9222, {
			fetchImpl,
			sleep: noSleep,
			timeoutMs: 1000,
			intervalMs: 10,
		});
		expect(ok).toBe(true);
		expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:9222/json/version", expect.anything());
	});

	it("resolves false after the timeout when never reachable", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("down"));
		const ok = await waitForEndpoint("h", 9222, { fetchImpl, sleep: noSleep, timeoutMs: 30, intervalMs: 10 });
		expect(ok).toBe(false);
	});
});
