// suggestClosest from @pit/ai is the REAL fuzzy matcher used in production.
import { resolve as resolvePath } from "node:path";
import { suggestClosest } from "@pit/ai";
import { describe, expect, it } from "vitest";
import {
	groundPath,
	isPathGroundingDisabled,
	PATH_GROUNDING_DEFAULTS,
	type PathGroundingDeps,
} from "../src/core/path-grounding.ts";

const REAL_FUZZY = suggestClosest;

// Anchor a project layout under an absolute root so path.resolve is deterministic.
// `resolve` mirrors resolveToolPath bound to cwd=ROOT.
const ROOT = resolvePath("/proj/src");

// A fake fs from a flat set of absolute paths. fileExists is exact-path membership;
// listDir returns the basenames whose parent dir matches absDir.
function makeDeps(paths: string[], overrides: Partial<PathGroundingDeps> = {}): PathGroundingDeps {
	const set = new Set(paths.map((p) => resolvePath(p)));
	return {
		resolve: (raw) => resolvePath(ROOT, raw),
		fileExists: (absPath) => set.has(resolvePath(absPath)),
		listDir: (absDir) => {
			const dir = resolvePath(absDir);
			const out: string[] = [];
			for (const p of set) {
				if (resolvePath(p, "..") !== dir) continue;
				const base = p.slice(dir.length).replace(/^[\\/]/, "");
				if (base.length > 0 && !base.includes("\\") && !base.includes("/")) out.push(base);
			}
			return out;
		},
		fuzzy: REAL_FUZZY,
		maxDistance: PATH_GROUNDING_DEFAULTS.maxDistance,
		prefixMinOverlap: PATH_GROUNDING_DEFAULTS.prefixMinOverlap,
		...overrides,
	};
}

describe("groundPath — allows an existing path", () => {
	it("allows a relative path that exists", () => {
		expect(groundPath({ path: "./utils.ts" }, makeDeps([resolvePath(ROOT, "utils.ts")]))).toEqual({
			action: "allow",
		});
	});

	it("allows a bare (cwd-relative) filename that exists", () => {
		expect(groundPath({ path: "utils.ts" }, makeDeps([resolvePath(ROOT, "utils.ts")]))).toEqual({ action: "allow" });
	});

	it("allows an existing directory path (existsSync covers dirs)", () => {
		expect(groundPath({ path: "./core" }, makeDeps([resolvePath(ROOT, "core")]))).toEqual({ action: "allow" });
	});

	it("allows a sub-directory path that exists", () => {
		expect(groundPath({ path: "./lib/utils.ts" }, makeDeps([resolvePath(ROOT, "lib/utils.ts")]))).toEqual({
			action: "allow",
		});
	});
});

describe("groundPath — BLOCKS a missing path with a close candidate", () => {
	it("blocks a typo'd basename and suggests the close filename (./utis.ts -> ./utils.ts)", () => {
		const decision = groundPath(
			{ path: "./utis.ts" },
			makeDeps([resolvePath(ROOT, "utils.ts"), resolvePath(ROOT, "app.ts")]),
		);
		expect(decision.action).toBe("block");
		if (decision.action === "block") {
			expect(decision.message).toContain("./utis.ts");
			expect(decision.message).toContain("./utils.ts");
			expect(decision.message).toContain("re-issue the identical call");
		}
	});

	it("re-attaches the directory prefix in the suggestion (./lib/utis.ts -> ./lib/utils.ts)", () => {
		const decision = groundPath({ path: "./lib/utis.ts" }, makeDeps([resolvePath(ROOT, "lib/utils.ts")]));
		expect(decision.action).toBe("block");
		if (decision.action === "block") {
			expect(decision.message).toContain("./lib/utils.ts");
		}
	});

	it("compares the FULL basename incl. extension (config.json != config.yaml)", () => {
		// `./confg.json` is a typo of config.json; config.yaml is far -> only .json suggested.
		const decision = groundPath(
			{ path: "./confg.json" },
			makeDeps([resolvePath(ROOT, "config.json"), resolvePath(ROOT, "config.yaml")]),
		);
		expect(decision.action).toBe("block");
		if (decision.action === "block") {
			expect(decision.message).toContain("./config.json");
			expect(decision.message).not.toContain("config.yaml");
		}
	});

	it("blocks a bare filename typo (no directory prefix)", () => {
		const decision = groundPath({ path: "utis.ts" }, makeDeps([resolvePath(ROOT, "utils.ts")]));
		expect(decision.action).toBe("block");
		if (decision.action === "block") {
			expect(decision.message).toContain("utils.ts");
		}
	});
});

describe("groundPath — FAIL-OPEN / out of scope", () => {
	it("allows a glob/brace pattern (not a literal path)", () => {
		const deps = makeDeps([resolvePath(ROOT, "utils.ts")]);
		expect(groundPath({ path: "./*.ts" }, deps)).toEqual({ action: "allow" });
		expect(groundPath({ path: "./src/**/*.ts" }, deps)).toEqual({ action: "allow" });
		expect(groundPath({ path: "./{a,b}.ts" }, deps)).toEqual({ action: "allow" });
	});

	it("allows a missing path when NOTHING in the dir is close (no wedge)", () => {
		const decision = groundPath({ path: "./brandnewfile.ts" }, makeDeps([resolvePath(ROOT, "zzzzzzzz.ts")]));
		expect(decision).toEqual({ action: "allow" });
	});

	it("allows when the dir cannot be listed (empty fs)", () => {
		expect(groundPath({ path: "./missing.ts" }, makeDeps([]))).toEqual({ action: "allow" });
	});

	it("allows when listDir throws (fs unavailable) — fail-open", () => {
		const decision = groundPath(
			{ path: "./missing.ts" },
			makeDeps([], {
				listDir: () => {
					throw new Error("EACCES");
				},
			}),
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("allows on empty path", () => {
		expect(groundPath({ path: "" }, makeDeps([]))).toEqual({ action: "allow" });
	});

	it("does NOT match the affix-fallback (app.ts -> app.test.ts) thanks to prefixMinOverlap floor", () => {
		// `./app.ts` is missing; dir holds `app.test.ts`. Edit distance is large (>3);
		// only the affix fallback could match, and prefixMinOverlap=64 disables it.
		const decision = groundPath({ path: "./app.ts" }, makeDeps([resolvePath(ROOT, "app.test.ts")]));
		expect(decision).toEqual({ action: "allow" });
	});
});

describe("isPathGroundingDisabled — opt-out", () => {
	it("false when unset, true for 1/true/yes (case-insensitive)", () => {
		expect(isPathGroundingDisabled({})).toBe(false);
		expect(isPathGroundingDisabled({ PIT_NO_PATH_GROUNDING: "1" })).toBe(true);
		expect(isPathGroundingDisabled({ PIT_NO_PATH_GROUNDING: "TRUE" })).toBe(true);
		expect(isPathGroundingDisabled({ PIT_NO_PATH_GROUNDING: "yes" })).toBe(true);
		expect(isPathGroundingDisabled({ PIT_NO_PATH_GROUNDING: "0" })).toBe(false);
	});
});
