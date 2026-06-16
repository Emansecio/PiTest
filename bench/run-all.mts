/**
 * bench/run-all — roda TODOS os cenários nos N agentes e gera um SCORECARD.
 *
 * Uso:
 *   npx tsx bench/run-all.mts [opções]
 *
 * Opções (além das do runner):
 *   --only a,b,c    roda só estes ids de cenário (substring match)
 *   --agents pit,cc,codex
 *   --pit-model / --cc-model / --codex-model / --thinking
 *   --timeout <seg>
 *   --out <dir>     diretório de saída (default <tmp>/bench-all-<ts>)
 *   --keep --dry
 *
 * Saída: SCORECARD.md + scorecard.json + um subdir por cenário com artefatos.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentId,
	AGENT_LABEL,
	type AgentModels,
	type AgentRun,
	ALL_AGENTS,
	DEFAULT_MODELS,
	loadScenario,
	modelsLine,
	SCENARIOS_DIR,
	zeroByAgent,
} from "./lib.mts";
import { renderScenarioReport, type RunOpts, runScenario, type ScenarioResult } from "./runner.mts";

function listScenarioDirs(): string[] {
	if (!existsSync(SCENARIOS_DIR)) return [];
	return readdirSync(SCENARIOS_DIR, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(join(SCENARIOS_DIR, d.name, "meta.json")))
		.map((d) => join(SCENARIOS_DIR, d.name))
		.sort();
}

interface AllOpts extends RunOpts {
	only: string[];
}

function parseAll(argv: string[]): AllOpts {
	const models: AgentModels = { ...DEFAULT_MODELS };
	let agents: AgentId[] = [...ALL_AGENTS];
	let timeoutSec: number | undefined;
	let keep = false;
	let dry = false;
	let out: string | undefined;
	let only: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--agents") agents = argv[++i].split(",").map((s) => s.trim()) as AgentId[];
		else if (a === "--pit-model") models.pit = argv[++i];
		else if (a === "--cc-model") models.cc = argv[++i];
		else if (a === "--codex-model") models.codex = argv[++i];
		else if (a === "--droid-model") models.droid = argv[++i];
		else if (a === "--opencode-model") models.opencode = argv[++i];
		else if (a === "--thinking") models.thinking = argv[++i];
		else if (a === "--timeout") timeoutSec = Number(argv[++i]);
		else if (a === "--out") out = argv[++i];
		else if (a === "--only") only = argv[++i].split(",").map((s) => s.trim());
		else if (a === "--keep") keep = true;
		else if (a === "--dry") dry = true;
	}
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const baseTmp = process.env.PIT_TMP_DIR || tmpdir();
	return { agents, models, timeoutSec, out: out ?? join(baseTmp, `bench-all-${ts}`), keep, dry, only };
}

function num(v: number | undefined): number {
	return typeof v === "number" ? v : 0;
}

/** Per-scenario "efficiency winner" among agents that PASSED the oracle. Ranked
 * by WALL CLOCK first — the only axis that is cleanly comparable across the three
 * (turns are not: Codex `exec` reports the whole agentic loop as 1 turn; tool
 * calls have different granularity since Codex reads/searches via shell). Ties
 * broken by output tokens, then tool calls. Being cheap while failing is not a
 * win — only passers are eligible. */
function efficiencyWinner(runs: AgentRun[]): AgentId | null {
	const passers = runs.filter((r) => r.available && r.oracle.pass);
	if (passers.length === 0) return null;
	passers.sort((a, b) => {
		if (Math.round(a.wallMs) !== Math.round(b.wallMs)) return a.wallMs - b.wallMs;
		if (num(a.metrics.outTok) !== num(b.metrics.outTok)) return num(a.metrics.outTok) - num(b.metrics.outTok);
		return a.metrics.toolTotal - b.metrics.toolTotal;
	});
	return passers[0].agent;
}

/** Per-axis winner among passers (lower is better for all of these). Returns the
 * agent with the min value, or null on tie/empty. Honest counterpoint to a single
 * composite ranking: different harnesses win different axes. */
function axisWinner(runs: AgentRun[], pick: (r: AgentRun) => number): AgentId | null {
	const passers = runs.filter((r) => r.available && r.oracle.pass);
	if (passers.length === 0) return null;
	let best: AgentRun | null = null;
	let tie = false;
	for (const r of passers) {
		if (!best || pick(r) < pick(best)) {
			best = r;
			tie = false;
		} else if (pick(r) === pick(best)) {
			tie = true;
		}
	}
	return best && !tie ? best.agent : null;
}

export function renderScorecard(results: ScenarioResult[], opts: { agents: AgentId[]; models: AgentModels }): string {
	const agents = opts.agents;
	const L: string[] = [];
	L.push("# Scorecard — Pit × Claude Code × Codex");
	L.push("");
	L.push(
		modelsLine(opts.models, agents),
	);
	L.push("");
	L.push(`gerado: ${new Date().toISOString()} · cenários: ${results.length}`);
	L.push("");

	// 1) Oracle pass matrix
	L.push("## 1. Oracle (passou a tarefa?)");
	L.push("");
	L.push(`| # | cenário | ângulo | ${agents.map((a) => AGENT_LABEL[a]).join(" | ")} | venc. eficiência |`);
	L.push(`|-|-|-${"|-".repeat(agents.length)}|-|`);
	const pass: Record<AgentId, number> = zeroByAgent();
	const effWins: Record<AgentId, number> = zeroByAgent();
	let idx = 0;
	for (const r of results) {
		idx++;
		const cells = agents.map((a) => {
			const run = r.runs.find((x) => x.agent === a);
			if (!run || !run.available) return "—";
			if (run.oracle.pass) {
				pass[a]++;
				return "✅";
			}
			return run.timedOut ? "⏱" : "❌";
		});
		const eff = efficiencyWinner(r.runs);
		if (eff) effWins[eff]++;
		L.push(`| ${idx} | ${r.scenario.id} | ${r.scenario.angle} | ${cells.join(" | ")} | ${eff ? AGENT_LABEL[eff] : "—"} |`);
	}
	L.push(`| | **total PASS** | | ${agents.map((a) => `**${pass[a]}/${results.length}**`).join(" | ")} | |`);
	L.push("");

	// 2) Efficiency (median-ish aggregate over passing runs)
	L.push("## 2. Eficiência do harness (médias sobre runs que PASSARAM)");
	L.push("");
	L.push(`| métrica | ${agents.map((a) => AGENT_LABEL[a]).join(" | ")} |`);
	L.push(`|-${"|-".repeat(agents.length)}|`);
	const avg = (a: AgentId, pick: (r: AgentRun) => number) => {
		const xs = results
			.flatMap((r) => r.runs.filter((x) => x.agent === a && x.available && x.oracle.pass))
			.map(pick);
		if (xs.length === 0) return "—";
		return (xs.reduce((s, v) => s + v, 0) / xs.length).toFixed(1);
	};
	const avgRow = (name: string, pick: (r: AgentRun) => number) =>
		L.push(`| ${name} | ${agents.map((a) => avg(a, pick)).join(" | ")} |`);
	avgRow("turnos (méd)", (r) => r.metrics.turns);
	avgRow("tool calls (méd)", (r) => r.metrics.toolTotal);
	avgRow("tool errors (méd)", (r) => r.metrics.toolErrors);
	avgRow("tokens out (méd)", (r) => num(r.metrics.outTok));
	avgRow("wall s (méd)", (r) => r.wallMs / 1000);
	avgRow("diff linhas ± (méd)", (r) => r.diff.added + r.diff.removed);
	L.push("");
	L.push(
		`**vitórias por wall-clock** (entre quem passou): ${agents.map((a) => `${AGENT_LABEL[a]} ${effWins[a]}`).join(" · ")}`,
	);
	L.push("");
	// Per-axis honesty: different harnesses win different axes. Tally a clear win
	// (no tie) on each comparable axis across the suite.
	const axes: Array<[string, (r: AgentRun) => number]> = [
		["wall-clock", (r) => r.wallMs],
		["tokens out", (r) => num(r.metrics.outTok)],
		["tool calls", (r) => r.metrics.toolTotal],
		["tool errors", (r) => r.metrics.toolErrors],
	];
	L.push("vitórias claras por eixo (sem empate), sobre os 10 cenários:");
	L.push("");
	L.push(`| eixo (menor = melhor) | ${agents.map((a) => AGENT_LABEL[a]).join(" | ")} |`);
	L.push(`|-${"|-".repeat(agents.length)}|`);
	for (const [name, pick] of axes) {
		const wins: Record<AgentId, number> = zeroByAgent();
		for (const r of results) {
			const w = axisWinner(r.runs, pick);
			if (w) wins[w]++;
		}
		L.push(`| ${name} | ${agents.map((a) => wins[a]).join(" | ")} |`);
	}
	L.push("");
	L.push(
		"_Nota: **turnos não entram no ranking** — não são comparáveis. O Codex `exec` reporta o loop agêntico inteiro como 1 turno, enquanto Pit/CC contam iterações do loop. Por isso o eixo limpo de tempo é o wall-clock. Tokens de entrada também não são 1:1 (Pit reporta só o não-cacheado; Codex reporta contexto cumulativo) — ver bench/README.md._",
	);
	L.push("");

	// 3) Harness-only signals (Pit)
	const pitRuns = results.flatMap((r) => r.runs.filter((x) => x.agent === "pit" && x.available));
	if (pitRuns.length > 0) {
		const sum = (pick: (r: AgentRun) => number) => pitRuns.reduce((s, r) => s + pick(r), 0);
		L.push("## 3. Sinais exclusivos do harness do Pit (total na suíte)");
		L.push("");
		L.push(
			`tool-rewrites=${sum((r) => r.metrics.rewrites)} · rejects=${sum((r) => r.metrics.rejects)} · error-hints=${sum((r) => r.metrics.errorHints)} · gate ${sum((r) => r.metrics.verifyPassed)}✓/${sum((r) => r.metrics.verifyFailed)}✗ · auto-retries=${sum((r) => r.metrics.retries)}`,
		);
		L.push("");
		L.push(
			"_Estes são mecanismos que CC/Codex não expõem no stream: reescrita preventiva de tool-call, bloqueio de call inválida, dica pós-erro, gate de verificação (typecheck/teste) e auto-retry. Cada um é uma chance a mais de acertar antes de declarar pronto._",
		);
		L.push("");
	}

	// 4) Per-scenario detail
	L.push("## 4. Detalhe por cenário");
	L.push("");
	for (const r of results) {
		L.push(renderScenarioReport(r, opts.models));
		L.push("");
	}
	return L.join("\n");
}

async function main(): Promise<void> {
	const opts = parseAll(process.argv.slice(2));
	mkdirSync(opts.out, { recursive: true });
	let dirs = listScenarioDirs();
	if (opts.only.length > 0) dirs = dirs.filter((d) => opts.only.some((o) => d.includes(o)));
	if (dirs.length === 0) {
		console.error(`nenhum cenário em ${SCENARIOS_DIR}${opts.only.length ? ` (filtro: ${opts.only.join(",")})` : ""}`);
		process.exit(1);
	}
	console.error(`\n=== bench: ${dirs.length} cenário(s) × ${opts.agents.length} agente(s) ===`);
	console.error(`saída: ${opts.out}\n`);
	const results: ScenarioResult[] = [];
	for (const dir of dirs) {
		const scenario = loadScenario(dir);
		console.error(`▶ ${scenario.id} — ${scenario.title}`);
		const result = await runScenario(scenario, { ...opts, out: opts.out });
		results.push(result);
	}
	const scorecard = renderScorecard(results, opts);
	writeFileSync(join(opts.out, "SCORECARD.md"), scorecard);
	writeFileSync(
		join(opts.out, "scorecard.json"),
		JSON.stringify(
			results.map((r) => ({
				id: r.scenario.id,
				angle: r.scenario.angle,
				runs: r.runs.map((x) => ({
					agent: x.agent,
					pass: x.oracle.pass,
					turns: x.metrics.turns,
					tools: x.metrics.toolTotal,
					toolErrors: x.metrics.toolErrors,
					outTok: x.metrics.outTok,
					wallMs: Math.round(x.wallMs),
				})),
			})),
			null,
			2,
		),
	);
	console.log(`\n${scorecard}`);
	console.log(`\nSCORECARD: ${join(opts.out, "SCORECARD.md")}`);
}

// Só executa quando invocado diretamente — importar este módulo (ex.: rescore.mts
// reusa renderScorecard) NÃO pode disparar a matriz inteira.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("run-all.mts")) {
	main().catch((e) => {
		console.error(e instanceof Error ? e.stack : String(e));
		process.exit(1);
	});
}
