/**
 * Shared safety limits for local image reads and model attachments.
 *
 * These limits are intentionally independent from the provider-specific
 * resize target. The file limit protects the process before decoding, while
 * the encoded limits protect the prompt and provider request size.
 */
export const MAX_IMAGE_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_ATTACH_BASE64_BYTES = 7 * 1024 * 1024;
export const MAX_INITIAL_IMAGE_ATTACHMENTS = 8;
export const MAX_INITIAL_IMAGE_ATTACH_BASE64_BYTES = 20 * 1024 * 1024;

export function encodedImageBytes(base64: string): number {
	return Buffer.byteLength(base64, "utf8");
}

export function formatImageLimitNote(fileName: string, fileBytes: number): string {
	return `[Image omitted: ${fileName} is ${formatBytes(fileBytes)}, which exceeds the ${formatBytes(MAX_IMAGE_FILE_BYTES)} pre-read limit. Downscale or crop it first.]`;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
