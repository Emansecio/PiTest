import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findTsconfigPathsForFile,
	loadProjectConfigContext,
	projectEnforcesErasableSyntax,
	projectEnforcesNoNestedTernary,
} from "../src/core/project-config-context.js";

describe("loadProjectConfigContext", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pit-cfg-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns null when no config files exist", () => {
		expect(loadProjectConfigContext(dir)).toBeNull();
	});

	it("distills tsconfig strict + erasableSyntaxOnly + aliases", () => {
		writeFileSync(
			join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					verbatimModuleSyntax: true,
					erasableSyntaxOnly: true,
					paths: { "@pit/*": ["packages/*/src"] },
				},
			}),
		);
		const ctx = loadProjectConfigContext(dir);
		expect(ctx).not.toBeNull();
		expect(ctx?.path).toBe("<project-config>");
		expect(ctx?.content).toContain("strict");
		expect(ctx?.content).toContain("verbatimModuleSyntax");
		expect(ctx?.content).toContain("erasableSyntaxOnly");
		expect(ctx?.content).toContain("@pit/*");
	});

	it("parses JSONC (comments) in tsconfig", () => {
		writeFileSync(
			join(dir, "tsconfig.json"),
			`{\n  // project config\n  "compilerOptions": { "strict": true } /* trailing */\n}`,
		);
		expect(loadProjectConfigContext(dir)?.content).toContain("strict");
	});

	it("distills biome formatter conventions", () => {
		writeFileSync(
			join(dir, "biome.json"),
			JSON.stringify({
				formatter: { indentStyle: "tab", lineWidth: 120 },
				javascript: { formatter: { quoteStyle: "double", semicolons: "always" } },
			}),
		);
		const content = loadProjectConfigContext(dir)?.content ?? "";
		expect(content).toContain("tab indent");
		expect(content).toContain("line width 120");
		expect(content).toContain("double quotes");
		expect(content).toContain("semicolons required");
	});

	it("returns null on malformed JSON rather than throwing", () => {
		writeFileSync(join(dir, "tsconfig.json"), "{ this is not json");
		expect(loadProjectConfigContext(dir)).toBeNull();
	});

	it("inherits compilerOptions through the extends chain", () => {
		writeFileSync(join(dir, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { erasableSyntaxOnly: true } }));
		writeFileSync(
			join(dir, "tsconfig.json"),
			JSON.stringify({ extends: "./tsconfig.base.json", compilerOptions: { strict: true } }),
		);
		const content = loadProjectConfigContext(dir)?.content ?? "";
		expect(content).toContain("erasableSyntaxOnly");
		expect(content).toContain("strict");
	});
});

describe("projectEnforcesErasableSyntax", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pit-cfg-eso-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("is false with no tsconfig", () => {
		expect(projectEnforcesErasableSyntax(dir)).toBe(false);
	});

	it("is true when set directly", () => {
		writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { erasableSyntaxOnly: true } }));
		expect(projectEnforcesErasableSyntax(dir)).toBe(true);
	});

	it("is true when inherited via extends", () => {
		writeFileSync(join(dir, "base.json"), JSON.stringify({ compilerOptions: { erasableSyntaxOnly: true } }));
		writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ extends: "./base.json" }));
		expect(projectEnforcesErasableSyntax(dir)).toBe(true);
	});

	it("is false when the project allows enums", () => {
		writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
		expect(projectEnforcesErasableSyntax(dir)).toBe(false);
	});

	it("child can override an inherited true back to false", () => {
		writeFileSync(join(dir, "base.json"), JSON.stringify({ compilerOptions: { erasableSyntaxOnly: true } }));
		writeFileSync(
			join(dir, "tsconfig.json"),
			JSON.stringify({ extends: "./base.json", compilerOptions: { erasableSyntaxOnly: false } }),
		);
		expect(projectEnforcesErasableSyntax(dir)).toBe(false);
	});
});

describe("projectEnforcesNoNestedTernary", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pit-cfg-nnt-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("is false with no biome config", () => {
		expect(projectEnforcesNoNestedTernary(dir)).toBe(false);
	});

	it("is true via the recommended set", () => {
		writeFileSync(
			join(dir, "biome.json"),
			JSON.stringify({ linter: { enabled: true, rules: { recommended: true } } }),
		);
		expect(projectEnforcesNoNestedTernary(dir)).toBe(true);
	});

	it("is false when the rule is explicitly off", () => {
		writeFileSync(
			join(dir, "biome.json"),
			JSON.stringify({ linter: { rules: { recommended: true, style: { noNestedTernary: "off" } } } }),
		);
		expect(projectEnforcesNoNestedTernary(dir)).toBe(false);
	});

	it("is false when the linter is disabled", () => {
		writeFileSync(join(dir, "biome.json"), JSON.stringify({ linter: { enabled: false } }));
		expect(projectEnforcesNoNestedTernary(dir)).toBe(false);
	});

	it("is true when set explicitly even with recommended off", () => {
		writeFileSync(
			join(dir, "biome.json"),
			JSON.stringify({ linter: { rules: { recommended: false, style: { noNestedTernary: "error" } } } }),
		);
		expect(projectEnforcesNoNestedTernary(dir)).toBe(true);
	});
});

describe("findTsconfigPathsForFile", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pit-cfg-paths-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("returns undefined when no tsconfig governs the file", () => {
		expect(findTsconfigPathsForFile(join(dir, "src", "app.ts"))).toBeUndefined();
	});

	it("reads paths with baseUrl resolved against the config dir", () => {
		writeFileSync(
			join(dir, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
		);
		const result = findTsconfigPathsForFile(join(dir, "src", "app.ts"));
		expect(result?.baseUrl).toBe(join(dir));
		expect(result?.paths).toEqual({ "@/*": ["src/*"] });
	});

	it("defaults baseUrl to the config dir when baseUrl is unset", () => {
		writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "~/*": ["./*"] } } }));
		expect(findTsconfigPathsForFile(join(dir, "a.ts"))?.baseUrl).toBe(join(dir));
	});

	it("parses JSONC comments (which break a plain JSON.parse)", () => {
		writeFileSync(
			join(dir, "tsconfig.json"),
			'{\n  // project config\n  "compilerOptions": {\n    /* alias map */\n    "paths": { "@/*": ["src/*"] }\n  }\n}',
		);
		expect(findTsconfigPathsForFile(join(dir, "app.ts"))?.paths).toEqual({ "@/*": ["src/*"] });
	});

	it("fails open (undefined) on a tsconfig the shared parser can't read (trailing commas)", () => {
		// The reused readJsonc strips comments but not trailing commas; an unparseable
		// config yields no mapping rather than throwing -> aliases simply ALLOW.
		writeFileSync(join(dir, "tsconfig.json"), '{\n  "compilerOptions": { "paths": { "@/*": ["src/*"], } },\n}');
		expect(findTsconfigPathsForFile(join(dir, "app.ts"))).toBeUndefined();
	});

	it("inherits paths through the extends chain", () => {
		writeFileSync(
			join(dir, "tsconfig.base.json"),
			JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"] } } }),
		);
		writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ extends: "./tsconfig.base.json" }));
		expect(findTsconfigPathsForFile(join(dir, "app.ts"))?.paths).toEqual({ "@/*": ["src/*"] });
	});

	it("uses the nearest config; a child without paths is authoritative (no paths)", () => {
		writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"] } } }));
		const sub = join(dir, "packages", "app");
		mkdirSync(sub, { recursive: true });
		writeFileSync(join(sub, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
		expect(findTsconfigPathsForFile(join(sub, "x.ts"))).toBeUndefined();
	});
});
