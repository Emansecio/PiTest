import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultPackageManager, type ResolvedPaths } from "../src/core/package-manager.js";
import {
	computeSettingsSignature,
	type ResolveCacheKey,
	readResolveCache,
	writeResolveCache,
} from "../src/core/resolve-cache.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const NO_CACHE_ENV = "PIT_NO_RESOLVE_CACHE";

function makeResult(skillPath: string): ResolvedPaths {
	return {
		extensions: [],
		skills: [
			{
				path: skillPath,
				enabled: true,
				metadata: { source: "auto", scope: "user", origin: "top-level" },
			},
		],
		prompts: [],
		themes: [],
	};
}

/** Bump a path's mtime far into the future so strict stamps definitely move. */
function touchFuture(path: string): void {
	const future = new Date(Date.now() + 60_000);
	utimesSync(path, future, future);
}

describe("resolve cache (unit)", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;
	let skillsDir: string;
	let key: ResolveCacheKey;
	let result: ResolvedPaths;
	let originalNoCache: string | undefined;

	beforeEach(() => {
		originalNoCache = process.env[NO_CACHE_ENV];
		delete process.env[NO_CACHE_ENV];
		root = mkdtempSync(join(tmpdir(), "pit-resolve-cache-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		skillsDir = join(agentDir, "skills", "my-skill");
		mkdirSync(skillsDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(skillsDir, "SKILL.md"), "---\nname: my-skill\ndescription: d\n---\n", "utf8");
		key = {
			agentDir,
			cwd,
			homeDir: join(root, "home"),
			settingsSignature: computeSettingsSignature({ packages: [] }, {}),
		};
		result = makeResult(join(skillsDir, "SKILL.md"));
	});

	afterEach(() => {
		if (originalNoCache === undefined) {
			delete process.env[NO_CACHE_ENV];
		} else {
			process.env[NO_CACHE_ENV] = originalNoCache;
		}
		rmSync(root, { recursive: true, force: true });
	});

	function write(): void {
		writeResolveCache({
			key,
			watch: { treeRoots: [join(agentDir, "skills")], existencePaths: [] },
			result,
		});
	}

	it("round-trips the result while inputs are unchanged", async () => {
		write();
		await expect(readResolveCache(key)).resolves.toEqual(result);
	});

	it("misses when the settings signature changes", async () => {
		write();
		const changedKey = {
			...key,
			settingsSignature: computeSettingsSignature({ packages: ["npm:x"] }, {}),
		};
		await expect(readResolveCache(changedKey)).resolves.toBeUndefined();
	});

	it("misses for a different cwd or home", async () => {
		write();
		await expect(readResolveCache({ ...key, cwd: join(root, "other") })).resolves.toBeUndefined();
		await expect(readResolveCache({ ...key, homeDir: join(root, "other-home") })).resolves.toBeUndefined();
	});

	it("misses when a file is added anywhere in a watched tree", async () => {
		write();
		await expect(readResolveCache(key)).resolves.toEqual(result);
		writeFileSync(join(skillsDir, "reference.md"), "extra", "utf8");
		await expect(readResolveCache(key)).resolves.toBeUndefined();
	});

	it("misses when a new subdirectory (deep skill) appears", async () => {
		write();
		mkdirSync(join(agentDir, "skills", "another-skill"), { recursive: true });
		await expect(readResolveCache(key)).resolves.toBeUndefined();
	});

	it("misses when a watched ts/js entry file is touched (mtime-sensitive resolve)", async () => {
		const extDir = join(agentDir, "extensions", "my-ext");
		mkdirSync(extDir, { recursive: true });
		const entry = join(extDir, "index.ts");
		writeFileSync(entry, "export default {};\n", "utf8");
		writeResolveCache({
			key,
			watch: { treeRoots: [join(agentDir, "extensions")], existencePaths: [] },
			result,
		});
		await expect(readResolveCache(key)).resolves.toEqual(result);
		// Same bytes, newer mtime: preferJsSibling decisions depend on mtime, so
		// this MUST invalidate (no content-hash forgiveness for ts/js stamps).
		touchFuture(entry);
		await expect(readResolveCache(key)).resolves.toBeUndefined();
	});

	it("existence-only stamps ignore mtime churn but catch removal", async () => {
		const gitDir = join(cwd, ".git");
		mkdirSync(gitDir, { recursive: true });
		writeResolveCache({
			key,
			watch: { treeRoots: [join(agentDir, "skills")], existencePaths: [gitDir] },
			result,
		});
		// mtime churn on .git (every git op) must NOT invalidate...
		writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
		await expect(readResolveCache(key)).resolves.toEqual(result);
		// ...but its disappearance must.
		rmSync(gitDir, { recursive: true, force: true });
		await expect(readResolveCache(key)).resolves.toBeUndefined();
	});

	it("a watched-but-missing root appearing invalidates", async () => {
		const missingDir = join(cwd, ".pit", "skills");
		writeResolveCache({
			key,
			watch: { treeRoots: [join(agentDir, "skills"), missingDir], existencePaths: [] },
			result,
		});
		await expect(readResolveCache(key)).resolves.toEqual(result);
		mkdirSync(missingDir, { recursive: true });
		await expect(readResolveCache(key)).resolves.toBeUndefined();
	});

	it("PIT_NO_RESOLVE_CACHE=1 disables both read and write", async () => {
		process.env[NO_CACHE_ENV] = "1";
		write();
		expect(existsSync(join(agentDir, "resolve-cache.json"))).toBe(false);
		delete process.env[NO_CACHE_ENV];
		write();
		process.env[NO_CACHE_ENV] = "1";
		await expect(readResolveCache(key)).resolves.toBeUndefined();
	});

	it("treats a corrupt cache file as a miss and recovers on write", async () => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "resolve-cache.json"), "{not json", "utf8");
		await expect(readResolveCache(key)).resolves.toBeUndefined();
		write();
		await expect(readResolveCache(key)).resolves.toEqual(result);
	});
});

describe("resolve cache (through DefaultPackageManager.resolve)", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;
	let originalNoCache: string | undefined;

	beforeEach(() => {
		originalNoCache = process.env[NO_CACHE_ENV];
		delete process.env[NO_CACHE_ENV];
		tempDir = join(tmpdir(), `pit-resolve-cache-pm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		// Bound the ancestor .agents walk at tempDir (same pattern as the
		// package-manager suite).
		mkdirSync(join(tempDir, ".git"), { recursive: true });
		agentDir = join(tempDir, "agent");
		mkdirSync(join(agentDir, "skills", "alpha"), { recursive: true });
		writeFileSync(join(agentDir, "skills", "alpha", "SKILL.md"), "---\ndescription: a\n---\n", "utf8");

		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
	});

	afterEach(() => {
		if (originalNoCache === undefined) {
			delete process.env[NO_CACHE_ENV];
		} else {
			process.env[NO_CACHE_ENV] = originalNoCache;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("serves the cached result on a second resolve (observable via cache tamper)", async () => {
		const first = await packageManager.resolve();
		expect(first.skills.some((s) => s.path.endsWith("SKILL.md"))).toBe(true);

		// Prove the second resolve() consumes the disk cache: plant a sentinel in
		// the cached result and watch it come back.
		const cachePath = join(agentDir, "resolve-cache.json");
		expect(existsSync(cachePath)).toBe(true);
		const file = JSON.parse(readFileSync(cachePath, "utf8"));
		file.entries[0].result.skills[0].path = "SENTINEL.md";
		writeFileSync(cachePath, JSON.stringify(file), "utf8");

		const second = await packageManager.resolve();
		expect(second.skills.some((s) => s.path === "SENTINEL.md")).toBe(true);
	});

	it("recomputes when a new skill appears on disk", async () => {
		await packageManager.resolve();
		mkdirSync(join(agentDir, "skills", "beta"), { recursive: true });
		writeFileSync(join(agentDir, "skills", "beta", "SKILL.md"), "---\ndescription: b\n---\n", "utf8");
		const result = await packageManager.resolve();
		expect(result.skills.some((s) => s.path.includes("beta"))).toBe(true);
	});

	it("recomputes when settings change (signature keying)", async () => {
		const first = await packageManager.resolve();
		expect(first.extensions).toEqual([]);
		const extPath = join(agentDir, "my-extension.ts");
		writeFileSync(extPath, "export default {};\n", "utf8");
		settingsManager.setExtensionPaths(["my-extension.ts"]);
		const second = await packageManager.resolve();
		expect(second.extensions.some((r) => r.path === extPath)).toBe(true);
	});

	it("does not write a cache file when PIT_NO_RESOLVE_CACHE=1", async () => {
		process.env[NO_CACHE_ENV] = "1";
		await packageManager.resolve();
		expect(existsSync(join(agentDir, "resolve-cache.json"))).toBe(false);
	});
});
