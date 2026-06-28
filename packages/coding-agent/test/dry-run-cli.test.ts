/**
 * Dry-run contract tests.
 *
 * Most cases call `buildDryRunReport` in-process via `createAgentSessionServices`
 * (fast, no tsx spawn). One E2E smoke spawns the CLI to verify the full boot
 * path still works end-to-end.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sync as crossSpawnSync } from "cross-spawn";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDryRunReport, formatReportJson, formatReportText } from "../src/cli/dry-run/index.js";
import { createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { Settings } from "../src/core/settings-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const CLI_ENTRY = path.join(PROJECT_ROOT, "src", "cli.ts");
const TSX_BIN = path.resolve(PROJECT_ROOT, "../../node_modules/.bin/tsx");
const TSCONFIG = path.resolve(PROJECT_ROOT, "../../tsconfig.json");

function tsxAvailable(): boolean {
	const candidate = process.platform === "win32" ? `${TSX_BIN}.cmd` : TSX_BIN;
	return fs.existsSync(candidate) || fs.existsSync(TSX_BIN);
}

function cleanProviderEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const cleaned = { ...env };
	for (const key of Object.keys(cleaned)) {
		if (
			/(_API_KEY|_OAUTH_TOKEN|ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|AZURE_|AWS_|DEEPSEEK_|MOONSHOT_|KIMI_|MISTRAL_|MINIMAX_|GROQ_|CEREBRAS_|XAI_|FIREWORKS_|TOGETHER_|OPENROUTER_|AI_GATEWAY_|ZAI_|OPENCODE_|CLOUDFLARE_|XIAOMI_)/.test(
				key,
			)
		) {
			delete cleaned[key];
		}
	}
	return cleaned;
}

function runCliSpawn(args: string[], cwd: string, agentDir: string): { status: number; stdout: string } {
	const result = crossSpawnSync(TSX_BIN, ["--tsconfig", TSCONFIG, CLI_ENTRY, ...args], {
		cwd,
		env: {
			...cleanProviderEnv(process.env),
			PIT_CODING_AGENT_DIR: agentDir,
			PIT_OFFLINE: "1",
			PIT_SKIP_VERSION_CHECK: "1",
			PIT_DRY_RUN: "1",
			COLUMNS: "120",
			NO_COLOR: "1",
			FORCE_COLOR: "0",
		},
		encoding: "utf-8",
		timeout: 90_000,
	});
	return {
		status: typeof result.status === "number" ? result.status : -1,
		stdout: result.stdout ?? "",
	};
}

async function createDryRunServices(cwd: string, agentDir: string, settings: Partial<Settings> = {}) {
	const settingsManager = SettingsManager.inMemory(settings);
	const authStorage = AuthStorage.inMemory();
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	return createAgentSessionServices({
		cwd,
		agentDir,
		settingsManager,
		authStorage,
		modelRegistry,
		disableBuiltInExtensions: true,
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		},
	});
}

function dryRunExitCode(overallStatus: string): number {
	return overallStatus === "blocked" ? 1 : 0;
}

describe("pi --dry-run", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeAll(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dryrun-"));
		cwd = path.join(tempDir, "proj");
		agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });
	});

	afterAll(() => {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	});

	describe("in-process report builder", () => {
		it("returns JSON with overallStatus=blocked when no model resolves", async () => {
			const services = await createDryRunServices(cwd, agentDir);
			const report = buildDryRunReport({
				services,
				resolvedModel: undefined,
				resolvedToolNames: ["read", "bash"],
			});
			const stdout = formatReportJson(report).trim();
			expect(stdout.length).toBeGreaterThan(0);
			const parsed = JSON.parse(stdout) as {
				overallStatus: string;
				cwd: string;
				agentDir: string;
				checks: Array<{ name: string; status: string; detail: string }>;
			};
			expect(dryRunExitCode(parsed.overallStatus)).toBe(1);
			expect(parsed.overallStatus).toBe("blocked");
			expect(parsed.cwd).toBe(cwd);
			expect(parsed.checks.length).toBeGreaterThan(0);
			const modelCheck = parsed.checks.find((c) => c.name === "Model & auth");
			expect(modelCheck?.status).toBe("blocked");
			const detail = modelCheck?.detail.toLowerCase() ?? "";
			expect(detail.includes("no model") || detail.includes("missing api key")).toBe(true);
		});

		it("text format includes 'pit dry-run' header and tool list", async () => {
			const services = await createDryRunServices(cwd, agentDir);
			const report = buildDryRunReport({
				services,
				resolvedModel: undefined,
				resolvedToolNames: ["read"],
			});
			const text = formatReportText(report);
			expect(dryRunExitCode(report.overallStatus)).toBe(1);
			expect(text).toContain("pit dry-run");
			expect(text).toContain("Model & auth");
			expect(text).toContain("Permissions");
		});

		it("includes the configured permission mode in the Permissions detail", async () => {
			const services = await createDryRunServices(cwd, agentDir, {
				permissions: {
					mode: "plan",
					denyPaths: [{ glob: "**/.env" }],
				},
			});
			const report = buildDryRunReport({
				services,
				resolvedModel: undefined,
				resolvedToolNames: ["read"],
			});
			const permCheck = report.checks.find((c) => c.name === "Permissions");
			expect(permCheck?.detail).toContain("mode=plan");
			expect(permCheck?.detail).toContain("deny=1");
		});

		it("lists configured MCP servers without making network calls", async () => {
			const services = await createDryRunServices(cwd, agentDir, {
				mcp: {
					servers: {
						unreachable: { url: "http://127.0.0.1:1/never", timeoutMs: 1000 },
					},
				},
			});
			const t0 = Date.now();
			const report = buildDryRunReport({
				services,
				resolvedModel: undefined,
				resolvedToolNames: ["read"],
			});
			const elapsedMs = Date.now() - t0;
			expect(elapsedMs).toBeLessThan(2_000);
			const mcpCheck = report.checks.find((c) => c.name === "MCP servers");
			expect(mcpCheck?.detail).toContain("1 configured");
			expect(mcpCheck?.items?.[0].label).toBe("unreachable");
		});
	});

	const spawnSuite = tsxAvailable() ? describe : describe.skip;
	if (!tsxAvailable()) {
		console.warn(`[dry-run-cli] tsx not found at ${TSX_BIN} — skipping E2E smoke.`);
	}

	spawnSuite("E2E smoke (tsx spawn)", () => {
		it("blocked dry-run exits 1 through the real CLI entry", () => {
			const result = runCliSpawn(["--dry-run", "json", "--no-extensions", "--no-skills"], cwd, agentDir);
			expect(result.status).toBe(1);
			const report = JSON.parse(result.stdout.trim()) as { overallStatus: string };
			expect(report.overallStatus).toBe("blocked");
		});
	});
});
