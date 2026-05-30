/**
 * `ask` tool — resolves ambiguity mid-turn by asking the user to pick one of
 * 2-6 short, pre-defined options. NOT for freeform input.
 *
 * Interactive mode binds a listener to the UserInputBus and renders an option
 * picker. Print / non-interactive mode does not bind, so the bus auto-resolves
 * with the recommended (or first) option for deterministic execution.
 */

import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { getCurrentUserInputBus, type UserInputBus } from "../user-input-bus.ts";
import { getTextOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const askOptionSchema = Type.Object(
	{
		label: Type.String({ description: "Short label shown in the picker. Max ~60 chars." }),
		description: Type.Optional(Type.String({ description: "One-line clarification below the label." })),
		recommended: Type.Optional(Type.Boolean({ description: "Mark this as the default / suggested option." })),
		value: Type.Optional(Type.String({ description: "Optional value associated with the label." })),
	},
	{ additionalProperties: false },
);

const askSchema = Type.Object(
	{
		question: Type.String({ description: "The question shown to the user. Keep it terse." }),
		header: Type.Optional(
			Type.String({
				description: "Short chip label rendered above the question. Max 16 chars.",
			}),
		),
		options: Type.Array(askOptionSchema, {
			minItems: 2,
			maxItems: 6,
			description: "Between 2 and 6 short options.",
		}),
		multiSelect: Type.Optional(Type.Boolean({ description: "Allow the user to pick more than one option." })),
	},
	{ additionalProperties: false },
);

export type AskToolInput = Static<typeof askSchema>;

export interface AskToolDetails {
	picked: string[];
	recommended?: string;
	cancelled: boolean;
}

export interface AskToolOptions {
	/**
	 * Inject a specific bus instance. When omitted the tool falls back to
	 * the module-level current bus (set by the active mode at session boot).
	 */
	bus?: UserInputBus;
	/**
	 * Milliseconds to wait for a listener to be bound before falling back
	 * to the deterministic recommended/first option. Default 200ms.
	 */
	bindTimeoutMs?: number;
}

const HEADER_MAX = 16;
const LABEL_MAX = 60;

function trimToMax(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function pickFallbackLabel(options: AskToolInput["options"]): string {
	const recommended = options.find((o) => o.recommended);
	if (recommended) return recommended.label;
	return options[0]?.label ?? "";
}

export function createAskToolDefinition(
	_cwd: string,
	options?: AskToolOptions,
): ToolDefinition<typeof askSchema, AskToolDetails> {
	const bindTimeoutMs = options?.bindTimeoutMs ?? 200;
	return {
		name: "ask",
		label: "ask",
		description:
			"Ask the user to pick one of 2-6 pre-defined options. Use this to resolve ambiguity mid-turn, never for freeform input. In non-interactive runs the recommended (or first) option is auto-selected.",
		promptSnippet: "Pick one of 2-6 options",
		promptGuidelines: [
			"Use ask only to resolve ambiguity — not to confirm safe actions or collect freeform text.",
			"Provide 2-6 short, mutually exclusive options.",
			"Mark at most one option as recommended; in non-interactive runs that one is picked automatically.",
			"Keep question, header (≤16 chars), and option labels (≤60 chars) terse.",
		],
		parameters: askSchema,
		async execute(toolCallId: string, input: AskToolInput) {
			const question = input.question.trim();
			const header = input.header ? trimToMax(input.header.trim(), HEADER_MAX) : undefined;

			// Normalize options (trim labels, enforce caps, dedupe recommended flag).
			let recommendedSeen = false;
			const normalizedOptions = input.options.map((opt) => {
				const label = trimToMax(opt.label.trim(), LABEL_MAX);
				let recommended = opt.recommended === true;
				if (recommended && recommendedSeen) {
					recommended = false;
				}
				if (recommended) recommendedSeen = true;
				return {
					label,
					description: opt.description,
					recommended,
					value: opt.value,
				};
			});

			const recommendedLabel = normalizedOptions.find((o) => o.recommended)?.label;
			const fallbackLabel = pickFallbackLabel(normalizedOptions);

			const bus = options?.bus ?? getCurrentUserInputBus();

			// No bus at all → deterministic local fallback.
			if (!bus) {
				const picked = fallbackLabel ? [fallbackLabel] : [];
				return {
					content: [
						{
							type: "text" as const,
							text: `Selected: ${picked.join(", ")} (auto, no interactive input bound)`,
						},
					],
					details: { picked, recommended: recommendedLabel, cancelled: false },
				};
			}

			// Bus present but no listener: wait briefly, then deterministic fallback.
			if (!bus.hasListener()) {
				const startedAt = Date.now();
				while (Date.now() - startedAt < bindTimeoutMs) {
					if (bus.hasListener()) break;
					await new Promise((r) => setTimeout(r, 20));
				}
				if (!bus.hasListener()) {
					const picked = fallbackLabel ? [fallbackLabel] : [];
					return {
						content: [
							{
								type: "text" as const,
								text: `Selected: ${picked.join(", ")} (auto, no interactive input bound)`,
							},
						],
						details: { picked, recommended: recommendedLabel, cancelled: false },
					};
				}
			}

			const answer = await bus.askOptions({
				question,
				header,
				options: normalizedOptions,
				multiSelect: input.multiSelect === true,
				source: { toolCallId, toolName: "ask" },
			});

			if (answer.cancelled) {
				return {
					content: [{ type: "text" as const, text: "User cancelled the prompt." }],
					details: { picked: [], recommended: recommendedLabel, cancelled: true },
				};
			}

			return {
				content: [{ type: "text" as const, text: `Selected: ${answer.picked.join(", ")}` }],
				details: { picked: answer.picked, recommended: recommendedLabel, cancelled: false },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const rawQuestion = str(args?.question);
			const question = rawQuestion ? trimToMax(rawQuestion, 80) : "(missing)";
			text.setText(`${theme.fg("toolTitle", theme.bold("ask"))} ${theme.fg("accent", question)}`);
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

export function createAskTool(cwd: string, options?: AskToolOptions): AgentTool<typeof askSchema> {
	return wrapToolDefinition(createAskToolDefinition(cwd, options));
}
