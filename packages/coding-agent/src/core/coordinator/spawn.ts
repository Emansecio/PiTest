/**
 * spawnSubagent — runs a one-shot Agent loop with restricted tools and
 * captures the final assistant text.
 *
 * The subagent shares the parent's model, auth, and streamFn so it inherits
 * provider-level retries, token caching, and OAuth wiring without duplicate
 * code paths. The Agent instance is short-lived and discarded after the
 * prompt completes.
 *
 * Optional extensions:
 *   - `resultSchema`: validates the subagent's final assistant text against
 *     a typebox schema, returning the parsed value as `result.value`.
 *   - `worktree`: runs the subagent in an isolated git worktree checked out
 *     at the parent's HEAD; cleans up on settle (unless `cleanup: "keep"`).
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { type Message, modelsAreEqual, streamSimple } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import type { ModelRegistry } from "../model-registry.ts";
import { recordSubagentResult } from "./agent-url.ts";
import type { SubagentRegistry } from "./registry.ts";
import type { SpawnSubagentOptions, SpawnSubagentResult, SubagentTaskResult, WorktreeSpec } from "./types.ts";

const execFileP = promisify(execFile);

const DEFAULT_SYSTEM_PROMPT =
	"You are a focused subagent. Use the provided tools to complete the task in as few turns as possible, " +
	"then summarize the result in a final assistant message. Do not ask follow-up questions; deliver a self-contained answer.";

const SCHEMA_PROMPT_SUFFIX =
	"\n\nYour final assistant message MUST be a single fenced ```json``` block containing a JSON object that matches the provided result schema. Do not include any prose outside the fence.";

export interface SpawnSubagentDependencies {
	registry: SubagentRegistry;
	model: Model<any>;
	modelRegistry: ModelRegistry;
	availableTools: AgentTool[];
	convertToLlm: (messages: AgentMessage[]) => Message[];
}

function filterTools(tools: readonly AgentTool[], allowed: readonly string[] | undefined): AgentTool[] {
	if (!allowed) return [...tools];
	const allowSet = new Set(allowed);
	return tools.filter((tool) => allowSet.has(tool.name));
}

function extractAssistantText(messages: readonly AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		if (!Array.isArray(msg.content)) continue;
		const text = msg.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (text.length > 0) {
			return text;
		}
	}
	return "(subagent produced no textual output)";
}

const FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)\n```/i;

/** Extracts a JSON payload from an assistant message, preferring fenced blocks. */
function extractJsonPayload(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
	const trimmed = text.trim();
	const fenced = FENCE_RE.exec(trimmed);
	const candidate = fenced ? fenced[1].trim() : trimmed;
	if (!candidate) return { ok: false, error: "empty assistant output" };
	try {
		return { ok: true, value: JSON.parse(candidate) };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `JSON parse failed: ${message}` };
	}
}

function normalizeWorktree(spec: SpawnSubagentOptions["worktree"]): WorktreeSpec | undefined {
	if (!spec) return undefined;
	if (spec === true) return { cleanup: "auto" };
	return { cleanup: "auto", ...spec };
}

interface WorktreeHandle {
	path: string;
	cleanup: "auto" | "keep";
}

async function createWorktree(parentCwd: string, taskName: string, spec: WorktreeSpec): Promise<WorktreeHandle> {
	const root = resolve(parentCwd, ".pi", "worktreesParent");
	const safeName = taskName.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40) || "task";
	const dir = join(parentCwd, ".pi", "worktrees", `${safeName}-${randomUUID().slice(0, 8)}`);
	await mkdir(join(parentCwd, ".pi", "worktrees"), { recursive: true });
	// Use --detach so the worktree is on a detached HEAD copy of current HEAD;
	// this avoids branch conflicts and keeps the parent branch untouched.
	const args = ["worktree", "add", "--detach", dir, spec.branch ?? "HEAD"];
	await execFileP("git", args, { cwd: parentCwd });
	// Silence "unused" lint for `root` — kept for clarity if path layout changes.
	void root;
	return { path: dir, cleanup: spec.cleanup ?? "auto" };
}

async function removeWorktree(parentCwd: string, path: string): Promise<void> {
	try {
		await execFileP("git", ["worktree", "remove", "--force", path], { cwd: parentCwd });
	} catch {
		// Best-effort cleanup: git may have already pruned, or the directory is
		// gone. Swallow to avoid masking the real task error.
	}
}

export async function spawnSubagent(
	deps: SpawnSubagentDependencies,
	options: SpawnSubagentOptions,
): Promise<SpawnSubagentResult> {
	const record = deps.registry.create({
		prompt: options.prompt,
		systemPrompt: options.systemPrompt,
		allowedTools: options.allowedTools,
	});
	deps.registry.update(record.id, { status: "running", startedAt: Date.now() });

	const parentCwd = options.cwd ?? process.cwd();
	const worktreeSpec = normalizeWorktree(options.worktree);
	const taskName = options.taskName ?? record.id;

	let worktree: WorktreeHandle | undefined;
	if (worktreeSpec) {
		try {
			worktree = await createWorktree(parentCwd, taskName, worktreeSpec);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			deps.registry.update(record.id, {
				status: "failed",
				endedAt: Date.now(),
				error: `worktree setup failed: ${message}`,
			});
			throw new Error(`worktree setup failed: ${message}`);
		}
	}

	// Combine the caller's signal with any internally-derived ones (timeout,
	// turn cap). We own the controller so we can fire abort in either case.
	const controller = new AbortController();
	const onParentAbort = () => controller.abort();
	if (options.signal) {
		if (options.signal.aborted) controller.abort();
		else options.signal.addEventListener("abort", onParentAbort, { once: true });
	}

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	if (options.timeoutMs && options.timeoutMs > 0) {
		timeoutHandle = setTimeout(() => controller.abort(), options.timeoutMs);
	}

	const systemPromptBase = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
	const systemPrompt = options.resultSchema ? `${systemPromptBase}${SCHEMA_PROMPT_SUFFIX}` : systemPromptBase;
	const tools = filterTools(deps.availableTools, options.allowedTools);
	const maxTurns = options.maxTurns ?? 25;
	let turnCount = 0;

	const agent = new Agent({
		initialState: {
			systemPrompt,
			model: deps.model,
			thinkingLevel: "off",
			tools,
		},
		convertToLlm: deps.convertToLlm,
		streamFn: async (model, context, streamOptions) => {
			const auth = await deps.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) {
				throw new Error(auth.error);
			}
			return streamSimple(model, context, {
				...streamOptions,
				apiKey: auth.apiKey,
				headers: auth.headers,
			});
		},
	});

	agent.subscribe((event) => {
		if (event.type === "turn_end") {
			turnCount++;
			deps.registry.update(record.id, { turnCount });
			if (turnCount >= maxTurns) {
				controller.abort();
			}
		}
	});

	const cleanup = async () => {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		if (options.signal) options.signal.removeEventListener("abort", onParentAbort);
		if (worktree && worktree.cleanup === "auto") {
			await removeWorktree(parentCwd, worktree.path);
		}
	};

	try {
		const promptText = options.prompt;
		const promise = agent.prompt(promptText);
		const aborted = new Promise<void>((_, reject) => {
			if (controller.signal.aborted) {
				reject(new Error("aborted"));
				return;
			}
			controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
		});
		await Promise.race([promise, aborted]);

		const output = extractAssistantText(agent.state.messages);
		let value: unknown | undefined;
		if (options.resultSchema) {
			const parsed = extractJsonPayload(output);
			if (!parsed.ok) {
				const errMsg = `Subagent output did not match resultSchema: ${parsed.error}`;
				deps.registry.update(record.id, {
					status: "failed",
					endedAt: Date.now(),
					output,
					error: errMsg,
					turnCount,
				});
				const settled: SubagentTaskResult = {
					taskName,
					ok: false,
					output,
					error: errMsg,
					worktreePath: worktree && worktree.cleanup === "keep" ? worktree.path : undefined,
				};
				recordSubagentResult(taskName, settled);
				await cleanup();
				throw new Error(errMsg);
			}
			if (!Value.Check(options.resultSchema, parsed.value)) {
				const issues = [...Value.Errors(options.resultSchema, parsed.value)]
					.slice(0, 3)
					.map((e) => `${e.instancePath || "/"}: ${e.message}`)
					.join("; ");
				const errMsg = `Subagent output did not match resultSchema: ${issues || "validation failed"}`;
				deps.registry.update(record.id, {
					status: "failed",
					endedAt: Date.now(),
					output,
					error: errMsg,
					turnCount,
				});
				const settled: SubagentTaskResult = {
					taskName,
					ok: false,
					output,
					error: errMsg,
					worktreePath: worktree && worktree.cleanup === "keep" ? worktree.path : undefined,
				};
				recordSubagentResult(taskName, settled);
				await cleanup();
				throw new Error(errMsg);
			}
			value = parsed.value;
		}

		deps.registry.update(record.id, {
			status: "completed",
			endedAt: Date.now(),
			output,
			turnCount,
		});

		const settled: SubagentTaskResult = {
			taskName,
			ok: true,
			output,
			value,
			worktreePath: worktree && worktree.cleanup === "keep" ? worktree.path : undefined,
			cost: { durationMs: Date.now() - (record.startedAt ?? Date.now()) },
		};
		recordSubagentResult(taskName, settled);

		await cleanup();
		return {
			record: deps.registry.get(record.id)!,
			output,
			value,
			worktreePath: worktree?.path,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const status = message === "aborted" ? "cancelled" : "failed";
		deps.registry.update(record.id, {
			status,
			endedAt: Date.now(),
			error: message,
			turnCount,
		});
		const settled: SubagentTaskResult = {
			taskName,
			ok: false,
			error: message,
			worktreePath: worktree && worktree.cleanup === "keep" ? worktree.path : undefined,
		};
		recordSubagentResult(taskName, settled);
		await cleanup();
		throw err;
	}
}

/** Resolves the parent's effective model (used by the task tool). */
export function resolveSubagentModel(
	parentModel: Model<any> | undefined,
	fallbacks: readonly Model<any>[],
): Model<any> | undefined {
	if (parentModel) return parentModel;
	for (const candidate of fallbacks) {
		if (candidate) return candidate;
	}
	return undefined;
}

export function modelsMatch(a: Model<any> | undefined, b: Model<any> | undefined): boolean {
	if (!a || !b) return false;
	return modelsAreEqual(a, b);
}
