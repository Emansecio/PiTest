/**
 * `retain` tool — adds a durable fact / decision / pattern to the project-local
 * hindsight bank. Use this for things worth remembering across sessions, not
 * session-only state. The bank lives at `<cwd>/.pit/hindsight/bank.jsonl`.
 */

import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import { truncateWithEllipsis } from "../../utils/surrogate.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { getCurrentHindsightBank, type HindsightBank, type HindsightKind } from "../hindsight/index.ts";
import { renderToolOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const retainSchema = Type.Object(
	{
		body: Type.String({
			description: "The fact to remember. One short paragraph of Markdown. Be specific and durable.",
		}),
		subject: Type.Optional(
			Type.String({ description: "Optional short tag for the entry (e.g. 'auth-flow'). Max ~40 chars." }),
		),
		kind: Type.Optional(Type.Enum(["fact", "decision", "pattern"], { description: "Entry kind. Default 'fact'." })),
		tags: Type.Optional(Type.Array(Type.String(), { description: "Optional list of short tags." })),
	},
	{ additionalProperties: false },
);

export type RetainToolInput = Static<typeof retainSchema>;

export interface RetainToolDetails {
	id?: string;
	kind: HindsightKind;
	stored: boolean;
}

export interface RetainToolOptions {
	/** Override the active bank (otherwise pulled from the module registry). */
	bank?: HindsightBank;
	/** Bound agent scope stamped on every entry this instance writes. */
	agentScope?: string;
}

function shortPreview(text: string, max = 40): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return truncateWithEllipsis(compact, max);
}

export function createRetainToolDefinition(
	_cwd: string,
	options?: RetainToolOptions,
): ToolDefinition<typeof retainSchema, RetainToolDetails> {
	return {
		name: "retain",
		label: "retain",
		description:
			"Save a durable fact, decision, or pattern to the project's hindsight memory bank. Use for things worth remembering across sessions (NOT session-only state). Searchable later via `recall` and `reflect`.",
		promptSnippet: "Save a durable fact to project hindsight memory",
		promptGuidelines: [
			"Proactively retain durable facts the moment you confirm them — architecture, key decisions, gotchas, conventions, file locations, API shapes, and fixes. Do not wait to be asked.",
			"Make retaining a default reflex after any non-trivial investigation or task: capture what a future session would otherwise have to rediscover.",
			"Keep each entry focused — one short paragraph, specifics over generalities. Prefer several small precise facts over one vague dump. Skip only truly transient state.",
		],
		parameters: retainSchema,
		async execute(toolCallId: string, input: RetainToolInput) {
			const bank = options?.bank ?? getCurrentHindsightBank();
			const kind: HindsightKind = input.kind ?? "fact";
			if (!bank) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Hindsight bank is not enabled for this session. Set `hindsight.enabled: true` in settings to use retain/recall/reflect.",
						},
					],
					details: { kind, stored: false },
					isError: true,
				};
			}

			const entry = bank.add({
				kind,
				body: input.body,
				subject: input.subject,
				tags: input.tags,
				source: { toolCallId },
				agentScope: options?.agentScope,
			});
			const label = input.subject ?? shortPreview(input.body);
			return {
				content: [{ type: "text" as const, text: `Retained: ${label} [id: ${entry.id}]` }],
				details: { id: entry.id, kind, stored: true },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const subject = str(args?.subject);
			const body = str(args?.body);
			const headline = subject || (body ? shortPreview(body, 60) : "(missing)");
			text.setText(`${theme.fg("toolTitle", theme.bold("retain"))} ${theme.fg("accent", headline)}`);
			return text;
		},
		renderResult: renderToolOutput,
	};
}

export function createRetainTool(cwd: string, options?: RetainToolOptions): AgentTool<typeof retainSchema> {
	return wrapToolDefinition(createRetainToolDefinition(cwd, options));
}
