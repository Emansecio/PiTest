/**
 * Unit coverage for LSP binary resolution helpers, TS-missing detection, and
 * the setCurrentLspManager overwrite diagnostic.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type LspConfig,
	missingTypescriptLsp,
	resolveCommand,
	resolvePackageBinCommand,
} from "../../src/core/lsp/config.ts";
import { createLspManager, getConfig, invalidateConfig, setCurrentLspManager } from "../../src/core/lsp/manager.ts";
import type { ServerConfig } from "../../src/core/lsp/types.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const c of cleanups.splice(0)) c();
	setCurrentLspManager(undefined);
	resetRuntimeDiagnostics();
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function touchExecutable(filePath: string): void {
	mkdirSync(join(filePath, ".."), { recursive: true });
	writeFileSync(filePath, "#!/bin/sh\n");
	if (process.platform === "win32") {
		writeFileSync(`${filePath}.cmd`, "@echo off\r\n");
	}
}

describe("resolveCommand / package bins", () => {
	it("finds a binary under a Pit package node_modules/.bin fixture", () => {
		const packageRoot = tempDir("pit-lsp-pkg-");
		const binName = "fake-pit-lsp-bin";
		touchExecutable(join(packageRoot, "node_modules", ".bin", binName));

		const cwd = tempDir("pit-lsp-cwd-");
		// No project-local bin — must come from packageRoots.
		const resolved = resolveCommand(binName, cwd, [packageRoot]);
		expect(resolved).toBeTruthy();
		expect(resolved!.replace(/\.cmd$/i, "").replace(/\\/g, "/")).toContain(
			`node_modules/.bin/${binName}`.replace(/\\/g, "/"),
		);
	});

	it("resolvePackageBinCommand returns null when missing", () => {
		const packageRoot = tempDir("pit-lsp-pkg-miss-");
		expect(resolvePackageBinCommand("definitely-not-installed-xyz", packageRoot)).toBeNull();
	});

	it("resolves Windows-style Python Scripts/ when present", () => {
		const cwd = tempDir("pit-lsp-py-");
		writeFileSync(join(cwd, "pyproject.toml"), "[project]\nname = 'x'\n");
		const scriptsDir = join(cwd, ".venv", "Scripts");
		mkdirSync(scriptsDir, { recursive: true });
		const binName = "pylsp-fake";
		const base = join(scriptsDir, binName);
		if (process.platform === "win32") {
			writeFileSync(`${base}.exe`, "");
		} else {
			// On Unix we still probe Scripts/ so the path is covered in CI.
			writeFileSync(base, "#!/bin/sh\n");
		}

		const resolved = resolveCommand(binName, cwd, []);
		expect(resolved).toBeTruthy();
		expect(resolved!.replace(/\\/g, "/")).toContain(".venv/Scripts/");
	});
});

describe("missingTypescriptLsp", () => {
	const tsCwd = (): string => {
		const cwd = tempDir("pit-lsp-ts-");
		writeFileSync(join(cwd, "package.json"), '{"name":"x"}\n');
		writeFileSync(join(cwd, "tsconfig.json"), "{}\n");
		return cwd;
	};

	it("is true when only a linter covers .ts", () => {
		const config: LspConfig = {
			servers: {
				biome: {
					command: "biome",
					fileTypes: [".ts", ".tsx", ".js"],
					rootMarkers: ["biome.json"],
					isLinter: true,
				} satisfies ServerConfig,
			},
		};
		expect(missingTypescriptLsp(config, tsCwd())).toBe(true);
	});

	it("is false when a non-linter TS server is present", () => {
		const config: LspConfig = {
			servers: {
				typescript: {
					command: "typescript-language-server",
					fileTypes: [".ts", ".tsx"],
					rootMarkers: ["package.json"],
				} satisfies ServerConfig,
			},
		};
		expect(missingTypescriptLsp(config, tsCwd())).toBe(false);
	});

	it("is false when cwd has no TS markers", () => {
		const cwd = tempDir("pit-lsp-nots-");
		const config: LspConfig = { servers: {} };
		expect(missingTypescriptLsp(config, cwd)).toBe(false);
	});
});

describe("setCurrentLspManager overwrite", () => {
	it("records lsp.manager-overwrite when replacing a live manager", () => {
		resetRuntimeDiagnostics();
		const a = createLspManager(tempDir("pit-lsp-mgr-a-"));
		const b = createLspManager(tempDir("pit-lsp-mgr-b-"));
		setCurrentLspManager(a);
		setCurrentLspManager(b);

		const snap = getRuntimeDiagnostics();
		const hit = snap.recent.find((e) => e.category === "lsp.manager-overwrite");
		expect(hit).toBeTruthy();
		expect(hit!.level).toBe("warn");
		expect(hit!.source).toBe("lsp.manager-overwrite");
	});

	it("does not record when clearing or setting the same manager", () => {
		resetRuntimeDiagnostics();
		const a = createLspManager(tempDir("pit-lsp-mgr-same-"));
		setCurrentLspManager(a);
		setCurrentLspManager(a);
		setCurrentLspManager(undefined);
		const snap = getRuntimeDiagnostics();
		expect(snap.recent.some((e) => e.category === "lsp.manager-overwrite")).toBe(false);
	});
});

describe("getConfig mtime invalidation", () => {
	it("reloads when an lsp.json source mtime changes", () => {
		const cwd = tempDir("pit-lsp-mtime-");
		writeFileSync(join(cwd, "package.json"), '{"name":"x"}\n');
		const cfgPath = join(cwd, "lsp.json");
		writeFileSync(cfgPath, JSON.stringify({ servers: {} }));

		invalidateConfig(cwd);
		const first = getConfig(cwd);
		const second = getConfig(cwd);
		expect(second).toBe(first);

		// Bump mtime (and content) so the cache must reload.
		writeFileSync(cfgPath, JSON.stringify({ idleTimeoutMs: 12_345, servers: {} }));
		const third = getConfig(cwd);
		expect(third).not.toBe(first);
		expect(third.idleTimeoutMs).toBe(12_345);
	});
});
