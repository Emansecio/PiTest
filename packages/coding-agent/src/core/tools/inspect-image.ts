/**
 * `inspect_image` tool — attach a local image to the next assistant turn.
 *
 * Returns the image as an ImageContent block alongside a text note carrying the
 * question. The downstream model layer re-uses the attachment when computing
 * the next turn, so the assistant (if vision-capable) sees the image and can
 * answer the question naturally — no nested model call from the tool itself.
 */

import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";
import type { AgentTool } from "@pit/agent-core";
import type { ImageContent, Model, TextContent } from "@pit/ai";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import { formatDimensionNote, resizeImage } from "../../utils/image-resize.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { sliceSafe } from "../../utils/surrogate.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { renderToolOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { formatSize } from "./truncate.ts";

/** Largest image file we will load into memory; above this, fail fast and tell the model to downscale. */
const MAX_IMAGE_FILE_BYTES = 25 * 1024 * 1024;
/** Largest base64 payload we will attach; above this providers reject the image, so error instead of sending. */
const MAX_ATTACH_BASE64_BYTES = 7 * 1024 * 1024;

const inspectImageSchema = Type.Object(
	{
		path: Type.String({ description: "Local file path to the image (relative or absolute)." }),
		question: Type.Optional(
			Type.String({
				description: 'What you want the next turn to answer about the image. Default: "describe this image".',
			}),
		),
	},
	{ additionalProperties: false },
);

export type InspectImageToolInput = Static<typeof inspectImageSchema>;

export interface InspectImageToolDetails {
	path: string;
	mimeType: string | null;
	question: string;
	bytes: number;
}

export interface InspectImageToolOptions {
	/** Whether to auto-resize to fit provider limits (default true). */
	autoResizeImages?: boolean;
}

function resolveCwd(cwd: string, path: string): string {
	if (isAbsolute(path)) return path;
	return resolvePath(cwd, path);
}

function modelSupportsImages(model: Model<any> | undefined): boolean {
	if (!model) return true; // be lenient when no model context
	return Array.isArray(model.input) && model.input.includes("image");
}

export function createInspectImageToolDefinition(
	cwd: string,
	options?: InspectImageToolOptions,
): ToolDefinition<typeof inspectImageSchema, InspectImageToolDetails | undefined> {
	const autoResize = options?.autoResizeImages ?? true;
	return {
		name: "inspect_image",
		activity: "navigation",
		label: "inspect_image",
		description:
			"Attach a local image to the next assistant turn so the model can describe or answer questions about it. Use when you need the vision model to look at a screenshot, chart, photo, or diagram on disk.",
		promptSnippet: "Attach a local image for the next turn to inspect.",
		promptGuidelines: [
			"Use inspect_image when you need the model to *see* a local image — screenshots, charts, photos.",
			"Pass a focused question; otherwise the model just describes the image.",
			"Requires a vision-capable model. If the active model lacks image input the call errors out.",
		],
		parameters: inspectImageSchema,
		async execute(_toolCallId, input: InspectImageToolInput, _signal, _onUpdate, ctx) {
			const question = (input.question ?? "describe this image").trim();
			const resolvedPath = resolveCwd(cwd, input.path);
			const model = ctx?.model;
			if (!modelSupportsImages(model)) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Current model does not support image input. Switch with /model to a vision-capable model.",
						},
					],
					isError: true,
					details: undefined,
				};
			}
			try {
				await fsAccess(resolvedPath, constants.R_OK);
			} catch {
				return {
					content: [{ type: "text" as const, text: `inspect_image error: cannot read file: ${resolvedPath}` }],
					isError: true,
					details: undefined,
				};
			}
			const mimeType = await detectSupportedImageMimeTypeFromFile(resolvedPath);
			if (!mimeType) {
				return {
					content: [
						{
							type: "text" as const,
							text: `inspect_image error: unsupported image format at ${resolvedPath}. Supported: PNG, JPEG, GIF, WebP.`,
						},
					],
					isError: true,
					details: undefined,
				};
			}
			try {
				const fileSize = (await fsStat(resolvedPath)).size;
				if (fileSize > MAX_IMAGE_FILE_BYTES) {
					return {
						content: [
							{
								type: "text" as const,
								text: `inspect_image error: ${basename(resolvedPath)} is ${formatSize(fileSize)}, exceeds the ${formatSize(MAX_IMAGE_FILE_BYTES)} limit. Downscale or crop it first (e.g. via bash) before inspecting.`,
							},
						],
						isError: true,
						details: undefined,
					};
				}
			} catch {
				// stat failed — fall through; fsReadFile below surfaces the real error.
			}
			const buffer = await fsReadFile(resolvedPath);
			const base64 = buffer.toString("base64");

			let finalData = base64;
			let finalMime = mimeType;
			let dimensionNote: string | undefined;
			if (autoResize) {
				const resized = await resizeImage({ type: "image", data: base64, mimeType });
				if (resized) {
					finalData = resized.data;
					finalMime = resized.mimeType;
					dimensionNote = formatDimensionNote(resized);
				}
			}

			if (Buffer.byteLength(finalData, "utf8") > MAX_ATTACH_BASE64_BYTES) {
				return {
					content: [
						{
							type: "text" as const,
							text: `inspect_image error: ${basename(resolvedPath)} is too large to attach (${formatSize(Buffer.byteLength(finalData, "utf8"))} encoded)${autoResize ? " and could not be downscaled" : " (auto-resize is off)"}. Crop or downscale it first.`,
						},
					],
					isError: true,
					details: undefined,
				};
			}

			const fileLabel = basename(resolvedPath);
			let textNote = `[image attached: ${fileLabel}, q=${question}]`;
			if (dimensionNote) textNote += `\n${dimensionNote}`;

			const content: (TextContent | ImageContent)[] = [
				{ type: "text", text: textNote },
				{ type: "image", data: finalData, mimeType: finalMime },
			];
			return {
				content,
				details: {
					path: resolvedPath,
					mimeType: finalMime,
					question,
					bytes: buffer.length,
				},
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const path = str(args?.path) || "";
			const display = path.length > 60 ? `…${sliceSafe(path, path.length - 59)}` : path;
			const question = str(args?.question) || "";
			const qDisplay = question ? ` ${theme.fg("toolOutput", `(${sliceSafe(question, 0, 40)})`)}` : "";
			text.setText(
				`${theme.fg("toolTitle", theme.bold("inspect_image"))} ${theme.fg("accent", display)}${qDisplay}`,
			);
			return text;
		},
		renderResult: renderToolOutput,
	};
}

export function createInspectImageTool(
	cwd: string,
	options?: InspectImageToolOptions,
): AgentTool<typeof inspectImageSchema> {
	return wrapToolDefinition(createInspectImageToolDefinition(cwd, options));
}
