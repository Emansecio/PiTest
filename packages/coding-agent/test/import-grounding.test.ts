// suggestClosest from @pit/ai is the REAL fuzzy matcher used in production.
// Using the real one (not a stub) makes the candidate thresholds load-bearing.
import { resolve as resolvePath } from "node:path";
import { suggestClosest } from "@pit/ai";
import { describe, expect, it } from "vitest";
import {
	groundImports,
	IMPORT_GROUNDING_DEFAULTS,
	type ImportGroundingDeps,
	isImportGroundingDisabled,
} from "../src/core/import-grounding.ts";

const REAL_FUZZY = suggestClosest;

// A fake fs from a flat set of absolute paths. fileExists is exact-path membership;
// listDir returns the basenames whose parent dir matches absDir.
function makeFs(paths: string[]): {
	fileExists: ImportGroundingDeps["fileExists"];
	listDir: ImportGroundingDeps["listDir"];
} {
	const set = new Set(paths.map((p) => resolvePath(p)));
	return {
		fileExists: (absPath) => set.has(resolvePath(absPath)),
		listDir: (absDir) => {
			const dir = resolvePath(absDir);
			const out: string[] = [];
			for (const p of set) {
				const parent = resolvePath(p, "..");
				if (parent === dir) {
					const base = p.slice(dir.length).replace(/^[\\/]/, "");
					if (base.length > 0 && !base.includes("\\") && !base.includes("/")) out.push(base);
				}
			}
			return out;
		},
	};
}

function makeDeps(paths: string[], overrides: Partial<ImportGroundingDeps> = {}): ImportGroundingDeps {
	const fs = makeFs(paths);
	return {
		fileExists: fs.fileExists,
		listDir: fs.listDir,
		fuzzy: REAL_FUZZY,
		maxDistance: IMPORT_GROUNDING_DEFAULTS.maxDistance,
		prefixMinOverlap: IMPORT_GROUNDING_DEFAULTS.prefixMinOverlap,
		...overrides,
	};
}

// Anchor a project layout under an absolute root so path.resolve is deterministic.
const ROOT = resolvePath("/proj/src");
const TARGET = resolvePath(ROOT, "app.ts");

describe("groundImports — invariant: RELATIVE paths only", () => {
	it("allows a bare package specifier (out of scope, never grounded)", () => {
		const decision = groundImports({ targetFile: TARGET, content: `import { x } from "react";` }, makeDeps([]));
		expect(decision).toEqual({ action: "allow" });
	});

	it("allows an alias specifier @/… and ~/… (tsconfig paths, out of scope)", () => {
		const a = groundImports({ targetFile: TARGET, content: `import x from "@/utils";` }, makeDeps([]));
		const b = groundImports({ targetFile: TARGET, content: `import y from "~/lib/foo";` }, makeDeps([]));
		expect(a).toEqual({ action: "allow" });
		expect(b).toEqual({ action: "allow" });
	});

	it("allows a scoped package @scope/pkg (not relative)", () => {
		const decision = groundImports({ targetFile: TARGET, content: `import { z } from "@pit/ai";` }, makeDeps([]));
		expect(decision).toEqual({ action: "allow" });
	});
});

describe("groundImports — resolution (exact + extensions + index)", () => {
	it("allows when the import resolves via .ts extension", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import { u } from "./utils";` },
			makeDeps([resolvePath(ROOT, "utils.ts")]),
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("allows when the import resolves via /index.ts (directory form)", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import { c } from "./core";` },
			makeDeps([resolvePath(ROOT, "core/index.ts")]),
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("allows when the import resolves to the EXACT path as written (with extension)", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import data from "./data.json";` },
			makeDeps([resolvePath(ROOT, "data.json")]),
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("allows a parent-relative ../ import that resolves", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import { h } from "../helpers";` },
			makeDeps([resolvePath(ROOT, "..", "helpers.ts")]),
		);
		expect(decision).toEqual({ action: "allow" });
	});
});

describe("groundImports — BLOCK on a broken relative import with a close candidate", () => {
	it("blocks a typo'd specifier and suggests the close filename (./utis -> ./utils)", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import { u } from "./utis";` },
			makeDeps([resolvePath(ROOT, "utils.ts"), resolvePath(ROOT, "app.ts")]),
		);
		expect(decision.action).toBe("block");
		if (decision.action === "block") {
			expect(decision.message).toContain("./utis");
			expect(decision.message).toContain("./utils");
			expect(decision.message).toContain("re-issue the identical call");
		}
	});

	it("re-attaches the sub-directory prefix in the suggestion (./lib/utis -> ./lib/utils)", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import { u } from "./lib/utis";` },
			makeDeps([resolvePath(ROOT, "lib/utils.ts")]),
		);
		expect(decision.action).toBe("block");
		if (decision.action === "block") {
			expect(decision.message).toContain("./lib/utils");
		}
	});

	it("blocks the FIRST broken import when several are broken", () => {
		const decision = groundImports(
			{
				targetFile: TARGET,
				content: `import a from "./utis";\nimport b from "./helprs";`,
			},
			makeDeps([resolvePath(ROOT, "utils.ts"), resolvePath(ROOT, "helpers.ts")]),
		);
		expect(decision.action).toBe("block");
		if (decision.action === "block") {
			expect(decision.message).toContain("./utis");
			expect(decision.message).not.toContain("./helprs");
		}
	});

	it("grounds export … from (re-export)", () => {
		const exp = groundImports(
			{ targetFile: TARGET, content: `export { a } from "./utis";` },
			makeDeps([resolvePath(ROOT, "utils.ts")]),
		);
		expect(exp.action).toBe("block");
	});

	it("does NOT match require() / dynamic import() (out of v1 scope — false-positive prone in strings/templates)", () => {
		const req = groundImports(
			{ targetFile: TARGET, content: `const m = require("./utis");` },
			makeDeps([resolvePath(ROOT, "utils.ts")]),
		);
		const dyn = groundImports(
			{ targetFile: TARGET, content: `const m = await import("./utis");` },
			makeDeps([resolvePath(ROOT, "utils.ts")]),
		);
		expect(req).toEqual({ action: "allow" });
		expect(dyn).toEqual({ action: "allow" });
	});
});

describe("groundImports — review fixes: assets, comments, NodeNext, suggestion extension", () => {
	it("ALLOWS an asset import (.svg/.css) even with a near-named sibling — bundler-resolved, not ours", () => {
		const svg = groundImports(
			{ targetFile: TARGET, content: `import logo from "./logo.svg";` },
			makeDeps([resolvePath(ROOT, "logo.png"), resolvePath(ROOT, "icon.svg")]),
		);
		const css = groundImports(
			{ targetFile: TARGET, content: `import "./theme.css";` },
			makeDeps([resolvePath(ROOT, "base.css")]),
		);
		expect(svg).toEqual({ action: "allow" });
		expect(css).toEqual({ action: "allow" });
	});

	it("does NOT extract an import from a comment or a string literal (anchored at line start)", () => {
		const lineComment = groundImports(
			{ targetFile: TARGET, content: `// import x from "./fake";\nconst y = 1;` },
			makeDeps([resolvePath(ROOT, "face.ts")]),
		);
		const blockComment = groundImports(
			{ targetFile: TARGET, content: `/* import x from "./fake" */\n` },
			makeDeps([resolvePath(ROOT, "face.ts")]),
		);
		const stringLit = groundImports(
			{ targetFile: TARGET, content: `const code = "import x from './fake'";` },
			makeDeps([resolvePath(ROOT, "face.ts")]),
		);
		expect(lineComment).toEqual({ action: "allow" });
		expect(blockComment).toEqual({ action: "allow" });
		expect(stringLit).toEqual({ action: "allow" });
	});

	it("resolves a NodeNext .js specifier to its .ts source (no false-block)", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import { h } from "./helpers.js";` },
			makeDeps([resolvePath(ROOT, "helpers.ts")]),
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("preserves the original .json extension in the suggestion (./confg.json -> ./config.json)", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import data from "./confg.json";` },
			makeDeps([resolvePath(ROOT, "config.json")]),
		);
		expect(decision.action).toBe("block");
		if (decision.action === "block") {
			expect(decision.message).toContain("./config.json");
		}
	});

	it("preserves the NodeNext .js extension in the suggestion (./helpr.js -> ./helpers.js)", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import { h } from "./helpr.js";` },
			makeDeps([resolvePath(ROOT, "helpers.ts")]),
		);
		expect(decision.action).toBe("block");
		if (decision.action === "block") {
			expect(decision.message).toContain("./helpers.js");
		}
	});
});

describe("groundImports — FAIL-OPEN (never wedge a possibly-valid path)", () => {
	it("allows a broken import with NO close candidate in the dir (nothing to suggest)", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import x from "./brandnewmodule";` },
			// dir holds only an unrelated file -> fuzzy yields nothing within threshold
			makeDeps([resolvePath(ROOT, "zzzzzzzz.ts")]),
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("allows when the target dir cannot be listed (empty fs)", () => {
		const decision = groundImports({ targetFile: TARGET, content: `import x from "./missing";` }, makeDeps([]));
		expect(decision).toEqual({ action: "allow" });
	});

	it("allows when listDir throws (fs unavailable) — fail-open", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import x from "./missing";` },
			makeDeps([], {
				listDir: () => {
					throw new Error("EACCES");
				},
			}),
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("allows on empty content / empty targetFile", () => {
		expect(groundImports({ targetFile: TARGET, content: "" }, makeDeps([]))).toEqual({ action: "allow" });
		expect(groundImports({ targetFile: "", content: `import x from "./y";` }, makeDeps([]))).toEqual({
			action: "allow",
		});
	});

	it("does NOT match the affix-fallback garbage (auth -> authentication) thanks to prefixMinOverlap floor", () => {
		// `./auth` is broken; dir has `authentication.ts`. Edit distance is large (>3);
		// only the affix fallback could match, and prefixMinOverlap=64 disables it.
		const decision = groundImports(
			{ targetFile: TARGET, content: `import x from "./auth";` },
			makeDeps([resolvePath(ROOT, "authentication.ts")]),
		);
		expect(decision).toEqual({ action: "allow" });
	});
});

describe("groundImports — does not double-report a UNIQUE specifier", () => {
	it("dedupes the same broken specifier appearing twice", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import a from "./utis";\nimport b from "./utis";` },
			makeDeps([resolvePath(ROOT, "utils.ts")]),
		);
		// One block (the first), not a throw or a duplicated candidate set.
		expect(decision.action).toBe("block");
	});
});

describe("isImportGroundingDisabled — opt-out", () => {
	it("false when unset, true for 1/true/yes (case-insensitive)", () => {
		expect(isImportGroundingDisabled({})).toBe(false);
		expect(isImportGroundingDisabled({ PIT_NO_IMPORT_GROUNDING: "1" })).toBe(true);
		expect(isImportGroundingDisabled({ PIT_NO_IMPORT_GROUNDING: "TRUE" })).toBe(true);
		expect(isImportGroundingDisabled({ PIT_NO_IMPORT_GROUNDING: "yes" })).toBe(true);
		expect(isImportGroundingDisabled({ PIT_NO_IMPORT_GROUNDING: "0" })).toBe(false);
	});
});
