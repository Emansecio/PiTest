// suggestClosest from @pit/ai is the REAL fuzzy matcher used in production.
// Using the real one (not a stub) makes the candidate thresholds load-bearing.
import { resolve as resolvePath } from "node:path";
import { suggestClosest } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { reconstructEditedRegion } from "../src/core/built-ins/import-grounding-extension.ts";
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

// Deps backed by a {absPath -> source} map so the named-export pass (pass 2) can
// read each resolved module. Paths double as the on-disk set for pass 1.
function makeDepsWithFiles(
	files: Record<string, string>,
	overrides: Partial<ImportGroundingDeps> = {},
): ImportGroundingDeps {
	const byAbs = new Map<string, string>();
	for (const [p, source] of Object.entries(files)) byAbs.set(resolvePath(p), source);
	const base = makeDeps([...byAbs.keys()], overrides);
	return { ...base, readFile: (absPath) => byAbs.get(resolvePath(absPath)), ...overrides };
}

// Anchor a project layout under an absolute root so path.resolve is deterministic.
const ROOT = resolvePath("/proj/src");
const TARGET = resolvePath(ROOT, "app.ts");

describe("groundImports — invariant: RELATIVE paths only", () => {
	it("allows a bare package specifier (out of scope, never grounded)", () => {
		const decision = groundImports({ targetFile: TARGET, content: `import { x } from "react";` }, makeDeps([]));
		expect(decision).toEqual({ action: "allow" });
	});

	it("allows an alias specifier @/… and ~/… (skipped when the tsconfig-paths dep is not wired)", () => {
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

describe("groundImports — tsconfig path aliases (@/…, ~/…)", () => {
	// baseUrl is the project root; @/* -> src/*, ~/* -> ./* (root-relative).
	const TS_PATHS = { baseUrl: resolvePath("/proj"), paths: { "@/*": ["src/*"], "~/*": ["./*"] } };
	const readTsconfigPaths = () => TS_PATHS;

	it("skips the alias pass entirely when readTsconfigPaths is not wired", () => {
		const decision = groundImports({ targetFile: TARGET, content: `import x from "@/nope";` }, makeDeps([]));
		expect(decision).toEqual({ action: "allow" });
	});

	it("allows when readTsconfigPaths returns undefined (no governing config)", () => {
		const deps = makeDeps([], { readTsconfigPaths: () => undefined });
		const decision = groundImports({ targetFile: TARGET, content: `import x from "@/nope";` }, deps);
		expect(decision).toEqual({ action: "allow" });
	});

	it("allows a mapped alias that resolves on disk (@/* -> src/*)", () => {
		const deps = makeDeps([resolvePath("/proj/src/utils.ts")], { readTsconfigPaths });
		const decision = groundImports({ targetFile: TARGET, content: `import { u } from "@/utils";` }, deps);
		expect(decision).toEqual({ action: "allow" });
	});

	it("resolves the ~/* -> ./* mapping (subdir target)", () => {
		const deps = makeDeps([resolvePath("/proj/lib/foo.ts")], { readTsconfigPaths });
		const decision = groundImports({ targetFile: TARGET, content: `import y from "~/lib/foo";` }, deps);
		expect(decision).toEqual({ action: "allow" });
	});

	it("blocks a mapped alias that is missing but typos a real sibling", () => {
		const deps = makeDeps([resolvePath("/proj/src/utils.ts")], { readTsconfigPaths });
		const decision = groundImports({ targetFile: TARGET, content: `import { u } from "@/utis";` }, deps);
		expect(decision.action).toBe("block");
		if (decision.action === "block") {
			expect(decision.kind).toBe("alias");
			expect(decision.message).toContain("@/utils");
		}
	});

	it("allows a missing alias with no close sibling (fail-open)", () => {
		const deps = makeDeps([resolvePath("/proj/src/utils.ts")], { readTsconfigPaths });
		const decision = groundImports({ targetFile: TARGET, content: `import x from "@/zzzzzz";` }, deps);
		expect(decision).toEqual({ action: "allow" });
	});

	it("allows an alias not covered by any paths pattern", () => {
		const onlyAt = { baseUrl: resolvePath("/proj"), paths: { "@/*": ["src/*"] } };
		const deps = makeDeps([], { readTsconfigPaths: () => onlyAt });
		const decision = groundImports({ targetFile: TARGET, content: `import x from "~/whatever";` }, deps);
		expect(decision).toEqual({ action: "allow" });
	});

	it("picks the longest-prefix pattern (@/ui/* over @/*)", () => {
		const cfg = { baseUrl: resolvePath("/proj"), paths: { "@/*": ["src/*"], "@/ui/*": ["components/*"] } };
		const deps = makeDeps([resolvePath("/proj/components/Button.ts")], { readTsconfigPaths: () => cfg });
		const decision = groundImports({ targetFile: TARGET, content: `import { B } from "@/ui/Button";` }, deps);
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

describe("import-grounding edit reconstruction (surgical specifier swap — reinforcement)", () => {
	it("rebuilds the full import line from oldText context so the regex still matches", () => {
		const file = `import { x } from "./old";\nconst y = 1;\n`;
		// the edit swaps ONLY the specifier — newText alone carries no `import` keyword
		expect(reconstructEditedRegion(file, "./old", "./renamed")).toBe(`import { x } from "./renamed";`);
	});

	it("falls back to the raw newText when the file is unavailable or oldText is absent (fail-open)", () => {
		expect(reconstructEditedRegion(undefined, "./old", "./new")).toBe("./new");
		expect(reconstructEditedRegion(`import x from "./a";`, "./zzz", "./new")).toBe("./new");
	});

	it("the reconstructed line feeds groundImports so a surgical specifier typo is caught", () => {
		const file = `import { calc } from "./utils";\n`;
		const reconstructed = reconstructEditedRegion(file, "./utils", "./utis");
		const decision = groundImports(
			{ targetFile: TARGET, content: reconstructed },
			makeDeps([resolvePath(ROOT, "utils.ts")]),
		);
		expect(decision.action).toBe("block");
		if (decision.action === "block") expect(decision.message).toContain("./utis");
	});
});

describe("import-grounding edit reconstruction — occurrence semantics mirror the edit tool", () => {
	// A UNIQUE oldText must behave exactly as before: expand the single line and
	// splice newText in. The replaceAll flag is a no-op when there is one match.
	it("unique oldText reconstructs the single line (unchanged; replaceAll is a no-op)", () => {
		const file = `import { x } from "./old";\nconst y = 1;\n`;
		expect(reconstructEditedRegion(file, "./old", "./renamed")).toBe(`import { x } from "./renamed";`);
		expect(reconstructEditedRegion(file, "./old", "./renamed", true)).toBe(`import { x } from "./renamed";`);
	});

	// The BUG: when oldText appears twice, the old code took the FIRST indexOf and
	// reconstructed that region — validating an import the model isn't editing (and
	// that the edit tool would refuse to apply as ambiguous). Now it skips entirely.
	it("ambiguous oldText (2 occurrences, no replaceAll) is SKIPPED, not first-match reconstructed", () => {
		const file = `import { a } from "./alpha";\nconst z = 1;\nimport { b } from "./alpha";\n`;
		const result = reconstructEditedRegion(file, "./alpha", "./bravo");
		// Old buggy behavior reconstructed the FIRST occurrence's line — assert it's gone.
		expect(result).not.toBe(`import { a } from "./bravo";`);
		// New behavior: ambiguous edit contributes nothing (fail-open skip).
		expect(result).toBe("");
	});

	// End-to-end: the second occurrence is the REAL edit site. The old code would
	// have validated the FIRST region (here a broken specifier -> spurious block on
	// a region the model never touched). Now the ambiguous edit yields no content,
	// so groundImports sees nothing to block.
	it("does not raise a wrong-region block for an ambiguous edit whose real site is the 2nd occurrence", () => {
		const file = `import { a } from "./old";\nconst z = 1;\nimport { b } from "./old";\n`;
		// Suppose the model's newText would typo the specifier (./nu ~ ./new). Because
		// the match is ambiguous, the edit tool rejects it; the guard must not block.
		const reconstructed = reconstructEditedRegion(file, "./old", "./nu");
		expect(reconstructed).toBe("");
		const decision = groundImports(
			{ targetFile: TARGET, content: reconstructed || "" },
			makeDeps([resolvePath(ROOT, "new.ts")]),
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("replaceAll reconstructs EVERY occurrence's line (joined by newlines)", () => {
		const file = `import { a } from "./old";\nconst z = 1;\nimport { b } from "./old";\n`;
		const result = reconstructEditedRegion(file, "./old", "./new", true);
		expect(result).toBe(`import { a } from "./new";\nimport { b } from "./new";`);
	});

	// With replaceAll the specifier is swapped at every site, so a typo is still
	// grounded — the guard reconstructs all occurrences and pass 1 catches it.
	it("replaceAll: a typo'd specifier applied to all occurrences is still caught by groundImports", () => {
		const file = `import { a } from "./utils";\nimport { b } from "./utils";\n`;
		const reconstructed = reconstructEditedRegion(file, "./utils", "./utis", true);
		const decision = groundImports(
			{ targetFile: TARGET, content: reconstructed },
			makeDeps([resolvePath(ROOT, "utils.ts")]),
		);
		expect(decision.action).toBe("block");
		if (decision.action === "block") expect(decision.message).toContain("./utis");
	});
});

describe("groundImports — named-export validation (pass 2)", () => {
	const MATH = resolvePath(ROOT, "math.ts");

	it("blocks a typo'd named import and suggests the close export (calcualte -> calculate)", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import { calcualte } from "./math";` },
			makeDepsWithFiles({ [MATH]: "export function calculate() {}\nexport const PI = 3;\n" }),
		);
		expect(decision.action).toBe("block");
		if (decision.action === "block") {
			expect(decision.message).toContain("calcualte");
			expect(decision.message).toContain("calculate");
			expect(decision.message).toContain("has no exported member");
			expect(decision.message).toContain("re-issue the identical call");
		}
	});

	it("allows a named import that DOES exist", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import { calculate, PI } from "./math";` },
			makeDepsWithFiles({ [MATH]: "export function calculate() {}\nexport const PI = 3;\n" }),
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("validates the SOURCE name (before `as`) of a renamed import", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import { calcualte as fn } from "./math";` },
			makeDepsWithFiles({ [MATH]: "export function calculate() {}\n" }),
		);
		expect(decision.action).toBe("block");
		if (decision.action === "block") expect(decision.message).toContain("calcualte");
	});

	it("recognises an `export { internal as Public }` re-name (import the public name -> allow)", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import { Public } from "./math";` },
			makeDepsWithFiles({ [MATH]: "function internal() {}\nexport { internal as Public };\n" }),
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("recognises a MULTI-LINE export list block", () => {
		const src = "export {\n  alpha,\n  beta,\n};\n";
		const ok = groundImports(
			{ targetFile: TARGET, content: `import { alpha } from "./math";` },
			makeDepsWithFiles({ [MATH]: src }),
		);
		const bad = groundImports(
			{ targetFile: TARGET, content: `import { alfa } from "./math";` },
			makeDepsWithFiles({ [MATH]: src }),
		);
		expect(ok).toEqual({ action: "allow" });
		expect(bad.action).toBe("block");
		if (bad.action === "block") expect(bad.message).toContain("alpha");
	});

	it("validates `export type`/`interface` exports against a (type) import", () => {
		const src = "export type Foo = number;\nexport interface Bar {}\n";
		const ok = groundImports(
			{ targetFile: TARGET, content: `import type { Foo } from "./math";` },
			makeDepsWithFiles({ [MATH]: src }),
		);
		const bad = groundImports(
			{ targetFile: TARGET, content: `import { Fo } from "./math";` },
			makeDepsWithFiles({ [MATH]: src }),
		);
		expect(ok).toEqual({ action: "allow" });
		expect(bad.action).toBe("block");
		if (bad.action === "block") expect(bad.message).toContain("Foo");
	});

	it("FAIL-OPEN: a bare `export *` re-export defeats enumeration (no block)", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import { anything } from "./math";` },
			makeDepsWithFiles({ [MATH]: `export * from "./other";\nexport const known = 1;\n` }),
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("does NOT validate default or namespace imports", () => {
		const dflt = groundImports(
			{ targetFile: TARGET, content: `import math from "./math";` },
			makeDepsWithFiles({ [MATH]: "export const PI = 3;\n" }),
		);
		const ns = groundImports(
			{ targetFile: TARGET, content: `import * as m from "./math";` },
			makeDepsWithFiles({ [MATH]: "export const PI = 3;\n" }),
		);
		expect(dflt).toEqual({ action: "allow" });
		expect(ns).toEqual({ action: "allow" });
	});

	it("FAIL-OPEN: an absent name with NO close export candidate is allowed", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import { zzzzzzzz } from "./math";` },
			makeDepsWithFiles({ [MATH]: "export function calculate() {}\n" }),
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("FAIL-OPEN: skips export validation entirely when no readFile dep is wired", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import { calcualte } from "./math";` },
			makeDeps([MATH]), // resolves on disk, but no readFile -> pass 2 is skipped
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("export-list `export *` wildcard does NOT trip on `export * as ns` (ns IS a named export)", () => {
		const ok = groundImports(
			{ targetFile: TARGET, content: `import { ns } from "./math";` },
			makeDepsWithFiles({ [MATH]: `export * as ns from "./other";\n` }),
		);
		expect(ok).toEqual({ action: "allow" });
	});

	it("still reports a broken PATH (pass 1) before any export check", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import { x } from "./mth";` },
			makeDepsWithFiles({ [MATH]: "export const x = 1;\n" }),
		);
		expect(decision.action).toBe("block");
		if (decision.action === "block") expect(decision.message).toContain("does not resolve");
	});
});

describe("groundImports — MULTI-LINE imports (Change 1)", () => {
	const MATH = resolvePath(ROOT, "math.ts");

	it("blocks a MULTI-LINE named import whose PATH is broken (path) with a candidate", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import {\n  a,\n  b,\n} from "./utis";\n` },
			makeDeps([resolvePath(ROOT, "utils.ts")]),
		);
		expect(decision.action).toBe("block");
		if (decision.action === "block") {
			expect(decision.kind).toBe("path");
			expect(decision.message).toContain("./utis");
			expect(decision.message).toContain("./utils");
		}
	});

	it("blocks a MULTI-LINE named import whose SYMBOL is not exported (export) with a candidate", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import {\n  calcualte,\n  PI,\n} from "./math";\n` },
			makeDepsWithFiles({ [MATH]: "export function calculate() {}\nexport const PI = 3;\n" }),
		);
		expect(decision.action).toBe("block");
		if (decision.action === "block") {
			expect(decision.kind).toBe("export");
			expect(decision.message).toContain("calcualte");
			expect(decision.message).toContain("calculate");
			expect(decision.message).toContain("has no exported member");
		}
	});

	it("allows a VALID MULTI-LINE named import (path resolves + symbols exported)", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import {\n  calculate,\n  PI,\n} from "./math";\n` },
			makeDepsWithFiles({ [MATH]: "export function calculate() {}\nexport const PI = 3;\n" }),
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("handles a MULTI-LINE import with `as` renames and inline `type` across lines", () => {
		const src = "export function calculate() {}\nexport type Vec = number;\n";
		const ok = groundImports(
			{ targetFile: TARGET, content: `import {\n  calculate as run,\n  type Vec,\n} from "./math";\n` },
			makeDepsWithFiles({ [MATH]: src }),
		);
		expect(ok).toEqual({ action: "allow" });
	});

	it("does NOT match a LINE-comment import even when adjacent to real lines (multi-line content)", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `// import { x } from "./fake"\nconst y = 1;\nexport {};\n` },
			makeDeps([resolvePath(ROOT, "face.ts")]),
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("does NOT match an indented LINE-comment import (leading whitespace before //)", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `function f() {\n  // import { x } from "./fake";\n}\n` },
			makeDeps([resolvePath(ROOT, "face.ts")]),
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("a broken MULTI-LINE export … from re-export blocks with kind path", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `export {\n  a,\n  b,\n} from "./utis";\n` },
			makeDeps([resolvePath(ROOT, "utils.ts")]),
		);
		expect(decision.action).toBe("block");
		if (decision.action === "block") expect(decision.kind).toBe("path");
	});
});

describe("ImportGroundingDecision — block carries kind (Change 2)", () => {
	const MATH = resolvePath(ROOT, "math.ts");

	it('a PATH block reports kind "path"', () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import { u } from "./utis";` },
			makeDeps([resolvePath(ROOT, "utils.ts")]),
		);
		expect(decision.action).toBe("block");
		if (decision.action === "block") expect(decision.kind).toBe("path");
	});

	it('an EXPORT block reports kind "export"', () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import { calcualte } from "./math";` },
			makeDepsWithFiles({ [MATH]: "export function calculate() {}\n" }),
		);
		expect(decision.action).toBe("block");
		if (decision.action === "block") expect(decision.kind).toBe("export");
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

// PV3-bare: ground BARE package specifiers against knownPackages + Node builtins.
// No fs needed (packages aren't on disk) — only the injected knownPackages set.
function makeBareDeps(packageNames: string[] | undefined): ImportGroundingDeps {
	return makeDeps([], packageNames === undefined ? {} : { knownPackages: () => new Set(packageNames) });
}

describe("groundImports — BARE package grounding (PV3-bare)", () => {
	it("blocks an unknown package that typos a known dep (lodash-es -> lodash)", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import x from "lodash-es";` },
			makeBareDeps(["lodash"]),
		);
		expect(decision.action).toBe("block");
		if (decision.action === "block") {
			expect(decision.kind).toBe("bare");
			expect(decision.message).toContain("lodash-es");
			expect(decision.message).toContain("lodash");
			expect(decision.message).toContain("re-issue the identical call");
		}
	});

	it("allows a package that IS a known dependency (react)", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import x from "react";` },
			makeBareDeps(["react"]),
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("allows Node builtins (node:fs prefix and bare path)", () => {
		const prefixed = groundImports(
			{ targetFile: TARGET, content: `import { readFile } from "node:fs";` },
			makeBareDeps(["react"]),
		);
		const bare = groundImports({ targetFile: TARGET, content: `import "path";` }, makeBareDeps(["react"]));
		expect(prefixed).toEqual({ action: "allow" });
		expect(bare).toEqual({ action: "allow" });
	});

	it("allows a SUBPATH of a known scoped package (@scope/pkg/sub -> @scope/pkg)", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import x from "@scope/pkg/sub";` },
			makeBareDeps(["@scope/pkg"]),
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("allows ALIAS specifiers @/… and ~/… (out of scope, never grounded as bare)", () => {
		// knownPackages wired but EMPTY: a bare typo would block — these must not even
		// be considered bare (alias is explicitly out of scope).
		const at = groundImports(
			{ targetFile: TARGET, content: `import x from "@/components/X";` },
			makeBareDeps(["components"]),
		);
		const tilde = groundImports({ targetFile: TARGET, content: `import x from "~/lib";` }, makeBareDeps(["lib"]));
		expect(at).toEqual({ action: "allow" });
		expect(tilde).toEqual({ action: "allow" });
	});

	it("allows a workspace package present in knownPackages (@pit/ai — no internal false-block)", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import { x } from "@pit/ai";` },
			makeBareDeps(["@pit/ai", "@pit/coding-agent", "@pit/tui"]),
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("FAIL-OPEN: bare grounding is skipped when knownPackages is not wired", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import x from "lodash-es";` },
			makeBareDeps(undefined),
		);
		expect(decision).toEqual({ action: "allow" });
	});

	it("FAIL-OPEN: an empty knownPackages set never blocks (no close candidate)", () => {
		const decision = groundImports({ targetFile: TARGET, content: `import x from "lodash-es";` }, makeBareDeps([]));
		expect(decision).toEqual({ action: "allow" });
	});

	it("FAIL-OPEN: an unknown package with NO close known name is allowed (genuinely new dep)", () => {
		const decision = groundImports(
			{ targetFile: TARGET, content: `import x from "react";` },
			makeBareDeps(["@scope/pkg", "typescript"]),
		);
		expect(decision).toEqual({ action: "allow" });
	});
});
