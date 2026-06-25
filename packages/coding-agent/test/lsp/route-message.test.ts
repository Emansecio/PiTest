import { describe, expect, it } from "vitest";
import { routeMessage } from "../../src/core/lsp/client.ts";
import type { LspClient } from "../../src/core/lsp/types.ts";

type Written = { id?: number | string; result?: unknown; error?: unknown; method?: string };

function makeClient(): { client: LspClient; writes: Written[]; resolvedProjectLoaded: () => boolean } {
	const writes: Written[] = [];
	let projectLoadedResolved = false;
	const proc = {
		stdin: {
			write: (data: string) => {
				// Strip the LSP header and parse the JSON-RPC body.
				const idx = data.indexOf("\r\n\r\n");
				const body = idx >= 0 ? data.slice(idx + 4) : data;
				try {
					writes.push(JSON.parse(body));
				} catch {
					// ignore
				}
				return true;
			},
		},
	} as unknown as LspClient["proc"];

	const client = {
		name: "fake",
		cwd: "/tmp",
		config: { settings: {} },
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
		activeProgressTokens: new Set<string | number>(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => {
			projectLoadedResolved = true;
		},
		stderrBuffer: "",
		exitCode: null,
		serverApplyEditDepth: 0,
	} as unknown as LspClient;

	return { client, writes, resolvedProjectLoaded: () => projectLoadedResolved };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe("routeMessage server-request vs response disambiguation (#7)", () => {
	it("does not resolve an outbound request when a server request reuses its id", async () => {
		const { client, writes } = makeClient();
		let resolvedWith: unknown = "UNSET";
		let rejected = false;
		client.pendingRequests.set(1, {
			resolve: (v: unknown) => {
				resolvedWith = v;
			},
			reject: () => {
				rejected = true;
			},
		} as never);

		// Server-initiated request whose id (1) collides with our in-flight id.
		await routeMessage(client, {
			jsonrpc: "2.0",
			id: 1,
			method: "workspace/configuration",
			params: { items: [{ section: "foo" }] },
		} as never);
		await flush();

		// The outbound promise must NOT be touched.
		expect(resolvedWith).toBe("UNSET");
		expect(rejected).toBe(false);
		expect(client.pendingRequests.has(1)).toBe(true);
		// And the server request must be answered.
		const reply = writes.find((w) => w.id === 1);
		expect(reply).toBeDefined();
		expect(Array.isArray(reply?.result)).toBe(true);
	});

	it("still resolves a genuine response (no method) to an outbound request", async () => {
		const { client } = makeClient();
		let resolvedWith: unknown = "UNSET";
		client.pendingRequests.set(2, {
			resolve: (v: unknown) => {
				resolvedWith = v;
			},
			reject: () => {},
		} as never);
		await routeMessage(client, { jsonrpc: "2.0", id: 2, result: { ok: true } } as never);
		await flush();
		expect(resolvedWith).toEqual({ ok: true });
		expect(client.pendingRequests.has(2)).toBe(false);
	});
});

describe("routeMessage server request with string id (#24)", () => {
	it("answers a workspace/configuration request that uses a string id", async () => {
		const { client, writes } = makeClient();
		await routeMessage(client, {
			jsonrpc: "2.0",
			id: "req-1",
			method: "workspace/configuration",
			params: { items: [{ section: "foo" }] },
		} as never);
		await flush();
		const reply = writes.find((w) => w.id === "req-1");
		expect(reply).toBeDefined();
		expect(Array.isArray(reply?.result)).toBe(true);
	});
});

describe("$/progress premature projectLoaded resolution (#8)", () => {
	it("ignores a spurious 'end' for a token that never began", async () => {
		const { client, resolvedProjectLoaded } = makeClient();
		await routeMessage(client, {
			jsonrpc: "2.0",
			method: "$/progress",
			params: { token: "ghost", value: { kind: "end" } },
		} as never);
		expect(resolvedProjectLoaded()).toBe(false);
	});

	it("resolves only after a genuinely-tracked token ends", async () => {
		const { client, resolvedProjectLoaded } = makeClient();
		await routeMessage(client, {
			jsonrpc: "2.0",
			method: "$/progress",
			params: { token: "idx", value: { kind: "begin" } },
		} as never);
		expect(resolvedProjectLoaded()).toBe(false);
		await routeMessage(client, {
			jsonrpc: "2.0",
			method: "$/progress",
			params: { token: "idx", value: { kind: "end" } },
		} as never);
		expect(resolvedProjectLoaded()).toBe(true);
	});
});
