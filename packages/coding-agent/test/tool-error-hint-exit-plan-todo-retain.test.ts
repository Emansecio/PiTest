/**
 * Recovery-hint coverage for the anti-error pack (plans 008 C/D): the plan-mode
 * `exit_plan` misfire, `read` offset past EOF, `todo` unknown id, `edit`
 * non-unique oldText, and `retain` invalid kind. Each assertion drives the real
 * error string the tool emits through the default registry and checks the
 * matching hint fires (and stays quiet on unrelated errors).
 */

import { describe, expect, it } from "vitest";
import { createDefaultToolErrorHintRegistry } from "../src/core/tool-error-hint-rules.ts";

const reg = createDefaultToolErrorHintRegistry();
type Call = Parameters<typeof reg.apply>[0];
type Result = Parameters<typeof reg.apply>[1];

const call = (name: string, args: Record<string, unknown>): Call => ({
	type: "toolCall",
	id: "c1",
	name,
	arguments: args,
});
const errResult = (text: string): Result => ({ content: [{ type: "text", text }], details: undefined }) as Result;

const hintsFor = (name: string, args: Record<string, unknown>, text: string): string =>
	createDefaultToolErrorHintRegistry()
		.apply(call(name, args), errResult(text))
		.hints.map((h) => h.hint)
		.join("\n");

describe("008 Fix C: exit_plan called from execution mode", () => {
	it("steers the model to just continue the work", () => {
		const hints = hintsFor("exit_plan", { title: "x" }, "exit_plan is only available in plan mode.");
		expect(/already in execution/i.test(hints)).toBe(true);
		expect(/continue the work/i.test(hints)).toBe(true);
	});

	it("stays quiet on an unrelated exit_plan error", () => {
		const hints = hintsFor("exit_plan", { title: "x" }, "Some other failure happened.");
		expect(hints).toBe("");
	});
});

describe("008 Fix D: read offset beyond EOF", () => {
	it("names the real line count and a valid offset bound", () => {
		const hints = hintsFor(
			"read",
			{ path: "a.ts", offset: 500 },
			"Offset 500 is beyond end of file (42 lines total)",
		);
		expect(hints).toContain("42");
		expect(/offset <= 42/i.test(hints)).toBe(true);
	});
});

describe("008 Fix D: todo unknown id", () => {
	it("points the model at the list op", () => {
		const hints = hintsFor("todo", { action: "update", id: 9 }, "No todo with id 9.");
		expect(hints).toContain('todo({action:"list"})');
	});

	it("stays quiet on an unrelated todo error", () => {
		const hints = hintsFor("todo", { action: "create" }, "subject is required for create.");
		expect(hints).toBe("");
	});
});

describe("008 Fix D: edit non-unique oldText", () => {
	it("offers replaceAll or extending the anchor", () => {
		const hints = hintsFor(
			"edit",
			{ path: "a.ts", edits: [{ oldText: "x", newText: "y" }] },
			"Found 3 occurrences of the text in a.ts. The text must be unique.",
		);
		expect(/replaceAll: true/i.test(hints)).toBe(true);
		expect(/extend oldText/i.test(hints)).toBe(true);
	});
});

describe("008 Fix D: retain invalid kind", () => {
	it("lists the allowed kind values", () => {
		const hints = hintsFor(
			"retain",
			{ subject: "x", kind: "note" },
			'validation failed for tool "retain": /kind: must be equal to one of the allowed values',
		);
		expect(hints).toContain("fact");
		expect(hints).toContain("decision");
		expect(hints).toContain("pattern");
	});
});
