/**
 * `recipe` tool — invoke a target from a detected task runner.
 *
 * Detects (in priority order):
 *   1. package.json with scripts.<target>  → npm/bun/pnpm/yarn (from lockfile)
 *   2. Justfile / justfile                 → just <target>
 *   3. Makefile                            → make <target>
 *   4. Cargo.toml                          → cargo <target> (known subcommands only)
 *   5. pyproject.toml with [tool.poe]      → poe <target>
 *
 * Uses execFile, streams stdout/stderr, applies a 5-minute hard timeout, and
 * honors the agent's abort signal.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as nodePath from "node:path";
import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { getTextOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const recipeSchema = Type.Object(
	{
		target: Type.String({
			description: 'Task/script/recipe name to invoke (e.g. "build", "test", "clean").',
		}),
		args: Type.Optional(
			Type.Array(Type.String(), {
				description: "Extra arguments forwarded to the task runner after the target.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type RecipeToolInput = Static<typeof recipeSchema>;

export interface RecipeToolDetails {
	runner: string;
	command: string;
	args: string[];
	exitCode: number;
	durationMs: number;
}

export interface RecipeToolOptions {
	/** Max wall-clock time per invocation in ms. Default 5 minutes. */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const CARGO_SUBCOMMANDS = new Set(["build", "test", "check", "run", "clippy", "fmt"]);

type Runner = {
	binary: string;
	args: string[];
	label: string;
};

function readTextSafe(path: string): string | null {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return null;
	}
}

function detectPackageManager(cwd: string): { binary: string; runArgs: string[] } {
	if (existsSync(nodePath.join(cwd, "bun.lockb")) || existsSync(nodePath.join(cwd, "bun.lock"))) {
		return { binary: "bun", runArgs: ["run"] };
	}
	if (existsSync(nodePath.join(cwd, "pnpm-lock.yaml"))) {
		return { binary: "pnpm", runArgs: ["run"] };
	}
	if (existsSync(nodePath.join(cwd, "yarn.lock"))) {
		return { binary: "yarn", runArgs: ["run"] };
	}
	return { binary: "npm", runArgs: ["run"] };
}

function detectRunner(cwd: string, target: string, extraArgs: string[]): Runner | { error: string } {
	// 1. package.json
	const pkgPath = nodePath.join(cwd, "package.json");
	if (existsSync(pkgPath)) {
		const raw = readTextSafe(pkgPath);
		if (raw) {
			try {
				const pkg = JSON.parse(raw);
				const scripts = pkg?.scripts;
				if (scripts && typeof scripts === "object" && target in scripts) {
					const pm = detectPackageManager(cwd);
					const args = [...pm.runArgs, target];
					if (extraArgs.length > 0) {
						// npm/pnpm/yarn require `--` to forward args. bun does not, but accepts it.
						args.push("--", ...extraArgs);
					}
					return { binary: pm.binary, args, label: `${pm.binary} run ${target}` };
				}
			} catch {
				// fall through to next runner
			}
		}
	}

	// 2. Justfile
	if (existsSync(nodePath.join(cwd, "Justfile")) || existsSync(nodePath.join(cwd, "justfile"))) {
		return { binary: "just", args: [target, ...extraArgs], label: `just ${target}` };
	}

	// 3. Makefile
	if (existsSync(nodePath.join(cwd, "Makefile")) || existsSync(nodePath.join(cwd, "makefile"))) {
		return { binary: "make", args: [target, ...extraArgs], label: `make ${target}` };
	}

	// 4. Cargo.toml (only known subcommands)
	if (existsSync(nodePath.join(cwd, "Cargo.toml"))) {
		if (CARGO_SUBCOMMANDS.has(target)) {
			return { binary: "cargo", args: [target, ...extraArgs], label: `cargo ${target}` };
		}
	}

	// 5. pyproject.toml with [tool.poe]
	const pyproject = readTextSafe(nodePath.join(cwd, "pyproject.toml"));
	if (pyproject && /\[tool\.poe(\.tasks)?\]/.test(pyproject)) {
		return { binary: "poe", args: [target, ...extraArgs], label: `poe ${target}` };
	}

	return {
		error: "No task runner detected (looked for: package.json, Justfile, Makefile, Cargo.toml, pyproject.toml).",
	};
}

interface RunOutcome {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

function runRunner(
	binary: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<RunOutcome> {
	return new Promise((resolve) => {
		let timedOut = false;
		// On Windows, package-manager binaries (npm, pnpm, yarn, bun) are typically
		// installed as `.cmd` / `.bat` shims, which Node's execFile cannot resolve
		// without invoking the shell. We still pass args as an array so the shell
		// receives properly quoted tokens, not a concatenated command string.
		const useShell = process.platform === "win32";
		const child = execFile(
			binary,
			args,
			{
				cwd,
				signal,
				timeout: timeoutMs,
				maxBuffer: 16 * 1024 * 1024,
				shell: useShell,
				windowsHide: true,
			},
			(err, stdout, stderr) => {
				const stdoutStr = stdout?.toString() ?? "";
				const stderrStr = stderr?.toString() ?? "";
				if (err) {
					const e = err as NodeJS.ErrnoException & { code?: string | number; killed?: boolean; signal?: string };
					if (e.code === "ENOENT") {
						resolve({
							exitCode: 127,
							stdout: stdoutStr,
							stderr: stderrStr || `recipe error: binary not found in PATH: ${binary}`,
							timedOut: false,
						});
						return;
					}
					if (e.signal === "SIGTERM" && e.killed) {
						timedOut = true;
					}
					const exitCode = typeof e.code === "number" ? e.code : 1;
					resolve({ exitCode, stdout: stdoutStr, stderr: stderrStr || String(err), timedOut });
					return;
				}
				resolve({ exitCode: 0, stdout: stdoutStr, stderr: stderrStr, timedOut });
			},
		);
		void child;
	});
}

function formatOutput(runner: string, binary: string, args: string[], outcome: RunOutcome, durationMs: number): string {
	const head = `[${runner}: ${binary} ${args.join(" ")}] exit=${outcome.exitCode} dur=${durationMs}ms${
		outcome.timedOut ? " (timed out)" : ""
	}`;
	const parts: string[] = [head];
	const sections: Array<[string, string]> = [];
	if (outcome.stdout) sections.push(["stdout", outcome.stdout]);
	if (outcome.stderr) sections.push(["stderr", outcome.stderr]);
	for (const [label, body] of sections) {
		const trimmed = body.replace(/\s+$/, "");
		const oneLine = !trimmed.includes("\n") && trimmed.length <= 80;
		if (oneLine) {
			parts.push(`${label}: ${trimmed}`);
		} else {
			parts.push(`--- ${label} ---`);
			parts.push(trimmed);
		}
	}
	if (sections.length === 0) {
		parts.push("(no output)");
	}
	return parts.join("\n");
}

export function createRecipeToolDefinition(
	cwd: string,
	options?: RecipeToolOptions,
): ToolDefinition<typeof recipeSchema, RecipeToolDetails | undefined> {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	return {
		name: "recipe",
		label: "recipe",
		description:
			"Invoke a build/test/lint target from the detected task runner — no need to remember which (npm/bun/pnpm/yarn/just/make/cargo/poe). Auto-detects from manifest files in cwd.",
		promptSnippet: "Run a target via the detected task runner.",
		promptGuidelines: [
			"Use recipe instead of guessing which package manager / build tool runs a target.",
			"Pass extra flags via `args` (forwarded after the target; `--` is inserted for npm-like runners).",
			"Falls back with a clear error if no manifest is found.",
		],
		parameters: recipeSchema,
		async execute(_toolCallId, input: RecipeToolInput, signal) {
			const extraArgs = input.args ?? [];
			const detected = detectRunner(cwd, input.target, extraArgs);
			if ("error" in detected) {
				return {
					content: [{ type: "text" as const, text: detected.error }],
					isError: true,
					details: undefined,
				};
			}
			const started = Date.now();
			let outcome: RunOutcome;
			try {
				outcome = await runRunner(detected.binary, detected.args, cwd, timeoutMs, signal);
			} catch (err) {
				const msg = (err as Error).message ?? String(err);
				return {
					content: [{ type: "text" as const, text: `recipe error: ${msg}` }],
					isError: true,
					details: undefined,
				};
			}
			const durationMs = Date.now() - started;
			const text = formatOutput(detected.label, detected.binary, detected.args, outcome, durationMs);
			const isError = outcome.exitCode !== 0;
			return {
				content: [{ type: "text" as const, text }],
				isError,
				details: {
					runner: detected.binary,
					command: detected.label,
					args: detected.args,
					exitCode: outcome.exitCode,
					durationMs,
				},
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const target = str(args?.target) || "";
			const extra = Array.isArray(args?.args) ? ` ${(args.args as string[]).join(" ")}` : "";
			text.setText(
				`${theme.fg("toolTitle", theme.bold("recipe"))} ${theme.fg("accent", target)}${theme.fg(
					"toolOutput",
					extra,
				)}`,
			);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result as any, context.showImages).trim();
			text.setText(output ? `\n${theme.fg("toolOutput", output)}` : "");
			return text;
		},
	};
}

export function createRecipeTool(cwd: string, options?: RecipeToolOptions): AgentTool<typeof recipeSchema> {
	return wrapToolDefinition(createRecipeToolDefinition(cwd, options));
}
