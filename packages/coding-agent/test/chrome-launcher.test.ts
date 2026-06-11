import { describe, expect, it, vi } from "vitest";
import { findChromeBinary, launchChrome, waitForEndpoint } from "../src/core/chrome/chrome-launcher.js";

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
		const child = { pid: 4321, unref: vi.fn() };
		const spawnImpl = vi.fn().mockReturnValue(child);
		const mkdir = vi.fn();
		const pid = launchChrome({
			binary: "/bin/chrome",
			port: 9222,
			userDataDir: "/data/chrome",
			spawnImpl: spawnImpl as any,
			mkdir,
		});
		expect(pid).toBe(4321);
		expect(mkdir).toHaveBeenCalledWith("/data/chrome");
		expect(child.unref).toHaveBeenCalled();
		const [bin, args, options] = spawnImpl.mock.calls[0]!;
		expect(bin).toBe("/bin/chrome");
		expect(args).toContain("--remote-debugging-port=9222");
		expect(args).toContain("--user-data-dir=/data/chrome");
		expect(options).toMatchObject({ detached: true, stdio: "ignore" });
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
