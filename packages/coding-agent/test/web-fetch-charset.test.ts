/**
 * Charset handling in the `web_fetch` pipeline.
 *
 * The body is read as *bytes* and only then decoded, because the encoding may
 * be declared inside the bytes themselves. Resolution order:
 *   `Content-Type: ...; charset=` → `<meta charset>` (HTML, first 1KB) → UTF-8.
 *
 * Every response body below is built from REAL single-byte encodings (latin-1 /
 * windows-1252), so a regression to unconditional UTF-8 decoding shows up as
 * U+FFFD instead of the accented characters.
 */

import { describe, expect, it } from "vitest";
import { createWebFetchToolDefinition, type WebFetchToolDetails } from "../src/core/tools/web-fetch.ts";
import { readCappedBytes } from "../src/core/web-search/extractors.ts";
import { charsetFromContentType, charsetFromMeta, decodeBody } from "../src/core/web-search/page-fetch.ts";
import type { DnsResolver } from "../src/core/web-search/url-guard.ts";

const PUBLIC_DNS: DnsResolver = async () => ["93.184.216.34"];

/**
 * Encode to real single-byte bytes (code point == byte). This covers both the
 * `iso-8859-1` and the `windows-1252` cases here: Node's `TextDecoder` treats
 * the two labels as the same single-byte table and leaves 0x80–0x9F as C1
 * controls rather than applying the WHATWG windows-1252 index, so the tests
 * stick to characters where the encodings agree. The genuinely different
 * decoder tables are exercised by the shift_jis case below.
 */
function encodeLatin1(text: string): Uint8Array {
	const out = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code > 0xff) throw new Error(`not representable in latin-1: ${text[i]}`);
		out[i] = code;
	}
	return out;
}

type Handler = (url: string) => Response | Promise<Response>;

function mockFetch(handler: Handler): typeof fetch {
	return (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		return await handler(url);
	}) as unknown as typeof fetch;
}

async function run(handler: Handler) {
	const def = createWebFetchToolDefinition("/tmp", {
		fetchImpl: mockFetch(handler),
		resolve: PUBLIC_DNS,
		// Keep Firecrawl out of the picture: these are all 200s, but the kill-switch
		// makes any accidental fallback loud instead of silently rewriting the body.
		env: { PIT_NO_FIRECRAWL: "1" },
	});
	const result = await def.execute("call-1", { url: "https://example.com/page" }, undefined, undefined, {} as never);
	const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
	return { result, text, details: result.details as WebFetchToolDetails };
}

/** The accented sentence every decode test looks for. */
const ACCENTED = "Ação e coração: à noite, o cão não vê nada.";

function htmlBytes(meta: string, body: string): Uint8Array {
	return encodeLatin1(
		`<!doctype html><html><head>${meta}<title>Página</title></head><body><p>${body}</p></body></html>`,
	);
}

describe("web_fetch — charset from the Content-Type header", () => {
	it("decodes real latin-1 bytes when the header says iso-8859-1", async () => {
		const bytes = htmlBytes("", ACCENTED);
		const { text, details } = await run(
			() => new Response(bytes, { status: 200, headers: { "content-type": "text/html; charset=iso-8859-1" } }),
		);
		expect(text).toContain(ACCENTED);
		expect(text).not.toContain("�");
		expect(details.title).toBe("Página");
	});

	it("wins over a conflicting <meta charset>", async () => {
		const bytes = htmlBytes('<meta charset="utf-8">', ACCENTED);
		const { text } = await run(
			() => new Response(bytes, { status: 200, headers: { "content-type": "text/html; charset=windows-1252" } }),
		);
		expect(text).toContain(ACCENTED);
	});

	it("applies to text/* bodies as well", async () => {
		const bytes = encodeLatin1(`plain ${ACCENTED}`);
		const { text } = await run(
			() => new Response(bytes, { status: 200, headers: { "content-type": "text/plain; charset=iso-8859-1" } }),
		);
		expect(text).toContain(`plain ${ACCENTED}`);
		expect(text).not.toContain("�");
	});

	it("applies to JSON bodies as well", async () => {
		const bytes = encodeLatin1(JSON.stringify({ titulo: ACCENTED }));
		const { text, details } = await run(
			() =>
				new Response(bytes, { status: 200, headers: { "content-type": "application/json; charset=iso-8859-1" } }),
		);
		expect(details.contentType).toContain("application/json");
		expect(text).toContain(ACCENTED);
		expect(text).not.toContain("�");
	});
});

describe("web_fetch — charset from <meta>", () => {
	it('honours <meta charset="windows-1252"> when the header carries none', async () => {
		const body = `${ACCENTED} Preço: 10 EUR - José, Ñuñez, ½ Åke.`;
		const bytes = htmlBytes('<meta charset="windows-1252">', body);
		const { text } = await run(() => new Response(bytes, { status: 200, headers: { "content-type": "text/html" } }));
		expect(text).toContain(ACCENTED);
		expect(text).toContain("Preço: 10 EUR - José, Ñuñez, ½ Åke.");
		expect(text).not.toContain("�");
	});

	it("honours the http-equiv Content-Type form", async () => {
		const meta = '<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">';
		const bytes = htmlBytes(meta, ACCENTED);
		const { text } = await run(() => new Response(bytes, { status: 200, headers: { "content-type": "text/html" } }));
		expect(text).toContain(ACCENTED);
		expect(text).not.toContain("�");
	});

	it("also applies when the content-type is missing entirely (HTML sniffed from the bytes)", async () => {
		const bytes = htmlBytes('<meta charset="windows-1252">', ACCENTED);
		const { text } = await run(() => new Response(bytes, { status: 200, headers: {} }));
		expect(text).toContain(ACCENTED);
	});

	it("ignores a declaration that appears past the 1KB prescan window", async () => {
		const filler = `<!--${"x".repeat(1_200)}-->`;
		const bytes = encodeLatin1(
			`<!doctype html><html><head>${filler}<meta charset="iso-8859-1"></head><body><p>${ACCENTED}</p></body></html>`,
		);
		const { text } = await run(() => new Response(bytes, { status: 200, headers: { "content-type": "text/html" } }));
		// No usable declaration → UTF-8 default → the latin-1 bytes become U+FFFD.
		// The point is that the pipeline degrades instead of throwing.
		expect(text).toContain("�");
	});
});

describe("web_fetch — fallbacks", () => {
	it("falls back to UTF-8 on an unknown charset label instead of throwing", async () => {
		const bytes = new TextEncoder().encode(`<html><body><p>${ACCENTED}</p></body></html>`);
		const { result, text } = await run(
			() =>
				new Response(bytes, { status: 200, headers: { "content-type": "text/html; charset=x-totally-made-up" } }),
		);
		expect(result.isError).toBeUndefined();
		expect(text).toContain(ACCENTED);
	});

	it("keeps UTF-8 as the default when nothing declares a charset", async () => {
		const bytes = new TextEncoder().encode(`<html><body><p>${ACCENTED} 日本語 🎉</p></body></html>`);
		const { text } = await run(() => new Response(bytes, { status: 200, headers: { "content-type": "text/html" } }));
		expect(text).toContain(ACCENTED);
		expect(text).toContain("日本語 🎉");
	});

	it("handles a multi-byte charset end to end (shift_jis)", async () => {
		// 日本語 in Shift_JIS.
		const bytes = new Uint8Array([0x3c, 0x70, 0x3e, 0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x3c, 0x2f, 0x70, 0x3e]);
		const { text } = await run(
			() => new Response(bytes, { status: 200, headers: { "content-type": "text/html; charset=shift_jis" } }),
		);
		expect(text).toContain("日本語");
	});
});

describe("charset helpers", () => {
	it("parses the charset parameter out of a Content-Type header", () => {
		expect(charsetFromContentType("text/html; charset=utf-8")).toBe("utf-8");
		expect(charsetFromContentType("text/html;charset=ISO-8859-1")).toBe("ISO-8859-1");
		expect(charsetFromContentType('text/html; charset="windows-1252"')).toBe("windows-1252");
		expect(charsetFromContentType("text/html; boundary=x; charset=latin1")).toBe("latin1");
		expect(charsetFromContentType("text/html")).toBeUndefined();
		expect(charsetFromContentType("")).toBeUndefined();
		// `charset` must be the parameter name, not a substring of the mime type.
		expect(charsetFromContentType("application/charset-thing")).toBeUndefined();
	});

	it("finds both <meta> declaration forms and nothing else", () => {
		const meta = (s: string) => charsetFromMeta(new TextEncoder().encode(s));
		expect(meta('<meta charset="windows-1252">')).toBe("windows-1252");
		expect(meta("<meta charset=Shift_JIS>")).toBe("Shift_JIS");
		expect(meta('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-15">')).toBe("iso-8859-15");
		expect(meta("<html><body>charset=utf-8 in prose</body></html>")).toBeUndefined();
		// An ASCII-readable document cannot really be utf-16; the prescan says utf-8.
		expect(meta('<meta charset="utf-16le">')).toBe("utf-8");
	});

	it("decodes with the given label and never throws on a bad one", () => {
		const latin1 = encodeLatin1("café");
		expect(decodeBody(latin1, "iso-8859-1")).toBe("café");
		expect(decodeBody(latin1, undefined)).toContain("�");
		expect(decodeBody(latin1, "not-a-charset")).toContain("�");
		expect(decodeBody(new TextEncoder().encode("café"), undefined)).toBe("café");
		// A multi-byte character sliced by the byte cap substitutes rather than throwing.
		const cut = new TextEncoder().encode("café").subarray(0, 4);
		expect(() => decodeBody(cut, "utf-8")).not.toThrow();
		expect(decodeBody(cut, "utf-8")).toBe("caf�");
	});
});

describe("readCappedBytes", () => {
	function streamed(chunks: Uint8Array[]): Response {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const c of chunks) controller.enqueue(c);
				controller.close();
			},
		});
		return new Response(stream, { status: 200 });
	}

	it("stops at the byte cap, joining chunks in order", async () => {
		const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]), new Uint8Array([7, 8, 9])];
		expect(Array.from(await readCappedBytes(streamed(chunks), 100))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(Array.from(await readCappedBytes(streamed(chunks), 4))).toEqual([1, 2, 3, 4]);
	});

	it("caps a bodyless response too", async () => {
		const res = new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 });
		Object.defineProperty(res, "body", { value: null });
		expect(Array.from(await readCappedBytes(res, 3))).toEqual([1, 2, 3]);
	});
});
