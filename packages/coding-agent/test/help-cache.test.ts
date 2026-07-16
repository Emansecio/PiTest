import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.js";
import type { ExtensionFlag } from "../src/core/extensions/types.js";
import { readCachedExtensionFlags, writeExtensionFlagsCache } from "../src/core/help-cache.js";

describe("help cache", () => {
	const NO_CACHE_ENV = "PIT_NO_HELP_CACHE";
	let originalNoCache: string | undefined;
	let root: string;
	let agentDir: string;
	let cwd: string;
	let extensionPath: string;

	const flags: ExtensionFlag[] = [
		{ name: "plan", type: "boolean", description: "Enable plan mode", extensionPath: "" },
		{ name: "ssh", type: "string", extensionPath: "" },
	];

	beforeEach(() => {
		originalNoCache = process.env[NO_CACHE_ENV];
		delete process.env[NO_CACHE_ENV];
		root = mkdtempSync(join(tmpdir(), "pit-help-cache-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		extensionPath = join(root, "my-extension.ts");
		writeFileSync(extensionPath, "export default {};\n", "utf8");
		for (const flag of flags) {
			flag.extensionPath = extensionPath;
		}
	});

	afterEach(() => {
		if (originalNoCache === undefined) {
			delete process.env[NO_CACHE_ENV];
		} else {
			process.env[NO_CACHE_ENV] = originalNoCache;
		}
		rmSync(root, { recursive: true, force: true });
	});

	function write(overrides: Partial<Parameters<typeof writeExtensionFlagsCache>[0]> = {}): void {
		writeExtensionFlagsCache({
			cwd,
			agentDir,
			extensionPaths: [extensionPath],
			flags,
			...overrides,
		});
	}

	it("round-trips flags for the same cwd while sources are unchanged", () => {
		write();
		expect(readCachedExtensionFlags(cwd, agentDir)).toEqual(flags);
	});

	it("misses for a different cwd", () => {
		write();
		expect(readCachedExtensionFlags(join(root, "other"), agentDir)).toBeUndefined();
	});

	it("misses when an extension entry file's content changes", () => {
		write();
		writeFileSync(extensionPath, "export default { changed: true };\n", "utf8");
		expect(readCachedExtensionFlags(cwd, agentDir)).toBeUndefined();
	});

	it("still hits when a file is rewritten with identical content (mtime bump only)", () => {
		write();
		// Pit rewrites the global settings.json on every boot; an mtime-only
		// change with unchanged bytes must not invalidate the help cache.
		const later = Date.now() / 1000 + 10;
		utimesSync(extensionPath, later, later);
		expect(readCachedExtensionFlags(cwd, agentDir)).toEqual(flags);
	});

	it("misses when a watched-but-absent source appears (project settings.json)", () => {
		write();
		expect(readCachedExtensionFlags(cwd, agentDir)).toEqual(flags);
		mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
		writeFileSync(join(cwd, CONFIG_DIR_NAME, "settings.json"), "{}\n", "utf8");
		expect(readCachedExtensionFlags(cwd, agentDir)).toBeUndefined();
	});

	it("misses when the global settings.json content changes", () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, "{}\n", "utf8");
		write();
		expect(readCachedExtensionFlags(cwd, agentDir)).toEqual(flags);
		writeFileSync(settingsPath, '{"packages":["npm:new-ext"]}\n', "utf8");
		expect(readCachedExtensionFlags(cwd, agentDir)).toBeUndefined();
	});

	it("skips synthetic extension paths without failing", () => {
		write({ extensionPaths: [extensionPath, "<factory:built-in>"] });
		expect(readCachedExtensionFlags(cwd, agentDir)).toEqual(flags);
	});

	it("keeps entries for multiple cwds", () => {
		const otherCwd = join(root, "project-b");
		mkdirSync(otherCwd, { recursive: true });
		write();
		write({ cwd: otherCwd, flags: [flags[0]] });
		expect(readCachedExtensionFlags(cwd, agentDir)).toEqual(flags);
		expect(readCachedExtensionFlags(otherCwd, agentDir)).toEqual([flags[0]]);
	});

	it("treats a corrupt cache file as a miss", () => {
		writeFileSync(join(agentDir, "help-cache.json"), "{not json", "utf8");
		expect(readCachedExtensionFlags(cwd, agentDir)).toBeUndefined();
		// And write recovers from the corrupt state.
		write();
		expect(readCachedExtensionFlags(cwd, agentDir)).toEqual(flags);
	});

	it("PIT_NO_HELP_CACHE=1 disables both read and write", () => {
		process.env[NO_CACHE_ENV] = "1";
		write();
		expect(existsSync(join(agentDir, "help-cache.json"))).toBe(false);
		delete process.env[NO_CACHE_ENV];
		write();
		process.env[NO_CACHE_ENV] = "1";
		expect(readCachedExtensionFlags(cwd, agentDir)).toBeUndefined();
	});
});
