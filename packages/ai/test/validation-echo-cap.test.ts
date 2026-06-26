/**
 * T2 #5: the schema-validation error echoes the received arguments so the model
 * can self-correct, but with no cap it echoed the ENTIRE payload — for write/edit/
 * code that's the whole file, often re-sent right after (2-3x tokens). The cap
 * truncates only long string VALUES, preserving keys + the actionable hints.
 */

import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Tool, ToolCall } from "../src/types.js";
import { validateToolArguments } from "../src/utils/validation.js";

const tool: Tool = {
	name: "write",
	description: "write a file",
	parameters: Type.Object({ path: Type.String(), content: Type.String() }, { additionalProperties: false }),
};

function failMessage(args: Record<string, unknown>): string {
	const toolCall: ToolCall = { type: "toolCall", id: "t", name: "write", arguments: args };
	try {
		validateToolArguments(tool, toolCall);
		return "";
	} catch (e) {
		return (e as Error).message;
	}
}

describe("T2 #5: validation error caps the echoed argument payload", () => {
	it("truncates a huge string value but keeps keys and actionable hints", () => {
		const msg = failMessage({ path: "x.ts", content: "A".repeat(100_000), bogus: 1 });
		expect(msg).toContain("Validation failed");
		expect(msg).toMatch(/Received arguments/);
		expect(msg).toContain('"path"'); // key preserved
		expect(msg).toMatch(/chars truncated/); // long value capped
		// The 100KB payload must NOT round-trip into the error.
		expect(msg.length).toBeLessThan(5000);
	});

	it("echoes small invalid payloads in full (cap only bites long values)", () => {
		const msg = failMessage({ path: "x.ts", content: "tiny body", bogus: 1 });
		expect(msg).toContain('"tiny body"'); // short value verbatim
		expect(msg).not.toMatch(/chars truncated/);
	});

	it("never splits an astral char into a lone surrogate when truncating", () => {
		// 700 emoji (each a surrogate pair) exceeds the cap; the truncated echo must
		// contain no unpaired surrogate (U+FFFD-free round trip through the boundary).
		const msg = failMessage({ path: "x.ts", content: "😀".repeat(700), bogus: 1 });
		expect(msg).toMatch(/chars truncated/);
		expect(msg).not.toMatch(/�/);
		// no lone high/low surrogate left dangling
		expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(msg)).toBe(false);
	});
});
