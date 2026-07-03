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
import { join } from "node:path";
import { promisify } from "node:util";
import {
	Agent,
	type AgentMessage,
	type AgentTool,
	type BeforeToolCallResult,
	type ThinkingLevel,
} from "@pit/agent-core";
import type { Model } from "@pit/ai";
import { type Message, repairJson, streamSimple } from "@pit/ai";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { areSubagentGuardsDisabled, createSubagentGuardChain } from "../built-ins/subagent-guards.ts";
import type { ToolCallEvent, ToolResultEvent } from "../extensions/types.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { describeToolAction, type PermissionChecker } from "../permissions/index.ts";
import { formatSkillsForPrompt, type Skill } from "../skills.ts";
import type { SubagentRegistry } from "./registry.ts";
import type { SpawnSubagentOptions, SpawnSubagentResult, SubagentUsage, WorktreeSpec } from "./types.ts";

const execFileP = promisify(execFile);

const DEFAULT_SYSTEM_PROMPT =
	"You are a focused subagent. Use the provided tools to complete the task in as few turns as possible, " +
	"then summarize the result in a final assistant message. Do not ask follow-up questions; deliver a self-contained answer.";

/**
 * Default hard cap on subagent turns when the caller does not pass `maxTurns`.
 * 25 was too low for long recon/mining tasks (MFE bundle reversing, JS chunk
 * walks) that silently hit the cap and surfaced only a bare "aborted" — raised
 * to give those room while still bounding a runaway loop. Callers can override
 * per task via the `max_turns` tool param.
 */
export const DEFAULT_MAX_TURNS = 50;

/**
 * Model-id substrings that mark a "small-class" model — the cheap/fast tiers
 * (haiku, mini, nano, flash, lite) that a fan-out hands its trivial, mechanical
 * work to (search, read, list, extract, classify). Matched case-insensitively
 * against the model id. Kept as a named list so the bucket is auditable in one
 * place rather than scattered across string checks.
 */
export const SMALL_CLASS_MODEL_MARKERS: readonly string[] = ["haiku", "mini", "nano", "flash", "lite"];

/**
 * Default reasoning level for a subagent, bucketed by the model it runs on.
 *
 * Rationale (auditoria §3.5/§5.8): subagents used to think at "medium"
 * unconditionally — burning reasoning tokens on the trivial fan-out tasks that
 * are deliberately routed to small/fast models. A small-class model is almost
 * always given mechanical work, so it defaults to "low"; every other model keeps
 * the historical "medium".
 *
 * The repo invariant that subagents ALWAYS think (never "off" — see the coercion
 * in coordinator-extension's resolveSubModel and the "medium" fallback below) is
 * preserved: the floor here is "low", not "off". An explicit per-task thinking
 * override still wins over this default (see `spawnSubagent`, where
 * `options.thinkingLevel` short-circuits this call).
 */
export function resolveSubagentThinking(model: Model<any> | undefined): ThinkingLevel {
	const id = model?.id?.toLowerCase() ?? "";
	if (SMALL_CLASS_MODEL_MARKERS.some((marker) => id.includes(marker))) return "low";
	return "medium";
}

/** Coerce an AbortSignal `reason` into an Error for rejection. `controller.abort()`
 * may be called with an explanatory Error (turn cap / timeout / parent), a string,
 * or nothing (default DOMException). Keeps the message informative downstream. */
function toAbortError(reason: unknown): Error {
	if (reason instanceof Error) return reason;
	if (typeof reason === "string" && reason.length > 0) return new Error(reason);
	return new Error("aborted");
}

/** Build the schema instruction appended to a subagent's system prompt when a
 * `resultSchema` is set. The schema is SERIALIZED into the prompt (not merely
 * referenced) so the model emits the exact property names and value types — without
 * this the model guesses the shape (e.g. "status" instead of "verdict") and the
 * downstream `Value.Check` silently rejects an otherwise-fine answer. */
function schemaPromptSuffix(schema: TSchema): string {
	return (
		"\n\nYour final assistant message MUST be a single fenced ```json``` block containing a JSON " +
		"object that conforms to this JSON Schema:\n```json\n" +
		`${JSON.stringify(schema, null, 2)}\n` +
		"```\nUse exactly the property names and value types it specifies. Do not include any prose outside the fence."
	);
}

export interface SpawnSubagentDependencies {
	registry: SubagentRegistry;
	model: Model<any>;
	modelRegistry: ModelRegistry;
	availableTools: AgentTool[];
	convertToLlm: (messages: AgentMessage[]) => Message[];
	/**
	 * Parent's permission checker. When provided, every tool call the subagent
	 * attempts is gated through the same policy as the parent (denyTools,
	 * denyPaths, plan-mode mutation blocks, etc.). The subagent runs headless,
	 * so an "ask" decision is treated as a denial — there is no UI to confirm.
	 * When omitted, the subagent runs ungated (legacy behavior, e.g. tests).
	 */
	permissionChecker?: PermissionChecker;
	/**
	 * Parent's model-invocable skills. Appended to the subagent's system prompt
	 * only when the spawn opts in via `inheritSkills`. Omitted = subagent runs
	 * skill-blind (legacy behavior).
	 */
	skills?: Skill[];
}

/**
 * Maps a subagent tool call to a permission decision. Returns a
 * `BeforeToolCallResult` with `block: true` when the parent's policy denies the
 * call, or `undefined` to allow it.
 *
 * Exported for unit testing the gating logic in isolation.
 */
export function evaluateSubagentToolPermission(
	checker: PermissionChecker,
	toolName: string,
	args: Record<string, unknown>,
): BeforeToolCallResult | undefined {
	const decision = checker.check(describeToolAction(toolName, args));
	if (decision.decision === "deny") {
		return { block: true, reason: decision.reason ?? `Tool "${toolName}" is denied by permission policy.` };
	}
	return undefined;
}

function filterTools(tools: readonly AgentTool[], allowed: readonly string[] | undefined): AgentTool[] {
	if (!allowed) return [...tools];
	const allowSet = new Set(allowed);
	return tools.filter((tool) => allowSet.has(tool.name));
}

export function extractAssistantText(messages: readonly AgentMessage[]): string {
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
		// Deterministic second pass: repairJson fixes control chars / invalid escapes
		// the model leaves in (no-op on already-valid JSON). Only runs on parse
		// failure, so a clean payload never pays for it.
		try {
			return { ok: true, value: JSON.parse(repairJson(candidate)) };
		} catch {
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, error: `JSON parse failed: ${message}` };
		}
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
	const safeName = taskName.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40) || "task";
	const dir = join(parentCwd, ".pit", "worktrees", `${safeName}-${randomUUID().slice(0, 8)}`);
	await mkdir(join(parentCwd, ".pit", "worktrees"), { recursive: true });
	// Use --detach so the worktree is on a detached HEAD copy of current HEAD;
	// this avoids branch conflicts and keeps the parent branch untouched.
	const args = ["worktree", "add", "--detach", dir, spec.branch ?? "HEAD"];
	await execFileP("git", args, { cwd: parentCwd });
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
		taskName: options.taskName,
		depth: options.depth,
	});
	deps.registry.update(record.id, { status: "running", startedAt: Date.now() });

	const parentCwd = options.cwd ?? process.cwd();
	const worktreeSpec = normalizeWorktree(options.worktree);
	// The registry guarantees a unique taskName even when callers reuse `name`
	// across parallel spawns, so worktree paths and result identity never clash.
	const taskName = record.taskName;

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
	// Propagate the parent's abort reason so a parent-driven cancel stays
	// distinguishable downstream (falls back to a generic note if unset).
	const onParentAbort = () => controller.abort(options.signal?.reason ?? new Error("aborted: parent signal"));
	if (options.signal) {
		if (options.signal.aborted) controller.abort(options.signal.reason ?? new Error("aborted: parent signal"));
		else options.signal.addEventListener("abort", onParentAbort, { once: true });
	}

	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	if (options.timeoutMs && options.timeoutMs > 0) {
		const ms = options.timeoutMs;
		timeoutHandle = setTimeout(() => controller.abort(new Error(`aborted: timeout after ${ms}ms`)), ms);
	}

	const systemPromptBase = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
	// Opt-in skill inheritance: append the parent's model-invocable skills so the
	// subagent knows they exist and how to invoke them. Placed before the schema
	// suffix, which must stay last (it constrains the final-message format).
	const skillsSection =
		options.inheritSkills && deps.skills && deps.skills.length > 0
			? formatSkillsForPrompt(deps.skills, undefined, parentCwd)
			: "";
	const withSkills = skillsSection ? `${systemPromptBase}\n\n${skillsSection}` : systemPromptBase;
	const withSuffix = options.systemPromptSuffix ? `${withSkills}\n\n${options.systemPromptSuffix}` : withSkills;
	const systemPrompt = options.resultSchema ? `${withSuffix}${schemaPromptSuffix(options.resultSchema)}` : withSuffix;
	const tools = filterTools(deps.availableTools, options.allowedTools);
	const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
	let turnCount = 0;
	// GAP #5 token accounting: sum each assistant turn's reported usage so the
	// run's aggregate cost is available on the registry record and the result.
	const usage: SubagentUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };

	const checker = deps.permissionChecker;
	// Tool calls denied by the parent's policy (including headless ask→deny).
	// Recorded on the registry (and surfaced in the task result's details) so
	// the denial doesn't vanish silently inside the subagent loop.
	const deniedToolCalls: string[] = [];
	// Per-spawn grounding-guard chain (isolated session state). Default on; opt out
	// with PIT_NO_SUBAGENT_GUARDS. Individual guards keep their own PIT_NO_* opt-outs.
	const guardChain = areSubagentGuardsDisabled() ? undefined : createSubagentGuardChain({ cwd: parentCwd });
	const agent = new Agent({
		initialState: {
			systemPrompt,
			// Heterogeneous spawn: a task may run on a cheaper model than the parent.
			model: options.model ?? deps.model,
			// Subagents always think (never "off"). An explicit per-task override wins;
			// otherwise the level is bucketed by the model (small-class → "low",
			// everything else → "medium") so trivial fan-out on a cheap model doesn't
			// pay for medium reasoning. See resolveSubagentThinking (N10).
			thinkingLevel: options.thinkingLevel ?? resolveSubagentThinking(options.model ?? deps.model),
			// Forward the resolved turn cap so the loop's native backstop enforces it
			// (it was inert before — every subagent ran at DEFAULT_MAX_TURNS=250).
			maxTurns,
			tools,
			// Seed prior transcript when resuming from disk (Tier 2); empty otherwise.
			messages: options.initialMessages,
		},
		convertToLlm: deps.convertToLlm,
		// Gate every subagent tool call through the parent's permission policy.
		// Without this, the subagent's raw Agent loop would bypass the parent's
		// permissions extension entirely (deny rules, plan-mode mutation blocks).
		beforeToolCall: async ({ toolCall, args }) => {
			if (checker) {
				const decision = evaluateSubagentToolPermission(
					checker,
					toolCall.name,
					(args ?? {}) as Record<string, unknown>,
				);
				if (decision?.block) {
					deniedToolCalls.push(toolCall.name);
					deps.registry.update(record.id, { deniedToolCalls: [...deniedToolCalls] });
					return decision;
				}
			}
			// Propagate the parent's grounding guards (read-guard, edit-precondition,
			// symbol/import/path/pattern/bash grounding) so a subagent can't edit an
			// unread file, submit a non-matching edit, or write a broken import —
			// failures the main agent is structurally prevented from making.
			if (guardChain) {
				const guardDecision = await guardChain.beforeToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: (args ?? {}) as Record<string, unknown>,
				} as ToolCallEvent);
				if (guardDecision?.block) return guardDecision;
			}
			return undefined;
		},
		afterToolCall: guardChain
			? async ({ toolCall, args, result, isError }) => {
					// Lets the read-guard re-stamp the file the subagent just wrote so a
					// follow-up write isn't seen as external drift (false positive).
					await guardChain.afterToolCall({
						type: "tool_result",
						toolName: toolCall.name,
						toolCallId: toolCall.id,
						input: (args ?? {}) as Record<string, unknown>,
						content: result.content,
						details: result.details,
						isError,
					} as ToolResultEvent);
					return undefined;
				}
			: undefined,
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
			// GAP #5: accumulate token/cost usage from the assistant message.
			const message = event.message;
			if (message.role === "assistant" && message.usage) {
				usage.inputTokens += message.usage.input;
				usage.outputTokens += message.usage.output;
				usage.totalTokens += message.usage.totalTokens;
				usage.costUsd += message.usage.cost.total;
			}
			deps.registry.update(record.id, { turnCount, usage });
			// GAP #3: emit a lightweight per-turn progress signal (turn, last tool).
			let lastTool: string | undefined;
			if (message.role === "assistant" && Array.isArray(message.content)) {
				for (const block of message.content) {
					if (block.type === "toolCall") lastTool = block.name;
				}
			}
			options.onSubagentEvent?.({ turn: turnCount, lastTool });
			if (turnCount >= maxTurns) {
				controller.abort(new Error(`aborted: turn cap (${maxTurns}) reached`));
			}
		}
	});

	// Wire the controller to the Agent: a timeout / turn-cap / parent-ESC abort
	// must actually STOP the run, not merely reject the Promise.race below and
	// leave the Agent running orphaned — burning tokens, emitting phantom
	// turn_end telemetry, and writing into the worktree that cleanup() is about
	// to remove (corruption risk). abort() settles agent.prompt() so the race
	// resolves and cleanup awaits a quiesced run before removing the worktree.
	if (controller.signal.aborted) agent.abort();
	else controller.signal.addEventListener("abort", () => agent.abort(), { once: true });

	// Best-effort: a throwing onAgentReady must not abort the spawn (and leak the
	// timeout/abort wiring set up below). The only caller attaches a bus responder.
	try {
		options.onAgentReady?.(agent);
	} catch {
		// ignore — readiness notification is not load-bearing for the task.
	}

	// The live run promise, so cleanup() can wait for the Agent to fully stop
	// (post-abort) before removing the worktree it may still be writing to.
	let runPromise: Promise<void> | undefined;
	let settled = false;
	const cleanup = async () => {
		// Idempotent-once: a second call (e.g. resultSchema failure paths cleanup +
		// re-throw caught by the outer catch) must be a full no-op, otherwise the
		// listener teardown and `git worktree remove --force` would run twice.
		if (settled) return;
		settled = true;
		try {
			options.onSettle?.();
		} catch {
			// onSettle is best-effort teardown; never mask the task result.
		}
		if (timeoutHandle) clearTimeout(timeoutHandle);
		if (options.signal) options.signal.removeEventListener("abort", onParentAbort);
		if (worktree && worktree.cleanup === "auto") {
			// Let an aborted run settle so it isn't still writing into the worktree
			// while we delete it (the race may have returned via the abort branch).
			if (runPromise) await runPromise.catch(() => {});
			await removeWorktree(parentCwd, worktree.path);
		}
	};

	try {
		const promptText = options.prompt;
		runPromise = agent.prompt(promptText);
		const promise = runPromise;
		const aborted = new Promise<void>((_, reject) => {
			const fail = () => reject(toAbortError(controller.signal.reason));
			if (controller.signal.aborted) {
				fail();
				return;
			}
			controller.signal.addEventListener("abort", fail, { once: true });
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
			usage,
		});

		await cleanup();
		return {
			record: deps.registry.get(record.id)!,
			output,
			value,
			usage,
			worktreePath: worktree?.path,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// Any controller-driven abort (parent / timeout / turn cap) => cancelled.
		// Decoupled from the message string so richer reasons don't get miscategorized.
		const status = controller.signal.aborted ? "cancelled" : "failed";
		deps.registry.update(record.id, {
			status,
			endedAt: Date.now(),
			error: message,
			turnCount,
		});
		await cleanup();
		throw err;
	}
}
