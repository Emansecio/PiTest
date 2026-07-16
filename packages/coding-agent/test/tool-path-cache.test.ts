import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { readCachedSystemCommand, writeCachedSystemCommand } from "../src/utils/tools-manager.js";

const NO_CACHE_ENV = "PIT_NO_TOOL_PATH_CACHE";

describe("tool path cache", () => {
	let root: string;
	let agentDir: string;
	let binaryPath: string;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		savedEnv = {
			[ENV_AGENT_DIR]: process.env[ENV_AGENT_DIR],
			[NO_CACHE_ENV]: process.env[NO_CACHE_ENV],
			PATH: process.env.PATH,
		};
		delete process.env[NO_CACHE_ENV];
		root = mkdtempSync(join(tmpdir(), "pit-tool-path-cache-"));
		agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		process.env[ENV_AGENT_DIR] = agentDir;
		binaryPath = join(root, "fd.exe");
		writeFileSync(binaryPath, "fake-binary", "utf8");
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		rmSync(root, { recursive: true, force: true });
	});

	it("round-trips a command while the binary and PATH are unchanged", () => {
		writeCachedSystemCommand("fd", binaryPath);
		expect(readCachedSystemCommand("fd")).toBe("fd");
	});

	it("misses for a command that was never recorded", () => {
		writeCachedSystemCommand("fd", binaryPath);
		expect(readCachedSystemCommand("rg")).toBeNull();
	});

	it("misses when the recorded binary changes (mtime bump)", () => {
		writeCachedSystemCommand("fd", binaryPath);
		const future = new Date(Date.now() + 60_000);
		utimesSync(binaryPath, future, future);
		expect(readCachedSystemCommand("fd")).toBeNull();
	});

	it("misses when the recorded binary disappears", () => {
		writeCachedSystemCommand("fd", binaryPath);
		rmSync(binaryPath);
		expect(readCachedSystemCommand("fd")).toBeNull();
	});

	it("misses when PATH changes (a different install could shadow)", () => {
		writeCachedSystemCommand("fd", binaryPath);
		expect(readCachedSystemCommand("fd")).toBe("fd");
		process.env.PATH = `${root};${process.env.PATH ?? ""}`;
		expect(readCachedSystemCommand("fd")).toBeNull();
	});

	it("keeps entries for multiple commands", () => {
		const rgPath = join(root, "rg.exe");
		writeFileSync(rgPath, "fake-rg", "utf8");
		writeCachedSystemCommand("fd", binaryPath);
		writeCachedSystemCommand("rg", rgPath);
		expect(readCachedSystemCommand("fd")).toBe("fd");
		expect(readCachedSystemCommand("rg")).toBe("rg");
	});

	it("PIT_NO_TOOL_PATH_CACHE=1 disables both read and write", () => {
		process.env[NO_CACHE_ENV] = "1";
		writeCachedSystemCommand("fd", binaryPath);
		expect(existsSync(join(agentDir, "tool-path-cache.json"))).toBe(false);
		delete process.env[NO_CACHE_ENV];
		writeCachedSystemCommand("fd", binaryPath);
		process.env[NO_CACHE_ENV] = "1";
		expect(readCachedSystemCommand("fd")).toBeNull();
	});

	it("treats a corrupt cache file as a miss and recovers on write", () => {
		writeFileSync(join(agentDir, "tool-path-cache.json"), "{not json", "utf8");
		expect(readCachedSystemCommand("fd")).toBeNull();
		writeCachedSystemCommand("fd", binaryPath);
		expect(readCachedSystemCommand("fd")).toBe("fd");
	});
});
