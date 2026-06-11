/**
 * compare-harness — roda o MESMO prompt no harness do Pit (local) e no do
 * Claude Code, em sandboxes idênticos e isolados, e imprime uma comparação
 * lado-a-lado (tool calls, erros, turnos, tokens, wall-clock, diff de código).
 *
 * O ponto: fixando o MESMO modelo nos dois lados, a diferença observada é do
 * HARNESS — system prompt, toolset, tool-rewrite, gate de verificação,
 * compaction — não da LLM.
 *
 * Uso:
 *   npx tsx scripts/compare-harness.mts "<prompt>" [opções]
 *
 * Opções:
 *   --model <id>     modelo do Pit         (default: claude-opus-4-8)
 *   --cc-model <id>  modelo do Claude Code (default: opus)
 *   --cc-permission <m>  permission-mode do Claude Code (default: acceptEdits;
 *                    use bypassPermissions p/ tarefas que rodam comandos/testes)
 *   --seed <dir>     diretório-template copiado p/ cada sandbox (estado inicial
 *                    idêntico). Sem isto, cada sandbox começa vazio + TASK.md.
 *   --thinking <lvl> nível de thinking do Pit (ex.: high, xhigh)
 *   --timeout <seg>  teto por agente (default: 900)
 *   --pit-only | --cc-only   roda só um lado
 *   --keep           não apaga os sandboxes ao final
 *   --dry            valida a mecânica (sandbox/git/launchers) sem chamar a LLM
 *   --out <dir>      diretório de saída (default: <tmp>/compare-harness-<ts>)
 *
 * Artefatos por run: pit.jsonl/pit.diff/pit.err, cc.jsonl/cc.diff/cc.err, REPORT.md
 */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const IS_WIN = process.platform === "win32";

interface Opts {
	prompt: string;
	model: string;
	ccModel: string;
	ccPermission: string;
	seed?: string;
	thinking?: string;
	timeoutSec: number;
	pitOnly: boolean;
	ccOnly: boolean;
	keep: boolean;
	dry: boolean;
	out?: string;
}

function parseArgs(argv: string[]): Opts {
	const positionals: string[] = [];
	const o: Opts = {
		prompt: "",
		model: "claude-opus-4-8",
		ccModel: "opus",
		ccPermission: "acceptEdits",
		timeoutSec: 900,
		pitOnly: false,
		ccOnly: false,
		keep: false,
		dry: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--model") o.model = argv[++i];
		else if (a === "--cc-model") o.ccModel = argv[++i];
		else if (a === "--cc-permission") o.ccPermission = argv[++i];
		else if (a === "--seed") o.seed = argv[++i];
		else if (a === "--thinking") o.thinking = argv[++i];
		else if (a === "--timeout") o.timeoutSec = Number(argv[++i]);
		else if (a === "--pit-only") o.pitOnly = true;
		else if (a === "--cc-only") o.ccOnly = true;
		else if (a === "--keep") o.keep = true;
		else if (a === "--dry") o.dry = true;
		else if (a === "--out") o.out = argv[++i];
		else if (a === "--help" || a === "-h") {
			printUsage();
			process.exit(0);
		} else positionals.push(a);
	}
	o.prompt = positionals.join(" ").trim();
	return o;
}

function printUsage(): void {
	console.log(
		'Uso: npx tsx scripts/compare-harness.mts "<prompt>" [--model <id>] [--cc-model <id>]\n' +
			"     [--seed <dir>] [--thinking <lvl>] [--timeout <seg>] [--pit-only|--cc-only]\n" +
			"     [--keep] [--dry] [--out <dir>]",
	);
}

function git(cwd: string, args: string[]): string {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	return r.stdout ?? "";
}

function prepareSandbox(dir: string, seed?: string): void {
	mkdirSync(dir, { recursive: true });
	if (seed) {
		const seedAbs = isAbsolute(seed) ? seed : resolve(process.cwd(), seed);
		if (!existsSync(seedAbs)) throw new Error(`seed não encontrado: ${seedAbs}`);
		cpSync(seedAbs, dir, { recursive: true });
	} else {
		writeFileSync(join(dir, "TASK.md"), "# Task\n\nVeja o prompt do agente.\n");
	}
	// Baseline git p/ medir o diff produzido pelo agente.
	git(dir, ["init", "-q"]);
	git(dir, ["add", "-A"]);
	git(dir, [
		"-c",
		"user.email=harness@local",
		"-c",
		"user.name=harness",
		"commit",
		"-q",
		"-m",
		"baseline",
		"--allow-empty",
	]);
}

interface RunResult {
	durationMs: number;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
}

function runAgent(label: string, command: string, args: string[], cwd: string, prompt: string, timeoutSec: number): Promise<RunResult> {
	return new Promise((resolveRun) => {
		const t0 = performance.now();
		const child = spawn(IS_WIN ? `"${command}"` : command, args, {
			cwd,
			shell: IS_WIN,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 3000);
		}, timeoutSec * 1000);
		child.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolveRun({ durationMs: performance.now() - t0, stdout, stderr, exitCode: code, timedOut });
		});
		child.stdin.write(prompt);
		child.stdin.end();
		process.stderr.write(`  → ${label} rodando…\n`);
	});
}

interface Metrics {
	toolCalls: Record<string, number>;
	toolTotal: number;
	toolErrors: number;
	turns: number;
	inTok: number;
	outTok: number;
	costUsd?: number;
	// harness-only (Pit)
	rewrites: number;
	rejects: number;
	errorHints: number;
	verifyPassed: number;
	verifyFailed: number;
	retries: number;
	parseErrors: number;
}

function emptyMetrics(): Metrics {
	return {
		toolCalls: {},
		toolTotal: 0,
		toolErrors: 0,
		turns: 0,
		inTok: 0,
		outTok: 0,
		rewrites: 0,
		rejects: 0,
		errorHints: 0,
		verifyPassed: 0,
		verifyFailed: 0,
		retries: 0,
		parseErrors: 0,
	};
}

function bump(rec: Record<string, number>, key: string): void {
	rec[key] = (rec[key] ?? 0) + 1;
}

function parsePit(jsonl: string): Metrics {
	const m = emptyMetrics();
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let ev: any;
		try {
			ev = JSON.parse(line);
		} catch {
			m.parseErrors++;
			continue;
		}
		switch (ev.type) {
			case "tool_execution_start":
				bump(m.toolCalls, String(ev.toolName ?? "?").toLowerCase());
				m.toolTotal++;
				break;
			case "tool_execution_end":
				if (ev.isError) m.toolErrors++;
				break;
			case "tool_call_rewritten":
				m.rewrites++;
				break;
			case "tool_call_rejected":
				m.rejects++;
				break;
			case "tool_error_hint_applied":
				m.errorHints++;
				break;
			case "verification":
				if (ev.phase === "passed") m.verifyPassed++;
				else if (ev.phase === "failed") m.verifyFailed++;
				break;
			case "auto_retry_start":
				m.retries++;
				break;
			case "turn_start":
				m.turns++;
				break;
			case "message_end": {
				const u = ev.message?.usage;
				if (u && ev.message?.role === "assistant") {
					m.inTok += u.input ?? u.inputTokens ?? u.input_tokens ?? 0;
					m.outTok += u.output ?? u.outputTokens ?? u.output_tokens ?? 0;
				}
				break;
			}
		}
	}
	return m;
}

function parseCC(jsonl: string): Metrics {
	const m = emptyMetrics();
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let ev: any;
		try {
			ev = JSON.parse(line);
		} catch {
			m.parseErrors++;
			continue;
		}
		if (ev.type === "assistant" && ev.message?.content) {
			for (const c of ev.message.content) {
				if (c.type === "tool_use") {
					bump(m.toolCalls, String(c.name ?? "?").toLowerCase());
					m.toolTotal++;
				}
			}
			const u = ev.message.usage;
			if (u) {
				m.inTok += u.input_tokens ?? 0;
				m.outTok += u.output_tokens ?? 0;
			}
		} else if (ev.type === "user" && ev.message?.content) {
			for (const c of ev.message.content) {
				if (c.type === "tool_result" && c.is_error) m.toolErrors++;
			}
		} else if (ev.type === "result") {
			if (typeof ev.num_turns === "number") m.turns = ev.num_turns;
			if (typeof ev.total_cost_usd === "number") m.costUsd = ev.total_cost_usd;
			if (ev.usage) {
				m.inTok = ev.usage.input_tokens ?? m.inTok;
				m.outTok = ev.usage.output_tokens ?? m.outTok;
			}
		}
	}
	return m;
}

interface DiffStat {
	files: number;
	added: number;
	removed: number;
	raw: string;
}

function captureDiff(cwd: string): DiffStat {
	git(cwd, ["add", "-A"]);
	// Exclui o estado interno dos agentes (.pit/, .claude/) — só interessa o
	// código que o harness produziu, não os sidecars de bookkeeping.
	const exclude = [":(exclude).pit", ":(exclude).pit/**", ":(exclude).claude", ":(exclude).claude/**"];
	const raw = git(cwd, ["diff", "--cached", "--", ".", ...exclude]);
	const names = git(cwd, ["diff", "--cached", "--name-only", "--", ".", ...exclude]).split("\n").filter(Boolean);
	let added = 0;
	let removed = 0;
	for (const l of raw.split("\n")) {
		if (l.startsWith("+") && !l.startsWith("+++")) added++;
		else if (l.startsWith("-") && !l.startsWith("---")) removed++;
	}
	return { files: names.length, added, removed, raw };
}

function pad(s: string, n: number): string {
	return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function buildReport(o: Opts, pit: Metrics | null, cc: Metrics | null, pitDiff: DiffStat | null, ccDiff: DiffStat | null, pitWall: number, ccWall: number): string {
	const L: string[] = [];
	L.push("## Harness comparison: Pit vs Claude Code\n");
	L.push(`- prompt: ${o.prompt}`);
	L.push(`- modelo: pit=\`${o.model}\` · cc=\`${o.ccModel}\`${o.thinking ? ` · thinking=${o.thinking}` : ""}`);
	L.push("");
	const col = (v: number | string | undefined) => (v === undefined ? "—" : String(v));
	L.push("| métrica | Pit | Claude Code |");
	L.push("|-|-|-|");
	L.push(`| wall-clock (s) | ${pit ? (pitWall / 1000).toFixed(1) : "—"} | ${cc ? (ccWall / 1000).toFixed(1) : "—"} |`);
	L.push(`| turnos | ${col(pit?.turns)} | ${col(cc?.turns)} |`);
	L.push(`| tool calls (total) | ${col(pit?.toolTotal)} | ${col(cc?.toolTotal)} |`);
	L.push(`| tool errors | ${col(pit?.toolErrors)} | ${col(cc?.toolErrors)} |`);
	L.push(`| tokens in/out (aprox) | ${pit ? `${pit.inTok}/${pit.outTok}` : "—"} | ${cc ? `${cc.inTok}/${cc.outTok}` : "—"} |`);
	L.push(`| custo (USD) | — | ${col(cc?.costUsd?.toFixed?.(4))} |`);
	L.push(`| arquivos alterados | ${col(pitDiff?.files)} | ${col(ccDiff?.files)} |`);
	L.push(`| linhas +/- | ${pitDiff ? `+${pitDiff.added}/-${pitDiff.removed}` : "—"} | ${ccDiff ? `+${ccDiff.added}/-${ccDiff.removed}` : "—"} |`);
	L.push("");
	// tool calls por tipo
	const tools = new Set<string>([...Object.keys(pit?.toolCalls ?? {}), ...Object.keys(cc?.toolCalls ?? {})]);
	if (tools.size > 0) {
		L.push("tool calls por tipo:");
		L.push("");
		L.push("| tool | Pit | Claude Code |");
		L.push("|-|-|-|");
		for (const t of [...tools].sort()) {
			L.push(`| ${t} | ${pit?.toolCalls[t] ?? 0} | ${cc?.toolCalls[t] ?? 0} |`);
		}
		L.push("");
	}
	if (pit) {
		L.push(
			`harness-only (Pit): rewrites=${pit.rewrites} · rejects=${pit.rejects} · error-hints=${pit.errorHints} · ` +
				`verification-gate=${pit.verifyPassed}✓/${pit.verifyFailed}✗ · retries=${pit.retries}`,
		);
		L.push("");
	}
	if ((pit?.parseErrors ?? 0) > 0 || (cc?.parseErrors ?? 0) > 0) {
		L.push(`(linhas JSONL não parseadas: pit=${pit?.parseErrors ?? 0} cc=${cc?.parseErrors ?? 0})`);
		L.push("");
	}
	return L.join("\n");
}

async function main(): Promise<void> {
	const o = parseArgs(process.argv.slice(2));
	if (!o.prompt) {
		printUsage();
		process.exit(2);
	}
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const baseTmp = process.env.PIT_TMP_DIR || tmpdir();
	const outDir = o.out ?? join(baseTmp, `compare-harness-${ts}`);
	mkdirSync(outDir, { recursive: true });

	const pitSandbox = join(outDir, "pit");
	const ccSandbox = join(outDir, "cc");
	const runPit = !o.ccOnly;
	const runCc = !o.pitOnly;

	// Launchers
	const pitLauncher = join(REPO_ROOT, "bin", IS_WIN ? "pit.cmd" : "pit");
	if (runPit && !existsSync(pitLauncher)) {
		console.error(`Pit launcher não encontrado: ${pitLauncher}`);
		process.exit(1);
	}
	if (runCc) {
		const probe = spawnSync(IS_WIN ? "claude.cmd" : "claude", ["--version"], { encoding: "utf8", shell: IS_WIN });
		if (probe.status !== 0) {
			console.error("claude CLI não encontrado no PATH — instale o Claude Code ou use --pit-only.");
			process.exit(1);
		}
	}

	console.error(`sandboxes em: ${outDir}`);
	if (runPit) prepareSandbox(pitSandbox, o.seed);
	if (runCc) prepareSandbox(ccSandbox, o.seed);

	const pitArgs = ["--mode", "json", "--no-session", "--model", o.model];
	if (o.thinking) pitArgs.push("--thinking", o.thinking);
	const ccArgs = ["-p", "--output-format", "stream-json", "--verbose", "--model", o.ccModel, "--permission-mode", o.ccPermission];

	if (o.dry) {
		console.error("\n[--dry] mecânica validada. Comandos que seriam executados:\n");
		if (runPit) console.error(`  Pit (cwd=${pitSandbox}):\n    ${pitLauncher} ${pitArgs.join(" ")}  < (prompt via stdin)`);
		if (runCc) console.error(`  CC  (cwd=${ccSandbox}):\n    claude ${ccArgs.join(" ")}  < (prompt via stdin)`);
		console.error(`\nbaseline git criado nos sandboxes. Rode sem --dry p/ valer.`);
		return;
	}

	let pitMetrics: Metrics | null = null;
	let ccMetrics: Metrics | null = null;
	let pitDiff: DiffStat | null = null;
	let ccDiff: DiffStat | null = null;
	let pitWall = 0;
	let ccWall = 0;

	if (runPit) {
		const r = await runAgent("Pit", pitLauncher, pitArgs, pitSandbox, o.prompt, o.timeoutSec);
		pitWall = r.durationMs;
		writeFileSync(join(outDir, "pit.jsonl"), r.stdout);
		writeFileSync(join(outDir, "pit.err"), r.stderr);
		pitMetrics = parsePit(r.stdout);
		pitDiff = captureDiff(pitSandbox);
		writeFileSync(join(outDir, "pit.diff"), pitDiff.raw);
		if (r.timedOut) console.error("  ⚠ Pit estourou o timeout");
	}
	if (runCc) {
		const r = await runAgent("Claude Code", IS_WIN ? "claude.cmd" : "claude", ccArgs, ccSandbox, o.prompt, o.timeoutSec);
		ccWall = r.durationMs;
		writeFileSync(join(outDir, "cc.jsonl"), r.stdout);
		writeFileSync(join(outDir, "cc.err"), r.stderr);
		ccMetrics = parseCC(r.stdout);
		ccDiff = captureDiff(ccSandbox);
		writeFileSync(join(outDir, "cc.diff"), ccDiff.raw);
		if (r.timedOut) console.error("  ⚠ Claude Code estourou o timeout");
	}

	const report = buildReport(o, pitMetrics, ccMetrics, pitDiff, ccDiff, pitWall, ccWall);
	writeFileSync(join(outDir, "REPORT.md"), report);
	console.log(`\n${report}`);
	console.log(`\nartefatos: ${outDir}`);
	if (!o.keep) console.error(`(use --keep p/ preservar; sandboxes ficam em ${outDir})`);
}

main().catch((e) => {
	console.error(e instanceof Error ? e.stack : String(e));
	process.exit(1);
});
