/**
 * Process @file CLI arguments into text content and image attachments
 */

import { access, open, readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@pit/ai";
import chalk from "chalk";
import { resolve } from "path";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { formatSize, truncateHead } from "../core/tools/truncate.ts";
import { formatDimensionNote, resizeImage } from "../utils/image-resize.ts";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";

/**
 * Upper bound on the bytes read from a single @file text argument. The whole
 * file content is inlined into the prompt string, so an unbounded read of a
 * multi-GB log (e.g. `@server.log`) would buffer the file plus its wrapped copy
 * and OOM the CLI before the prompt is even built. Over this cap we read only a
 * bounded prefix and append a clear truncation note instead of erroring out.
 */
const MAX_TEXT_FILE_BYTES = 5 * 1024 * 1024; // 5MB

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
}

/** Process @file arguments into text content and image attachments */
export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		// Expand and resolve path (handles ~ expansion and macOS screenshot Unicode spaces)
		const absolutePath = resolve(resolveReadPath(fileArg, process.cwd()));

		// Check if file exists
		try {
			await access(absolutePath);
		} catch {
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}

		// Check if file is empty
		const stats = await stat(absolutePath);
		if (stats.size === 0) {
			// Skip empty files
			continue;
		}

		const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);

		if (mimeType) {
			// Handle image file
			const content = await readFile(absolutePath);
			const base64Content = content.toString("base64");

			let attachment: ImageContent;
			let dimensionNote: string | undefined;

			if (autoResizeImages) {
				const resized = await resizeImage({ type: "image", data: base64Content, mimeType });
				if (!resized) {
					text += `<file name="${absolutePath}">[Image omitted: could not be resized below the inline image size limit.]</file>\n`;
					continue;
				}
				dimensionNote = formatDimensionNote(resized);
				attachment = {
					type: "image",
					mimeType: resized.mimeType,
					data: resized.data,
				};
			} else {
				attachment = {
					type: "image",
					mimeType,
					data: base64Content,
				};
			}

			images.push(attachment);

			// Add text reference to image with optional dimension note
			if (dimensionNote) {
				text += `<file name="${absolutePath}">${dimensionNote}</file>\n`;
			} else {
				text += `<file name="${absolutePath}"></file>\n`;
			}
		} else {
			// Handle text file
			try {
				if (stats.size > MAX_TEXT_FILE_BYTES) {
					// Read only a bounded prefix so a huge file (e.g. a multi-GB log)
					// cannot buffer its full contents into the prompt and OOM the CLI.
					const handle = await open(absolutePath, "r");
					let prefix: string;
					try {
						const buffer = Buffer.allocUnsafe(MAX_TEXT_FILE_BYTES);
						const { bytesRead } = await handle.read(buffer, 0, MAX_TEXT_FILE_BYTES, 0);
						prefix = buffer.toString("utf-8", 0, bytesRead);
					} finally {
						await handle.close();
					}
					// Snap to a whole-line boundary so the inlined excerpt never ends
					// mid-line (and never mid-UTF-8-character from the byte read).
					const snapped = truncateHead(prefix, {
						maxBytes: MAX_TEXT_FILE_BYTES,
						maxLines: Number.POSITIVE_INFINITY,
					});
					const note = `[Truncated: file is ${formatSize(stats.size)}, showing first ${formatSize(MAX_TEXT_FILE_BYTES)}. Use the read tool with offset/limit to page through the rest.]`;
					text += `<file name="${absolutePath}">\n${snapped.content}\n${note}\n</file>\n`;
				} else {
					const content = await readFile(absolutePath, "utf-8");
					text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
				}
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
				process.exit(1);
			}
		}
	}

	return { text, images };
}
