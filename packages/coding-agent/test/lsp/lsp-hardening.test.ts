import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { routeMessage, shutdownAll } from "../../src/core/lsp/client.ts";
import { applyWorkspaceEdit } from "../../src/core/lsp/edits.ts";
import { createLspToolDefinition } from "../../src/core/lsp/tool.ts";
import type { LspClient } from "../../src/core/lsp/types.ts";
import { fileToUri, formatDiagnostic } from "../../src/core/lsp/utils.ts";
import { setDiagnosticsOnWrite, setFormatOnWrite } from "../../src/core/lsp/writethrough.ts";
import { createWriteToolDefinition } from "../../src/core/tools/write.ts";

const UNSAFE_SERVER = fileURLToPath(new URL("./unsafe-lsp-server.mjs", import.meta.url));

const PREV_LSP_DIAG_WAIT = process.env.PIT_LSP_SINGLE_DIAGNOSTICS_WAIT_MS;

beforeAll(() => {
	// The stale-diagnostics case intentionally waits for a publish that never comes.
	// Production default is 3s; 200ms is enough to prove the failure path in tests.
	process.env.PIT_LSP_SINGLE_DIAGNOSTICS_WAIT_MS = "200";
});

afterAll(() => {
	if (PREV_LSP_DIAG_WAIT === undefined) {
		delete process.env.PIT_LSP_SINGLE_DIAGNOSTICS_WAIT_MS;
	} else {
		process.env.PIT_LSP_SINGLE_DIAGNOSTICS_WAIT_MS = PREV_LSP_DIAG_WAIT;
	}
});

type ToolResult = { content: Array<{ type: string; text?: string }> };
type WrittenRpc = { id?: number | string; result?: unknown; error?: unknown };

function text(result: unknown): string {
	return (result as ToolResult).content[0]?.text ?? "";
}

function makeProject(args: string[] = []): string {
	const cwd = mkdtempSync(join(tmpdir(), "pit-lsp-hardening-"));
	writeFileSync(
		join(cwd, "lsp.json"),
		JSON.stringify({
			servers: {
				unsafe: {
					command: "node",
					args: [UNSAFE_SERVER, ...args],
					fileTypes: [".txt", ".unsafe"],
					rootMarkers: ["lsp.json"],
				},
			},
		}),
	);
	return cwd;
}

async function runLsp(cwd: string, params: Record<string, unknown>): Promise<string> {
	const def = createLspToolDefinition(cwd);
	const ctx = {} as Parameters<typeof def.execute>[4];
	return text(await def.execute("lsp-hardening", params as never, undefined, undefined, ctx));
}

async function runWrite(cwd: string, path: string, content: string): Promise<string> {
	const def = createWriteToolDefinition(cwd);
	const ctx = {} as Parameters<typeof def.execute>[4];
	return text(await def.execute("write-hardening", { path, content }, undefined, undefined, ctx));
}

function makeApplyEditClient(cwd: string, writes: WrittenRpc[]): LspClient {
	const proc = {
		stdin: {
			write: (data: string) => {
				const idx = data.indexOf("\r\n\r\n");
				const body = idx >= 0 ? data.slice(idx + 4) : data;
				writes.push(JSON.parse(body) as WrittenRpc);
				return true;
			},
		},
	} as unknown as LspClient["proc"];

	return {
		name: "apply-edit-test",
		cwd,
		config: { command: "node", fileTypes: [".txt"], rootMarkers: ["lsp.json"] },
		proc,
		requestId: 0,
		diagnostics: new Map(),
		diagnosticsVersion: 0,
		openFiles: new Map(),
		pendingRequests: new Map(),
		messageBuffer: Buffer.alloc(0),
		pendingChunks: [],
		isReading: false,
		lastActivity: Date.now(),
		writeQueue: Promise.resolve(),
		activeProgressTokens: new Set(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => {},
		stderrBuffer: "",
		exitCode: null,
		serverApplyEditDepth: 0,
	} as LspClient;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe("lsp hardening", () => {
	afterEach(async () => {
		setDiagnosticsOnWrite(false);
		setFormatOnWrite(false);
		await shutdownAll().catch(() => {});
	});

	it("rejects workspace text edits outside cwd", async () => {
		const cwd = makeProject();
		const outside = mkdtempSync(join(tmpdir(), "pit-lsp-outside-"));
		try {
			const outsideFile = join(outside, "secret.txt");
			writeFileSync(outsideFile, "secret\n");

			await expect(
				applyWorkspaceEdit(
					{
						changes: {
							[fileToUri(outsideFile)]: [
								{
									range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
									newText: "leaked",
								},
							],
						},
					},
					cwd,
				),
			).rejects.toThrow(/outside|workspace|cwd|escapes/i);
			expect(readFileSync(outsideFile, "utf-8")).toBe("secret\n");
		} finally {
			await shutdownAll().catch(() => {});
			rmSync(cwd, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("rolls back earlier text edits when a later workspace edit fails", async () => {
		const cwd = makeProject();
		try {
			const first = join(cwd, "first.txt");
			const second = join(cwd, "second.txt");
			writeFileSync(first, "alpha\n");
			writeFileSync(second, "beta\n");

			await expect(
				applyWorkspaceEdit(
					{
						changes: {
							[fileToUri(first)]: [
								{
									range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
									newText: "ALPHA",
								},
							],
							[fileToUri(second)]: [
								{
									range: { start: { line: 99, character: 0 }, end: { line: 99, character: 1 } },
									newText: "bad",
								},
							],
						},
					},
					cwd,
				),
			).rejects.toThrow(/rolled back|out of range|workspace edit/i);
			expect(readFileSync(first, "utf-8")).toBe("alpha\n");
			expect(readFileSync(second, "utf-8")).toBe("beta\n");
		} finally {
			await shutdownAll().catch(() => {});
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("denies unsolicited server-initiated workspace/applyEdit", async () => {
		const cwd = makeProject();
		try {
			const target = join(cwd, "target.txt");
			writeFileSync(target, "safe\n");
			const writes: WrittenRpc[] = [];
			const client = makeApplyEditClient(cwd, writes);

			await routeMessage(client, {
				jsonrpc: "2.0",
				id: "server-edit",
				method: "workspace/applyEdit",
				params: {
					edit: {
						changes: {
							[fileToUri(target)]: [
								{
									range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
									newText: "pwned",
								},
							],
						},
					},
				},
			} as never);
			await flush();

			expect(readFileSync(target, "utf-8")).toBe("safe\n");
			expect(writes.find((entry) => entry.id === "server-edit")?.result).toMatchObject({ applied: false });
		} finally {
			await shutdownAll().catch(() => {});
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("omits source context for LSP locations outside cwd", async () => {
		const outside = mkdtempSync(join(tmpdir(), "pit-lsp-location-outside-"));
		const outsideFile = join(outside, "secret.txt");
		writeFileSync(outsideFile, "SECRET OUTSIDE\n");
		const cwd = makeProject(["--outside-uri", fileToUri(outsideFile)]);
		try {
			writeFileSync(join(cwd, "sample.unsafe"), "hello\n");
			const out = await runLsp(cwd, { action: "definition", file: "sample.unsafe", line: 1, symbol: "hello" });
			expect(out).toContain("secret.txt:1:1");
			expect(out).not.toContain("SECRET OUTSIDE");
		} finally {
			await shutdownAll().catch(() => {});
			rmSync(cwd, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("does not return OK when diagnostics never publish a fresh result", async () => {
		const cwd = makeProject();
		try {
			writeFileSync(join(cwd, "stale.txt"), "NO_PUBLISH\n");
			const out = await runLsp(cwd, { action: "diagnostics", file: "stale.txt" });
			expect(out).toMatch(/unavailable|stale|no fresh|Do not assume/i);
			expect(out).not.toBe("OK");
		} finally {
			await shutdownAll().catch(() => {});
			rmSync(cwd, { recursive: true, force: true });
		}
	}, 10_000);

	it("filters pre-existing diagnostics from post-write output", async () => {
		const cwd = makeProject();
		try {
			setDiagnosticsOnWrite(true);
			writeFileSync(join(cwd, "baseline.txt"), "OLD_ERROR\n");
			const out = await runWrite(cwd, "baseline.txt", "OLD_ERROR\nNEW_ERROR\n");
			expect(out).toContain("new issue");
			expect(out).not.toContain("preexisting issue");
		} finally {
			await shutdownAll().catch(() => {});
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("bounds and relativizes diagnostic related information", () => {
		const cwd = join(tmpdir(), "pit-lsp-related-cwd");
		const diagnostic = {
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			severity: 1 as const,
			message: "root issue",
			relatedInformation: Array.from({ length: 8 }, (_, index) => ({
				location: {
					uri: fileToUri(join(cwd, "src", `related-${index}.ts`)),
					range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } },
				},
				message: `related ${index}`,
			})),
		};

		const formatted = formatDiagnostic(diagnostic, "src/main.ts", cwd);
		expect(formatted).toContain("src/related-0.ts");
		expect(formatted).not.toContain(cwd.replace(/\\/g, "/"));
		expect(formatted).toContain("3 related location(s) omitted");
		expect(formatted).not.toContain("related 7");
	});
});
