/**
 * spawnSubagent — runs a one-shot Agent loop with restricted tools and
 * captures the final assistant text.
 *
 * The subagent shares the parent's model, auth, and streamFn so it inherits
 * provider-level retries, token caching, and OAuth wiring without duplicate
 * code paths. The Agent instance is short-lived and discarded after the
 * prompt completes.
 */

import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { type Message, modelsAreEqual, streamSimple } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../model-registry.ts";
import type { SubagentRegistry } from "./registry.ts";
import type { SpawnSubagentOptions, SpawnSubagentResult } from "./types.ts";

const DEFAULT_SYSTEM_PROMPT =
	"You are a focused subagent. Use the provided tools to complete the task in as few turns as possible, " +
	"then summarize the result in a final assistant message. Do not ask follow-up questions; deliver a self-contained answer.";

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

	const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
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
				options.signal?.dispatchEvent?.(new Event("abort"));
			}
		}
	});

	try {
		const promptText = options.prompt;
		const promise = agent.prompt(promptText);
		if (options.signal) {
			const aborted = new Promise<void>((_, reject) => {
				if (options.signal!.aborted) {
					reject(new Error("aborted"));
					return;
				}
				options.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
			await Promise.race([promise, aborted]);
		} else {
			await promise;
		}
		const output = extractAssistantText(agent.state.messages);
		deps.registry.update(record.id, {
			status: "completed",
			endedAt: Date.now(),
			output,
			turnCount,
		});
		return { record: deps.registry.get(record.id)!, output };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const status = message === "aborted" ? "cancelled" : "failed";
		deps.registry.update(record.id, {
			status,
			endedAt: Date.now(),
			error: message,
			turnCount,
		});
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
