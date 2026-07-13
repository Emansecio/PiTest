import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type ChromeDevtoolsManager,
	setCurrentChromeDevtoolsManager,
} from "../src/core/chrome/chrome-devtools-manager.js";
import { allToolNames, createToolDefinition } from "../src/core/tools/index.js";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((item) => item.text ?? "").join("");
}

let dir: string;
const servers: Array<ReturnType<typeof createServer>> = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pit-security-tools-"));
});
afterEach(async () => {
	setCurrentChromeDevtoolsManager(undefined);
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
	rmSync(dir, { recursive: true, force: true });
});

describe("native lazy security tools", () => {
	it("registers all five built-ins", () => {
		for (const name of [
			"security_surface_map",
			"security_static_scan",
			"security_http_replay_diff",
			"security_validate_finding",
			"security_evidence",
		] as const) {
			expect(allToolNames.has(name)).toBe(true);
			expect(createToolDefinition(name, dir).name).toBe(name);
		}
	});

	it("executes OpenAPI mapping, ast-grep scanning, validation, and evidence through adapters", async () => {
		const surface = createToolDefinition("security_surface_map", dir);
		const surfaceResult = await surface.execute(
			"surface",
			{
				content: JSON.stringify({
					openapi: "3.0.3",
					info: { title: "API", version: "1" },
					paths: { "/ping": { get: { responses: { 200: { description: "ok" } } } } },
				}),
			},
			undefined,
			undefined,
			{} as never,
		);
		expect(textOf(surfaceResult)).toContain('"path": "/ping"');

		writeFileSync(join(dir, "target.ts"), "export const run = (input: string) => eval(input);\n");
		const scan = createToolDefinition("security_static_scan", dir);
		const scanResult = await scan.execute("scan", { path: dir, language: "ts" }, undefined, undefined, {} as never);
		expect(textOf(scanResult)).toContain('"state": "candidate"');

		const validate = createToolDefinition("security_validate_finding", dir);
		const validation = await validate.execute(
			"validate",
			{
				currentState: "reproduced",
				marker: { value: "marker-123", baselineBody: "a", controlBody: "a", mutationBody: "marker-123" },
				bodies: { baseline: "a", control: "a", mutation: "marker-123" },
				reproduction: { attempts: [true, true] },
			},
			undefined,
			undefined,
			{} as never,
		);
		expect(textOf(validation)).toContain('"nextState": "validated"');

		const evidence = createToolDefinition("security_evidence", dir, { security: { agentDir: join(dir, "agent") } });
		await evidence.execute(
			"append",
			{
				action: "append_finding",
				findingId: "finding-1",
				state: "candidate",
				summary: "sink",
				source: "security_static_scan",
			},
			undefined,
			undefined,
			{} as never,
		);
		const listed = await evidence.execute("list", { action: "list" }, undefined, undefined, {} as never);
		expect(textOf(listed)).toContain('"findingId": "finding-1"');
	});

	it("executes HTTP replay/diff through the native adapter", async () => {
		const server = createServer((request, response) => {
			const arm = new URL(request.url ?? "/", "http://local").searchParams.get("arm");
			response.end(arm === "mutation" ? "proof-marker" : "normal");
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("server did not bind");
		const base = `http://127.0.0.1:${address.port}`;
		const replay = createToolDefinition("security_http_replay_diff", dir);
		const result = await replay.execute(
			"replay",
			{
				baseline: { url: `${base}/?arm=baseline` },
				control: { url: `${base}/?arm=control` },
				mutation: { url: `${base}/?arm=mutation` },
			},
			undefined,
			undefined,
			{} as never,
		);
		expect(textOf(result)).toContain('"bodyChanged": true');
	});

	it("replays a captured Chrome XHR as baseline, control, and mutation", async () => {
		const replayCapturedXhr = vi.fn(async (_requestId, _hop, patch) => ({
			entryId: `replay#${replayCapturedXhr.mock.calls.length}`,
			requestId: `replay-${replayCapturedXhr.mock.calls.length}`,
			hop: 0,
			method: "POST",
			url: "https://a.test/api",
			resourceType: "XHR",
			status: 200,
			responseHeaders: { "Content-Type": "application/json" },
			responseBody: patch?.headers?.["X-Test-Arm"] === "mutation" ? "proof-marker" : "normal",
			durationMs: 10,
		}));
		const getNetworkEntry = vi.fn(() => ({
			entryId: "original#0",
			requestId: "original",
			hop: 0,
			method: "POST",
			url: "https://a.test/api",
			resourceType: "XHR",
		}));
		setCurrentChromeDevtoolsManager({ replayCapturedXhr, getNetworkEntry } as unknown as ChromeDevtoolsManager);

		const replay = createToolDefinition("security_http_replay_diff", dir);
		const result = await replay.execute(
			"replay-browser",
			{
				source: "chrome",
				requestId: "original",
				control: { headers: { "X-Test-Arm": "control" } },
				mutation: {
					headers: { "X-Test-Arm": "mutation", Authorization: "Bearer browser-secret" },
				},
			},
			undefined,
			undefined,
			{} as never,
		);

		expect(replayCapturedXhr).toHaveBeenCalledTimes(3);
		expect(textOf(result)).toContain('"bodyChanged": true');
		expect(textOf(result)).not.toContain("browser-secret");
	});
});
