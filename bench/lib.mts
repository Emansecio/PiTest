/**
 * bench/lib — núcleo da suíte de benchmark Pit × Claude Code × Codex.
 *
 * Cada benchmark é um CENÁRIO (seed + prompt + oráculo). O mesmo cenário roda
 * nos três harnesses, em sandboxes idênticos e isolados, com o MESMO modelo de
 * família comparável. A diferença observada (passou no oráculo? quantos turnos?
 * quantos tool-errors? quantos tokens?) é do HARNESS — system prompt, toolset,
 * tool-rewrite, gate de verificação, grounding — não da LLM.
 *
 * O oráculo é um script Node zero-dependência rodado FORA do agente, contra o
 * sandbox que ele produziu. Exit 0 = passou. É a fonte de verdade objetiva:
 * o agente não pode "se auto-avaliar".
 */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

export const IS_WIN = process.platform === "win32";
export const REPO_ROOT = resolve(import.meta.dirname, "..");
export const SCENARIOS_DIR = join(REPO_ROOT, "bench", "scenarios");

export type AgentId = "pit" | "cc" | "codex" | "droid" | "opencode";
export const ALL_AGENTS: AgentId[] = ["pit", "cc", "codex", "droid", "opencode"];

export const AGENT_LABEL: Record<AgentId, string> = {
	pit: "Pit",
	cc: "Claude Code",
	codex: "Codex",
	droid: "Droid",
	opencode: "opencode",
};

/** Zeroed counter keyed by every agent — use instead of a `{pit,cc,codex}`
 * literal so adding an agent doesn't desync the tallies. */
export function zeroByAgent(): Record<AgentId, number> {
	return Object.fromEntries(ALL_AGENTS.map((a) => [a, 0])) as Record<AgentId, number>;
}

/** Tool categories normalized so the three agents are comparable. Codex reads
 * and edits files by shelling out, so its "shell" count is naturally high — that
 * IS a harness signal (no dedicated Read/Edit tool), not noise. */
export interface ToolByCat {
	read: number;
	edit: number;
	write: number;
	shell: number;
	search: number;
	list: number;
	other: number;
}

export function emptyCat(): ToolByCat {
	return { read: 0, edit: 0, write: 0, shell: 0, search: 0, list: 0, other: 0 };
}

export interface Metrics {
	toolRaw: Record<string, number>;
	toolByCat: ToolByCat;
	toolTotal: number;
	toolErrors: number;
	turns: number;
	inTok: number;
	outTok: number;
	cacheReadTok: number;
	costUsd?: number;
	// harness-only (Pit emits these; others stay 0)
	rewrites: number;
	rejects: number;
	errorHints: number;
	verifyPassed: number;
	verifyFailed: number;
	retries: number;
	parseErrors: number;
}

export function emptyMetrics(): Metrics {
	return {
		toolRaw: {},
		toolByCat: emptyCat(),
		toolTotal: 0,
		toolErrors: 0,
		turns: 0,
		inTok: 0,
		outTok: 0,
		cacheReadTok: 0,
		rewrites: 0,
		rejects: 0,
		errorHints: 0,
		verifyPassed: 0,
		verifyFailed: 0,
		retries: 0,
		parseErrors: 0,
	};
}

export interface DiffStat {
	files: number;
	added: number;
	removed: number;
	raw: string;
	/** changed file paths (relative to sandbox), for the syntax gate. */
	names: string[];
}

export interface OracleResult {
	pass: boolean;
	reason: string;
	raw: string;
	exitCode: number | null;
}

/** Objective code-quality signal independent of the oracle: every changed JS
 * file is run through `node --check` (parse-only). All seeds are plain `.mjs`,
 * so this is a uniform, fair "did the agent leave syntactically valid code"
 * axis — a harness that lands a malformed edit scores a syntaxError here even if
 * the oracle would already FAIL for another reason. */
export interface CodeQuality {
	filesChecked: number;
	syntaxErrors: number;
	errorFiles: string[];
}

export function emptyQuality(): CodeQuality {
	return { filesChecked: 0, syntaxErrors: 0, errorFiles: [] };
}

export interface AgentRun {
	agent: AgentId;
	available: boolean;
	wallMs: number;
	/** ms from spawn to first stdout byte (time-to-first-token proxy). */
	firstOutputMs: number | null;
	/** ms from spawn to the first edit/write tool event (time-to-first-code).
	 * null when the agent emits no per-tool stream (Droid `-o json`). */
	firstEditMs: number | null;
	exitCode: number | null;
	timedOut: boolean;
	metrics: Metrics;
	diff: DiffStat;
	quality: CodeQuality;
	oracle: OracleResult;
}

export interface Scenario {
	id: string;
	dir: string;
	title: string;
	angle: string;
	prompt: string;
	/** timeout per agent, seconds (default 600). */
	timeoutSec: number;
	/** oracle script relative to scenario dir (default oracle.mjs). */
	oracle: string;
}

export interface ScenarioMeta {
	id: string;
	title: string;
	angle: string;
	timeoutSec?: number;
	oracle?: string;
}

// ---------------------------------------------------------------------------
// tool categorization
// ---------------------------------------------------------------------------

const READ = new Set(["read", "read_file", "readfile", "view", "cat"]);
const EDIT = new Set(["edit", "multiedit", "multi_edit", "apply_patch", "applypatch", "str_replace", "patch", "file_change", "update"]);
const WRITE = new Set(["write", "write_file", "writefile", "create", "create_file", "new_file"]);
const SHELL = new Set(["bash", "shell", "exec", "command", "command_execution", "run_command", "terminal", "powershell"]);
const SEARCH = new Set(["grep", "glob", "search", "find", "ripgrep", "rg", "web_search", "websearch", "codebase_search", "file_search"]);
const LIST = new Set(["ls", "list", "list_dir", "listdir", "list_files", "tree"]);

export function categorize(rawName: string): keyof ToolByCat {
	const n = rawName.toLowerCase().trim();
	if (READ.has(n)) return "read";
	if (EDIT.has(n)) return "edit";
	if (WRITE.has(n)) return "write";
	if (SHELL.has(n)) return "shell";
	if (SEARCH.has(n)) return "search";
	if (LIST.has(n)) return "list";
	// fuzzy fallbacks for tool names with prefixes/suffixes
	if (n.includes("read")) return "read";
	if (n.includes("edit") || n.includes("patch")) return "edit";
	if (n.includes("write") || n.includes("create")) return "write";
	if (n.includes("bash") || n.includes("shell") || n.includes("exec") || n.includes("command")) return "shell";
	if (n.includes("grep") || n.includes("glob") || n.includes("search") || n.includes("find")) return "search";
	return "other";
}

function bumpTool(m: Metrics, rawName: string): void {
	const raw = rawName || "?";
	m.toolRaw[raw] = (m.toolRaw[raw] ?? 0) + 1;
	m.toolByCat[categorize(raw)]++;
	m.toolTotal++;
}

// ---------------------------------------------------------------------------
// parsers — one per agent JSONL/stream format
// ---------------------------------------------------------------------------

export function parsePit(jsonl: string): Metrics {
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
				bumpTool(m, String(ev.toolName ?? "?"));
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
					m.cacheReadTok += u.cacheRead ?? u.cache_read ?? u.cacheReadTokens ?? 0;
				}
				break;
			}
		}
	}
	return m;
}

export function parseCC(jsonl: string): Metrics {
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
				if (c.type === "tool_use") bumpTool(m, String(c.name ?? "?"));
			}
			const u = ev.message.usage;
			if (u) {
				m.inTok += u.input_tokens ?? 0;
				m.outTok += u.output_tokens ?? 0;
				m.cacheReadTok += u.cache_read_input_tokens ?? 0;
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
				m.cacheReadTok = ev.usage.cache_read_input_tokens ?? m.cacheReadTok;
			}
		}
	}
	return m;
}

/** Codex `exec --json` emits {type:"item.completed",item:{type,...}} for each
 * step and {type:"turn.completed",usage} per turn. Codex has no dedicated Read
 * tool — it reads via command_execution (shell), so those land in `shell`. */
export function parseCodex(jsonl: string): Metrics {
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
		if (ev.type === "turn.started") {
			m.turns++;
		} else if (ev.type === "turn.completed" && ev.usage) {
			m.inTok = ev.usage.input_tokens ?? m.inTok; // cumulative context; take latest
			m.outTok += (ev.usage.output_tokens ?? 0) + (ev.usage.reasoning_output_tokens ?? 0);
			m.cacheReadTok = ev.usage.cached_input_tokens ?? m.cacheReadTok;
		} else if (ev.type === "item.completed" && ev.item) {
			const it = ev.item;
			const t = String(it.type ?? "");
			if (t === "agent_message" || t === "reasoning") continue; // text, not a tool
			if (t === "command_execution") {
				bumpTool(m, "command_execution");
				if (typeof it.exit_code === "number" && it.exit_code !== 0) m.toolErrors++;
			} else if (t === "file_change" || t === "patch_apply") {
				bumpTool(m, "file_change");
				if (it.status && it.status !== "completed") m.toolErrors++;
			} else if (t === "mcp_tool_call") {
				bumpTool(m, "mcp_tool_call");
				if (it.status && it.status !== "completed") m.toolErrors++;
			} else if (t === "web_search") {
				bumpTool(m, "web_search");
			} else if (t === "error") {
				m.toolErrors++;
			}
		} else if (ev.type === "error") {
			m.toolErrors++;
		}
	}
	if (m.turns === 0) m.turns = 1;
	return m;
}

/** Droid `exec -o json` emits a single final `result` object: turns + usage,
 * but no per-tool events — so toolTotal stays 0 (a measurement limit, noted in
 * the report). is_error marks a run-level failure. */
export function parseDroid(jsonl: string): Metrics {
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
		if (ev.type === "result") {
			if (typeof ev.num_turns === "number") m.turns = ev.num_turns;
			if (ev.is_error) m.toolErrors++;
			const u = ev.usage;
			if (u) {
				m.inTok = u.input_tokens ?? 0;
				m.outTok = u.output_tokens ?? 0;
				m.cacheReadTok = u.cache_read_input_tokens ?? 0;
			}
		}
	}
	if (m.turns === 0) m.turns = 1;
	return m;
}

/** opencode `run --format json` streams `step_start` / `tool_use` / `step_finish`
 * events. tokens.input is the per-step FULL context (take latest, like Codex);
 * output+reasoning are per-step (sum). cost is per-step (sum → real total). */
export function parseOpencode(jsonl: string): Metrics {
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
		const part = ev.part;
		if (ev.type === "step_start") {
			m.turns++;
		} else if (ev.type === "tool_use" && part) {
			bumpTool(m, String(part.tool ?? "?"));
			if (part.state?.status === "error") m.toolErrors++;
		} else if (ev.type === "step_finish" && part?.tokens) {
			const t = part.tokens;
			m.outTok += (t.output ?? 0) + (t.reasoning ?? 0);
			m.inTok = t.input ?? m.inTok;
			m.cacheReadTok = t.cache?.read ?? m.cacheReadTok;
			if (typeof part.cost === "number") m.costUsd = (m.costUsd ?? 0) + part.cost;
		} else if (ev.type === "error") {
			m.toolErrors++;
		}
	}
	if (m.turns === 0) m.turns = 1;
	return m;
}

export function parseMetrics(agent: AgentId, jsonl: string): Metrics {
	if (agent === "pit") return parsePit(jsonl);
	if (agent === "cc") return parseCC(jsonl);
	if (agent === "codex") return parseCodex(jsonl);
	if (agent === "droid") return parseDroid(jsonl);
	return parseOpencode(jsonl);
}

// ---------------------------------------------------------------------------
// git + sandbox
// ---------------------------------------------------------------------------

function git(cwd: string, args: string[]): string {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	return r.stdout ?? "";
}

/** Copies the scenario seed into `dir` and lays a baseline git commit so the
 * agent's diff is measurable. Excludes the oracle from what the agent sees. */
export function prepareSandbox(dir: string, seedDir: string): void {
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const seedAbs = isAbsolute(seedDir) ? seedDir : resolve(process.cwd(), seedDir);
	if (!existsSync(seedAbs)) throw new Error(`seed não encontrado: ${seedAbs}`);
	cpSync(seedAbs, dir, { recursive: true });
	git(dir, ["init", "-q"]);
	git(dir, ["add", "-A"]);
	git(dir, [
		"-c",
		"user.email=bench@local",
		"-c",
		"user.name=bench",
		"commit",
		"-q",
		"-m",
		"baseline",
		"--allow-empty",
	]);
}

export function captureDiff(cwd: string): DiffStat {
	git(cwd, ["add", "-A"]);
	// Exclude agent bookkeeping sidecars — only the produced code matters.
	const exclude = [
		":(exclude).pit",
		":(exclude).pit/**",
		":(exclude).claude",
		":(exclude).claude/**",
		":(exclude).codex",
		":(exclude).codex/**",
		":(exclude).droid",
		":(exclude).droid/**",
		":(exclude).factory",
		":(exclude).factory/**",
		":(exclude).opencode",
		":(exclude).opencode/**",
	];
	const raw = git(cwd, ["diff", "--cached", "--", ".", ...exclude]);
	const names = git(cwd, ["diff", "--cached", "--name-only", "--", ".", ...exclude])
		.split("\n")
		.filter(Boolean);
	let added = 0;
	let removed = 0;
	for (const l of raw.split("\n")) {
		if (l.startsWith("+") && !l.startsWith("+++")) added++;
		else if (l.startsWith("-") && !l.startsWith("---")) removed++;
	}
	return { files: names.length, added, removed, raw, names };
}

// ---------------------------------------------------------------------------
// code-quality gate (node --check on every changed JS file)
// ---------------------------------------------------------------------------

/** Parse-checks every changed `.mjs/.cjs/.js` file in the sandbox. A deleted
 * file is skipped (nothing to parse). Runs FOR each agent independently so a
 * malformed edit is caught as an objective quality regression, distinct from
 * the oracle verdict. */
export function checkSyntax(sandbox: string, names: string[]): CodeQuality {
	const q = emptyQuality();
	for (const rel of names) {
		if (!/\.(mjs|cjs|js)$/i.test(rel)) continue;
		const abs = join(sandbox, rel);
		if (!existsSync(abs)) continue; // deleted by the agent — nothing to check
		q.filesChecked++;
		const r = spawnSync("node", ["--check", abs], { encoding: "utf8" });
		if (r.status !== 0) {
			q.syntaxErrors++;
			q.errorFiles.push(rel);
		}
	}
	return q;
}

// ---------------------------------------------------------------------------
// first-edit detection (time-to-first-code latency)
// ---------------------------------------------------------------------------

function isEditCat(name: string): boolean {
	const c = categorize(name);
	return c === "edit" || c === "write";
}

/** True if a single JSONL stream line marks the agent STARTING to edit/write a
 * file. Reuses the same `categorize()` taxonomy as the tool tallies, so the
 * latency axis and the tool-call axis agree on what "an edit" is. Droid emits
 * only a final result object (no per-tool stream) → always false (firstEdit
 * stays null, reported as "n/d"). */
export function isEditLine(agent: AgentId, line: string): boolean {
	let ev: any;
	try {
		ev = JSON.parse(line);
	} catch {
		return false;
	}
	if (agent === "pit") {
		return ev.type === "tool_execution_start" && isEditCat(String(ev.toolName ?? ""));
	}
	if (agent === "cc") {
		if (ev.type !== "assistant" || !Array.isArray(ev.message?.content)) return false;
		return ev.message.content.some((c: any) => c?.type === "tool_use" && isEditCat(String(c.name ?? "")));
	}
	if (agent === "codex") {
		const t = ev.type === "item.completed" ? String(ev.item?.type ?? "") : "";
		return t === "file_change" || t === "patch_apply";
	}
	if (agent === "opencode") {
		return ev.type === "tool_use" && ev.part && isEditCat(String(ev.part.tool ?? ""));
	}
	return false; // droid: no per-tool events
}

// ---------------------------------------------------------------------------
// cost estimate (public list price — NOT what the owner pays via Max/OAuth)
// ---------------------------------------------------------------------------

interface Price {
	in: number;
	out: number;
	cache: number;
}

/** Public list price in US$ per million tokens, matched by model-name
 * substring. This is a normalized COMPARISON proxy, not a bill: Pit/CC/opencode
 * here route Anthropic via OAuth/Max (flat-rate, $0 marginal), so this column
 * answers "what would this run cost at API list price", uniformly across
 * agents. Input-token bias (§ caveat in report) carries over — out-token cost
 * is the cleanest component. */
const PRICES: { match: RegExp; price: Price }[] = [
	{ match: /opus/i, price: { in: 15, out: 75, cache: 1.5 } },
	{ match: /sonnet/i, price: { in: 3, out: 15, cache: 0.3 } },
	{ match: /haiku/i, price: { in: 1, out: 5, cache: 0.1 } },
	{ match: /gpt-5|codex/i, price: { in: 1.25, out: 10, cache: 0.125 } },
	{ match: /minimax/i, price: { in: 0.3, out: 1.2, cache: 0.03 } },
];

export function priceFor(model: string): Price | null {
	for (const p of PRICES) if (p.match.test(model)) return p.price;
	return null;
}

/** Estimated US$ at list price from the parsed token counts. null when the
 * model isn't in the table. */
export function estimateCostUsd(model: string, m: Metrics): number | null {
	const p = priceFor(model);
	if (!p) return null;
	return (m.inTok * p.in + m.outTok * p.out + m.cacheReadTok * p.cache) / 1e6;
}

// ---------------------------------------------------------------------------
// agent runners
// ---------------------------------------------------------------------------

export interface AgentLaunch {
	command: string;
	args: string[];
}

export interface AgentModels {
	pit: string;
	cc: string;
	codex: string;
	droid: string;
	opencode: string;
	thinking?: string;
}

export const DEFAULT_MODELS: AgentModels = {
	pit: "claude-opus-4-8",
	cc: "opus",
	codex: "gpt-5.5",
	droid: "claude-opus-4-8",
	// Registered as a custom model in opencode.json (provider.anthropic.models).
	// Routes via opencode's anthropic OAuth; runs once the Max opus quota is free
	// (a 400 "out of extra usage" means quota, not a config problem).
	opencode: "anthropic/claude-opus-4-8",
};

export function modelOf(models: AgentModels, agent: AgentId): string {
	return models[agent];
}

/** "pit=`x` · cc=`y` · …" line for only the agents shown. */
export function modelsLine(models: AgentModels, agents: AgentId[]): string {
	const parts = agents.map((a) => `${a}=\`${modelOf(models, a)}\``);
	return `modelos: ${parts.join(" · ")}${models.thinking ? ` · thinking=${models.thinking}` : ""}`;
}

export function pitLauncher(): string {
	return join(REPO_ROOT, "bin", IS_WIN ? "pit.cmd" : "pit");
}

export function buildLaunch(agent: AgentId, models: AgentModels, sandbox: string): AgentLaunch {
	if (agent === "pit") {
		const args = ["--mode", "json", "--no-session", "--model", models.pit];
		if (models.thinking) args.push("--thinking", models.thinking);
		return { command: pitLauncher(), args };
	}
	if (agent === "cc") {
		return {
			command: IS_WIN ? "claude.cmd" : "claude",
			args: ["-p", "--output-format", "stream-json", "--verbose", "--model", models.cc, "--permission-mode", "bypassPermissions"],
		};
	}
	if (agent === "codex") {
		return {
			command: IS_WIN ? "codex.cmd" : "codex",
			args: [
				"exec",
				"--json",
				"--skip-git-repo-check",
				"--dangerously-bypass-approvals-and-sandbox",
				"-C",
				sandbox,
				"-m",
				models.codex,
			],
		};
	}
	if (agent === "droid") {
		// Factory droid. exec is non-interactive; --skip-permissions-unsafe grants
		// edits/commands without prompts (full autonomy — mutually exclusive with
		// --auto). -o json = final result object.
		return {
			command: IS_WIN ? "droid.cmd" : "droid",
			args: ["exec", "-o", "json", "--skip-permissions-unsafe", "-m", models.droid, "--cwd", sandbox],
		};
	}
	// opencode
	return {
		command: IS_WIN ? "opencode.cmd" : "opencode",
		args: ["run", "--format", "json", "--dangerously-skip-permissions", "-m", models.opencode, "--dir", sandbox],
	};
}

const AGENT_COMMAND: Record<Exclude<AgentId, "pit">, string> = {
	cc: IS_WIN ? "claude.cmd" : "claude",
	codex: IS_WIN ? "codex.cmd" : "codex",
	droid: IS_WIN ? "droid.cmd" : "droid",
	opencode: IS_WIN ? "opencode.cmd" : "opencode",
};

export function agentAvailable(agent: AgentId): boolean {
	if (agent === "pit") return existsSync(pitLauncher());
	const probe = spawnSync(AGENT_COMMAND[agent], ["--version"], { encoding: "utf8", shell: IS_WIN });
	return probe.status === 0;
}

export interface RawRun {
	durationMs: number;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	/** ms to first stdout byte; null if the agent never wrote to stdout. */
	firstOutputMs: number | null;
	/** ms to the first edit/write tool event; null if none detected. */
	firstEditMs: number | null;
}

export function runProcess(
	label: string,
	launch: AgentLaunch,
	cwd: string,
	prompt: string,
	timeoutSec: number,
	onTick?: (label: string) => void,
	/** Per-line predicate marking the first edit/write event (time-to-code). */
	isEdit?: (line: string) => boolean,
): Promise<RawRun> {
	return new Promise((resolveRun) => {
		const t0 = performance.now();
		const child = spawn(IS_WIN ? `"${launch.command}"` : launch.command, launch.args, {
			cwd,
			shell: IS_WIN,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let firstOutputMs: number | null = null;
		let firstEditMs: number | null = null;
		// Carry an incomplete trailing line across chunks so the edit predicate
		// only ever sees whole JSONL lines.
		let lineCarry = "";
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 4000);
		}, timeoutSec * 1000);
		child.stdout.on("data", (d) => {
			const text = d.toString();
			if (firstOutputMs === null && text.length > 0) firstOutputMs = performance.now() - t0;
			stdout += text;
			if (isEdit && firstEditMs === null) {
				lineCarry += text;
				const lines = lineCarry.split("\n");
				lineCarry = lines.pop() ?? "";
				for (const line of lines) {
					if (line.trim() && isEdit(line)) {
						firstEditMs = performance.now() - t0;
						break;
					}
				}
			}
		});
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("error", (e) => {
			stderr += `\n[spawn error] ${String(e)}`;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolveRun({ durationMs: performance.now() - t0, stdout, stderr, exitCode: code, timedOut, firstOutputMs, firstEditMs });
		});
		child.stdin.write(prompt);
		child.stdin.end();
		if (onTick) onTick(label);
	});
}

// ---------------------------------------------------------------------------
// oracle
// ---------------------------------------------------------------------------

/** Runs `node <oracle>` with cwd = the agent's sandbox and BENCH_PRISTINE set
 * to a clean copy of the seed (so oracles can diff must-not-change files). */
export function runOracle(oracleAbs: string, sandbox: string, pristine: string, timeoutSec: number): OracleResult {
	const r = spawnSync("node", [oracleAbs], {
		cwd: sandbox,
		encoding: "utf8",
		timeout: timeoutSec * 1000,
		env: { ...process.env, BENCH_PRISTINE: pristine, BENCH_SANDBOX: sandbox },
	});
	const raw = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
	const pass = r.status === 0;
	const lines = raw.split("\n").filter(Boolean);
	const reasonLine = lines.find((l) => /^(PASS|FAIL)\b/i.test(l)) ?? lines[lines.length - 1] ?? "(sem saída)";
	return { pass, reason: reasonLine.slice(0, 300), raw, exitCode: r.status };
}

// ---------------------------------------------------------------------------
// scenario loading
// ---------------------------------------------------------------------------

export function loadScenario(dir: string): Scenario {
	const metaPath = join(dir, "meta.json");
	const promptPath = join(dir, "prompt.txt");
	const meta = JSON.parse(readFileSync(metaPath, "utf8")) as ScenarioMeta;
	const prompt = readFileSync(promptPath, "utf8").trim();
	return {
		id: meta.id,
		dir,
		title: meta.title,
		angle: meta.angle,
		prompt,
		timeoutSec: meta.timeoutSec ?? 600,
		oracle: meta.oracle ?? "oracle.mjs",
	};
}

export function pad(s: string, n: number): string {
	return s.length >= n ? s : s + " ".repeat(n - s.length);
}
