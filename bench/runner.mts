/**
 * bench/runner — roda UM cenário em N agentes e emite o relatório do cenário.
 *
 * Uso:
 *   npx tsx bench/runner.mts <scenarioId|scenarioDir> [opções]
 *
 * Opções:
 *   --agents pit,cc,codex   quais harnesses rodar (default: todos disponíveis)
 *   --pit-model <id>        default claude-opus-4-8
 *   --cc-model <id>         default opus
 *   --codex-model <id>      default gpt-5.2-codex
 *   --thinking <lvl>        nível de thinking do Pit (ex.: high, xhigh)
 *   --timeout <seg>         teto por agente (default: meta.timeoutSec ou 600)
 *   --out <dir>             diretório de saída
 *   --keep                  preserva sandboxes
 *   --dry                   valida mecânica (sandbox/launchers) sem chamar LLM
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
	type AgentId,
	type AgentModels,
	type AgentRun,
	AGENT_LABEL,
	agentAvailable,
	ALL_AGENTS,
	buildLaunch,
	captureDiff,
	DEFAULT_MODELS,
	emptyMetrics,
	loadScenario,
	parseMetrics,
	prepareSandbox,
	runOracle,
	runProcess,
	type Scenario,
	SCENARIOS_DIR,
} from "./lib.mts";

export interface RunOpts {
	agents: AgentId[];
	models: AgentModels;
	timeoutSec?: number;
	out: string;
	keep: boolean;
	dry: boolean;
}

export interface ScenarioResult {
	scenario: Scenario;
	runs: AgentRun[];
	outDir: string;
}

function emptyRun(agent: AgentId, available: boolean): AgentRun {
	return {
		agent,
		available,
		wallMs: 0,
		exitCode: null,
		timedOut: false,
		metrics: emptyMetrics(),
		diff: { files: 0, added: 0, removed: 0, raw: "" },
		oracle: { pass: false, reason: available ? "(não rodado)" : "(CLI ausente)", raw: "", exitCode: null },
	};
}

export async function runScenario(scenario: Scenario, opts: RunOpts): Promise<ScenarioResult> {
	const outDir = join(opts.out, scenario.id);
	mkdirSync(outDir, { recursive: true });

	const seedDir = join(scenario.dir, "seed");
	const oracleAbs = join(scenario.dir, scenario.oracle);
	const timeoutSec = opts.timeoutSec ?? scenario.timeoutSec;

	// Pristine copy of the seed for oracle diffing (must-not-change files).
	const pristine = join(outDir, "_pristine");
	prepareSandbox(pristine, seedDir);

	const runs: AgentRun[] = [];
	for (const agent of opts.agents) {
		const available = agentAvailable(agent);
		if (!available) {
			process.stderr.write(`  · ${AGENT_LABEL[agent]}: CLI ausente — pulado\n`);
			runs.push(emptyRun(agent, false));
			continue;
		}
		const sandbox = join(outDir, agent);
		prepareSandbox(sandbox, seedDir);
		const launch = buildLaunch(agent, opts.models, sandbox);

		if (opts.dry) {
			process.stderr.write(`  · ${AGENT_LABEL[agent]} (dry): ${launch.command} ${launch.args.join(" ")}\n`);
			runs.push(emptyRun(agent, true));
			continue;
		}

		process.stderr.write(`  · ${AGENT_LABEL[agent]} rodando (timeout ${timeoutSec}s)…\n`);
		const raw = await runProcess(AGENT_LABEL[agent], launch, sandbox, scenario.prompt, timeoutSec);
		writeFileSync(join(outDir, `${agent}.jsonl`), raw.stdout);
		writeFileSync(join(outDir, `${agent}.err`), raw.stderr);
		const metrics = parseMetrics(agent, raw.stdout);
		const diff = captureDiff(sandbox);
		writeFileSync(join(outDir, `${agent}.diff`), diff.raw);
		const oracle = runOracle(oracleAbs, sandbox, pristine, 120);
		runs.push({
			agent,
			available: true,
			wallMs: raw.durationMs,
			exitCode: raw.exitCode,
			timedOut: raw.timedOut,
			metrics,
			diff,
			oracle,
		});
		const verdict = oracle.pass ? "PASS" : "FAIL";
		process.stderr.write(
			`    ${verdict} · ${(raw.durationMs / 1000).toFixed(0)}s · ${metrics.turns} turnos · ${metrics.toolTotal} tools (${metrics.toolErrors} err)${raw.timedOut ? " · TIMEOUT" : ""}\n`,
		);
	}

	const result: ScenarioResult = { scenario, runs, outDir };
	writeFileSync(join(outDir, "result.json"), JSON.stringify(serializeResult(result), null, 2));
	writeFileSync(join(outDir, "REPORT.md"), renderScenarioReport(result, opts.models));
	return result;
}

function serializeResult(r: ScenarioResult) {
	return {
		id: r.scenario.id,
		title: r.scenario.title,
		angle: r.scenario.angle,
		runs: r.runs.map((run) => ({
			agent: run.agent,
			available: run.available,
			oraclePass: run.oracle.pass,
			oracleReason: run.oracle.reason,
			wallMs: Math.round(run.wallMs),
			turns: run.metrics.turns,
			toolTotal: run.metrics.toolTotal,
			toolByCat: run.metrics.toolByCat,
			toolErrors: run.metrics.toolErrors,
			inTok: run.metrics.inTok,
			outTok: run.metrics.outTok,
			cacheReadTok: run.metrics.cacheReadTok,
			costUsd: run.metrics.costUsd,
			diff: { files: run.diff.files, added: run.diff.added, removed: run.diff.removed },
			timedOut: run.timedOut,
			exitCode: run.exitCode,
			harness: {
				rewrites: run.metrics.rewrites,
				rejects: run.metrics.rejects,
				errorHints: run.metrics.errorHints,
				verifyPassed: run.metrics.verifyPassed,
				verifyFailed: run.metrics.verifyFailed,
				retries: run.metrics.retries,
			},
			parseErrors: run.metrics.parseErrors,
		})),
	};
}

function col(v: number | string | undefined): string {
	return v === undefined ? "—" : String(v);
}

export function renderScenarioReport(r: ScenarioResult, models: AgentModels): string {
	const L: string[] = [];
	const present = r.runs.filter((x) => x.available);
	L.push(`## ${r.scenario.id} — ${r.scenario.title}`);
	L.push("");
	L.push(`**Ângulo:** ${r.scenario.angle}`);
	L.push("");
	L.push(`**Prompt:** ${r.scenario.prompt.replace(/\n/g, " ")}`);
	L.push("");
	L.push(
		`modelos: pit=\`${models.pit}\` · cc=\`${models.cc}\` · codex=\`${models.codex}\`${models.thinking ? ` · thinking=${models.thinking}` : ""}`,
	);
	L.push("");
	const head = present.map((x) => AGENT_LABEL[x.agent]);
	L.push(`| métrica | ${head.join(" | ")} |`);
	L.push(`|-${"|-".repeat(head.length)}|`);
	const row = (name: string, fn: (x: AgentRun) => string) => L.push(`| ${name} | ${present.map(fn).join(" | ")} |`);
	row("oracle", (x) => (x.oracle.pass ? "✅ PASS" : "❌ FAIL"));
	row("wall (s)", (x) => (x.wallMs / 1000).toFixed(0) + (x.timedOut ? " ⏱" : ""));
	row("turnos", (x) => col(x.metrics.turns));
	row("tool calls", (x) => col(x.metrics.toolTotal));
	row("tool errors", (x) => col(x.metrics.toolErrors));
	row("read/edit/shell/search", (x) => {
		const c = x.metrics.toolByCat;
		return `${c.read}/${c.edit + c.write}/${c.shell}/${c.search}`;
	});
	row("tokens out", (x) => col(x.metrics.outTok));
	row("tokens in (≈)", (x) => col(x.metrics.inTok));
	row("diff (files +/-)", (x) => `${x.diff.files} (+${x.diff.added}/-${x.diff.removed})`);
	L.push("");
	const pit = present.find((x) => x.agent === "pit");
	if (pit) {
		const h = pit.metrics;
		L.push(
			`harness-only (Pit): rewrites=${h.rewrites} · rejects=${h.rejects} · error-hints=${h.errorHints} · gate=${h.verifyPassed}✓/${h.verifyFailed}✗ · retries=${h.retries}`,
		);
		L.push("");
	}
	for (const x of present) {
		if (!x.oracle.pass) L.push(`- ${AGENT_LABEL[x.agent]} oracle: ${x.oracle.reason}`);
	}
	if (present.some((x) => !x.oracle.pass)) L.push("");
	return L.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function resolveScenarioDir(arg: string): string {
	if (isAbsolute(arg) && existsSync(join(arg, "meta.json"))) return arg;
	const byId = join(SCENARIOS_DIR, arg);
	if (existsSync(join(byId, "meta.json"))) return byId;
	const asRel = resolve(process.cwd(), arg);
	if (existsSync(join(asRel, "meta.json"))) return asRel;
	throw new Error(`cenário não encontrado: ${arg}`);
}

export function parseRunOpts(argv: string[]): { scenarioArg: string; opts: RunOpts } {
	const models: AgentModels = { ...DEFAULT_MODELS };
	let agents: AgentId[] = [...ALL_AGENTS];
	let timeoutSec: number | undefined;
	let keep = false;
	let dry = false;
	let out: string | undefined;
	const positionals: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--agents") agents = argv[++i].split(",").map((s) => s.trim()) as AgentId[];
		else if (a === "--pit-model") models.pit = argv[++i];
		else if (a === "--cc-model") models.cc = argv[++i];
		else if (a === "--codex-model") models.codex = argv[++i];
		else if (a === "--thinking") models.thinking = argv[++i];
		else if (a === "--timeout") timeoutSec = Number(argv[++i]);
		else if (a === "--out") out = argv[++i];
		else if (a === "--keep") keep = true;
		else if (a === "--dry") dry = true;
		else positionals.push(a);
	}
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const baseTmp = process.env.PIT_TMP_DIR || tmpdir();
	return {
		scenarioArg: positionals.join(" ").trim(),
		opts: { agents, models, timeoutSec, out: out ?? join(baseTmp, `bench-${ts}`), keep, dry },
	};
}

async function main(): Promise<void> {
	const { scenarioArg, opts } = parseRunOpts(process.argv.slice(2));
	if (!scenarioArg) {
		console.error("uso: npx tsx bench/runner.mts <scenarioId> [--agents pit,cc,codex] [--dry]");
		process.exit(2);
	}
	const dir = resolveScenarioDir(scenarioArg);
	const scenario = loadScenario(dir);
	console.error(`\n▶ ${scenario.id} — ${scenario.title}\n  saída: ${opts.out}`);
	const result = await runScenario(scenario, opts);
	console.log(`\n${renderScenarioReport(result, opts.models)}`);
	console.log(`\nartefatos: ${result.outDir}`);
}

// run as CLI only when invoked directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("runner.mts")) {
	main().catch((e) => {
		console.error(e instanceof Error ? e.stack : String(e));
		process.exit(1);
	});
}
