import { existsSync } from "node:fs";
import type { AgentTool } from "@pit/agent-core";
import { Container, Text, truncateToWidth } from "@pit/tui";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { clampBashCommandRow } from "../../modes/interactive/components/bash-command-row.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { applyKeyAliases } from "./argument-prep.js";
import { OutputAccumulator } from "./output-accumulator.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import {
	collapseRepeatedLines,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
} from "./truncate.js";

const bashSchema = Type.Object(
	{
		command: Type.String({ description: "Bash command to execute" }),
		timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	},
	{ additionalProperties: false },
);

// Aliases for common LLM mistakes. `cmd` and `script` are the two most-seen
// variants in production traces; `commands` (array form) is normalized by
// joining with ' && ' so we still hit a single shell invocation.
const BASH_KEY_ALIASES = {
	cmd: "command",
	script: "command",
	shell: "command",
	run: "command",
} as const;

function prepareBashArguments(input: unknown): BashToolInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input as BashToolInput;
	let args = applyKeyAliases(input as Record<string, unknown>, BASH_KEY_ALIASES);
	// `commands: ["a", "b"]` -> `command: "a && b"`. Only triggers when canonical
	// `command` is absent so we never overwrite a string argument.
	if (Array.isArray((args as Record<string, unknown>).commands) && typeof args.command !== "string") {
		const commands = (args as Record<string, unknown>).commands as unknown[];
		if (commands.every((item) => typeof item === "string")) {
			const next = { ...args } as Record<string, unknown>;
			next.command = (commands as string[]).join(" && ");
			delete next.commands;
			args = next;
		}
	}
	return args as BashToolInput;
}

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to exit code (null if killed)
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout, env }) => {
			return new Promise((resolve, reject) => {
				const { shell, args } = getShellConfig(options?.shellPath);
				if (!existsSync(cwd)) {
					reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
					return;
				}
				const child = spawn(shell, [...args, command], {
					cwd,
					detached: process.platform !== "win32",
					env: env ?? getShellEnv(),
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
				if (child.pid) trackDetachedChildPid(child.pid);
				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				// Set timeout if provided.
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeout * 1000);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				const onAbort = () => {
					if (child.pid) killProcessTree(child.pid);
				};
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				waitForChildProcess(child)
					.then((code) => {
						if (child.pid) untrackDetachedChildPid(child.pid);
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (signal) signal.removeEventListener("abort", onAbort);
						if (signal?.aborted) {
							reject(new Error("aborted"));
							return;
						}
						if (timedOut) {
							reject(new Error(`timeout:${timeout}`));
							return;
						}
						resolve({ exitCode: code });
					})
					.catch((err) => {
						if (child.pid) untrackDetachedChildPid(child.pid);
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (signal) signal.removeEventListener("abort", onAbort);
						reject(err);
					});
			});
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

const BASH_PREVIEW_LINES = 0;
const BASH_UPDATE_THROTTLE_MS = 100;
// Below this, a successful command's `Took Xs` footer is pure noise — the
// duration carries no signal, so we drop it (kept on error/truncation/slow).
const BASH_SLOW_FOOTER_MS = 2000;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
	// Count of collapsed (hidden) output lines, set by the result body and read
	// by the call/title component so the `(N earlier lines, …)` hint rides on the
	// command line instead of costing its own row. Logical-line based (not visual)
	// so it's width-independent — no cross-component render-order race.
	skippedHint: number | undefined;
};

class BashResultRenderComponent extends Container {}

/**
 * Title component for a bash call. Renders the `$ command` line and, when the
 * result body has collapsed output, appends the `(N earlier lines, …to expand)`
 * hint to that same line so it costs no extra row. The skipped count is read
 * from the shared call state at render(width) time — after the result renderer
 * set it during the same rebuild — so the hint is always current with no extra
 * render pass.
 */
class BashCallRenderComponent {
	args: { command?: string; timeout?: number } | undefined;
	expanded = false;
	callState: BashRenderState | undefined;
	private cacheKey: string | undefined;
	private cacheLines: string[] | undefined;

	render(width: number): string[] {
		const skipped = this.expanded ? 0 : (this.callState?.skippedHint ?? 0);
		const command = str(this.args?.command);
		const key = `${width} ${skipped} ${this.expanded ? 1 : 0} ${command ?? ""} ${this.args?.timeout ?? ""}`;
		if (this.cacheLines !== undefined && this.cacheKey === key) return this.cacheLines;

		// Expanded, or no/invalid command: defer to the full multi-row formatter.
		if (this.expanded || command === null || command === "") {
			let title = formatBashCall(this.args, this.expanded);
			if (skipped > 0) {
				title += ` ${theme.fg("muted", `(${skipped} earlier lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
			}
			this.cacheLines = new Text(title, 0, 0).render(width);
			this.cacheKey = key;
			return this.cacheLines;
		}

		// Collapsed: clamp the command to a single visual row (shared with the
		// user `!` bash header). Skipped output lines fold into the hint count.
		const timeout = this.args?.timeout as number | undefined;
		const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
		this.cacheLines = [
			clampBashCommandRow({
				command,
				width,
				colorKey: "toolTitle",
				extraHidden: skipped,
				suffix: timeoutSuffix,
			}),
		];
		this.cacheKey = key;
		return this.cacheLines;
	}

	invalidate(): void {
		this.cacheKey = undefined;
		this.cacheLines = undefined;
	}
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Trailing failure status appended by `appendStatus` in `execute`. Lifted out
 * of the displayed output so the TUI can fold it into the muted footer line
 * instead of paying for a separate paragraph. The LLM-facing text is left
 * untouched — the caller still sees the verbatim status in its tool result.
 */
function extractFailureSuffix(text: string): { body: string; label: string } | undefined {
	const patterns: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
		[/^([\s\S]*?)(?:\n\n)?Command exited with code (-?\d+)$/, (m) => `exit ${m[2]}`],
		[/^([\s\S]*?)(?:\n\n)?Command aborted$/, () => "aborted"],
		[/^([\s\S]*?)(?:\n\n)?Command timed out after ([\d.]+) seconds$/, (m) => `timed out ${m[2]}s`],
	];
	for (const [re, label] of patterns) {
		const match = text.match(re);
		if (match) {
			return { body: match[1].trimEnd(), label: label(match) };
		}
	}
	return undefined;
}

const BASH_TITLE_HEAD_LINES = 3;

function formatBashCall(args: { command?: string; timeout?: number } | undefined, expanded: boolean): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";

	if (command === null) {
		return theme.fg("toolTitle", theme.bold(`$ ${invalidArgText(theme)}`)) + timeoutSuffix;
	}
	if (!command) {
		return theme.fg("toolTitle", theme.bold(`$ ${theme.fg("toolOutput", "...")}`)) + timeoutSuffix;
	}

	// Multiline heredocs and inline scripts otherwise dominate the title block;
	// keep the first few lines and defer the rest to the expand affordance.
	if (!expanded && command.includes("\n")) {
		const lines = command.split("\n");
		if (lines.length > BASH_TITLE_HEAD_LINES) {
			const head = lines.slice(0, BASH_TITLE_HEAD_LINES).join("\n");
			const remaining = lines.length - BASH_TITLE_HEAD_LINES;
			const titlePart = theme.fg("toolTitle", theme.bold(`$ ${head}`));
			const hint = `\n${theme.fg("muted", `... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
			return titlePart + hint + timeoutSuffix;
		}
	}

	return theme.fg("toolTitle", theme.bold(`$ ${command}`)) + timeoutSuffix;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
	isError: boolean,
	callState: BashRenderState,
): void {
	component.clear();

	const rawOutput = getTextOutput(result as any, showImages).trim();
	// Peel the trailing `Command (exited|aborted|timed out…)` line off so it
	// becomes a chip on the muted footer instead of a standalone paragraph.
	const failure = isError ? extractFailureSuffix(rawOutput) : undefined;
	const output = failure ? failure.body : rawOutput;
	const emptyOutput = output.length === 0 || output === "(no output)";

	// Default: nothing hidden. The collapsed branch below overrides this; the
	// title component reads it to decide whether to show the inline hint.
	callState.skippedHint = 0;

	// Tracks whether any body/warning line is actually rendered above the footer.
	// With BASH_PREVIEW_LINES === 0 the body is fully collapsed (just the inline
	// hint on the command line), so the footer/warning must hug the header instead
	// of leaving an orphan blank line.
	let hasContentAbove = false;
	if (!emptyOutput) {
		const logicalLines = output.split("\n");

		if (options.expanded) {
			const styledOutput = logicalLines.map((line) => theme.fg("toolOutput", line)).join("\n");
			component.addChild(new Text(styledOutput, 0, 0));
			hasContentAbove = true;
		} else {
			// Show only the last N logical lines, each clipped to one visual row,
			// so the body footprint is a fixed N rows. The count of hidden lines
			// is handed to the title component to render on the command line.
			// `slice(-0)` returns the whole array, so guard the "command-only" case
			// (BASH_PREVIEW_LINES === 0) explicitly.
			const previewLines = BASH_PREVIEW_LINES > 0 ? logicalLines.slice(-BASH_PREVIEW_LINES) : [];
			callState.skippedHint = logicalLines.length - previewLines.length;
			hasContentAbove = previewLines.length > 0;
			component.addChild({
				render: (width: number) =>
					previewLines.map((line) => theme.fg("toolOutput", truncateToWidth(line, width, "…"))),
				invalidate: () => {},
			});
		}
	}

	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	const hasWarnings = !!truncation?.truncated || !!fullOutputPath;
	if (hasWarnings) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		const warningPrefix = hasContentAbove ? "\n" : "";
		component.addChild(new Text(`${warningPrefix}${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
		hasContentAbove = true;
	}

	// Footer fold: `(no output) · exit 2 · 0.1s`-style single muted line. It hugs
	// whatever is directly above — the command header when the body is fully
	// collapsed (no preview lines / no warning), or the last rendered line
	// otherwise — so no orphan blank line sits between the command and the footer.
	const footerParts: string[] = [];
	if (emptyOutput && (failure || isError)) {
		footerParts.push("(no output)");
	}
	if (failure) {
		footerParts.push(failure.label);
	}
	if (startedAt !== undefined) {
		const endTime = endedAt ?? Date.now();
		const elapsed = endTime - startedAt;
		// Surface duration only when it carries signal: live (streaming),
		// errored, truncated, or genuinely slow. A fast successful command's
		// `Took 0.1s` is noise, so it's dropped to save the footer line.
		const showDuration = options.isPartial || isError || hasWarnings || elapsed >= BASH_SLOW_FOOTER_MS;
		if (showDuration) {
			const label = options.isPartial ? "Elapsed" : "Took";
			footerParts.push(`${label} ${formatDuration(elapsed)}`);
		}
	}
	if (footerParts.length === 0) {
		return;
	}
	const prefix = hasContentAbove ? "\n" : "";
	component.addChild(new Text(`${prefix}${theme.fg("muted", footerParts.join(" · "))}`, 0, 0));
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	return {
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory.

Use bash ONLY for tasks no dedicated tool covers: build/test scripts, install, git operations, network requests, process management, shell pipelines/redirects, or one-off commands.

Do NOT use bash to replace dedicated tools (the dedicated tool is always preferred when both are available):
- read a file → use \`read\` (not cat/head/tail/sed)
- search file contents → use \`grep\` (not grep/rg/egrep)
- locate files by name/glob → use \`find\` (not find/ls -R)
- list directory entries → use \`ls\` (not bash ls)
- create/overwrite a file → use \`write\`
- edit a file → use \`edit\`

Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.

Common mistakes to avoid:
- Passing the command under "cmd"/"script"/"run" — the canonical key is "command".
- Passing multiple commands as an array — join with " && " into a single "command" string, or call bash once per logical group.
- Using bash to read/grep/find files when those dedicated tools are available.
- Forgetting that each invocation runs in a fresh shell (no carried env, no carried cwd — use "cd /path && command" inline).
- Embedding multi-line scripts — write to a temp file with "write", then invoke it.`,
		promptSnippet: "Execute bash commands (build/test/git/network only; prefer read/grep/find/ls for files)",
		parameters: bashSchema,
		prepareArguments: prepareBashArguments,
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);
			const output = new OutputAccumulator({ tempFilePrefix: "pi-bash" });
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				// Collapse runs of identical consecutive lines (repeated log/test/warning
				// lines) to cut LLM tokens at the source. Lossless of meaning; the full
				// output is preserved on disk when truncated (fullOutputPath below).
				let text = snapshot.content ? collapseRepeatedLines(snapshot.content) : emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

			try {
				let exitCode: number | null;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode !== 0 && exitCode !== null) {
					throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
				}
				return { content: [{ type: "text", text: outputText }], details };
			} finally {
				clearUpdateTimer();
			}
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const comp =
				context.lastComponent instanceof BashCallRenderComponent
					? context.lastComponent
					: new BashCallRenderComponent();
			comp.args = args;
			comp.expanded = context.expanded;
			comp.callState = state;
			comp.invalidate();
			return comp;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result as any,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
				context.isError,
				state,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
