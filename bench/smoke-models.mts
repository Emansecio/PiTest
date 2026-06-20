/**
 * bench/smoke-models — probe REAL e leve de cada CLI com o modelo configurado.
 * Manda um prompt trivial ("responda OK") via a MESMA cadeia de launch do bench
 * e classifica o resultado: o agente autentica e o modelo responde, ou falha —
 * e por quê (auth / cota Max / rate-limit / overloaded / config / timeout).
 *
 * Sequencial de propósito: não dispara probes Opus em paralelo (evita competir
 * por cota com um bug-hunt em andamento e evita falso-negativo por rate-limit).
 *
 * Uso: npx tsx bench/smoke-models.mts [--agents pit,cc,droid,opencode] [--timeout 90]
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentId,
	AGENT_LABEL,
	agentAvailable,
	ALL_AGENTS,
	buildLaunch,
	DEFAULT_MODELS,
	modelOf,
	parseMetrics,
	runProcess,
} from "./lib.mts";

const PROMPT = "Responda APENAS com a palavra OK, sem mais nada e sem usar ferramentas.";

interface Probe {
	agent: AgentId;
	model: string;
	status: string;
	detail: string;
	wallS: string;
	outTok: number;
}

/** Classifies the raw run into a human verdict. The order matters: explicit
 * error signatures win over a 0 exit (a CLI can exit 0 while the stream carries
 * an error event). */
function classify(
	exitCode: number | null,
	timedOut: boolean,
	stdout: string,
	stderr: string,
	outTok: number,
): { status: string; detail: string } {
	const blob = `${stdout}\n${stderr}`.toLowerCase();
	const tail = stderr.trim().split("\n").slice(-1)[0]?.slice(0, 160) ?? "";
	if (timedOut) return { status: "⏱ TIMEOUT", detail: "não respondeu dentro do limite" };
	// Geração de tokens é prova direta de que autenticou e o modelo respondeu —
	// vence qualquer string ambígua no stream (ex.: o `rate_limit_event` de
	// utilização que a CLI do Claude SEMPRE emite e NÃO é um erro).
	if (outTok > 0) return { status: "✅ OK", detail: `modelo gerou ${outTok} tokens de saída` };
	if (/out of extra usage|credit balance|insufficient.*quota/.test(blob))
		return { status: "💸 COTA", detail: "cota Max/overage esgotada (não é falha de capacidade)" };
	if (/overloaded|"?529"?/.test(blob)) return { status: "🔁 OVERLOADED", detail: "Anthropic sobrecarregada (intermitente)" };
	// Só um erro REAL de limite (não o evento informativo `rate_limit_event`).
	if (/rate limit (reached|exceeded)|usage limit reached|too many requests|"?429"?/.test(blob))
		return { status: "🚦 RATE-LIMIT", detail: "rate-limit real (pode ser o bug-hunt consumindo agora)" };
	if (/401|unauthorized|authentication_error|not authenticated|please run.*login|no api key|missing api key/.test(blob))
		return { status: "🔑 AUTH", detail: tail || "credencial ausente/inválida" };
	if (/cli-proxy-api|proxy.*not found|exec failed/.test(blob))
		return { status: "🔧 SETUP", detail: tail || "proxy/binário do agente ausente — problema de instalação" };
	if (/403|forbidden|permission denied/.test(blob)) return { status: "⛔ 403", detail: tail || "acesso negado" };
	if (/unknown model|invalid model|model.*not found/.test(blob))
		return { status: "❓ MODELO", detail: tail || "modelo não reconhecido pela CLI" };
	if (exitCode === 0 && stdout.trim().length > 0)
		return { status: "✅ OK", detail: "exit 0 com saída (sem contagem de tokens no stream)" };
	return { status: "⚠ DESCONHECIDO", detail: tail || `exit ${exitCode}, sem saída útil` };
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	let agents: AgentId[] = [...ALL_AGENTS];
	let timeoutSec = 90;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--agents") agents = argv[++i].split(",").map((s) => s.trim()) as AgentId[];
		else if (argv[i] === "--timeout") timeoutSec = Number(argv[++i]);
	}

	console.error(`\n=== smoke de modelos · prompt trivial · timeout ${timeoutSec}s · SEQUENCIAL ===`);
	console.error("(pit/cc/droid/opencode compartilham a cota Anthropic Max; codex usa OpenAI)\n");

	const results: Probe[] = [];
	for (const agent of agents) {
		const model = modelOf(DEFAULT_MODELS, agent);
		if (!agentAvailable(agent)) {
			results.push({ agent, model, status: "— ausente", detail: "CLI não encontrada no PATH", wallS: "—", outTok: 0 });
			console.error(`· ${AGENT_LABEL[agent]}: CLI ausente`);
			continue;
		}
		const sandbox = mkdtempSync(join(tmpdir(), `smoke-${agent}-`));
		try {
			execSync("git init -q", { cwd: sandbox });
		} catch {
			// git ausente não impede o probe do modelo
		}
		console.error(`· ${AGENT_LABEL[agent]} (${model}) probando…`);
		const launch = buildLaunch(agent, DEFAULT_MODELS, sandbox);
		const raw = await runProcess(AGENT_LABEL[agent], launch, sandbox, PROMPT, timeoutSec);
		const m = parseMetrics(agent, raw.stdout);
		const { status, detail } = classify(raw.exitCode, raw.timedOut, raw.stdout, raw.stderr, m.outTok);
		results.push({ agent, model, status, detail, wallS: (raw.durationMs / 1000).toFixed(0), outTok: m.outTok });
		console.error(`  ${status} · ${(raw.durationMs / 1000).toFixed(0)}s · ${detail}`);
		rmSync(sandbox, { recursive: true, force: true });
	}

	console.log("\n## Smoke de modelos\n");
	console.log("| agente | modelo | status | tokens out | wall (s) | detalhe |");
	console.log("|-|-|-|-|-|-|");
	for (const r of results) {
		console.log(`| ${AGENT_LABEL[r.agent]} | \`${r.model}\` | ${r.status} | ${r.outTok} | ${r.wallS} | ${r.detail} |`);
	}
	const okCount = results.filter((r) => r.status.includes("OK")).length;
	console.log(`\n**${okCount}/${results.length}** agente(s) responderam. Pronto p/ disparar a matriz nos que deram ✅ OK.`);
}

main().catch((e) => {
	console.error(e instanceof Error ? e.stack : String(e));
	process.exit(1);
});
