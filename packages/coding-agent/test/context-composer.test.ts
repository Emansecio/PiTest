import { describe, expect, it } from "vitest";
import {
	type ComposeContextInput,
	composeContext,
	LEVEL_TOKEN_CAP,
	predictRelevantFiles,
} from "../src/core/conditioning/context-composer.ts";
import type { RepoMapDecl, RepoMapEntry } from "../src/core/repo-map/living-index.ts";

/** Terse RepoMapEntry builder: `decls` derived from `[kind, name, line]` triples. */
function entry(path: string, decls: Array<[string, string, number]>): RepoMapEntry {
	const d: RepoMapDecl[] = decls.map(([kind, name, line]) => ({ kind, name, line }));
	return { path, symbols: d.map((x) => x.name), decls: d, mtimeMs: 1 };
}

const MAP: RepoMapEntry[] = [
	entry("src/core/foo.ts", [
		["function", "computeThing", 10],
		["class", "FooEngine", 40],
	]),
	entry("src/core/bar.ts", [["const", "barHelper", 5]]),
	entry("src/util/helper.ts", [["function", "helperFn", 3]]),
];

const BASE: ComposeContextInput = { prompt: "", entries: MAP, env: {} };

describe("predictRelevantFiles", () => {
	it("picks a file whose path is mentioned in the prompt", () => {
		const predicted = predictRelevantFiles({
			...BASE,
			prompt: "please fix the bug in src/core/foo.ts around the engine",
		});
		expect(predicted).toContain("src/core/foo.ts");
	});

	it("picks a file whose declared symbol is mentioned in the prompt", () => {
		const predicted = predictRelevantFiles({ ...BASE, prompt: "the computeThing function returns the wrong value" });
		expect(predicted).toContain("src/core/foo.ts");
	});

	it("fuzzy-matches a lightly-misspelled path mention", () => {
		const predicted = predictRelevantFiles({ ...BASE, prompt: "look at src/utl/helper.ts" });
		expect(predicted).toContain("src/util/helper.ts");
	});

	it("includes session hot files that exist in the map", () => {
		const predicted = predictRelevantFiles({ ...BASE, prompt: "", frequentFiles: ["src/core/bar.ts"] });
		expect(predicted).toContain("src/core/bar.ts");
	});

	it("follows imports of the most-recently-read file to its neighbors", () => {
		const predicted = predictRelevantFiles({
			...BASE,
			recentReadPath: "src/core/entry.ts",
			recentReadContent: `import { barHelper } from "./bar.ts";\n`,
		});
		expect(predicted).toContain("src/core/bar.ts");
	});

	it("never re-surfaces the just-read file itself", () => {
		const predicted = predictRelevantFiles({
			...BASE,
			prompt: "edit src/core/foo.ts",
			recentReadPath: "src/core/foo.ts",
		});
		expect(predicted).not.toContain("src/core/foo.ts");
	});

	it("returns nothing for an empty map", () => {
		expect(predictRelevantFiles({ prompt: "src/core/foo.ts", entries: [], env: {} })).toEqual([]);
	});
});

describe("composeContext — assembler & budget", () => {
	it("renders a grounded_context block with real kind name:line outlines", () => {
		const r = composeContext({ ...BASE, prompt: "fix computeThing in src/core/foo.ts", level: "padrao" });
		expect(r.block).toContain("<grounded_context>");
		expect(r.block).toContain("src/core/foo.ts: function computeThing:10, class FooEngine:40");
		expect(r.predicted).toContain("src/core/foo.ts");
	});

	it("respects the thermostat-dosed token cap at every level", () => {
		// A prompt mentioning many files so the outline wants to exceed small caps.
		const bigMap: RepoMapEntry[] = [];
		const mentions: string[] = [];
		for (let i = 0; i < 60; i++) {
			const p = `src/mod/file${i}.ts`;
			bigMap.push(
				entry(p, [
					["function", `handler${i}`, i + 1],
					["const", `CONST_${i}`, i + 100],
				]),
			);
			mentions.push(p);
		}
		const prompt = mentions.join(" ");
		for (const level of ["assistido", "padrao", "leve"] as const) {
			// topK high so the token budget (not the predicted-file cap) is the binding constraint.
			const r = composeContext({ prompt, entries: bigMap, level, topK: 100, env: {} });
			expect(r.block.length).toBeLessThanOrEqual(LEVEL_TOKEN_CAP[level] * 4);
			expect(r.approxTokens).toBeLessThanOrEqual(LEVEL_TOKEN_CAP[level]);
		}
	});

	it("assistido fits at least as much as leve (more supervision → more truth)", () => {
		const bigMap: RepoMapEntry[] = [];
		const mentions: string[] = [];
		for (let i = 0; i < 60; i++) {
			const p = `src/mod/file${i}.ts`;
			bigMap.push(entry(p, [["function", `handler${i}`, i + 1]]));
			mentions.push(p);
		}
		const prompt = mentions.join(" ");
		const assistido = composeContext({ prompt, entries: bigMap, level: "assistido", topK: 100, env: {} });
		const leve = composeContext({ prompt, entries: bigMap, level: "leve", topK: 100, env: {} });
		expect(assistido.block.length).toBeGreaterThan(leve.block.length);
	});
});

describe("composeContext — fail-open", () => {
	it("empty map → empty block, zero cost", () => {
		const r = composeContext({ prompt: "anything", entries: [], env: {} });
		expect(r).toEqual({ block: "", predicted: [], approxTokens: 0 });
	});

	it("no prediction (empty prompt, no signals) → empty block", () => {
		const r = composeContext({ ...BASE, prompt: "", level: "padrao" });
		expect(r.block).toBe("");
	});
});

describe("composeContext — P3 style exemplar", () => {
	const files: Record<string, string> = {
		"src/foo.test.ts": "// target test\nimport x from 'x';\n",
		"src/bar.test.ts": Array.from({ length: 14 }, (_, i) => `const line${i} = ${i};`).join("\n"),
		"src/baz.ts": "export const plain = 1;\n",
	};
	const map: RepoMapEntry[] = [
		entry("src/foo.test.ts", [["const", "targetTest", 1]]),
		entry("src/bar.test.ts", [["const", "line0", 1]]),
		entry("src/baz.ts", [["const", "plain", 1]]),
	];
	const readFile = (p: string): string | null => files[p] ?? null;

	it("picks the same-suffix neighbor and emits a style_exemplar at padrao", () => {
		const r = composeContext({
			prompt: "",
			entries: map,
			level: "padrao",
			recentReadPath: "src/foo.test.ts",
			readFile,
			env: {},
		});
		expect(r.exemplarPath).toBe("src/bar.test.ts");
		expect(r.block).toContain("<style_exemplar>");
		expect(r.block).toContain("line0");
	});

	it("matches a dash-suffix pattern (*-extension.ts ↔ *-extension.ts)", () => {
		const dashFiles: Record<string, string> = {
			"src/b-extension.ts": Array.from({ length: 12 }, (_, i) => `const e${i} = ${i};`).join("\n"),
		};
		const dashMap: RepoMapEntry[] = [
			entry("src/a-extension.ts", [["const", "a", 1]]),
			entry("src/b-extension.ts", [["const", "b", 1]]),
			entry("src/c.ts", [["const", "c", 1]]),
		];
		const r = composeContext({
			prompt: "",
			entries: dashMap,
			level: "assistido",
			recentReadPath: "src/a-extension.ts",
			readFile: (p) => dashFiles[p] ?? null,
			env: {},
		});
		expect(r.exemplarPath).toBe("src/b-extension.ts");
	});

	it("is absent at the leve level (protected levels only)", () => {
		const r = composeContext({
			prompt: "",
			entries: map,
			level: "leve",
			recentReadPath: "src/foo.test.ts",
			readFile,
			env: {},
		});
		expect(r.exemplarPath).toBeUndefined();
		expect(r.block).toBe("");
	});
});

describe("composeContext — kill-switches", () => {
	it("PIT_NO_CONTEXT_COMPOSER=1 disables both blocks", () => {
		const r = composeContext({
			...BASE,
			prompt: "fix computeThing in src/core/foo.ts",
			level: "assistido",
			env: { PIT_NO_CONTEXT_COMPOSER: "1" },
		});
		expect(r.block).toBe("");
		expect(r.predicted).toEqual([]);
	});

	it("PIT_NO_STYLE_EXEMPLAR=1 keeps the outline but drops the exemplar", () => {
		const files: Record<string, string> = {
			"src/bar.test.ts": Array.from({ length: 14 }, (_, i) => `const l${i} = ${i};`).join("\n"),
		};
		const map: RepoMapEntry[] = [
			entry("src/foo.test.ts", [["const", "t", 1]]),
			entry("src/bar.test.ts", [["const", "line0", 1]]),
		];
		const r = composeContext({
			// Mention the neighbor (not the just-read file, which the predictor drops)
			// so the P1 outline has content to prove it survives the P3 kill-switch.
			prompt: "look at src/bar.test.ts",
			entries: map,
			level: "padrao",
			recentReadPath: "src/foo.test.ts",
			readFile: (p) => files[p] ?? null,
			env: { PIT_NO_STYLE_EXEMPLAR: "1" },
		});
		expect(r.block).toContain("<grounded_context>");
		expect(r.block).not.toContain("<style_exemplar>");
		expect(r.exemplarPath).toBeUndefined();
	});
});

describe("composeContext — determinism", () => {
	it("produces byte-identical output for identical inputs", () => {
		const input: ComposeContextInput = {
			prompt: "fix computeThing and barHelper in src/core/foo.ts and src/core/bar.ts",
			entries: MAP,
			level: "assistido",
			frequentFiles: ["src/util/helper.ts"],
			env: {},
		};
		const a = composeContext(input);
		const b = composeContext(input);
		expect(a.block).toBe(b.block);
		expect(a.predicted).toEqual(b.predicted);
	});
});
