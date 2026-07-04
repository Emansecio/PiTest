/**
 * Regression coverage for the header-probe optimization in terminal-image.ts:
 * getPngDimensions/getGifDimensions/getWebpDimensions used to `Buffer.from`
 * the ENTIRE base64 payload just to read a small fixed-size header. They now
 * decode only a small prefix. These tests build large (>1MB) synthetic
 * images and assert the new implementation agrees, byte for byte, with an
 * "oracle" that reproduces the OLD full-decode behavior — for both valid
 * images and invalid/too-short input.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { getGifDimensions, getPngDimensions, getWebpDimensions } from "../src/terminal-image.js";

const LARGE_PAYLOAD_BYTES = 1_500_000; // >1MB, to prove we no longer decode the whole thing

function largeTrailer(byte = 0x42): Buffer {
	return Buffer.alloc(LARGE_PAYLOAD_BYTES, byte);
}

// ---- Oracles: verbatim ports of the pre-optimization implementations, ----
// ---- decoding the FULL base64 string every time (no truncation).      ----

function oldGetPngDimensions(base64Data: string): { widthPx: number; heightPx: number } | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");
		if (buffer.length < 24) return null;
		if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return null;
		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);
		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

function oldGetGifDimensions(base64Data: string): { widthPx: number; heightPx: number } | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");
		if (buffer.length < 10) return null;
		const sig = buffer.slice(0, 6).toString("ascii");
		if (sig !== "GIF87a" && sig !== "GIF89a") return null;
		const width = buffer.readUInt16LE(6);
		const height = buffer.readUInt16LE(8);
		return { widthPx: width, heightPx: height };
	} catch {
		return null;
	}
}

function oldGetWebpDimensions(base64Data: string): { widthPx: number; heightPx: number } | null {
	try {
		const buffer = Buffer.from(base64Data, "base64");
		if (buffer.length < 30) return null;
		const riff = buffer.slice(0, 4).toString("ascii");
		const webp = buffer.slice(8, 12).toString("ascii");
		if (riff !== "RIFF" || webp !== "WEBP") return null;
		const chunk = buffer.slice(12, 16).toString("ascii");
		if (chunk === "VP8 ") {
			if (buffer.length < 30) return null;
			const width = buffer.readUInt16LE(26) & 0x3fff;
			const height = buffer.readUInt16LE(28) & 0x3fff;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8L") {
			if (buffer.length < 25) return null;
			const bits = buffer.readUInt32LE(21);
			const width = (bits & 0x3fff) + 1;
			const height = ((bits >> 14) & 0x3fff) + 1;
			return { widthPx: width, heightPx: height };
		} else if (chunk === "VP8X") {
			if (buffer.length < 30) return null;
			const width = (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16)) + 1;
			const height = (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16)) + 1;
			return { widthPx: width, heightPx: height };
		}
		return null;
	} catch {
		return null;
	}
}

// ---- Synthetic image builders ----

function buildPng(width: number, height: number, trailer: Buffer): Buffer {
	const header = Buffer.alloc(24);
	header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // PNG signature
	header.writeUInt32BE(13, 8); // IHDR chunk length (not read by parser, just realistic)
	header.write("IHDR", 12, "ascii");
	header.writeUInt32BE(width, 16);
	header.writeUInt32BE(height, 20);
	return Buffer.concat([header, trailer]);
}

function buildGif(width: number, height: number, trailer: Buffer): Buffer {
	const header = Buffer.alloc(10);
	header.write("GIF89a", 0, "ascii");
	header.writeUInt16LE(width, 6);
	header.writeUInt16LE(height, 8);
	return Buffer.concat([header, trailer]);
}

function buildWebpVp8(width: number, height: number, trailer: Buffer): Buffer {
	const header = Buffer.alloc(30);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(0, 4); // file size, unused by parser
	header.write("WEBP", 8, "ascii");
	header.write("VP8 ", 12, "ascii");
	header.writeUInt32LE(0, 16); // chunk size, unused by parser
	header.set([0x9d, 0x01, 0x2a], 23); // VP8 start code (realistic, unchecked by parser)
	header.writeUInt16LE(width & 0x3fff, 26);
	header.writeUInt16LE(height & 0x3fff, 28);
	return Buffer.concat([header, trailer]);
}

function buildWebpVp8l(width: number, height: number, trailer: Buffer): Buffer {
	const header = Buffer.alloc(25);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(0, 4);
	header.write("WEBP", 8, "ascii");
	header.write("VP8L", 12, "ascii");
	header.writeUInt32LE(0, 16);
	header[20] = 0x2f; // VP8L signature byte
	const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
	header.writeUInt32LE(bits >>> 0, 21);
	return Buffer.concat([header, trailer]);
}

function buildWebpVp8x(width: number, height: number, trailer: Buffer): Buffer {
	const header = Buffer.alloc(30);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(0, 4);
	header.write("WEBP", 8, "ascii");
	header.write("VP8X", 12, "ascii");
	header.writeUInt32LE(0, 16);
	const w = width - 1;
	const h = height - 1;
	header[24] = w & 0xff;
	header[25] = (w >> 8) & 0xff;
	header[26] = (w >> 16) & 0xff;
	header[27] = h & 0xff;
	header[28] = (h >> 8) & 0xff;
	header[29] = (h >> 16) & 0xff;
	return Buffer.concat([header, trailer]);
}

describe("terminal-image header probe (large payloads)", () => {
	it("PNG: matches the old full-decode oracle for a >1MB image", () => {
		const buf = buildPng(1920, 1080, largeTrailer());
		const b64 = buf.toString("base64");
		assert.ok(b64.length > 1_000_000);

		const expected = oldGetPngDimensions(b64);
		const actual = getPngDimensions(b64);
		assert.deepStrictEqual(actual, expected);
		assert.deepStrictEqual(actual, { widthPx: 1920, heightPx: 1080 });
	});

	it("GIF: matches the old full-decode oracle for a >1MB image", () => {
		const buf = buildGif(640, 480, largeTrailer());
		const b64 = buf.toString("base64");
		assert.ok(b64.length > 1_000_000);

		const expected = oldGetGifDimensions(b64);
		const actual = getGifDimensions(b64);
		assert.deepStrictEqual(actual, expected);
		assert.deepStrictEqual(actual, { widthPx: 640, heightPx: 480 });
	});

	it("WEBP (VP8 lossy): matches the old full-decode oracle for a >1MB image", () => {
		const buf = buildWebpVp8(800, 600, largeTrailer());
		const b64 = buf.toString("base64");
		assert.ok(b64.length > 1_000_000);

		const expected = oldGetWebpDimensions(b64);
		const actual = getWebpDimensions(b64);
		assert.deepStrictEqual(actual, expected);
		assert.deepStrictEqual(actual, { widthPx: 800, heightPx: 600 });
	});

	it("WEBP (VP8L lossless): matches the old full-decode oracle for a >1MB image", () => {
		const buf = buildWebpVp8l(1024, 768, largeTrailer());
		const b64 = buf.toString("base64");
		assert.ok(b64.length > 1_000_000);

		const expected = oldGetWebpDimensions(b64);
		const actual = getWebpDimensions(b64);
		assert.deepStrictEqual(actual, expected);
		assert.deepStrictEqual(actual, { widthPx: 1024, heightPx: 768 });
	});

	it("WEBP (VP8X extended): matches the old full-decode oracle for a >1MB image", () => {
		const buf = buildWebpVp8x(3000, 2000, largeTrailer());
		const b64 = buf.toString("base64");
		assert.ok(b64.length > 1_000_000);

		const expected = oldGetWebpDimensions(b64);
		const actual = getWebpDimensions(b64);
		assert.deepStrictEqual(actual, expected);
		assert.deepStrictEqual(actual, { widthPx: 3000, heightPx: 2000 });
	});

	it("PNG: returns null for a bad signature even with a large trailer, matching the oracle", () => {
		const buf = buildPng(100, 100, largeTrailer());
		buf[0] = 0x00; // corrupt signature
		const b64 = buf.toString("base64");
		assert.strictEqual(getPngDimensions(b64), oldGetPngDimensions(b64));
		assert.strictEqual(getPngDimensions(b64), null);
	});

	it("GIF: returns null for a bad signature even with a large trailer, matching the oracle", () => {
		const buf = buildGif(100, 100, largeTrailer());
		buf.write("XXXXXX", 0, "ascii");
		const b64 = buf.toString("base64");
		assert.strictEqual(getGifDimensions(b64), oldGetGifDimensions(b64));
		assert.strictEqual(getGifDimensions(b64), null);
	});

	it("WEBP: returns null for a bad fourCC even with a large trailer, matching the oracle", () => {
		const buf = buildWebpVp8(100, 100, largeTrailer());
		buf.write("WEBQ", 8, "ascii");
		const b64 = buf.toString("base64");
		assert.strictEqual(getWebpDimensions(b64), oldGetWebpDimensions(b64));
		assert.strictEqual(getWebpDimensions(b64), null);
	});

	it("PNG: returns null for input shorter than the header, matching the oracle", () => {
		const cases = ["", "AAAA", Buffer.alloc(23, 1).toString("base64")];
		for (const b64 of cases) {
			assert.strictEqual(getPngDimensions(b64), oldGetPngDimensions(b64));
			assert.strictEqual(getPngDimensions(b64), null);
		}
	});

	it("GIF: returns null for input shorter than the header, matching the oracle", () => {
		const cases = ["", "AAAA", Buffer.alloc(9, 1).toString("base64")];
		for (const b64 of cases) {
			assert.strictEqual(getGifDimensions(b64), oldGetGifDimensions(b64));
			assert.strictEqual(getGifDimensions(b64), null);
		}
	});

	it("WEBP: returns null for input shorter than the header, matching the oracle", () => {
		const cases = ["", "AAAA", Buffer.alloc(29, 1).toString("base64")];
		for (const b64 of cases) {
			assert.strictEqual(getWebpDimensions(b64), oldGetWebpDimensions(b64));
			assert.strictEqual(getWebpDimensions(b64), null);
		}
	});

	it("WEBP: VP8L just past its own (smaller) minimum length still resolves, matching the oracle", () => {
		// VP8L only needs 25 bytes, below the top-level 30-byte gate other
		// variants require — exercise it with a large trailer too.
		const buf = buildWebpVp8l(200, 100, largeTrailer());
		const b64 = buf.toString("base64");
		assert.deepStrictEqual(getWebpDimensions(b64), oldGetWebpDimensions(b64));
	});

	it("throws no exception and returns null on garbage input that is not valid base64-decodable header data", () => {
		// Buffer.from with base64 never throws in Node, but keep the parity check
		// for defense in depth (invalid chars are simply dropped by the decoder).
		const garbage = "!!!not-base64!!!";
		assert.strictEqual(getPngDimensions(garbage), oldGetPngDimensions(garbage));
		assert.strictEqual(getGifDimensions(garbage), oldGetGifDimensions(garbage));
		assert.strictEqual(getWebpDimensions(garbage), oldGetWebpDimensions(garbage));
	});
});
