import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createErasableSyntaxPreconditionExtension } from "../src/core/built-ins/erasable-syntax-precondition-extension.ts";

type Handler = (event: unknown, ctx?: unknown) => unknown;
type Decision = { block?: boolean; reason?: string } | undefined;

function collectHandler(cwd: string): Handler {
	let handler: Handler | undefined;
	const shim = {
		on: (event: string, h: Handler) => {
			if (event === "tool_call") handler = h;
		},
	};
	createErasableSyntaxPreconditionExtension({ cwd })(shim as never);
	if (!handler) throw new Error("no tool_call handler registered");
	return handler;
}

function call(handler: Handler, toolName: string, input: Record<string, unknown>): Promise<Decision> {
	return Promise.resolve(handler({ type: "tool_call", toolName, toolCallId: "1", input }) as Decision);
}

describe("erasable-syntax precondition extension", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pit-eso-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function enableErasable(): void {
		writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { erasableSyntaxOnly: true } }));
	}

	it("blocks a write that introduces an enum (project enforces erasableSyntaxOnly)", async () => {
		enableErasable();
		const handler = collectHandler(dir);
		const decision = await call(handler, "write", { path: join(dir, "x.ts"), content: "export enum E { A, B }" });
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("erasableSyntaxOnly");
	});

	it("blocks an edit whose newText adds a parameter property", async () => {
		enableErasable();
		const handler = collectHandler(dir);
		const decision = await call(handler, "edit", {
			path: join(dir, "x.ts"),
			edits: [{ oldText: "constructor()", newText: "constructor(private db: Db)" }],
		});
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("parameter properties");
	});

	it("does NOT block when the project allows enums (gate off)", async () => {
		writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
		const handler = collectHandler(dir);
		const decision = await call(handler, "write", { path: join(dir, "x.ts"), content: "export enum E { A }" });
		expect(decision).toBeUndefined();
	});

	it("does NOT block a .js file even with the gate on", async () => {
		enableErasable();
		const handler = collectHandler(dir);
		const decision = await call(handler, "write", { path: join(dir, "x.js"), content: "export enum E { A }" });
		expect(decision).toBeUndefined();
	});

	it("does NOT block clean erasable code", async () => {
		enableErasable();
		const handler = collectHandler(dir);
		const decision = await call(handler, "write", {
			path: join(dir, "x.ts"),
			content: "export const f = (n: number): number => n + 1;",
		});
		expect(decision).toBeUndefined();
	});

	it("fire-once: a re-issued identical blocked call is allowed through", async () => {
		enableErasable();
		const handler = collectHandler(dir);
		const input = { path: join(dir, "x.ts"), content: "enum E { A }" };
		expect((await call(handler, "write", input))?.block).toBe(true);
		expect(await call(handler, "write", input)).toBeUndefined();
	});

	it("blocks a nested ternary when biome enforces noNestedTernary", async () => {
		writeFileSync(join(dir, "biome.json"), JSON.stringify({ linter: { rules: { recommended: true } } }));
		const handler = collectHandler(dir);
		const decision = await call(handler, "write", {
			path: join(dir, "x.ts"),
			content: "export const v = a ? b : c ? d : e;",
		});
		expect(decision?.block).toBe(true);
		expect(decision?.reason).toContain("noNestedTernary");
	});

	it("does NOT block a nested ternary when biome does not enforce it", async () => {
		// No biome config + tsconfig without erasableSyntaxOnly -> both gates off.
		writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
		const handler = collectHandler(dir);
		const decision = await call(handler, "write", {
			path: join(dir, "x.ts"),
			content: "export const v = a ? b : c ? d : e;",
		});
		expect(decision).toBeUndefined();
	});

	it("respects PIT_NO_ERASABLE_PREFLIGHT", async () => {
		enableErasable();
		const prev = process.env.PIT_NO_ERASABLE_PREFLIGHT;
		process.env.PIT_NO_ERASABLE_PREFLIGHT = "1";
		try {
			const handler = collectHandler(dir);
			const decision = await call(handler, "write", { path: join(dir, "x.ts"), content: "enum E { A }" });
			expect(decision).toBeUndefined();
		} finally {
			if (prev === undefined) delete process.env.PIT_NO_ERASABLE_PREFLIGHT;
			else process.env.PIT_NO_ERASABLE_PREFLIGHT = prev;
		}
	});
});
