/**
 * bench/rescore — re-gera o SCORECARD a partir dos result.json já salvos por uma
 * rodada anterior, SEM re-executar os agentes. Útil pra corrigir a apresentação
 * (métricas/ranking) sobre dados já medidos.
 *
 * Uso:
 *   npx tsx bench/rescore.mts <outDir-da-rodada> [--pit-model ...] [--cc-model ...] [--codex-model ...]
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentId,
	type AgentModels,
	type AgentRun,
	ALL_AGENTS,
	DEFAULT_MODELS,
	emptyMetrics,
	SCENARIOS_DIR,
} from "./lib.mts";
import { renderScorecard } from "./run-all.mts";
import type { ScenarioResult } from "./runner.mts";

function reconstructRun(j: any): AgentRun {
	const m = emptyMetrics();
	m.toolByCat = j.toolByCat ?? m.toolByCat;
	m.toolTotal = j.toolTotal ?? 0;
	m.toolErrors = j.toolErrors ?? 0;
	m.turns = j.turns ?? 0;
	m.inTok = j.inTok ?? 0;
	m.outTok = j.outTok ?? 0;
	m.cacheReadTok = j.cacheReadTok ?? 0;
	m.costUsd = j.costUsd;
	const h = j.harness ?? {};
	m.rewrites = h.rewrites ?? 0;
	m.rejects = h.rejects ?? 0;
	m.errorHints = h.errorHints ?? 0;
	m.verifyPassed = h.verifyPassed ?? 0;
	m.verifyFailed = h.verifyFailed ?? 0;
	m.retries = h.retries ?? 0;
	return {
		agent: j.agent,
		available: j.available ?? true,
		wallMs: j.wallMs ?? 0,
		exitCode: j.exitCode ?? null,
		timedOut: j.timedOut ?? false,
		metrics: m,
		diff: { files: j.diff?.files ?? 0, added: j.diff?.added ?? 0, removed: j.diff?.removed ?? 0, raw: "" },
		oracle: { pass: j.oraclePass ?? false, reason: j.oracleReason ?? "", raw: "", exitCode: j.oraclePass ? 0 : 1 },
	};
}

function loadPrompt(id: string): string {
	const p = join(SCENARIOS_DIR, id, "prompt.txt");
	return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
}

function parseModels(argv: string[]): AgentModels {
	const m: AgentModels = { ...DEFAULT_MODELS };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--pit-model") m.pit = argv[++i];
		else if (argv[i] === "--cc-model") m.cc = argv[++i];
		else if (argv[i] === "--codex-model") m.codex = argv[++i];
		else if (argv[i] === "--thinking") m.thinking = argv[++i];
	}
	return m;
}

function main(): void {
	const argv = process.argv.slice(2);
	const outDir = argv.find((a) => !a.startsWith("--"));
	if (!outDir || !existsSync(outDir)) {
		console.error("uso: npx tsx bench/rescore.mts <outDir-da-rodada>");
		process.exit(2);
	}
	const models = parseModels(argv);
	const results: ScenarioResult[] = [];
	const dirs = readdirSync(outDir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(join(outDir, d.name, "result.json")))
		.map((d) => d.name)
		.sort();
	const seenAgents = new Set<AgentId>();
	for (const name of dirs) {
		const j = JSON.parse(readFileSync(join(outDir, name, "result.json"), "utf8"));
		const runs = (j.runs ?? []).map(reconstructRun);
		for (const r of runs) seenAgents.add(r.agent);
		results.push({
			scenario: {
				id: j.id,
				dir: join(SCENARIOS_DIR, j.id),
				title: j.title,
				angle: j.angle,
				prompt: loadPrompt(j.id),
				timeoutSec: 600,
				oracle: "oracle.mjs",
			},
			runs,
			outDir: join(outDir, name),
		});
	}
	const agents = ALL_AGENTS.filter((a) => seenAgents.has(a));
	const scorecard = renderScorecard(results, { agents, models });
	writeFileSync(join(outDir, "SCORECARD.md"), scorecard);
	console.log(scorecard);
	console.error(`\nSCORECARD reescrito: ${join(outDir, "SCORECARD.md")}`);
}

main();
