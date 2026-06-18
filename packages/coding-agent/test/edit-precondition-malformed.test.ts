import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEditPreconditionExtension } from "../src/core/built-ins/edit-precondition-extension.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;

/** Collect the extension's `tool_call` handler via a minimal ExtensionAPI shim. */
function collectHandler(cwd: string): Handler {
	let handler: Handler | undefined;
	const shim = {
		on: (event: string, h: Handler) => {
			if (event === "tool_call") handler = h;
		},
	};
	createEditPreconditionExtension({ cwd })(shim as never);
	if (!handler) throw new Error("no tool_call handler registered");
	return handler;
}

describe("edit-precondition: malformed edits shape", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pit-editprec-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("blocks an existing-file edit whose `edits` can't be parsed (was fail-open)", async () => {
		const file = join(dir, "a.ts");
		writeFileSync(file, "hello\n");
		const handler = collectHandler(dir);
		const decision = (await handler({
			type: "tool_call",
			toolName: "edit",
			toolCallId: "1",
			input: { path: file, edits: "not-an-array" },
		})) as { block?: boolean; reason?: string } | undefined;
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toMatch(/missing or malformed/i);
	});

	it("passes a well-formed edit whose oldText matches (dry-run path, no block)", async () => {
		const file = join(dir, "b.ts");
		writeFileSync(file, "hello world\n");
		const handler = collectHandler(dir);
		const decision = await handler({
			type: "tool_call",
			toolName: "edit",
			toolCallId: "2",
			input: { path: file, edits: [{ oldText: "hello", newText: "hi" }] },
		});
		expect(decision).toBeUndefined();
	});

	it("stays fail-open for a brand-new (non-existent) file", async () => {
		const handler = collectHandler(dir);
		const decision = await handler({
			type: "tool_call",
			toolName: "edit",
			toolCallId: "3",
			input: { path: join(dir, "new.ts"), edits: "garbage" },
		});
		expect(decision).toBeUndefined();
	});
});
