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
import { type Static, Type } from "typebox";
import { truncateWithEllipsis } from "../../utils/surrogate.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { getCurrentUserInputBus, type UserInputBus } from "../user-input-bus.ts";
import { applyKeyAliases, coerceJsonArrayField } from "./argument-prep.ts";
import { AskLineBlock, renderAskCallLines, renderAskResultLines } from "./ask-render.ts";
import { getTextOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const askOptionSchema = Type.Object(
	{
		label: Type.String({
			description: "Concise label shown in the picker; clipped only when the available terminal width requires it.",
		}),
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
				description: "Short chip label rendered above the question. Max 24 chars.",
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
		timeout_ms: Type.Optional(
			Type.Number({
				description: "Auto-dismiss after N milliseconds, falling back to the recommended (or first) option.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type AskToolInput = Static<typeof askSchema>;

const ASK_KEY_ALIASES = { timeout: "timeout_ms" } as const;

/** Normalize legacy aliases and JSON-stringified `options` before schema validation. */
export function prepareAskArguments(input: unknown): AskToolInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input as AskToolInput;
	let args = applyKeyAliases(input as Record<string, unknown>, ASK_KEY_ALIASES);
	args = coerceJsonArrayField(args, "options");
	return args as AskToolInput;
}

/** Structured outcome of an ask, mirroring pi-ask-user's response union. */
export type AskResponse =
	| { kind: "selection"; selections: string[]; comment?: string }
	| { kind: "freeform"; text: string };

export interface AskToolDetails {
	response: AskResponse | null;
	recommended?: string;
	cancelled: boolean;
}

/** Shared renderer state for one ask row: the call line needs to know whether
 * the result has landed, and only renderResult can tell it. */
interface AskRenderState {
	answered?: boolean;
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

const HEADER_MAX = 24;

function trimToMax(value: string, max: number): string {
	return truncateWithEllipsis(value, max);
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
		parameters: askSchema,
		prepareArguments: prepareAskArguments,
		// One picker at a time: a second concurrent UserInputBus request is
		// auto-resolved with the recommended/first option (never shown to the
		// user). Sequential execution asks the questions one by one instead.
		executionMode: "sequential",
		async execute(toolCallId: string, input: AskToolInput, signal?: AbortSignal) {
			const question = input.question.trim();
			const context = input.context?.trim() || undefined;
			const header = input.header ? trimToMax(input.header.trim(), HEADER_MAX) : undefined;

			// Normalize options (trim labels, dedupe recommended flag). The picker owns
			// display-width clipping so widening the terminal can reveal the full label.
			let recommendedSeen = false;
			const normalizedOptions = (input.options ?? []).map((opt) => {
				const label = opt.label.trim();
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
			const displayMode = "inline";
			const overlayToggleKey = "alt+o";
			const commentToggleKey = "ctrl+g";
			const timeout =
				typeof input.timeout_ms === "number" && Number.isFinite(input.timeout_ms) && input.timeout_ms > 0
					? input.timeout_ms
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

			// Honour run abort (Esc / interrupt). Without this the tool parks on
			// bus.askOptions forever while agent.abort() has already fired — the
			// turn never settles and the interrupt watchdog only notifies.
			if (signal?.aborted) {
				return {
					content: [{ type: "text" as const, text: "User cancelled the prompt." }],
					details: { response: null, recommended: recommendedLabel, cancelled: true },
				};
			}

			const answer = await new Promise<Awaited<ReturnType<typeof bus.askOptions>>>((resolve, reject) => {
				let settled = false;
				const onAbort = () => {
					if (settled) return;
					settled = true;
					// cancelAll resolves pending entries with cancelled:true; we also
					// short-circuit here so we don't wait if cancel races.
					bus.cancelAll("interrupt");
					resolve({
						requestId: "",
						picked: [],
						cancelled: true,
					});
				};
				if (signal) {
					if (signal.aborted) {
						onAbort();
						return;
					}
					signal.addEventListener("abort", onAbort, { once: true });
				}
				void bus
					.askOptions({
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
					})
					.then((result) => {
						if (settled) return;
						settled = true;
						signal?.removeEventListener("abort", onAbort);
						resolve(result);
					})
					.catch((err) => {
						if (settled) return;
						settled = true;
						signal?.removeEventListener("abort", onAbort);
						reject(err);
					});
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
		// Both renderers lay out against the real render width (see ask-render.ts);
		// the state key keeps a re-render with unchanged content free.
		renderCall(args, theme, context) {
			const prev = context.lastComponent;
			const block = prev instanceof AskLineBlock ? prev : new AskLineBlock("", () => []);
			const question = str(args?.question);
			const header = str(args?.header);
			// Answered asks demote the question to context — the answer below it is
			// what the scrollback is for. The flag rides the shared renderer state
			// because only renderResult knows the ask has settled.
			const answered = (context.state as AskRenderState | undefined)?.answered === true;
			block.setState(`${answered ? "a" : "p"} ${header} ${question}`, (width) =>
				renderAskCallLines(args, theme, width, answered),
			);
			return block;
		},
		renderResult(result, _options, theme, context) {
			const prev = context.lastComponent;
			const block = prev instanceof AskLineBlock ? prev : new AskLineBlock("", () => []);
			const details = result.details as AskToolDetails | undefined;
			// Auto-answers and listener-less runs carry no structured details, so the
			// raw text payload stays the fallback.
			const fallback = details?.response ? "" : getTextOutput(result, context.showImages);
			const state = context.state as AskRenderState | undefined;
			if (state && state.answered !== true) {
				state.answered = true;
				// The call line above rendered before the answer landed, so it still
				// reads as pending. One repaint on the transition fixes it; the guard
				// keeps this from looping. (HTML export renders each row once and never
				// revisits it, so there the question keeps its pending tone.)
				context.invalidate();
			}
			block.setState(JSON.stringify([details ?? null, fallback]), (width) =>
				renderAskResultLines(details, fallback, theme, width),
			);
			return block;
		},
	};
}

export function createAskTool(cwd: string, options?: AskToolOptions): AgentTool<typeof askSchema> {
	return wrapToolDefinition(createAskToolDefinition(cwd, options));
}
