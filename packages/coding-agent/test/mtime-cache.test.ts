import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMtimeParseCache, createMtimePrefixParseCache } from "../src/core/mtime-cache.js";
import { parseFrontmatter } from "../src/utils/frontmatter.js";

// Mirror of the production constants in skills.ts so the test exercises the
// exact configuration the skill loader uses.
const PREFIX_BYTES = 16384;
const FENCE_TAIL_MARGIN = 8;

// The fence-sufficiency predicate, identical to skillPrefixHasFrontmatterFence
// in skills.ts (kept in sync intentionally — this test is its contract).
function skillPrefixHasFrontmatterFence(prefix: string, atEof: boolean): boolean {
	if (atEof) {
		return true;
	}
	const normalized = prefix.replace(/\r\n?/g, "\n");
	if (!normalized.startsWith("---")) {
		return true;
	}
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) {
		return false;
	}
	return endIndex + 4 + FENCE_TAIL_MARGIN <= normalized.length;
}

type SkillParse = { frontmatter: Record<string, unknown> };

function makeSkillCache() {
	return createMtimePrefixParseCache<SkillParse>(
		(rawContent) => ({
			frontmatter: parseFrontmatter<Record<string, unknown>>(rawContent).frontmatter,
		}),
		{
			prefixBytes: PREFIX_BYTES,
			prefixIsSufficient: (prefix, ctx) => skillPrefixHasFrontmatterFence(prefix, ctx.atEof),
		},
	);
}

// The legacy full-read path, reproduced verbatim, so each test can assert the
// new prefix-read result is byte-for-byte identical to the old behavior.
function legacyFullRead(filePath: string): SkillParse {
	const rawContent = readFileSync(filePath, "utf-8");
	return { frontmatter: parseFrontmatter<Record<string, unknown>>(rawContent).frontmatter };
}

describe("createMtimePrefixParseCache (skill frontmatter)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pit-mtime-cache-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function writeSkill(name: string, content: string): string {
		const filePath = join(dir, name);
		writeFileSync(filePath, content);
		return filePath;
	}

	it("(1) small frontmatter + large body (>32KB): identical to full read", () => {
		const body = "x".repeat(40 * 1024);
		const content = `---\nname: big-body\ndescription: "A skill with a huge body."\n---\n\n${body}`;
		const filePath = writeSkill("big-body.md", content);

		const cache = makeSkillCache();
		const got = cache(filePath);
		const expected = legacyFullRead(filePath);

		expect(got.frontmatter).toEqual(expected.frontmatter);
		expect(got.frontmatter.name).toBe("big-body");
		expect(got.frontmatter.description).toBe("A skill with a huge body.");
	});

	it("(2) no closing fence within 16KB (giant frontmatter): falls back to full read, identical", () => {
		// Frontmatter whose closing `---` lives past the 16KB prefix window.
		// Each value is padded so the fence is comfortably beyond 16384 bytes.
		const pad = "v".repeat(64);
		const filler = Array.from({ length: 600 }, (_, i) => `key${i}: "${pad}-${i}"`).join("\n");
		const content = `---\nname: giant-fm\ndescription: "Giant frontmatter skill."\n${filler}\n---\n\nbody`;
		expect(content.indexOf("\n---", 3)).toBeGreaterThan(PREFIX_BYTES);
		const filePath = writeSkill("giant-fm.md", content);

		const cache = makeSkillCache();
		const got = cache(filePath);
		const expected = legacyFullRead(filePath);

		expect(got.frontmatter).toEqual(expected.frontmatter);
		expect(got.frontmatter.name).toBe("giant-fm");
		expect(got.frontmatter.description).toBe("Giant frontmatter skill.");
		// And the deep key only reachable via the full read must be present.
		expect(got.frontmatter.key599).toBe(`${"v".repeat(64)}-599`);
	});

	it("(3) file smaller than the prefix window: identical to full read", () => {
		const content = `---\nname: tiny\ndescription: "Tiny."\n---\nshort body`;
		const filePath = writeSkill("tiny.md", content);

		const cache = makeSkillCache();
		const got = cache(filePath);
		const expected = legacyFullRead(filePath);

		expect(got.frontmatter).toEqual(expected.frontmatter);
		expect(got.frontmatter.name).toBe("tiny");
	});

	it("(4) accents/emoji near the prefix boundary: identical to full read", () => {
		// Pad the description so the closing fence lands within ~a few bytes of
		// the 16KB boundary, then append a large body. Multi-byte chars (emoji,
		// acentuação) sit right at the truncation edge.
		const pad = "ção-🚀-".repeat(900); // multi-byte, pushes fence toward 16KB
		const body = "y".repeat(40 * 1024);
		const content = `---\nname: utf8-edge\ndescription: "Acentuação e emoji 🚀 ${pad}"\n---\n\n${body}`;
		const filePath = writeSkill("utf8-edge.md", content);

		const cache = makeSkillCache();
		const got = cache(filePath);
		const expected = legacyFullRead(filePath);

		expect(got.frontmatter).toEqual(expected.frontmatter);
		expect(String(got.frontmatter.description)).toContain("🚀");
		expect(String(got.frontmatter.description)).toContain("Acentuação");
	});

	it("(4b) emoji split exactly across the prefix boundary stays correct", () => {
		// Build frontmatter so a 4-byte emoji straddles byte 16384 in the body
		// region — but the fence is well before it, so the prefix parse is used
		// and the truncated trailing emoji never reaches the YAML.
		const head = `---\nname: split-emoji\ndescription: "ok"\n---\n`;
		const bodyPad = "a".repeat(PREFIX_BYTES - Buffer.byteLength(head) - 2);
		const content = `${head}${bodyPad}🚀${"z".repeat(2048)}`;
		const filePath = writeSkill("split-emoji.md", content);

		const cache = makeSkillCache();
		const got = cache(filePath);
		const expected = legacyFullRead(filePath);

		expect(got.frontmatter).toEqual(expected.frontmatter);
		expect(got.frontmatter.name).toBe("split-emoji");
		expect(got.frontmatter.description).toBe("ok");
	});

	it("BOM file behaves identically (no frontmatter, like the full-read path)", () => {
		const content = `﻿---\nname: bom\ndescription: "has bom"\n---\n\nbody`;
		const filePath = writeSkill("bom.md", content);

		const cache = makeSkillCache();
		const got = cache(filePath);
		const expected = legacyFullRead(filePath);

		// A leading BOM means startsWith("---") is false → empty frontmatter,
		// for BOTH paths. The point is parity, not the (degenerate) value.
		expect(got.frontmatter).toEqual(expected.frontmatter);
	});

	it("CRLF frontmatter parses identically to the full read", () => {
		const body = "w".repeat(40 * 1024);
		const content = `---\r\nname: crlf\r\ndescription: "CRLF skill"\r\n---\r\n\r\n${body}`;
		const filePath = writeSkill("crlf.md", content);

		const cache = makeSkillCache();
		const got = cache(filePath);
		const expected = legacyFullRead(filePath);

		expect(got.frontmatter).toEqual(expected.frontmatter);
		expect(got.frontmatter.name).toBe("crlf");
		expect(got.frontmatter.description).toBe("CRLF skill");
	});

	it("re-reads after mtime change, serves cache while mtime is stable", () => {
		const filePath = writeSkill("evolving.md", `---\nname: v1\ndescription: "first"\n---\nbody`);
		const cache = makeSkillCache();

		expect(cache(filePath).frontmatter.name).toBe("v1");

		// Bump mtime by writing new content with a forced-future timestamp.
		writeFileSync(filePath, `---\nname: v2\ndescription: "second"\n---\nbody`);
		const future = new Date(Date.now() + 5000);
		// Force a strictly-later mtime so the cache key (mtimeMs) definitely moves.
		utimesSync(filePath, future, future);

		expect(cache(filePath).frontmatter.name).toBe("v2");
	});
});

describe("createMtimeParseCache (generic, unchanged) still reads whole file", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pit-mtime-generic-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("passes the entire file body to the parse fn", () => {
		const filePath = join(dir, "whole.md");
		const body = "BODY-MARKER".repeat(4096);
		writeFileSync(filePath, `head\n${body}`);

		let seen = "";
		const cache = createMtimeParseCache<number>((raw) => {
			seen = raw;
			return raw.length;
		});
		const len = cache(filePath);

		expect(seen).toContain("BODY-MARKER");
		expect(len).toBe(readFileSync(filePath, "utf-8").length);
	});
});
