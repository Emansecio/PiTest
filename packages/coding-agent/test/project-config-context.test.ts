import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjectConfigContext } from "../src/core/project-config-context.js";

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
});
