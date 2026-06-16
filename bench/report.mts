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
	turns: number;
	toolTotal: number;
	toolByCat: Record<string, number>;
	toolErrors: number;
	inTok: number;
	outTok: number;
	cacheReadTok: number;
	costUsd?: number;
	diff: { files: number; added: number; removed: number };
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
			out: rs.map((r) => r.outTok),
			inn: rs.map((r) => r.inTok),
			cache: rs.map((r) => r.cacheReadTok),
			tools: rs.map((r) => r.toolTotal),
			errors: sum(rs.map((r) => r.toolErrors)),
			cost: rs.map((r) => r.costUsd).filter((x): x is number => typeof x === "number"),
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
	masterRow("tokens out total", (x) => fmt(sum(x.out)));
	masterRow("tokens out médio", (x) => fmt(mean(x.out)));
	masterRow("tokens in total (≈)†", (x) => fmt(sum(x.inn)));
	masterRow("cache-read total†", (x) => fmt(sum(x.cache)));
	masterRow("tool calls total‡", (x) => fmt(sum(x.tools)));
	masterRow("tool errors total", (x) => fmt(x.errors));
	masterRow("custo real US$", (x) => (x.cost.length ? `$${sum(x.cost).toFixed(2)}` : "—"));
	L.push("");
	L.push(
		"† Tokens de entrada **não são comparáveis 1:1** entre os agentes (Pit reporta só o não-cacheado; Codex e Droid reportam contexto cumulativo; opencode reporta o contexto por step). Ver §4. ‡ Droid (`-o json`) não expõe eventos por-tool → tool calls = 0 (limite de medição, não zero real).",
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

	// ---- tokens out ----
	L.push("## 3. Tokens de saída (gerados pelo modelo)");
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
	L.push("## 4. Tokens de entrada e cache (consumo de contexto)");
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
	L.push("## 5. Consumo de ferramentas");
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
	L.push("## 6. Custo");
	L.push("");
	if (withCost.length === 0) {
		L.push(
			"Nenhum agente reportou custo em dólar no stream desta rodada (Pit roda via OAuth/Max; Codex e Droid não expõem custo). Os proxies comparáveis são **tokens de saída** (§3) e **tempo** (§2).",
		);
	} else {
		L.push(
			`Custo em dólar reportado no stream por: ${withCost.map((a) => LABEL[a]).join(", ")} (billing real). Os demais não expõem (Pit OAuth/Max; Codex/Droid sem custo no stream) — proxies comparáveis: tokens de saída (§3) e tempo (§2).`,
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

	// ---- detalhe por cenário ----
	L.push("## 7. Detalhe por cenário");
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
		row("custo US$", (r) => (typeof r?.costUsd === "number" ? `$${r.costUsd.toFixed(4)}` : "—"));
		L.push("");
	}

	// ---- conclusão (data-driven) ----
	L.push("## 8. Conclusão");
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
	const errLeader = [...ORDER].sort((a, b) => A[b].errors - A[a].errors)[0];
	if (errLeader && A[errLeader].errors > 0) {
		L.push(`- **Tool errors:** ${LABEL[errLeader]} liderou com ${A[errLeader].errors}; os demais: ${ORDER.filter((a) => a !== errLeader).map((a) => `${LABEL[a]} ${A[a].errors}`).join(" · ")}.`);
	}
	L.push("");
	L.push(
		"**Ressalvas honestas.** (a) n=1 por cenário — sem repetição não há barra de erro, e wall-clock tem variância de carga/rede. (b) Tokens de entrada não são comparáveis entre vendors/harnesses (§4). (c) Droid `-o json` não expõe tool-calls (conta 0). (d) Custo em dólar só é confiável para quem reporta no stream. (e) Agentes podem aparecer com ❌ por falta de credencial/cota (ex.: opencode + opus pendente de configurar), não por falha de capacidade.",
	);
	L.push("");
	return L.join("\n");
}

function main(): void {
	const argv = process.argv.slice(2);
	const outDir = argv.find((a) => !a.startsWith("--"));
	const outIdx = argv.indexOf("--out");
	const file = outIdx >= 0 ? argv[outIdx + 1] : join(process.cwd(), "BENCHMARK-REPORT.md");
	if (!outDir || !existsSync(outDir)) {
		console.error("uso: npx tsx bench/report.mts <outDir-da-rodada> [--out <arquivo.md>]");
		process.exit(2);
	}
	const md = build(outDir);
	writeFileSync(file, md);
	console.error(`relatório escrito: ${file} (${md.length} bytes)`);
}

main();
