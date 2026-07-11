import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve("tsx/esm")).href;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const aiEntryUrl = new URL("../src/index.ts", import.meta.url).href;

const SDK_SPECIFIERS = ["@anthropic-ai/sdk", "openai", "@google/genai"] as const;

type ProbeResult = {
	loadedSpecifiers: string[];
};

function runProbe(action: string): ProbeResult {
	const script = `
		import { registerHooks } from "node:module";

		const targets = new Set(${JSON.stringify(SDK_SPECIFIERS)});
		const loaded = [];

		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (targets.has(specifier)) {
					loaded.push(specifier);
				}
				return nextResolve(specifier, context);
			},
		});

		const mod = await import(${JSON.stringify(aiEntryUrl)});
		${action}
		console.log(JSON.stringify({ loadedSpecifiers: [...new Set(loaded)] }));
	`;

	const result = spawnSync(process.execPath, ["--import", tsxLoader, "--input-type=module", "--eval", script], {
		cwd: packageRoot,
		encoding: "utf8",
	});

	if (result.status !== 0) {
		throw new Error(`Probe failed (exit ${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	}

	const stdoutLines = result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const lastLine = stdoutLines.at(-1);
	if (!lastLine) {
		throw new Error(`Probe produced no output\nSTDERR:\n${result.stderr}`);
	}

	return JSON.parse(lastLine) as ProbeResult;
}

describe("lazy provider module loading", () => {
	it("does not load provider SDKs when importing the root barrel", () => {
		const result = runProbe("");
		expect(result.loadedSpecifiers).toEqual([]);
	});

	it("loads only the Anthropic SDK when calling the root lazy wrapper", () => {
		const result = runProbe(`
			const model = {
				id: "claude-sonnet-4-6",
				name: "Claude Sonnet 4",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 8192,
			};
			const context = { messages: [{ role: "user", content: "hi" }] };
			await mod.streamSimpleAnthropic(model, context).result();
		`);

		expect(result.loadedSpecifiers).toEqual(["@anthropic-ai/sdk"]);
	});

	it("loads only the Anthropic SDK when dispatching through streamSimple", () => {
		const result = runProbe(`
			const model = mod.getModel("anthropic", "claude-sonnet-4-6");
			const context = { messages: [{ role: "user", content: "hi" }] };
			await mod.streamSimple(model, context).result();
		`);

		expect(result.loadedSpecifiers).toEqual(["@anthropic-ai/sdk"]);
	});

	it("prewarmProviderModule loads the matching SDK and is idempotent", () => {
		const result = runProbe(`
			await mod.prewarmProviderModule("anthropic-messages");
			await mod.prewarmProviderModule("anthropic-messages");
		`);

		expect(result.loadedSpecifiers).toEqual(["@anthropic-ai/sdk"]);
	});

	it("prewarmProviderModule is a no-op for unknown APIs", () => {
		const result = runProbe(`
			await mod.prewarmProviderModule("custom-unknown-api");
		`);

		expect(result.loadedSpecifiers).toEqual([]);
	});
});

describe("lazy models.generated loading", () => {
	it("does not load models.generated when importing the root barrel", () => {
		const script = `
			import { registerHooks } from "node:module";
			const loaded = [];
			registerHooks({
				resolve(specifier, context, nextResolve) {
					// Match models.generated but not image-models.generated
					if (/(^|[\\\\/])models\\.generated\\./.test(specifier) || specifier === "./models.generated.ts" || specifier === "./models.generated.js") {
						loaded.push(specifier);
					}
					return nextResolve(specifier, context);
				},
			});
			await import(${JSON.stringify(aiEntryUrl)});
			console.log(JSON.stringify({ loaded }));
		`;
		const result = spawnSync(process.execPath, ["--import", tsxLoader, "--input-type=module", "--eval", script], {
			cwd: packageRoot,
			encoding: "utf8",
		});
		if (result.status !== 0) {
			throw new Error(`Probe failed\n${result.stdout}\n${result.stderr}`);
		}
		const lastLine = result.stdout
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean)
			.at(-1);
		const parsed = JSON.parse(lastLine!) as { loaded: string[] };
		expect(parsed.loaded).toEqual([]);
	});

	it("loads models.generated on first getModel call", () => {
		const script = `
			import { registerHooks } from "node:module";
			const loaded = [];
			registerHooks({
				resolve(specifier, context, nextResolve) {
					if (/(^|[\\\\/])models\\.generated\\./.test(specifier) || specifier === "./models.generated.ts" || specifier === "./models.generated.js") {
						loaded.push(specifier);
					}
					return nextResolve(specifier, context);
				},
			});
			const mod = await import(${JSON.stringify(aiEntryUrl)});
			mod.getModel("openai", "gpt-4o");
			console.log(JSON.stringify({ loaded: [...new Set(loaded)] }));
		`;
		const result = spawnSync(process.execPath, ["--import", tsxLoader, "--input-type=module", "--eval", script], {
			cwd: packageRoot,
			encoding: "utf8",
		});
		if (result.status !== 0) {
			throw new Error(`Probe failed\n${result.stdout}\n${result.stderr}`);
		}
		const lastLine = result.stdout
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean)
			.at(-1);
		const parsed = JSON.parse(lastLine!) as { loaded: string[] };
		expect(parsed.loaded.length).toBeGreaterThan(0);
	});
});
