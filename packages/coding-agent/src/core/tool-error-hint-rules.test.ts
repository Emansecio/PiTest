/**
 * Tests for the edit-scoped Tier 4 hint rules (#6 + #7).
 *
 * Each test feeds the REAL error string emitted by the corresponding tool path
 * and asserts the matching rule fires with an actionable hint. Error strings
 * are copied verbatim from:
 *   - edit.ts / edit-diff.ts   : `Could not edit file: <p>. Error code: ENOENT.`
 *   - read-guard-extension.ts  : `Read guard: file "<p>" has not been read ...`
 *   - edit-hashline-diff.ts    : `edits[N].before_hash <h> not found. ...`
 *                                `edits[N].after_hash <h> is ambiguous (matches lines ...)`
 */

import type { AgentToolCall, AgentToolResult } from "@pit/agent-core";
import { describe, expect, it } from "vitest";
import { createDefaultToolErrorHintRegistry } from "./tool-error-hint-rules.ts";

function call(name: string, args: Record<string, unknown>): AgentToolCall {
	return { type: "toolCall", id: "tool-1", name, arguments: args };
}

function errorResult(text: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details: undefined };
}

// Build once with learned-error rules disabled (they require disk state).
const registry = createDefaultToolErrorHintRegistry();

function hintIdsFor(toolCall: AgentToolCall, errorText: string): string[] {
	return registry.apply(toolCall, errorResult(errorText)).hints.map((h) => h.ruleId);
}

function hintTextsFor(toolCall: AgentToolCall, errorText: string): string {
	return registry
		.apply(toolCall, errorResult(errorText))
		.hints.map((h) => h.hint)
		.join("\n");
}

describe("edit-scoped tool-error hints (#6)", () => {
	it("fires edit-enoent-verify-path on the real ENOENT edit error", () => {
		const err = "Could not edit file: src/missing.ts. Error code: ENOENT.";
		const c = call("edit", { path: "src/missing.ts", edits: [{ oldText: "a", newText: "b" }] });
		const ids = hintIdsFor(c, err);
		expect(ids).toContain("edit-enoent-verify-path");
		const text = hintTextsFor(c, err);
		expect(text).toMatch(/find\(\{pattern:"\*\*\/missing\.ts"\}\)/);
	});

	it("does NOT fire the read/bash ENOENT rules for an edit ENOENT (appliesTo filter)", () => {
		const err = "Could not edit file: src/missing.ts. Error code: ENOENT.";
		const c = call("edit", { path: "src/missing.ts", edits: [{ oldText: "a", newText: "b" }] });
		const ids = hintIdsFor(c, err);
		expect(ids).not.toContain("read-enoent-suggest-find");
		expect(ids).not.toContain("bash-path-not-found");
	});

	it("fires edit-read-guard-not-read on the real read-guard block reason", () => {
		const err =
			'Read guard: file "src/app.ts" has not been read in this session. Read it first to confirm its current content before editing.';
		const c = call("edit", { path: "src/app.ts", edits: [{ oldText: "a", newText: "b" }] });
		const ids = hintIdsFor(c, err);
		expect(ids).toContain("edit-read-guard-not-read");
		expect(hintTextsFor(c, err)).toMatch(/read\(\{path:"src\/app\.ts"\}\)/);
	});

	it("fires edit-read-guard-not-read on the stale post-compaction guard reason", () => {
		const err =
			'Read guard: file "src/app.ts" changed since it was last read (pre-compaction snapshot stale). Read it again to confirm current content before editing.';
		const c = call("edit", { path: "src/app.ts", edits: [{ oldText: "a", newText: "b" }] });
		expect(hintIdsFor(c, err)).toContain("edit-read-guard-not-read");
	});

	it("fires edit-hashline-anchor-stale on a real before_hash not-found error", () => {
		const err =
			"edits[0].before_hash a1b2c3d4 not found. Nearby lines: 12, 40. Re-read the file to get fresh anchors.";
		const c = call("edit", {
			path: "src/app.ts",
			edits: [{ before_hash: "a1b2c3d4", after_hash: "x", new_text: "y" }],
		});
		const ids = hintIdsFor(c, err);
		expect(ids).toContain("edit-hashline-anchor-stale");
		const text = hintTextsFor(c, err);
		expect(text).toMatch(/fresh content-hash anchors/);
		// Scraped nearby line numbers surface in the hint.
		expect(text).toMatch(/12, 40/);
	});

	it("fires edit-hashline-anchor-stale on a real ambiguous after_hash error and surfaces the matched lines", () => {
		const err =
			"edits[1].after_hash deadbeef is ambiguous (matches lines 3, 88, 120). Re-read the file to get fresh anchors.";
		const c = call("edit", { path: "src/app.ts", edits: [] });
		const text = hintTextsFor(c, err);
		expect(hintIdsFor(c, err)).toContain("edit-hashline-anchor-stale");
		expect(text).toMatch(/3, 88, 120/);
	});

	it("reads structured HashlineEditError.detail (#9) when the message omits the line numbers", () => {
		// errorText deliberately omits "(matches lines ...)" so the regex scrape
		// finds nothing — only the structured detail on result.details.detail can
		// supply the matched lines. Proves the rule prefers structured data.
		const err = "edits[1].after_hash deadbeef is ambiguous. Re-read the file to get fresh anchors.";
		const c = call("edit", { path: "src/app.ts", edits: [] });
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: err }],
			details: { detail: { kind: "ambiguous", which: "after_hash", hash: "deadbeef", matches: [7, 42, 99] } },
		};
		const out = registry.apply(c, result);
		const ids = out.hints.map((h) => h.ruleId);
		const text = out.hints.map((h) => h.hint).join("\n");
		expect(ids).toContain("edit-hashline-anchor-stale");
		expect(text).toMatch(/7, 42, 99/);
	});
});

describe("edit-old-text-not-found generalization (#7)", () => {
	it("still fires on the classic 'could not find the exact text' message", () => {
		const err = "Could not find the exact text in src/app.ts.";
		const c = call("edit", { path: "src/app.ts", edits: [{ oldText: "a", newText: "b" }] });
		expect(hintIdsFor(c, err)).toContain("edit-old-text-not-found");
	});

	it("now ALSO fires on a hashline before_hash not-found error", () => {
		const err = "edits[0].before_hash a1b2c3d4 not found. Re-read the file to get fresh anchors.";
		const c = call("edit", { path: "src/app.ts", edits: [] });
		expect(hintIdsFor(c, err)).toContain("edit-old-text-not-found");
	});

	it("now ALSO fires on a hashline ambiguous error", () => {
		const err = "edits[1].after_hash deadbeef is ambiguous (matches lines 3, 88).";
		const c = call("edit", { path: "src/app.ts", edits: [] });
		expect(hintIdsFor(c, err)).toContain("edit-old-text-not-found");
	});

	it("does not fire when edit-diff already injected a verbatim oldText block", () => {
		const err = "Could not find the exact text. Paste this verbatim as oldText: <block>";
		const c = call("edit", { path: "src/app.ts", edits: [] });
		expect(hintIdsFor(c, err)).not.toContain("edit-old-text-not-found");
	});
});
