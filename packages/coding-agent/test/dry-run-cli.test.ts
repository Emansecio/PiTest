/**
 * E2E smoke for `pi --dry-run`.
 *
 * Spawns the CLI via `tsx src/cli.ts` with an isolated agent directory and
 * cwd so we don't read the developer's settings.json. Asserts the JSON
 * report shape, key checks, and exit code semantics.
 *
 * No model is configured so the report is expected to be "blocked" (no
 * model resolved) — the test asserts that as the canonical failure path.
 * Auth-less runs are exactly what users hit when they install Pi and try it
 * without setting up a provider yet.
 *
 * The test is skipped when the tsx binary cannot be located so external
 * builds (e.g. running tests against a published tarball) don't fail.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sync as crossSpawnSync } from "cross-spawn";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const CLI_ENTRY = path.join(PROJECT_ROOT, "src", "cli.ts");
const TSX_BIN = path.resolve(PROJECT_ROOT, "../../node_modules/.bin/tsx");

function tsxAvailable(): boolean {
	const candidate = process.platform === "win32" ? `${TSX_BIN}.cmd` : TSX_BIN;
	return fs.existsSync(candidate) || fs.existsSync(TSX_BIN);
}

interface RunResult {
	status: number;
	stdout: string;
	stderr: string;
}

/**
 * Strip every provider env var so the spawned CLI cannot resolve auth from
 * the developer's shell. Without this the test would inherit
 * ANTHROPIC_API_KEY / OPENAI_API_KEY / etc. and the "blocked" assertion
 * would fail because a model resolved successfully.
 */
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

function runCli(args: string[], cwd: string, agentDir: string): RunResult {
	const result = crossSpawnSync(TSX_BIN, [CLI_ENTRY, ...args], {
		cwd,
		env: {
			...cleanProviderEnv(process.env),
			PIT_CODING_AGENT_DIR: agentDir,
			PIT_OFFLINE: "1",
			PIT_SKIP_VERSION_CHECK: "1",
			PIT_DRY_RUN: "1",
			// Force a deterministic terminal width so wrapped output doesn't break
			// substring assertions.
			COLUMNS: "120",
			// Disable colors so the text format includes no ANSI escapes.
			NO_COLOR: "1",
			FORCE_COLOR: "0",
		},
		encoding: "utf-8",
		timeout: 60_000,
	});
	return {
		status: typeof result.status === "number" ? result.status : -1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

describe("pi --dry-run (E2E)", () => {
	const available = tsxAvailable();
	const suite = available ? describe : describe.skip;
	if (!available) {
		// vitest still emits this describe so CI surfaces the skip.
		console.warn(`[dry-run-cli] tsx not found at ${TSX_BIN} — skipping E2E.`);
	}

	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeAll(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dryrun-e2e-"));
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

	suite("with no model configured", () => {
		it("returns JSON with overallStatus=blocked and exit code 1", () => {
			const result = runCli(["--dry-run", "json", "--no-extensions", "--no-skills"], cwd, agentDir);
			expect(result.status).toBe(1);
			const stdout = result.stdout.trim();
			expect(stdout.length).toBeGreaterThan(0);
			const report = JSON.parse(stdout) as {
				overallStatus: string;
				cwd: string;
				agentDir: string;
				checks: Array<{ name: string; status: string; detail: string }>;
			};
			expect(report.overallStatus).toBe("blocked");
			expect(report.cwd).toBe(cwd);
			expect(report.checks.length).toBeGreaterThan(0);
			const modelCheck = report.checks.find((c) => c.name === "Model & auth");
			expect(modelCheck?.status).toBe("blocked");
			// Detail mentions either "no model" (none resolved) or "missing api key" (placeholder model selected but auth absent).
			const detail = modelCheck?.detail.toLowerCase() ?? "";
			expect(detail.includes("no model") || detail.includes("missing api key")).toBe(true);
		});

		it("text format includes 'pi dry-run' header and tool list", () => {
			const result = runCli(["--dry-run", "text", "--no-extensions", "--no-skills"], cwd, agentDir);
			expect(result.status).toBe(1);
			expect(result.stdout).toContain("pi dry-run");
			expect(result.stdout).toContain("Model & auth");
			expect(result.stdout).toContain("Permissions");
		});
	});

	suite("with permissions configured", () => {
		it("includes the configured mode in the Permissions detail", () => {
			const settings = {
				permissions: {
					mode: "plan",
					denyPaths: [{ glob: "**/.env" }],
				},
			};
			fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
			const result = runCli(["--dry-run", "json", "--no-extensions", "--no-skills"], cwd, agentDir);
			const stdout = result.stdout.trim();
			expect(stdout.length).toBeGreaterThan(0);
			const report = JSON.parse(stdout) as {
				checks: Array<{ name: string; detail: string }>;
			};
			const permCheck = report.checks.find((c) => c.name === "Permissions");
			expect(permCheck?.detail).toContain("mode=plan");
			expect(permCheck?.detail).toContain("deny=1");
			// Reset settings for following tests.
			fs.unlinkSync(path.join(agentDir, "settings.json"));
		});
	});

	suite("MCP servers in settings", () => {
		it("lists configured MCP servers without making network calls", () => {
			const settings = {
				mcp: {
					servers: {
						unreachable: { url: "http://127.0.0.1:1/never", timeoutMs: 1000 },
					},
				},
			};
			fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
			const t0 = Date.now();
			const result = runCli(["--dry-run", "json", "--no-extensions", "--no-skills"], cwd, agentDir);
			const elapsedMs = Date.now() - t0;
			// PIT_DRY_RUN=1 guards MCP connectAll so we should finish well under
			// the 1s timeout that would otherwise apply.
			expect(elapsedMs).toBeLessThan(15_000);
			const stdout = result.stdout.trim();
			expect(stdout.length).toBeGreaterThan(0);
			const report = JSON.parse(stdout) as {
				checks: Array<{ name: string; detail: string; items?: Array<{ label: string; value: string }> }>;
			};
			const mcpCheck = report.checks.find((c) => c.name === "MCP servers");
			expect(mcpCheck?.detail).toContain("1 configured");
			expect(mcpCheck?.items?.[0].label).toBe("unreachable");
			fs.unlinkSync(path.join(agentDir, "settings.json"));
		});
	});
});
