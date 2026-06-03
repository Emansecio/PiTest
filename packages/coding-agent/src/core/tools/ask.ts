/**
 * `ask` tool — resolves ambiguity mid-turn by asking the user a question. The
 * user can pick one of (or several of) pre-defined options AND/OR type a
 * freeform answer. Modelled after the `pi-ask-user` package but introduced
 * natively so it rides on the default coding surface.
 *
 * Interactive mode binds a listener to the UserInputBus and renders an answer
 * picker (single-select, multi-select, and/or a freeform text field). Print /
 * non-interactive mode does not bind, so the bus auto-resolves with the
 * recommended (or first) option — or an empty freeform answer for option-less
 * prompts — for deterministic execution.
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
		context: Type.Optional(
			Type.String({
				description: "Optional background shown above the question to frame the decision.",
			}),
		),
		header: Type.Optional(
			Type.String({
				description: "Short chip label rendered above the question. Max 16 chars.",
			}),
		),
		options: Type.Optional(
			Type.Array(askOptionSchema, {
				maxItems: 8,
				description: "Up to 8 short, mutually exclusive options. Omit for a freeform-only question.",
			}),
		),
		allowMultiple: Type.Optional(
			Type.Boolean({ description: "Let the user toggle and pick more than one option (checkbox-style)." }),
		),
		allowFreeform: Type.Optional(
			Type.Boolean({
				description:
					"Offer a 'type a custom answer' path returning freeform text. Defaults to true, so the user can always type their own answer alongside the options; set false to force a choice.",
			}),
		),
		allowComment: Type.Optional(
			Type.Boolean({
				description: "Let the user attach a freeform comment to their selection (toggled in the UI).",
			}),
		),
		displayMode: Type.Optional(
			Type.Union([Type.Literal("overlay"), Type.Literal("inline")], {
				description:
					"Render inline above the prompt (default: full-width, in flow, never overlaps the transcript) or as a centered floating overlay.",
			}),
		),
		overlayToggleKey: Type.Optional(
			Type.String({
				description: "Key to temporarily hide/show the overlay to review prior output. Default 'alt+o'.",
			}),
		),
		commentToggleKey: Type.Optional(
			Type.String({ description: "Key to toggle the comment field. Default 'ctrl+g'." }),
		),
		timeout: Type.Optional(
			Type.Number({
				description: "Auto-dismiss after N milliseconds, falling back to the recommended (or first) option.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type AskToolInput = Static<typeof askSchema>;

/** Structured outcome of an ask, mirroring pi-ask-user's response union. */
export type AskResponse =
	| { kind: "selection"; selections: string[]; comment?: string }
	| { kind: "freeform"; text: string };

export interface AskToolDetails {
	response: AskResponse | null;
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

function pickFallbackLabel(options: Array<{ label: string; recommended?: boolean }>): string {
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
			"Ask the user a question mid-turn. Provide up to 8 options for the user to pick one (or several with allowMultiple), and/or allow a freeform typed answer. Use to resolve ambiguity, not to confirm safe actions. In non-interactive runs the recommended (or first) option is auto-selected.",
		promptSnippet: "Ask the user to choose options and/or type an answer",
		promptGuidelines: [
			"Use ask to resolve genuine ambiguity — not to confirm safe actions you can just perform.",
			"Provide up to 8 short, mutually exclusive options, or omit options for a freeform-only question.",
			"Set allowMultiple when several options can be picked together; set allowFreeform to also accept a typed answer.",
			"Mark at most one option as recommended; in non-interactive runs that one is picked automatically.",
			"Keep question, context, header (≤16 chars), and option labels (≤60 chars) terse.",
		],
		parameters: askSchema,
		async execute(toolCallId: string, input: AskToolInput) {
			const question = input.question.trim();
			const context = input.context?.trim() || undefined;
			const header = input.header ? trimToMax(input.header.trim(), HEADER_MAX) : undefined;

			// Normalize options (trim labels, enforce caps, dedupe recommended flag).
			let recommendedSeen = false;
			const normalizedOptions = (input.options ?? []).map((opt) => {
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

			// Freeform defaults ON so the user can always type a custom answer
			// alongside the options; the model can set false to force a choice.
			const allowFreeform = input.allowFreeform ?? true;
			const allowMultiple = input.allowMultiple === true && normalizedOptions.length > 0;
			const allowComment = input.allowComment === true && normalizedOptions.length > 0;
			const displayMode = input.displayMode ?? "inline";
			const overlayToggleKey = input.overlayToggleKey?.trim() || "alt+o";
			const commentToggleKey = input.commentToggleKey?.trim() || "ctrl+g";
			const timeout =
				typeof input.timeout === "number" && Number.isFinite(input.timeout) && input.timeout > 0
					? input.timeout
					: undefined;

			const recommendedLabel = normalizedOptions.find((o) => o.recommended)?.label;
			const fallbackLabel = pickFallbackLabel(normalizedOptions);

			const autoSelection = (note: string) => {
				if (normalizedOptions.length > 0) {
					const selections = fallbackLabel ? [fallbackLabel] : [];
					return {
						content: [{ type: "text" as const, text: `Selected: ${selections.join(", ")} (${note})` }],
						details: {
							response: { kind: "selection" as const, selections },
							recommended: recommendedLabel,
							cancelled: false,
						},
					};
				}
				return {
					content: [{ type: "text" as const, text: `No answer (${note})` }],
					details: {
						response: { kind: "freeform" as const, text: "" },
						recommended: recommendedLabel,
						cancelled: false,
					},
				};
			};

			const bus = options?.bus ?? getCurrentUserInputBus();

			// No bus at all → deterministic local fallback.
			if (!bus) {
				return autoSelection("auto, no interactive input bound");
			}

			// Bus present but no listener: wait briefly, then deterministic fallback.
			if (!bus.hasListener()) {
				const startedAt = Date.now();
				while (Date.now() - startedAt < bindTimeoutMs) {
					if (bus.hasListener()) break;
					await new Promise((r) => setTimeout(r, 20));
				}
				if (!bus.hasListener()) {
					return autoSelection("auto, no interactive input bound");
				}
			}

			const answer = await bus.askOptions({
				question,
				context,
				header,
				options: normalizedOptions,
				allowMultiple,
				allowFreeform,
				allowComment,
				displayMode,
				overlayToggleKey,
				commentToggleKey,
				timeout,
				source: { toolCallId, toolName: "ask" },
			});

			if (answer.cancelled) {
				return {
					content: [{ type: "text" as const, text: "User cancelled the prompt." }],
					details: { response: null, recommended: recommendedLabel, cancelled: true },
				};
			}

			if (answer.freeformText !== undefined && answer.picked.length === 0) {
				const text = answer.freeformText;
				return {
					content: [{ type: "text" as const, text: `User answered: ${text}` }],
					details: {
						response: { kind: "freeform" as const, text },
						recommended: recommendedLabel,
						cancelled: false,
					},
				};
			}

			const comment = answer.comment?.trim() || undefined;
			const selection: AskResponse = comment
				? { kind: "selection", selections: answer.picked, comment }
				: { kind: "selection", selections: answer.picked };
			return {
				content: [
					{
						type: "text" as const,
						text: `Selected: ${answer.picked.join(", ")}${comment ? ` — comment: ${comment}` : ""}`,
					},
				],
				details: {
					response: selection,
					recommended: recommendedLabel,
					cancelled: false,
				},
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
			const output = getTextOutput(result, context.showImages).trim();
			text.setText(output ? theme.fg("toolOutput", output) : "");
			return text;
		},
	};
}

export function createAskTool(cwd: string, options?: AskToolOptions): AgentTool<typeof askSchema> {
	return wrapToolDefinition(createAskToolDefinition(cwd, options));
}
