import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.js";

/**
 * Parity suite for the large-file streaming read path: every (offset, limit)
 * shape must produce byte-identical output to the buffered path. The streaming
 * path is forced with a tiny streamingMinBytes; the buffered baseline with a
 * huge one.
 */

const dir = mkdtempSync(join(tmpdir(), "pit-read-stream-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeTools(filePath: string) {
	const base = { embedHashlineAnchors: false } as const;
	return {
		streaming: createReadTool(dir, { ...base, streamingMinBytes: 1024 }),
		buffered: createReadTool(dir, { ...base, streamingMinBytes: Number.MAX_SAFE_INTEGER }),
		path: filePath,
	};
}

async function runBoth(tools: ReturnType<typeof makeTools>, args: { offset?: number; limit?: number }) {
	const streaming = await tools.streaming.execute("t-stream", { path: tools.path, ...args });
	const buffered = await tools.buffered.execute("t-buffer", { path: tools.path, ...args });
	return {
		streamingText: (streaming.content[0] as { text: string }).text,
		bufferedText: (buffered.content[0] as { text: string }).text,
	};
}

describe("read streaming fast path (parity with buffered path)", () => {
	// ~360KB, 6000 lines, mixed content: CRLF on every 7th line (CR must be
	// preserved like split("\n") does), multi-byte chars, and a trailing newline.
	const lines: string[] = [];
	for (let i = 0; i < 6000; i++) {
		const body = `line ${i} água-emoji 🚀 status=${i % 2 ? "ok" : "err"} cursor=eyJvZmZzZXQiOjEyMzR9`;
		lines.push(i % 7 === 0 ? `${body}\r` : body);
	}
	const textFile = join(dir, "big.log");
	writeFileSync(textFile, `${lines.join("\n")}\n`, "utf-8");

	const cases: Array<{ name: string; args: { offset?: number; limit?: number } }> = [
		{ name: "no offset/limit (head truncation notice)", args: {} },
		{ name: "offset near start", args: { offset: 3, limit: 50 } },
		{ name: "offset deep with limit", args: { offset: 5900, limit: 200 } },
		{ name: "limit reaching past EOF (remaining notice)", args: { offset: 5990, limit: 5 } },
		{ name: "limit only", args: { limit: 10 } },
		{ name: "offset only (truncateHead decides)", args: { offset: 2500 } },
		{ name: "offset at last line", args: { offset: 6001 } },
		{ name: "CRLF line at range start", args: { offset: 15, limit: 7 } },
	];

	for (const { name, args } of cases) {
		it(`matches buffered output: ${name}`, async () => {
			const tools = makeTools(textFile);
			const { streamingText, bufferedText } = await runBoth(tools, args);
			expect(streamingText).toBe(bufferedText);
		});
	}

	it("matches buffered error for offset beyond EOF", async () => {
		const tools = makeTools(textFile);
		const args = { path: tools.path, offset: 99999 };
		const [streamErr, bufferErr] = await Promise.all([
			tools.streaming.execute("t-stream", args).then(
				() => undefined,
				(e: Error) => e.message,
			),
			tools.buffered.execute("t-buffer", args).then(
				() => undefined,
				(e: Error) => e.message,
			),
		]);
		expect(streamErr).toBeDefined();
		expect(streamErr).toBe(bufferErr);
	});

	it("matches buffered binary note (NUL bytes in the sniff window)", async () => {
		const binFile = join(dir, "blob.bin");
		const payload = Buffer.alloc(64 * 1024);
		for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
		writeFileSync(binFile, payload);
		const tools = makeTools(binFile);
		const { streamingText, bufferedText } = await runBoth(tools, {});
		expect(streamingText).toBe(bufferedText);
		expect(streamingText).toContain("[Binary file:");
	});

	it("keeps the buffered path for operations without stat/createByteStream", async () => {
		const content = Array.from({ length: 100 }, (_, i) => `remote line ${i}`).join("\n");
		const tool = createReadTool(dir, {
			embedHashlineAnchors: false,
			streamingMinBytes: 1, // would force streaming if the ops supported it
			operations: {
				readFile: async () => Buffer.from(content, "utf-8"),
				access: async () => {},
				detectImageMimeType: async () => null,
			},
		});
		const res = await tool.execute("t-remote", { path: "remote.txt", offset: 5, limit: 2 });
		expect((res.content[0] as { text: string }).text).toContain("remote line 4");
	});
});
