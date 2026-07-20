import { describe, expect, it } from "vitest";
import { buildWorkspacePackageMap, type WorkspaceMapDeps } from "../src/core/repo-map/workspace-map.js";

const CWD = "/repo";

/**
 * In-memory deps from a {repo-relative path -> file content} record plus a
 * {repo-relative dir -> entry names} record. Paths are joined by the module with
 * the OS separator, so normalize both slashes back to "/" before lookups.
 */
function depsFrom(files: Record<string, string>, dirs: Record<string, string[]> = {}): WorkspaceMapDeps {
	const norm = (absPath: string) => absPath.split("\\").join("/").replace(`${CWD}/`, "");
	return {
		readFile: (absPath) => files[norm(absPath)] ?? null,
		readDir: (absPath) => dirs[norm(absPath)] ?? null,
	};
}

const pkg = (name: string) => JSON.stringify({ name });

describe("buildWorkspacePackageMap", () => {
	it("maps names from the ARRAY `workspaces` form with literal dirs", () => {
		const deps = depsFrom({
			"package.json": JSON.stringify({ workspaces: ["packages/ai", "packages/agent"] }),
			"packages/ai/package.json": pkg("@pit/ai"),
			"packages/agent/package.json": pkg("@pit/agent-core"),
		});
		const map = buildWorkspacePackageMap(CWD, deps);
		expect(map.get("@pit/ai")).toBe("packages/ai");
		expect(map.get("@pit/agent-core")).toBe("packages/agent");
		expect(map.size).toBe(2);
	});

	it("maps names from the OBJECT `{ packages: [...] }` form", () => {
		const deps = depsFrom({
			"package.json": JSON.stringify({ workspaces: { packages: ["libs/core"] } }),
			"libs/core/package.json": pkg("@acme/core"),
		});
		const map = buildWorkspacePackageMap(CWD, deps);
		expect(map.get("@acme/core")).toBe("libs/core");
	});

	it("expands a one-level `packages/*` glob via the injected readdir", () => {
		const deps = depsFrom(
			{
				"package.json": JSON.stringify({ workspaces: ["packages/*"] }),
				"packages/ai/package.json": pkg("@pit/ai"),
				"packages/agent/package.json": pkg("@pit/agent-core"),
			},
			{ packages: ["ai", "agent"] },
		);
		const map = buildWorkspacePackageMap(CWD, deps);
		expect(map.get("@pit/ai")).toBe("packages/ai");
		expect(map.get("@pit/agent-core")).toBe("packages/agent");
	});

	it("maps a package whose name does NOT match its directory (@pit/agent-core -> packages/agent)", () => {
		const deps = depsFrom(
			{
				"package.json": JSON.stringify({ workspaces: ["packages/*"] }),
				"packages/agent/package.json": pkg("@pit/agent-core"),
			},
			{ packages: ["agent"] },
		);
		const map = buildWorkspacePackageMap(CWD, deps);
		expect(map.get("@pit/agent-core")).toBe("packages/agent");
		expect(map.has("@pit/agent")).toBe(false); // the dir name is NOT a key
	});

	it("skips a glob-expanded entry with no readable package.json (plain file in packages/)", () => {
		const deps = depsFrom(
			{
				"package.json": JSON.stringify({ workspaces: ["packages/*"] }),
				"packages/ai/package.json": pkg("@pit/ai"),
				// "packages/README.md" has no package.json -> readFile null -> skipped
			},
			{ packages: ["ai", "README.md"] },
		);
		const map = buildWorkspacePackageMap(CWD, deps);
		expect(map.size).toBe(1);
		expect(map.get("@pit/ai")).toBe("packages/ai");
	});

	it("skips unsupported glob shapes (`**`, mid-pattern `*`) instead of guessing", () => {
		const deps = depsFrom(
			{
				"package.json": JSON.stringify({ workspaces: ["packages/**", "apps/*/nested", "packages/*"] }),
				"packages/ai/package.json": pkg("@pit/ai"),
			},
			{ packages: ["ai"] },
		);
		const map = buildWorkspacePackageMap(CWD, deps);
		// Only the trivial `packages/*` contributed.
		expect(Array.from(map.entries())).toEqual([["@pit/ai", "packages/ai"]]);
	});

	it("root manifest unreadable -> empty map (fail-open)", () => {
		const map = buildWorkspacePackageMap(CWD, depsFrom({}));
		expect(map.size).toBe(0);
	});

	it("malformed root JSON -> empty map (fail-open)", () => {
		const map = buildWorkspacePackageMap(CWD, depsFrom({ "package.json": "{not json" }));
		expect(map.size).toBe(0);
	});

	it("no `workspaces` field -> empty map", () => {
		const map = buildWorkspacePackageMap(CWD, depsFrom({ "package.json": pkg("solo") }));
		expect(map.size).toBe(0);
	});

	it("a throwing readdir is contained (fail-open to an empty expansion)", () => {
		const deps: WorkspaceMapDeps = {
			readFile: (absPath) =>
				absPath.split("\\").join("/").endsWith("/repo/package.json")
					? JSON.stringify({ workspaces: ["packages/*"] })
					: null,
			readDir: () => {
				throw new Error("EACCES");
			},
		};
		expect(buildWorkspacePackageMap(CWD, deps).size).toBe(0);
	});

	it("a workspace package.json without a string name is skipped", () => {
		const deps = depsFrom(
			{
				"package.json": JSON.stringify({ workspaces: ["packages/*"] }),
				"packages/ai/package.json": JSON.stringify({ private: true }),
				"packages/tui/package.json": pkg("@pit/tui"),
			},
			{ packages: ["ai", "tui"] },
		);
		const map = buildWorkspacePackageMap(CWD, deps);
		expect(Array.from(map.entries())).toEqual([["@pit/tui", "packages/tui"]]);
	});
});
