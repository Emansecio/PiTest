import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/image-resize.js", () => ({
	resizeImage: vi.fn(),
	formatDimensionNote: vi.fn(() => undefined),
}));

import { processFileArguments } from "../src/cli/file-processor.js";
import { createReadTool } from "../src/core/tools/read.js";
import { MAX_IMAGE_FILE_BYTES } from "../src/utils/image-attachment-limits.js";
import { resizeImage } from "../src/utils/image-resize.js";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

describe("image resize callers", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `image-resize-callers-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		vi.mocked(resizeImage).mockReset();
		vi.mocked(resizeImage).mockResolvedValue(null);
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("read tool returns text-only output when auto-resize cannot produce a safe image", async () => {
		const imagePath = join(testDir, "test.png");
		writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const tool = createReadTool(testDir);
		const result = await tool.execute("test-read-image", { path: imagePath });

		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as { type: "text"; text: string }).text).toContain("Image omitted");
	});

	it("file processor omits image attachments when auto-resize cannot produce a safe image", async () => {
		const imagePath = join(testDir, "test.png");
		writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));

		const result = await processFileArguments([imagePath]);

		expect(result.images).toHaveLength(0);
		expect(result.text).toContain("Image omitted");
	});

	it("file processor rejects oversized images before reading or resizing", async () => {
		const imagePath = join(testDir, "oversized.png");
		writeFileSync(
			imagePath,
			Buffer.concat([Buffer.from(TINY_PNG_BASE64, "base64"), Buffer.alloc(MAX_IMAGE_FILE_BYTES + 1)]),
		);

		const result = await processFileArguments([imagePath]);

		expect(result.images).toHaveLength(0);
		expect(result.text).toContain("pre-read limit");
		expect(resizeImage).not.toHaveBeenCalled();
	});

	it("file processor caps the number of initial image attachments", async () => {
		const paths = Array.from({ length: 9 }, (_, index) => {
			const imagePath = join(testDir, `image-${index}.png`);
			writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
			return imagePath;
		});

		vi.mocked(resizeImage).mockResolvedValue({
			data: TINY_PNG_BASE64,
			mimeType: "image/png",
			originalWidth: 1,
			originalHeight: 1,
			width: 1,
			height: 1,
			wasResized: false,
		});
		const result = await processFileArguments(paths);

		expect(result.images).toHaveLength(8);
		expect(result.text).toContain("limited to 8 image attachments");
	});

	it("read tool rejects an oversized local image before readFile", async () => {
		const readFile = vi.fn(async () => Buffer.from(TINY_PNG_BASE64, "base64"));
		const tool = createReadTool(testDir, {
			operations: {
				access: async () => undefined,
				readFile,
				detectImageMimeType: async () => "image/png",
				stat: async () => ({ size: MAX_IMAGE_FILE_BYTES + 1, mtimeMs: 1 }),
			},
		});

		const result = await tool.execute("test-read-oversized-image", { path: "oversized.png" });

		expect(readFile).not.toHaveBeenCalled();
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as { type: "text"; text: string }).text).toContain("pre-read limit");
	});

	it("read tool refuses custom images without size metadata before readFile", async () => {
		const readFile = vi.fn(async () => Buffer.from(TINY_PNG_BASE64, "base64"));
		const tool = createReadTool(testDir, {
			autoResizeImages: false,
			operations: {
				access: async () => undefined,
				readFile,
				detectImageMimeType: async () => "image/png",
			},
		});

		const result = await tool.execute("test-read-image-without-stat", { path: "remote.png" });

		expect(readFile).not.toHaveBeenCalled();
		expect(result.content[0].type).toBe("text");
		expect((result.content[0] as { type: "text"; text: string }).text).toContain("size metadata");
	});
});
