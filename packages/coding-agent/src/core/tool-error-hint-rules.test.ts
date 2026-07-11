/**
 * Tests for the edit-scoped Tier 4 hint rules (#6 + #7).
 *
 * Each test feeds the REAL error string emitted by the corresponding tool path
 * and asserts the matching rule fires with an actionable hint. Error strings
 * are copied verbatim from:
 *   - edit.ts / edit-diff.ts   : `Could not edit file: <p>. Error code: ENOENT.`
 *   - read-guard-extension.ts  : `Read guard: unread "<p>" — read it first.`
 *   - edit-hashline-diff.ts    : `edits[N].before_hash <h> not found. ...`
 *                                `edits[N].after_hash <h> is ambiguous (matches lines ...)`
 */

import type { AgentToolCall, AgentToolResult, ToolErrorHintMatchInput } from "@pit/agent-core";
import { describe, expect, it } from "vitest";
import type { AggregatedLearnedError } from "./learned-error-store.ts";
import {
	createDefaultToolErrorHintRegistry,
	createLearnedErrorRules,
	createSameSessionHintRule,
} from "./tool-error-hint-rules.ts";

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
		const err = 'Read guard: unread "src/app.ts" — read it first.';
		const c = call("edit", { path: "src/app.ts", edits: [{ oldText: "a", newText: "b" }] });
		const ids = hintIdsFor(c, err);
		expect(ids).toContain("edit-read-guard-not-read");
		expect(hintTextsFor(c, err)).toMatch(/read\(\{path:"src\/app\.ts"\}\)/);
	});

	it("fires edit-read-guard-not-read on the stale post-compaction guard reason", () => {
		const err = 'Read guard: stale "src/app.ts" — re-read, then retry.';
		const c = call("edit", { path: "src/app.ts", edits: [{ oldText: "a", newText: "b" }] });
		expect(hintIdsFor(c, err)).toContain("edit-read-guard-not-read");
	});

	it("still matches legacy read-guard wording", () => {
		const err =
			'Read guard: file "src/app.ts" has not been read in this session. Read it first to confirm its current content before editing.';
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

// ---------------------------------------------------------------------------
// Truncated-fingerprint matching (#2): normalizeErrorFingerprint caps at 120
// chars and appends U+2026, so a literal `includes` of the capped form never
// matches the un-capped live error. Both the cross-session learned rule and
// the same-session rule must strip the ellipsis and match on the prefix.
// ---------------------------------------------------------------------------

const ELLIPSIS = "…";

function matchInput(errorText: string): ToolErrorHintMatchInput {
	const c = call("bash", { command: "noop" });
	const result: AgentToolResult<unknown> = errorResult(errorText);
	return { call: c, result, errorText };
}

function aggregated(overrides: Partial<AggregatedLearnedError>): AggregatedLearnedError {
	return {
		tool: "bash",
		fingerprint: "boom",
		totalCount: 3,
		sessionCount: 2,
		matchedRuleIds: [],
		sampleErrorText: "boom sample",
		...overrides,
	};
}

describe("createLearnedErrorRules truncated-fingerprint matching (#2)", () => {
	it("matches a >120-char fingerprint (capped with U+2026) against the un-capped live text", () => {
		// The aggregator caps the stored fingerprint at 120 chars + ellipsis. The
		// live error is longer and has no ellipsis; the matcher must strip "…" and
		// match on the 120-char prefix.
		const fingerprint = `${"x".repeat(120)}${ELLIPSIS}`;
		const rules = createLearnedErrorRules([aggregated({ fingerprint })]);
		expect(rules).toHaveLength(1);
		const rule = rules[0]!;

		// Live error: 120 "x" prefix, plus digits (exercise the \d+→N normalize),
		// plus trailing chars that the capped fingerprint dropped.
		const live = `${"x".repeat(120)} 4096 more bytes that the fingerprint dropped`;
		expect(rule.matcher(matchInput(live))).toBe(true);
	});

	it("does NOT match unrelated live text", () => {
		const fingerprint = `${"x".repeat(120)}${ELLIPSIS}`;
		const rule = createLearnedErrorRules([aggregated({ fingerprint })])[0]!;
		expect(rule.matcher(matchInput("a totally different error 500"))).toBe(false);
	});

	it("regression: a short fingerprint (no ellipsis) still matches exactly as before", () => {
		const rule = createLearnedErrorRules([aggregated({ fingerprint: "ENOENT no such file N" })])[0]!;
		// Live error normalizes digits → N, so "errno 17" becomes "errno N".
		expect(rule.matcher(matchInput("ENOENT no such file 17"))).toBe(true);
		expect(rule.matcher(matchInput("permission denied"))).toBe(false);
	});
});

describe("createSameSessionHintRule truncated-fingerprint matching (#2)", () => {
	it("matches a >120-char fingerprint (capped with U+2026) on its prefix", () => {
		const fingerprint = `${"y".repeat(120)}${ELLIPSIS}`;
		const rule = createSameSessionHintRule({ tool: "bash", fingerprint, count: 2, index: 0 });
		const live = `${"y".repeat(120)} 8 trailing bytes the cap removed`;
		expect(rule.matcher(matchInput(live))).toBe(true);
		expect(rule.matcher(matchInput("unrelated 1"))).toBe(false);
	});

	it("regression: a short fingerprint (no ellipsis) still matches exactly as before", () => {
		const rule = createSameSessionHintRule({
			tool: "bash",
			fingerprint: "command not found",
			count: 2,
			index: 0,
		});
		expect(rule.matcher(matchInput("bash: foo: command not found"))).toBe(true);
		expect(rule.matcher(matchInput("ENOENT"))).toBe(false);
	});
});

describe("error-class coverage hints (#15)", () => {
	it("routes a Python ModuleNotFoundError to the install-dependency hint", () => {
		const c = call("bash", { command: "python app.py" });
		const ids = hintIdsFor(c, "Traceback (most recent call last):\nModuleNotFoundError: No module named 'flask'");
		expect(ids).toContain("bash-dependency-missing");
		expect(hintTextsFor(c, "ModuleNotFoundError: No module named 'flask'")).toMatch(/install it/i);
	});

	it("routes a Node 'Cannot find module' to the install-dependency hint", () => {
		const c = call("bash", { command: "node server.js" });
		expect(hintIdsFor(c, "Error: Cannot find module 'express'")).toContain("bash-dependency-missing");
	});

	it("routes a network ECONNREFUSED to the transient hint", () => {
		const c = call("bash", { command: "curl https://api.example.com" });
		const ids = hintIdsFor(c, "curl: (7) Failed to connect: connect ECONNREFUSED 127.0.0.1:443");
		expect(ids).toContain("bash-network-transient");
	});

	it("routes getaddrinfo ENOTFOUND to the transient hint", () => {
		const c = call("bash", { command: "npm install" });
		expect(hintIdsFor(c, "npm ERR! getaddrinfo ENOTFOUND registry.npmjs.org")).toContain("bash-network-transient");
	});

	it("routes ENOSPC to the resource-exhausted hint", () => {
		const c = call("bash", { command: "npm install" });
		expect(hintIdsFor(c, "Error: ENOSPC: no space left on device, write")).toContain("bash-resource-exhausted");
	});

	it("routes a V8 heap OOM to the resource-exhausted hint", () => {
		const c = call("bash", { command: "node build.js" });
		expect(hintIdsFor(c, "FATAL ERROR: ... JavaScript heap out of memory")).toContain("bash-resource-exhausted");
	});

	it("does not misroute a plain grep no-match as dependency/network/resource", () => {
		const c = call("bash", { command: "grep foo bar.txt" });
		const ids = hintIdsFor(c, "Command exited with code 1");
		expect(ids).not.toContain("bash-dependency-missing");
		expect(ids).not.toContain("bash-network-transient");
		expect(ids).not.toContain("bash-resource-exhausted");
	});

	it("does not fire bash-only class hints for non-bash tools", () => {
		const c = call("read", { path: "x.py" });
		expect(hintIdsFor(c, "ModuleNotFoundError: No module named 'flask'")).not.toContain("bash-dependency-missing");
	});
});
