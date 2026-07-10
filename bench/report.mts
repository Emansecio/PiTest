/**
 * bench/report — gera um relatório detalhado (tempo / tokens / consumo / custo)
 * a partir dos result.json salvos por uma rodada. NÃO re-executa agentes.
 * Genérico sobre N agentes: mostra apenas os presentes nos dados.
 *
 * Uso:
 *   npx tsx bench/report.mts <outDir-da-rodada> [--out <arquivo.md>]
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type AgentId = "pit" | "cc" | "codex" | "droid" | "opencode";
const CANON: AgentId[] = ["pit", "cc", "codex", "droid", "opencode"];
const LABEL: Record<AgentId, string> = {
	pit: "Pit",
	cc: "Claude Code",
	codex: "Codex",
	droid: "Droid",
	opencode: "opencode",
};
const INVOCATION: Record<AgentId, { model: string; cmd: string }> = {
	pit: { model: "claude-opus-4-8", cmd: "pit --mode json --no-session --model <m>" },
	cc: { model: "opus", cmd: "claude -p --output-format stream-json --verbose --permission-mode bypassPermissions" },
	codex: { model: "gpt-5.5", cmd: "codex exec --json --dangerously-bypass-approvals-and-sandbox -C <dir>" },
	droid: { model: "claude-opus-4-8", cmd: "droid exec -o json --skip-permissions-unsafe --auto high -m <m> --cwd <dir>" },
	opencode: {
		model: "anthropic/claude-opus-4-1",
		cmd: "opencode run --format json --dangerously-skip-permissions -m <m> --dir <dir>",
	},
};

interface Run {
	agent: AgentId;
	available: boolean;
	oraclePass: boolean;
	wallMs: number;
	firstOutputMs?: number | null;
	firstEditMs?: number | null;
	turns: number;
	toolTotal: number;
	toolByCat: Record<string, number>;
	toolErrors: number;
	inTok: number;
	outTok: number;
	cacheReadTok: number;
	costUsd?: number;
	estCostUsd?: number;
	diff: { files: number; added: number; removed: number };
	quality?: { filesChecked: number; syntaxErrors: number; errorFiles: string[] };
	timedOut: boolean;
}
interface Scn {
	id: string;
	title: string;
	angle: string;
	runs: Run[];
}

function sum(xs: number[]): number {
	return xs.reduce((a, b) => a + b, 0);
}
function mean(xs: number[]): number {
	return xs.length ? sum(xs) / xs.length : 0;
}
function median(xs: number[]): number {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function min(xs: number[]): number {
	return xs.length ? Math.min(...xs) : 0;
}
function max(xs: number[]): number {
	return xs.length ? Math.max(...xs) : 0;
}
function fmt(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}
function s1(ms: number): string {
	return (ms / 1000).toFixed(1);
}
/** table separator row for a table with `cols` columns. */
function sep(cols: number): string {
	return `|${"-|".repeat(cols)}`;
}

function load(outDir: string): Scn[] {
	const dirs = readdirSync(outDir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(join(outDir, d.name, "result.json")))
		.map((d) => d.name)
		.sort();
	return dirs.map((name) => {
		const j = JSON.parse(readFileSync(join(outDir, name, "result.json"), "utf8"));
		return { id: j.id, title: j.title, angle: j.angle, runs: j.runs } as Scn;
	});
}

function runsOf(scns: Scn[], a: AgentId): Run[] {
	return scns.map((s) => s.runs.find((r) => r.agent === a)).filter((r): r is Run => !!r && r.available);
}

/** per-scenario winner on a "lower is better" axis, among passing agents only. */
function winnerLow(scn: Scn, pick: (r: Run) => number): AgentId | null {
	const rs = scn.runs.filter((r) => r.available && r.oraclePass);
	if (!rs.length) return null;
	let best: Run | null = null;
	let tie = false;
	for (const r of rs) {
		if (!best || pick(r) < pick(best)) {
			best = r;
			tie = false;
		} else if (pick(r) === pick(best)) tie = true;
	}
	return best && !tie ? best.agent : null;
}

function build(outDir: string): string {
	const scns = load(outDir);
	const L: string[] = [];
	const cell = (a: AgentId, fn: (r: Run | undefined) => string, s: Scn) => fn(s.runs.find((r) => r.agent === a));

	// Only the agents that actually appear in the data, in canonical order.
	const present = new Set<AgentId>();
	for (const s of scns) for (const r of s.runs) if (r.available) present.add(r.agent);
	const ORDER = CANON.filter((a) => present.has(a));
	const head = ORDER.map((a) => LABEL[a]).join(" | ");
	const sepM = sep(1 + ORDER.length); // | métrica | a1..an |

	const agg = (a: AgentId) => {
		const rs = runsOf(scns, a);
		return {
			pass: rs.filter((r) => r.oraclePass).length,
			ran: rs.length,
			wall: rs.map((r) => r.wallMs),
			firstEdit: rs.map((r) => r.firstEditMs).filter((x): x is number => typeof x === "number"),
			out: rs.map((r) => r.outTok),
			inn: rs.map((r) => r.inTok),
			cache: rs.map((r) => r.cacheReadTok),
			tools: rs.map((r) => r.toolTotal),
			errors: sum(rs.map((r) => r.toolErrors)),
			cost: rs.map((r) => r.costUsd).filter((x): x is number => typeof x === "number"),
			estCost: rs.map((r) => r.estCostUsd).filter((x): x is number => typeof x === "number"),
			churn: rs.map((r) => r.diff.added + r.diff.removed),
			netLoc: rs.map((r) => r.diff.added - r.diff.removed),
			filesChecked: sum(rs.map((r) => r.quality?.filesChecked ?? 0)),
			syntaxErrors: sum(rs.map((r) => r.quality?.syntaxErrors ?? 0)),
		};
	};
	const A = Object.fromEntries(ORDER.map((a) => [a, agg(a)])) as Record<AgentId, ReturnType<typeof agg>>;
	const n = scns.length;

	// ---- cabeçalho ----
	L.push(`# Relatório de Benchmark — ${ORDER.map((a) => LABEL[a]).join(" × ")}`);
	L.push("");
	L.push(`Gerado a partir de \`${outDir}\` · ${n} cenários × ${ORDER.length} agentes = ${n * ORDER.length} execuções.`);
	L.push("");
	L.push(
		"**Setup.** Mesma tarefa para todos, em sandboxes idênticos e isolados, com baseline `git` para medir o diff. Oráculo objetivo (Node zero-dep) roda FORA do agente — exit 0 = passou. Modelos default:",
	);
	L.push("");
	L.push("| agente | modelo | invocação headless |");
	L.push("|-|-|-|");
	for (const a of ORDER) L.push(`| ${LABEL[a]} | \`${INVOCATION[a].model}\` | \`${INVOCATION[a].cmd}\` |`);
	L.push("");

	// ---- sumário executivo (data-driven) ----
	L.push("## 1. Sumário executivo");
	L.push("");
	L.push(`- **Correção (oracle):** ${ORDER.map((a) => `${LABEL[a]} ${A[a].pass}/${n}`).join(" · ")}.`);
	const byWall = ORDER.filter((a) => A[a].wall.length > 0)
		.map((a) => ({ a, v: median(A[a].wall) }))
		.sort((x, y) => x.v - y.v);
	if (byWall.length >= 2) {
		const f = byWall[0];
		const slow = byWall[byWall.length - 1];
		L.push(
			`- **Tempo (wall, mediana):** mais rápido **${LABEL[f.a]} ${s1(f.v)}s**; mais lento ${LABEL[slow.a]} ${s1(slow.v)}s (~${(slow.v / Math.max(1, f.v)).toFixed(1)}× a diferença).`,
		);
	}
	const byOut = ORDER.filter((a) => A[a].out.length > 0)
		.map((a) => ({ a, v: sum(A[a].out) }))
		.sort((x, y) => x.v - y.v);
	if (byOut.length >= 2) {
		L.push(
			`- **Tokens de saída (total):** mais enxuto ${LABEL[byOut[0].a]} ${fmt(byOut[0].v)}; mais verboso ${LABEL[byOut[byOut.length - 1].a]} ${fmt(byOut[byOut.length - 1].v)}.`,
		);
	}
	const withCost = ORDER.filter((a) => A[a].cost.length > 0);
	L.push(
		withCost.length > 0
			? `- **Custo real (US$, só quem reporta no stream):** ${withCost.map((a) => `${LABEL[a]} $${sum(A[a].cost).toFixed(2)}`).join(" · ")}.`
			: "- **Custo real:** nenhum agente reportou custo em dólar no stream desta rodada.",
	);
	L.push(`- **Tool errors (suíte):** ${ORDER.map((a) => `${LABEL[a]} ${A[a].errors}`).join(" · ")}.`);
	L.push("");
	L.push("Tabela-mestre (agregados sobre os cenários, por agente):");
	L.push("");
	L.push(`| métrica | ${head} |`);
	L.push(sepM);
	const masterRow = (name: string, f: (x: ReturnType<typeof agg>) => string) =>
		L.push(`| ${name} | ${ORDER.map((a) => f(A[a])).join(" | ")} |`);
	masterRow("oracle PASS", (x) => `${x.pass}/${n}`);
	masterRow("wall total (s)", (x) => s1(sum(x.wall)));
	masterRow("wall mediana (s)", (x) => s1(median(x.wall)));
	masterRow("→ 1º edit mediana (s)§", (x) => (x.firstEdit.length ? s1(median(x.firstEdit)) : "n/d"));
	masterRow("tokens out total", (x) => fmt(sum(x.out)));
	masterRow("tokens out médio", (x) => fmt(mean(x.out)));
	masterRow("tokens in total (≈)†", (x) => fmt(sum(x.inn)));
	masterRow("cache-read total†", (x) => fmt(sum(x.cache)));
	masterRow("tool calls total‡", (x) => fmt(sum(x.tools)));
	masterRow("tool errors total", (x) => fmt(x.errors));
	masterRow("churn total (linhas ±)", (x) => fmt(sum(x.churn)));
	masterRow("syntax-err / arq. checados", (x) => `${x.syntaxErrors} / ${x.filesChecked}`);
	masterRow("custo real US$", (x) => (x.cost.length ? `$${sum(x.cost).toFixed(2)}` : "—"));
	masterRow("custo est. US$◊", (x) => (x.estCost.length ? `$${sum(x.estCost).toFixed(2)}` : "—"));
	L.push("");
	L.push(
		"† Tokens de entrada **não são comparáveis 1:1** entre os agentes (Pit reporta só o não-cacheado; Codex e Droid reportam contexto cumulativo; opencode reporta o contexto por step). Ver §5. ‡ Droid (`-o json`) não expõe eventos por-tool → tool calls = 0 (limite de medição, não zero real). § Droid não emite stream por-tool → latência até o 1º edit é **n/d**. ◊ Custo estimado a preço de tabela **público** (não o que se paga via Max/OAuth) — proxy comparável; ver §7.",
	);
	L.push("");

	// ---- tempo ----
	L.push("## 2. Tempo de execução (wall-clock)");
	L.push("");
	L.push(
		"O eixo mais limpo de comparação: tempo real de parede até a tarefa ficar pronta (inclui startup do CLI — e o Pit roda de fonte `tsx` interpretada, sem binário compilado).",
	);
	L.push("");
	L.push(`| # | cenário | ${head} | mais rápido |`);
	L.push(sep(3 + ORDER.length));
	let i = 0;
	for (const s of scns) {
		i++;
		const w = winnerLow(s, (r) => r.wallMs);
		L.push(
			`| ${i} | ${s.id} | ${ORDER.map((a) => cell(a, (r) => (r ? s1(r.wallMs) : "—"), s)).join(" | ")} | ${w ? LABEL[w] : "—"} |`,
		);
	}
	L.push(`| | **total (s)** | ${ORDER.map((a) => `**${s1(sum(A[a].wall))}**`).join(" | ")} | |`);
	L.push(
		`| | mediana / mín / máx (s) | ${ORDER.map((a) => `${s1(median(A[a].wall))} / ${s1(min(A[a].wall))} / ${s1(max(A[a].wall))}`).join(" | ")} | |`,
	);
	L.push("");
	const fastWins = ORDER.map((a) => scns.filter((s) => winnerLow(s, (r) => r.wallMs) === a).length);
	L.push(`Vitórias de velocidade (sem empate): ${ORDER.map((a, idx) => `${LABEL[a]} ${fastWins[idx]}`).join(" · ")} de ${n}.`);
	L.push("");

	// ---- tempo-para-código (latência até o 1º edit) ----
	L.push("## 3. Tempo-para-código (latência até a 1ª edição)");
	L.push("");
	L.push(
		"Wall-clock total mistura 'pensar' com 'startup do CLI'. Este eixo isola **quão rápido o harness começa a entregar código**: ms do spawn até o PRIMEIRO evento de edit/write no stream. Latência baixa = menos turnos de exploração antes de agir; alta = o harness lê/raciocina muito antes de tocar o arquivo. Droid não emite stream por-tool → **n/d**.",
	);
	L.push("");
	L.push(`| # | cenário | ${head} | mais rápido p/ código |`);
	L.push(sep(3 + ORDER.length));
	i = 0;
	for (const s of scns) {
		i++;
		const w = winnerLow(s, (r) => (typeof r.firstEditMs === "number" ? r.firstEditMs : Number.POSITIVE_INFINITY));
		L.push(
			`| ${i} | ${s.id} | ${ORDER.map((a) =>
				cell(a, (r) => (typeof r?.firstEditMs === "number" ? s1(r.firstEditMs) : r ? "n/d" : "—"), s),
			).join(" | ")} | ${w ? LABEL[w] : "—"} |`,
		);
	}
	L.push(
		`| | mediana / mín / máx (s) | ${ORDER.map((a) =>
			A[a].firstEdit.length ? `${s1(median(A[a].firstEdit))} / ${s1(min(A[a].firstEdit))} / ${s1(max(A[a].firstEdit))}` : "n/d",
		).join(" | ")} | |`,
	);
	L.push("");
	const ttfeWins = ORDER.map(
		(a) =>
			scns.filter(
				(s) => winnerLow(s, (r) => (typeof r.firstEditMs === "number" ? r.firstEditMs : Number.POSITIVE_INFINITY)) === a,
			).length,
	);
	L.push(`Mais rápido a produzir código (sem empate): ${ORDER.map((a, idx) => `${LABEL[a]} ${ttfeWins[idx]}`).join(" · ")} de ${n}.`);
	L.push("");

	// ---- tokens out ----
	L.push("## 4. Tokens de saída (gerados pelo modelo)");
	L.push("");
	L.push(
		"Quanto o modelo *escreveu* para resolver a tarefa (raciocínio + texto + tool-args). Comparável entre os agentes — proxy direto de verbosidade do harness.",
	);
	L.push("");
	L.push(`| # | cenário | ${head} | mais enxuto |`);
	L.push(sep(3 + ORDER.length));
	i = 0;
	for (const s of scns) {
		i++;
		const w = winnerLow(s, (r) => r.outTok);
		L.push(
			`| ${i} | ${s.id} | ${ORDER.map((a) => cell(a, (r) => (r ? fmt(r.outTok) : "—"), s)).join(" | ")} | ${w ? LABEL[w] : "—"} |`,
		);
	}
	L.push(`| | **total** | ${ORDER.map((a) => `**${fmt(sum(A[a].out))}**`).join(" | ")} | |`);
	L.push(`| | médio / mediana | ${ORDER.map((a) => `${fmt(mean(A[a].out))} / ${fmt(median(A[a].out))}`).join(" | ")} | |`);
	L.push("");

	// ---- tokens in / cache ----
	L.push("## 5. Tokens de entrada e cache (consumo de contexto)");
	L.push("");
	L.push(
		"Quanto contexto cada harness empurrou para o modelo. **Atenção à medição:** o Pit reporta só o input *não-cacheado* (o trabalho real aparece em `cache-read`); Codex/Droid reportam contexto *cumulativo*; opencode reporta o contexto por step. Não compare a coluna `in` diretamente — olhe `in + cache` como ordem de grandeza.",
	);
	L.push("");
	L.push(`| # | cenário | ${ORDER.map((a) => `${LABEL[a]} in/cache`).join(" | ")} |`);
	L.push(sep(2 + ORDER.length));
	i = 0;
	for (const s of scns) {
		i++;
		const c = (a: AgentId) => {
			const r = s.runs.find((x) => x.agent === a);
			return r ? `${fmt(r.inTok)} / ${fmt(r.cacheReadTok)}` : "—";
		};
		L.push(`| ${i} | ${s.id} | ${ORDER.map((a) => c(a)).join(" | ")} |`);
	}
	L.push(`| | **total in / cache** | ${ORDER.map((a) => `${fmt(sum(A[a].inn))} / ${fmt(sum(A[a].cache))}`).join(" | ")} |`);
	L.push("");
	L.push(
		`Contexto total processado (in + cache, ordem de grandeza): ${ORDER.map((a) => `${LABEL[a]} ${fmt(sum(A[a].inn) + sum(A[a].cache))}`).join(" · ")}.`,
	);
	L.push("");

	// ---- consumo de ferramentas ----
	L.push("## 6. Consumo de ferramentas");
	L.push("");
	L.push(
		"Número de tool-calls e como se distribuem. **Granularidade difere:** o Codex não tem Read/Edit dedicado (lê/edita via shell), e o Droid (`-o json`) não expõe eventos por-tool (conta 0). Por isso o total não é 1:1, mas a forma é reveladora.",
	);
	L.push("");
	L.push(`| # | cenário | ${head} | tool errors |`);
	L.push(sep(3 + ORDER.length));
	i = 0;
	for (const s of scns) {
		i++;
		const errs = ORDER.map((a) => s.runs.find((r) => r.agent === a)?.toolErrors ?? 0).join("/");
		L.push(
			`| ${i} | ${s.id} | ${ORDER.map((a) => cell(a, (r) => (r ? String(r.toolTotal) : "—"), s)).join(" | ")} | ${errs} |`,
		);
	}
	L.push(`| | **total** | ${ORDER.map((a) => `**${fmt(sum(A[a].tools))}**`).join(" | ")} | ${ORDER.map((a) => A[a].errors).join("/")} |`);
	L.push("");
	const catSum = (a: AgentId, cat: string) => sum(runsOf(scns, a).map((r) => r.toolByCat?.[cat] ?? 0));
	const cats = ["read", "edit", "write", "shell", "search", "list", "other"];
	L.push("Distribuição por categoria (total na suíte):");
	L.push("");
	L.push(`| categoria | ${head} |`);
	L.push(sepM);
	for (const cat of cats) {
		L.push(`| ${cat} | ${ORDER.map((a) => fmt(catSum(a, cat))).join(" | ")} |`);
	}
	L.push("");

	// ---- custo ----
	L.push("## 7. Custo");
	L.push("");
	L.push(
		"Dois números. **Custo estimado (◊)** aplica preço de tabela público da API (US$/Mtok: opus 15/75, sonnet 3/15, gpt-5/codex 1,25/10) aos tokens medidos — um proxy **uniforme** entre todos os agentes que responde \"quanto esta tarefa custaria a preço de API\". **Custo real** é o que o agente reportou no próprio stream (billing de verdade), disponível só para quem expõe. Aqui Pit/CC/opencode roteiam Anthropic via OAuth/Max (custo marginal $0 na prática) — por isso o estimado é o eixo comparável, e o componente mais limpo dele é o de **tokens de saída** (§4); a parcela de entrada herda o viés de medição da §5.",
	);
	L.push("");
	const withEst = ORDER.filter((a) => A[a].estCost.length > 0);
	if (withEst.length > 0) {
		L.push(`Custo **estimado** a preço de tabela (US$):`);
		L.push("");
		L.push(`| # | cenário | ${withEst.map((a) => LABEL[a]).join(" | ")} | mais barato |`);
		L.push(sep(3 + withEst.length));
		i = 0;
		for (const s of scns) {
			i++;
			const c = (a: AgentId) => {
				const r = s.runs.find((x) => x.agent === a);
				return typeof r?.estCostUsd === "number" ? `$${r.estCostUsd.toFixed(4)}` : "—";
			};
			const w = winnerLow(s, (r) => (typeof r.estCostUsd === "number" ? r.estCostUsd : Number.POSITIVE_INFINITY));
			L.push(`| ${i} | ${s.id} | ${withEst.map((a) => c(a)).join(" | ")} | ${w ? LABEL[w] : "—"} |`);
		}
		L.push(`| | **total** | ${withEst.map((a) => `**$${sum(A[a].estCost).toFixed(4)}**`).join(" | ")} | |`);
		L.push(`| | médio / tarefa | ${withEst.map((a) => `$${mean(A[a].estCost).toFixed(4)}`).join(" | ")} | |`);
		L.push("");
	}
	if (withCost.length === 0) {
		L.push(
			"Custo **real** no stream: nenhum agente reportou nesta rodada (Pit roda via OAuth/Max; Codex e Droid não expõem). Proxies comparáveis: custo estimado (acima), tokens de saída (§4) e tempo (§2).",
		);
	} else {
		L.push(
			`Custo **real** reportado no stream por: ${withCost.map((a) => LABEL[a]).join(", ")} (billing real). Os demais não expõem (Pit OAuth/Max; Codex/Droid sem custo no stream).`,
		);
		L.push("");
		L.push(`| # | cenário | ${withCost.map((a) => LABEL[a]).join(" | ")} |`);
		L.push(sep(2 + withCost.length));
		i = 0;
		for (const s of scns) {
			i++;
			const c = (a: AgentId) => {
				const r = s.runs.find((x) => x.agent === a);
				return typeof r?.costUsd === "number" ? `$${r.costUsd.toFixed(4)}` : "—";
			};
			L.push(`| ${i} | ${s.id} | ${withCost.map((a) => c(a)).join(" | ")} |`);
		}
		L.push(`| | **total** | ${withCost.map((a) => `**$${sum(A[a].cost).toFixed(4)}**`).join(" | ")} |`);
		L.push(`| | médio / tarefa | ${withCost.map((a) => `$${mean(A[a].cost).toFixed(4)}`).join(" | ")} |`);
	}
	L.push("");

	// ---- qualidade de código (syntax-gate + tamanho/churn) ----
	L.push("## 8. Qualidade e tamanho do código produzido");
	L.push("");
	L.push(
		"Dois sinais objetivos independentes do oráculo. **Syntax-gate:** todo arquivo `.mjs/.js` alterado passa por `node --check` (parse-only) — um harness que deixa uma edição malformada pontua erro aqui mesmo que o oráculo já fosse FAIL por outro motivo. **Tamanho/churn:** linhas adicionadas+removidas (churn) e net-LOC do diff — entre dois agentes que PASSAM, o de menor churn resolveu com menos código (menos superfície, menos risco). Inflar o diff para passar é penalizado na leitura, não no oráculo.",
	);
	L.push("");
	L.push(`| # | cenário | ${ORDER.map((a) => `${LABEL[a]} syntax`).join(" | ")} |`);
	L.push(sep(2 + ORDER.length));
	i = 0;
	for (const s of scns) {
		i++;
		const c = (a: AgentId) => {
			const r = s.runs.find((x) => x.agent === a);
			if (!r || !r.quality) return "—";
			if (r.quality.filesChecked === 0) return "—";
			if (r.quality.syntaxErrors === 0) return `✅ ${r.quality.filesChecked}`;
			return `❌ ${r.quality.syntaxErrors}/${r.quality.filesChecked}`;
		};
		L.push(`| ${i} | ${s.id} | ${ORDER.map((a) => c(a)).join(" | ")} |`);
	}
	L.push(`| | **syntax-err / checados** | ${ORDER.map((a) => `${A[a].syntaxErrors} / ${A[a].filesChecked}`).join(" | ")} |`);
	L.push("");
	L.push(`Churn do diff (linhas adicionadas + removidas na suíte; só código, sidecars excluídos):`);
	L.push("");
	L.push(`| métrica | ${head} |`);
	L.push(sepM);
	L.push(`| churn total (±linhas) | ${ORDER.map((a) => fmt(sum(A[a].churn))).join(" | ")} |`);
	L.push(`| churn médio / cenário | ${ORDER.map((a) => fmt(mean(A[a].churn))).join(" | ")} |`);
	L.push(`| net-LOC total (add−del) | ${ORDER.map((a) => fmt(sum(A[a].netLoc))).join(" | ")} |`);
	L.push("");

	// ---- detalhe por cenário ----
	L.push("## 9. Detalhe por cenário");
	L.push("");
	i = 0;
	for (const s of scns) {
		i++;
		L.push(`### ${i}. ${s.id} — ${s.title}`);
		L.push("");
		L.push(`*Ângulo:* ${s.angle}`);
		L.push("");
		L.push(`| métrica | ${head} |`);
		L.push(sepM);
		const row = (name: string, fn: (r: Run | undefined) => string) =>
			L.push(`| ${name} | ${ORDER.map((a) => fn(s.runs.find((r) => r.agent === a))).join(" | ")} |`);
		row("oracle", (r) => (r?.oraclePass ? "✅ PASS" : r ? "❌ FAIL" : "—"));
		row("wall (s)", (r) => (r ? s1(r.wallMs) : "—"));
		row("→ 1º edit (s)", (r) => (typeof r?.firstEditMs === "number" ? s1(r.firstEditMs) : r ? "n/d" : "—"));
		row("tokens out", (r) => (r ? fmt(r.outTok) : "—"));
		row("tokens in (≈)", (r) => (r ? fmt(r.inTok) : "—"));
		row("cache-read", (r) => (r ? fmt(r.cacheReadTok) : "—"));
		row("tool calls", (r) => (r ? String(r.toolTotal) : "—"));
		row("tool errors", (r) => (r ? String(r.toolErrors) : "—"));
		row("read/edit/shell/search", (r) => {
			if (!r) return "—";
			const c = r.toolByCat;
			return `${c.read ?? 0}/${(c.edit ?? 0) + (c.write ?? 0)}/${c.shell ?? 0}/${c.search ?? 0}`;
		});
		row("diff (files +/-)", (r) => (r ? `${r.diff.files} (+${r.diff.added}/-${r.diff.removed})` : "—"));
		row("syntax-check", (r) => {
			if (!r || !r.quality || r.quality.filesChecked === 0) return "—";
			if (r.quality.syntaxErrors === 0) return `✅ ${r.quality.filesChecked}`;
			return `❌ ${r.quality.syntaxErrors}/${r.quality.filesChecked}`;
		});
		row("custo real US$", (r) => (typeof r?.costUsd === "number" ? `$${r.costUsd.toFixed(4)}` : "—"));
		row("custo est. US$◊", (r) => (typeof r?.estCostUsd === "number" ? `$${r.estCostUsd.toFixed(4)}` : "—"));
		L.push("");
	}

	// ---- conclusão (data-driven) ----
	L.push("## 10. Conclusão");
	L.push("");
	const allPass = ORDER.every((a) => A[a].ran > 0 && A[a].pass === A[a].ran);
	if (allPass) {
		L.push(
			`Todos os agentes que rodaram acertaram todos os cenários — a tarefa não separa em **correção**. O que separa é a **eficiência do harness**:`,
		);
	} else {
		L.push(
			`Correção por agente: ${ORDER.map((a) => `${LABEL[a]} ${A[a].pass}/${n}`).join(" · ")}. Diferenças de correção + eficiência:`,
		);
	}
	L.push("");
	if (byWall.length >= 2) {
		const f = byWall[0];
		const slow = byWall[byWall.length - 1];
		L.push(
			`- **${LABEL[f.a]} é o mais rápido** (${fastWins[ORDER.indexOf(f.a)]}/${n} cenários; mediana ${s1(f.v)}s vs ${s1(slow.v)}s do ${LABEL[slow.a]}). O custo de uma tarefa de agente é dominado por round-trips de tool-call e re-prompt; o harness que corta esse overhead vence o relógio.`,
		);
	}
	if (byOut.length >= 2) {
		const lean = byOut[0];
		const verbose = byOut[byOut.length - 1];
		L.push(
			`- **${LABEL[verbose.a]} é o mais verboso em tokens de saída** (${fmt(sum(A[verbose.a].out))}, ~${(sum(A[verbose.a].out) / Math.max(1, sum(A[lean.a].out))).toFixed(1)}× o ${LABEL[lean.a]}, o mais enxuto) — verbosidade que vira custo e latência.`,
		);
	}
	const byEdit = ORDER.filter((a) => A[a].firstEdit.length > 0)
		.map((a) => ({ a, v: median(A[a].firstEdit) }))
		.sort((x, y) => x.v - y.v);
	if (byEdit.length >= 2) {
		const f = byEdit[0];
		const slow = byEdit[byEdit.length - 1];
		L.push(
			`- **${LABEL[f.a]} começa a escrever código mais cedo** (mediana ${s1(f.v)}s até o 1º edit, vs ${s1(slow.v)}s do ${LABEL[slow.a]}) — menos exploração antes de agir (§3).`,
		);
	}
	const byChurn = ORDER.filter((a) => A[a].churn.length > 0)
		.map((a) => ({ a, v: sum(A[a].churn) }))
		.sort((x, y) => x.v - y.v);
	if (byChurn.length >= 2) {
		const lean = byChurn[0];
		const fat = byChurn[byChurn.length - 1];
		L.push(
			`- **${LABEL[lean.a]} produz o diff mais enxuto** (${fmt(sum(A[lean.a].churn))} linhas de churn na suíte, vs ${fmt(sum(A[fat.a].churn))} do ${LABEL[fat.a]}) — menos código para o mesmo resultado, menos superfície de risco (§8).`,
		);
	}
	const totalSyntaxErr = sum(ORDER.map((a) => A[a].syntaxErrors));
	if (totalSyntaxErr === 0) {
		L.push("- **Syntax-gate:** nenhum agente deixou um arquivo malformado em toda a suíte (`node --check` limpo em todos os diffs).");
	} else {
		const worst = [...ORDER].sort((a, b) => A[b].syntaxErrors - A[a].syntaxErrors)[0];
		L.push(`- **Syntax-gate:** ${totalSyntaxErr} arquivo(s) malformado(s) no total; pior caso ${LABEL[worst]} (${A[worst].syntaxErrors}). Código que nem parseia (§8).`);
	}
	const errLeader = [...ORDER].sort((a, b) => A[b].errors - A[a].errors)[0];
	if (errLeader && A[errLeader].errors > 0) {
		L.push(`- **Tool errors:** ${LABEL[errLeader]} liderou com ${A[errLeader].errors}; os demais: ${ORDER.filter((a) => a !== errLeader).map((a) => `${LABEL[a]} ${A[a].errors}`).join(" · ")}.`);
	}
	L.push("");
	L.push(
		"**Ressalvas honestas.** (a) n=1 por cenário — sem repetição não há barra de erro, e wall-clock/latência têm variância de carga/rede. (b) Tokens de entrada não são comparáveis entre vendors/harnesses (§5). (c) Droid `-o json` não expõe tool-calls (conta 0) nem stream por-tool → latência-até-código n/d. (d) Custo real só é confiável para quem reporta no stream; o **custo estimado** (§7) usa preço de tabela público e herda o viés de tokens-in — leia-o como ordem de grandeza, com o componente de saída sendo o mais limpo. (e) O syntax-gate só roda em `.mjs/.js` (todos os seeds são JS) — é um piso de validade sintática, não prova semântica (isso é o oráculo). (f) Agentes podem aparecer com ❌ por falta de credencial/cota, não por falha de capacidade.",
	);
	L.push("");
	return L.join("\n");
}

function main(): void {
	const argv = process.argv.slice(2);
	const outDir = argv.find((a) => !a.startsWith("--"));
	const outIdx = argv.indexOf("--out");
	const file = outIdx >= 0 ? argv[outIdx + 1] : join(process.cwd(), "docs/reports/BENCHMARK-REPORT.md");
	if (!outDir || !existsSync(outDir)) {
		console.error("uso: npx tsx bench/report.mts <outDir-da-rodada> [--out <arquivo.md>]");
		process.exit(2);
	}
	const md = build(outDir);
	writeFileSync(file, md);
	console.error(`relatório escrito: ${file} (${md.length} bytes)`);
}

main();
