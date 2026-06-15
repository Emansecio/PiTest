import { type ChildProcess, spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordDiagnostic } from "@pit/ai";
import type { FusionCli, PanelMember, PanelResult } from "./types.ts";

const IS_WIN = process.platform === "win32";

/** Map a model's registry provider to the CLI that drives it. */
export function inferCli(provider: string): FusionCli | undefined {
	if (provider === "anthropic") return "claude";
	if (provider === "openai-codex") return "codex";
	return undefined;
}

/** Reverse of inferCli: the registry provider whose credentials back a Fusion CLI,
 * so a panel member can run under the SAME account as Pit (no separate CLI login). */
export function providerForCli(cli: FusionCli): string | undefined {
	if (cli === "claude") return "anthropic";
	if (cli === "codex") return "openai-codex";
	return undefined;
}

/**
 * Build the subprocess env so a panel member authenticates with the SAME account
 * as Pit instead of needing its own `claude /login`. Pit's anthropic OAuth access
 * token (`sk-ant-oat…`, issued by the Claude Code OAuth client — the very token the
 * `claude` CLI reads from CLAUDE_CODE_OAUTH_TOKEN) is forwarded as that env var; a
 * plain API key goes to ANTHROPIC_API_KEY. For codex, an API key maps to
 * OPENAI_API_KEY — a ChatGPT-OAuth session can't be reconstructed from a bearer
 * token, so it's left to codex's own ~/.codex/auth.json. Returns a clone of
 * `baseEnv` (never mutates the parent process env).
 */
export function buildMemberEnv(
	cli: FusionCli,
	token: string | undefined,
	baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...baseEnv };
	if (!token) return env;
	if (cli === "claude") {
		if (token.startsWith("sk-ant-oat")) {
			env.CLAUDE_CODE_OAUTH_TOKEN = token;
			// Drop a stray API key so it can't shadow the OAuth token we're injecting.
			delete env.ANTHROPIC_API_KEY;
		} else {
			env.ANTHROPIC_API_KEY = token;
			delete env.CLAUDE_CODE_OAUTH_TOKEN;
		}
		return env;
	}
	if (cli === "codex" && token.startsWith("sk-")) {
		env.OPENAI_API_KEY = token;
	}
	return env;
}

/**
 * Strip a registry model id down to what the CLI accepts on `--model`/`-m`.
 * Registry ids can carry a variant suffix in brackets (e.g. `claude-opus-4-8[1m]`)
 * that the CLI rejects; we drop any `[...]` suffix and trim. Deliberately
 * conservative — no family remapping (e.g. `gpt-5.5-codex` is NOT rewritten).
 */
function stripModelVariant(id: string): string {
	return id.replace(/\[[^\]]*\]/g, "").trim();
}

/** Normalize a registry model id for `claude --model`. */
export function toClaudeModel(id: string): string {
	return stripModelVariant(id);
}

/** Normalize a registry model id for `codex -m`. */
export function toCodexModel(id: string): string {
	return stripModelVariant(id);
}

export function buildCodexArgs(model: string, cwd: string, outFile: string, lean: boolean): string[] {
	// --json streams JSONL events (item.started/completed, turn.*) for live activity;
	// -o still captures the final message to a file (reliable, no event reassembly).
	const args = [
		"exec",
		"-s",
		"read-only",
		"-m",
		toCodexModel(model),
		"-C",
		cwd,
		"-o",
		outFile,
		"--skip-git-repo-check",
		"--json",
	];
	// NOTE: deliberately NOT `--ignore-user-config`. It can drop ~/.codex/auth.json,
	// the same auth-loading hazard as `--bare` on claude. `--color never` keeps the
	// stream clean without touching credentials.
	if (lean) args.push("--color", "never");
	return args;
}

export function buildClaudeArgs(model: string, lean: boolean): string[] {
	// stream-json (+ its required --verbose) emits ONE JSON event per line as the run
	// progresses (assistant text / thinking / tool_use, tool_result) instead of a
	// single blob at the end — this is what powers the live advisor activity. The
	// terminal `type:"result"` event carries the final text (and is_error on failure).
	const args = [
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--permission-mode",
		"plan",
		"--model",
		toClaudeModel(model),
	];
	// NOTE: deliberately NOT `--bare`. `--bare` disables credential loading, so the
	// CLAUDE_CODE_OAUTH_TOKEN we inject (to run the member under Pit's own login) is
	// ignored and the member dies with "Not logged in". `--strict-mcp-config` +
	// `--setting-sources project` keep the run lean without breaking auth.
	if (lean) args.push("--strict-mcp-config", "--setting-sources", "project");
	return args;
}

/** claude -p --output-format json emits one JSON object; the final text is `.result`. */
export function parseClaudeResult(stdout: string): string {
	try {
		const obj = JSON.parse(stdout) as { result?: unknown };
		return typeof obj.result === "string" ? obj.result : "";
	} catch {
		return "";
	}
}

/**
 * On failure, `claude -p --output-format json` STILL emits its JSON envelope on
 * stdout (exit code is non-zero, but `is_error` is true and `.result` carries the
 * human cause, e.g. "Not logged in · Please run /login"). That message is far more
 * actionable than a bare "exit N", so surface it as the member's error. Returns ""
 * when stdout isn't a recognizable claude error envelope.
 */
export function parseClaudeError(stdout: string): string {
	try {
		const obj = JSON.parse(stdout) as { is_error?: boolean; result?: unknown };
		if (obj.is_error === true && typeof obj.result === "string") return obj.result.trim();
	} catch {
		// not JSON — caller falls back to stderr / exit code
	}
	return "";
}

/** A single unit of live advisor activity, surfaced to the panel as it happens. */
export interface MemberProgress {
	/** What the member is doing right now. */
	kind: "thinking" | "writing" | "tool" | "tool_result";
	/** Tool name when kind === "tool" (e.g. "Read", "Bash", "Grep", "Glob"). */
	tool?: string;
}

/** Accumulated terminal state from a claude stream-json run (the final text, or the
 * error cause when the run reported is_error). */
export interface ClaudeStreamState {
	result: string;
	error: string;
	sawResult: boolean;
}

type ClaudeStreamEvent = {
	type?: string;
	is_error?: boolean;
	result?: unknown;
	message?: { content?: Array<{ type?: string; name?: unknown }> };
};

/**
 * Fold one claude stream-json line into `state` and emit live activity. stream-json
 * emits one JSON object per line (system / assistant / user / result). We surface
 * assistant `tool_use` / `text` / `thinking` as live activity and read the terminal
 * `type:"result"` for the final text (or the human error cause when is_error). A
 * malformed/partial line is ignored (the next data chunk completes it).
 */
export function applyClaudeStreamLine(
	line: string,
	state: ClaudeStreamState,
	onProgress?: (p: MemberProgress) => void,
): void {
	let o: ClaudeStreamEvent;
	try {
		o = JSON.parse(line) as ClaudeStreamEvent;
	} catch {
		return;
	}
	if (o.type === "result") {
		state.sawResult = true;
		const txt = typeof o.result === "string" ? o.result : "";
		if (o.is_error === true) state.error = txt.trim();
		else state.result = txt;
		return;
	}
	if (o.type === "assistant" && Array.isArray(o.message?.content)) {
		for (const c of o.message.content) {
			if (c?.type === "tool_use") onProgress?.({ kind: "tool", tool: String(c.name ?? "tool") });
			else if (c?.type === "text") onProgress?.({ kind: "writing" });
			else if (c?.type === "thinking") onProgress?.({ kind: "thinking" });
		}
		return;
	}
	if (o.type === "user" && Array.isArray(o.message?.content)) {
		for (const c of o.message.content) {
			if (c?.type === "tool_result") onProgress?.({ kind: "tool_result" });
		}
	}
}

/** Accumulated terminal state from a codex --json run (the error cause; the final
 * text is read from the -o tmpfile, not the event stream). */
export interface CodexStreamState {
	error: string;
}

type CodexStreamEvent = {
	type?: string;
	message?: unknown;
	error?: { message?: unknown };
	item?: { type?: string; tool_name?: unknown };
};

/** Map a codex item.type to a friendly tool label so the panel reads the same as
 * claude's (Bash / Search / Edit / a tool name). */
function codexToolName(itemType: string, toolName?: unknown): string {
	if (itemType === "command_execution") return "Bash";
	if (itemType === "web_search") return "Search";
	if (itemType === "mcp_tool_call") return typeof toolName === "string" ? toolName : "mcp";
	if (itemType === "file_change" || itemType === "patch_apply") return "Edit";
	return itemType;
}

/** codex nests its API error as a JSON string inside `message`; dig out the human
 * sentence ("The 'x' model is not supported…") instead of surfacing the raw blob. */
function extractCodexError(raw: string): string {
	try {
		const inner = JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown };
		const m = inner.error && typeof inner.error.message === "string" ? inner.error.message : inner.message;
		if (typeof m === "string") return m;
	} catch {
		// not nested JSON — fall through to the raw string
	}
	return raw.slice(0, 160);
}

/**
 * Fold one codex --json line into `state` and emit live activity. codex emits
 * `thread.started` / `turn.started` / `item.started` / `item.completed` /
 * `turn.completed|failed`. We surface each `item.started` as activity (a command →
 * "Bash", reasoning → thinking, agent_message → writing) and capture the error from
 * `error` / `turn.failed`. The final TEXT comes from the -o tmpfile, not here.
 */
export function applyCodexStreamLine(
	line: string,
	state: CodexStreamState,
	onProgress?: (p: MemberProgress) => void,
): void {
	let o: CodexStreamEvent;
	try {
		o = JSON.parse(line) as CodexStreamEvent;
	} catch {
		return;
	}
	if (o.type === "item.started" && o.item?.type) {
		const it = o.item.type;
		if (it === "reasoning") onProgress?.({ kind: "thinking" });
		else if (it === "agent_message") onProgress?.({ kind: "writing" });
		else onProgress?.({ kind: "tool", tool: codexToolName(it, o.item.tool_name) });
		return;
	}
	if (o.type === "error" || o.type === "turn.failed") {
		const msg = o.type === "error" ? o.message : o.error?.message;
		if (typeof msg === "string" && !state.error) state.error = extractCodexError(msg);
	}
}

/** Probe a CLI by running `<cli> --version`; read-only, fast, win32-aware. */
export function detectCli(cli: FusionCli, spawnSyncFn = nodeSpawnSync): boolean {
	try {
		const r = spawnSyncFn(cli, ["--version"], { shell: IS_WIN, encoding: "utf8", timeout: 10_000 });
		return r.status === 0;
	} catch {
		return false;
	}
}

/** Kill a (possibly shell-wrapped) child and its descendants. On win32 the shell
 * wrapper orphans the grandchild, so reap the tree with taskkill. */
function killTree(child: ChildProcess): void {
	if (IS_WIN && typeof child.pid === "number") {
		try {
			nodeSpawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { shell: false });
		} catch {
			child.kill("SIGKILL");
		}
		return;
	}
	child.kill("SIGTERM");
	setTimeout(() => child.kill("SIGKILL"), 3000);
}

export interface RunMemberOptions {
	prompt: string;
	cwd: string;
	/** Hard wall-clock cap (ms) — backstop against a member that streams forever. */
	timeoutMs: number;
	/** Idle cap (ms): kill the member only if it produces NO output for this long (i.e.
	 * it's stuck). Reset on every stdout/stderr chunk so an actively-working member is
	 * never killed just for taking long. 0/undefined disables the idle check. */
	idleTimeoutMs?: number;
	signal?: AbortSignal;
	/** Injectable for tests. */
	spawnFn?: typeof nodeSpawn;
	tmpDir?: string;
	lean?: boolean;
	/** Token from Pit's own credentials, injected into the subprocess env so the
	 * member runs under the same login as Pit (see buildMemberEnv). */
	authToken?: string;
	/** Live activity callback (claude stream-json): fires per tool_use / text /
	 * thinking event as the member works, so the panel can show what it's doing. */
	onProgress?: (p: MemberProgress) => void;
}

/** Run one Panel member as a read-only subprocess; never throws — failure is encoded in PanelResult. */
export function runPanelMember(member: PanelMember, opts: RunMemberOptions): Promise<PanelResult> {
	const spawnFn = opts.spawnFn ?? nodeSpawn;
	const isCodex = member.cli === "codex";
	const safeModel = member.model.replace(/[^\w.-]/g, "_");
	const outFile = isCodex
		? join(opts.tmpDir ?? tmpdir(), `fusion-${member.cli}-${safeModel}-${process.pid}-${randomTag()}.txt`)
		: "";
	const lean = opts.lean ?? true;
	const args = isCodex ? buildCodexArgs(member.model, opts.cwd, outFile, lean) : buildClaudeArgs(member.model, lean);

	return new Promise<PanelResult>((resolve) => {
		// Only stderr is retained (tail-bounded) for the exit-code diagnostic; the
		// claude final text comes from claudeState.result and codex's from the -o file,
		// so raw stdout is consumed line-by-line via drain() and not otherwise kept.
		let stderr = "";
		let settled = false;
		let lineBuf = "";
		// Both CLIs stream JSONL: claude → live activity + final text; codex → live
		// activity + error (its final text still comes from the -o tmpfile). One line
		// splitter, per-cli line parser.
		const claudeState: ClaudeStreamState = { result: "", error: "", sawResult: false };
		const codexState: CodexStreamState = { error: "" };
		const parseLine = (line: string): void => {
			if (isCodex) applyCodexStreamLine(line, codexState, opts.onProgress);
			else applyClaudeStreamLine(line, claudeState, opts.onProgress);
		};
		const drain = (chunk: string): void => {
			lineBuf += chunk;
			let nl = lineBuf.indexOf("\n");
			while (nl >= 0) {
				const line = lineBuf.slice(0, nl).trim();
				lineBuf = lineBuf.slice(nl + 1);
				if (line) parseLine(line);
				nl = lineBuf.indexOf("\n");
			}
		};
		const finish = (r: PanelResult) => {
			if (settled) return;
			settled = true;
			if (isCodex) {
				try {
					rmSync(outFile, { force: true });
				} catch {
					/* best-effort */
				}
			}
			resolve(r);
		};

		// Esc during the brief/stagger can abort before we ever spawn. addEventListener
		// won't fire for an already-aborted signal, so short-circuit here — don't spawn a
		// subprocess we'd only have to kill.
		if (opts.signal?.aborted) {
			finish({ member, ok: false, text: "", error: "aborted" });
			return;
		}

		const command = IS_WIN ? `"${member.cli}"` : member.cli;
		const env = buildMemberEnv(member.cli, opts.authToken);
		const child = spawnFn(command, args, { cwd: opts.cwd, shell: IS_WIN, stdio: ["pipe", "pipe", "pipe"], env });

		// Idle-timeout: `timeoutMs` is a HARD wall-clock cap (backstop against a CLI that
		// streams forever), but a working advisor must NOT be killed just for taking long.
		// The idle timer is reset on every stdout/stderr chunk and fires only when the member
		// goes silent for `idleTimeoutMs` — i.e. it is actually stuck.
		const idleMs = opts.idleTimeoutMs && opts.idleTimeoutMs > 0 ? opts.idleTimeoutMs : 0;
		let idleTimer: ReturnType<typeof setTimeout> | undefined;
		const killWith = (note: string, error: string, ms: number) => {
			killTree(child);
			recordDiagnostic({
				category: "fusion.member-failed",
				level: "warn",
				source: "fusion.cli-runner",
				context: { note: `${member.cli}:${note}`, ms },
			});
			finish({ member, ok: false, text: "", error });
		};
		const hardTimer =
			opts.timeoutMs > 0
				? setTimeout(() => killWith("timeout", "timeout", opts.timeoutMs), opts.timeoutMs)
				: undefined;
		const armIdle = () => {
			if (idleMs <= 0) return;
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => killWith("idle-timeout", "idle timeout", idleMs), idleMs);
		};
		const clearTimers = () => {
			if (hardTimer) clearTimeout(hardTimer);
			if (idleTimer) clearTimeout(idleTimer);
		};
		armIdle();

		const onAbort = () => {
			clearTimers();
			opts.signal?.removeEventListener("abort", onAbort);
			killTree(child);
			recordDiagnostic({
				category: "fusion.member-failed",
				level: "warn",
				source: "fusion.cli-runner",
				context: { note: `${member.cli}:aborted` },
			});
			finish({ member, ok: false, text: "", error: "aborted" });
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (d) => {
			// Any output means the member is alive — push back the idle deadline.
			armIdle();
			// Every chunk reaches the line parser; raw stdout is not otherwise retained.
			drain(String(d));
		});
		child.stderr?.on("data", (d) => {
			// stderr counts as liveness too (some CLIs log progress there).
			armIdle();
			stderr = appendTail(stderr, String(d));
		});
		child.on("error", (err) => {
			clearTimers();
			recordDiagnostic({
				category: "fusion.member-failed",
				level: "warn",
				source: "fusion.cli-runner",
				context: { note: `${member.cli}:${err.message}` },
			});
			finish({ member, ok: false, text: "", error: err.message });
		});
		child.on("close", (code) => {
			clearTimers();
			opts.signal?.removeEventListener("abort", onAbort);
			if (settled) return;
			// Flush a trailing partial line (the final event can arrive without a newline).
			if (lineBuf.trim()) parseLine(lineBuf.trim());
			// The real cause is in the stream (claude: result event / envelope; codex: error
			// / turn.failed) — prefer it over the opaque exit code. claude runs in
			// stream-json (multi-line JSONL), so parseClaudeError (single-blob JSON.parse)
			// can't apply here; the is_error cause is folded into claudeState.error.
			const streamErr = isCodex ? codexState.error : claudeState.error;
			if (code !== 0) {
				const stderrExcerpt = stderr.length > 400 ? `${stderr.slice(0, 200)} … ${stderr.slice(-200)}` : stderr;
				recordDiagnostic({
					category: "fusion.member-failed",
					level: "warn",
					source: "fusion.cli-runner",
					context: { note: `${member.cli}:exit ${code}` },
				});
				finish({ member, ok: false, text: "", error: streamErr || stderrExcerpt || `exit ${code}` });
				return;
			}
			const text = isCodex ? readCodexOut(outFile) : claudeState.result;
			if (text) {
				finish({ member, ok: true, text });
				return;
			}
			// Exit 0 but no text — a member may still have flagged an error in its stream.
			const why = streamErr || "empty output";
			recordDiagnostic({
				category: "fusion.member-failed",
				level: "warn",
				source: "fusion.cli-runner",
				context: { note: `${member.cli}:${why === "empty output" ? "empty output" : "is_error"}` },
			});
			finish({ member, ok: false, text: "", error: why });
		});

		child.stdin?.write(opts.prompt);
		child.stdin?.end();
	});
}

function readCodexOut(outFile: string): string {
	try {
		return readFileSync(outFile, "utf8").trim();
	} catch {
		return "";
	}
}

/** Cap how much raw stdout/stderr we retain for diagnostics. The final text comes
 * from `claudeState.result` / the codex `-o` file and every chunk still reaches the
 * line parser; this tail bound only stops the retained buffer growing without limit. */
const STREAM_TAIL_BYTES = 8192;
function appendTail(buf: string, chunk: string): string {
	const next = buf + chunk;
	return next.length > STREAM_TAIL_BYTES ? next.slice(-STREAM_TAIL_BYTES) : next;
}

let _tag = 0;
function randomTag(): string {
	_tag = (_tag + 1) % 1_000_000;
	return String(_tag);
}
