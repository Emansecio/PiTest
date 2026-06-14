import { type ChildProcess, spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FusionCli, PanelMember, PanelResult } from "./types.ts";

const IS_WIN = process.platform === "win32";

/** Map a model's registry provider to the CLI that drives it. */
export function inferCli(provider: string): FusionCli | undefined {
	if (provider === "anthropic") return "claude";
	if (provider === "openai-codex") return "codex";
	return undefined;
}

export function buildCodexArgs(model: string, cwd: string, outFile: string): string[] {
	return ["exec", "-s", "read-only", "-m", model, "-C", cwd, "-o", outFile, "--skip-git-repo-check"];
}

export function buildClaudeArgs(model: string): string[] {
	return ["-p", "--output-format", "json", "--permission-mode", "plan", "--model", model];
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
	timeoutMs: number;
	signal?: AbortSignal;
	/** Injectable for tests. */
	spawnFn?: typeof nodeSpawn;
	tmpDir?: string;
}

/** Run one Panel member as a read-only subprocess; never throws — failure is encoded in PanelResult. */
export function runPanelMember(member: PanelMember, opts: RunMemberOptions): Promise<PanelResult> {
	const spawnFn = opts.spawnFn ?? nodeSpawn;
	const isCodex = member.cli === "codex";
	const outFile = isCodex
		? join(opts.tmpDir ?? tmpdir(), `fusion-${member.cli}-${member.model}-${process.pid}-${randomTag()}.txt`)
		: "";
	const args = isCodex ? buildCodexArgs(member.model, opts.cwd, outFile) : buildClaudeArgs(member.model);

	return new Promise<PanelResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
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

		const command = IS_WIN ? `"${member.cli}"` : member.cli;
		const child = spawnFn(command, args, { cwd: opts.cwd, shell: IS_WIN, stdio: ["pipe", "pipe", "pipe"] });

		const timer = setTimeout(() => {
			killTree(child);
			finish({ member, ok: false, text: "", error: "timeout" });
		}, opts.timeoutMs);

		const onAbort = () => {
			killTree(child);
			finish({ member, ok: false, text: "", error: "aborted" });
		};
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (d) => {
			stdout += String(d);
		});
		child.stderr?.on("data", (d) => {
			stderr += String(d);
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			finish({ member, ok: false, text: "", error: err.message });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			if (settled) return;
			if (code !== 0) {
				finish({ member, ok: false, text: "", error: stderr.slice(-400) || `exit ${code}` });
				return;
			}
			const text = isCodex ? readCodexOut(outFile) : parseClaudeResult(stdout);
			finish(text ? { member, ok: true, text } : { member, ok: false, text: "", error: "empty output" });
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

let _tag = 0;
function randomTag(): string {
	_tag = (_tag + 1) % 1_000_000;
	return String(_tag);
}
