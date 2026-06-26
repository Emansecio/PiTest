/**
 * T1 #1: the edit recovery-hint rules were registered `appliesTo:"edit"` and the
 * registry matches the tool name exactly, so `edit_v2` (the content-hash editor,
 * always active) received none of them — and the `edit-hashline-anchor-stale`
 * rule, written specifically for edit_v2's HashlineEditError shape, was dead.
 * Widening the tool-agnostic rules to ["edit","edit_v2"] revives them, additively.
 */

import { describe, expect, it } from "vitest";
import { createDefaultToolErrorHintRegistry } from "../src/core/tool-error-hint-rules.ts";

const reg = createDefaultToolErrorHintRegistry();
type Call = Parameters<typeof reg.apply>[0];
type Result = Parameters<typeof reg.apply>[1];

const call = (name: string, args: Record<string, unknown>): Call => ({
	type: "toolCall",
	id: "t1",
	name,
	arguments: args,
});
const errResult = (text: string, details?: unknown): Result =>
	({ content: [{ type: "text", text }], details }) as Result;

const hashlineNotFound = (): Result =>
	errResult("edits[0].before_hash ab12 not found.", {
		detail: { kind: "not_found", which: "before_hash", editIndex: 0, hash: "ab12", nearby: [40, 41] },
	});

describe("T1 #1: edit_v2 receives edit recovery hints (dead rule revived)", () => {
	it("anchor-stale rule now fires for edit_v2 (was completely dead)", () => {
		const outcome = createDefaultToolErrorHintRegistry().apply(
			call("edit_v2", { path: "x.ts", edits: [] }),
			hashlineNotFound(),
		);
		expect(outcome.hints.some((h) => /fresh content-hash anchors/i.test(h.hint))).toBe(true);
		expect(outcome.hints.some((h) => /near lines 40, 41/i.test(h.hint))).toBe(true);
	});

	it("ENOENT verify-path hint now reaches edit_v2 (widened rule)", () => {
		const outcome = createDefaultToolErrorHintRegistry().apply(
			call("edit_v2", { path: "x.ts" }),
			errResult("Could not edit file: x.ts. Error code: ENOENT."),
		);
		expect(outcome.hints.some((h) => /find\(|ls\(|not found/i.test(h.hint))).toBe(true);
	});

	it("(regression) plain edit still gets the ENOENT hint — widening is additive", () => {
		const outcome = createDefaultToolErrorHintRegistry().apply(
			call("edit", { path: "x.ts" }),
			errResult("Could not edit file: x.ts. Error code: ENOENT."),
		);
		expect(outcome.hints.some((h) => /find\(|ls\(|not found/i.test(h.hint))).toBe(true);
	});

	it("oldText-specific advice does NOT leak to edit_v2 (kept appliesTo:'edit')", () => {
		const outcome = createDefaultToolErrorHintRegistry().apply(call("edit_v2", { path: "x.ts" }), hashlineNotFound());
		// edit-old-text-not-found stays edit-only; its leading-whitespace/oldText
		// guidance is wrong for the before_hash/after_hash schema.
		expect(outcome.hints.some((h) => /leading-whitespace|paste the exact slice|oldText/i.test(h.hint))).toBe(false);
	});
});
