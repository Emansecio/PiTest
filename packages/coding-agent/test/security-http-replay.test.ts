import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
	compareHttpExperiment,
	type HttpReplaySample,
	replayHttpExperiment,
} from "../src/core/security/http-replay.js";

function sample(arm: HttpReplaySample["arm"], body: string, status = 200, durationMs = 10): HttpReplaySample {
	return {
		arm,
		round: 0,
		status,
		headers: { "content-type": "application/json" },
		body,
		bodyTruncated: false,
		durationMs,
	};
}

describe("deterministic HTTP replay diff", () => {
	it("canonicalizes JSON and does not treat a status-only change as body evidence", () => {
		const comparison = compareHttpExperiment([
			sample("baseline", '{"a":1,"b":2}', 200),
			sample("control", '{"b":2,"a":1}', 200),
			sample("mutation", '{"b":2,"a":1}', 500),
		]);

		expect(comparison.bodyChanged).toBe(false);
		expect(comparison.statusChanged).toBe(true);
		expect(comparison.statusOnly).toBe(true);
		expect(comparison.bodyHashes.baseline).toBe(comparison.bodyHashes.mutation);
	});

	it("detects a semantic mutation body change", () => {
		const comparison = compareHttpExperiment([
			sample("baseline", '{"ok":true}'),
			sample("control", '{"ok":true}'),
			sample("mutation", '{"ok":false,"proof":"marker"}'),
		]);
		expect(comparison.bodyChanged).toBe(true);
		expect(comparison.statusOnly).toBe(false);
	});
});

describe("HTTP replay executor", () => {
	const servers: Array<ReturnType<typeof createServer>> = [];
	afterEach(async () => {
		await Promise.all(
			servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
		);
	});

	it("runs baseline/control/mutation in stable rounds with limits, redaction, and no retry", async () => {
		const order: string[] = [];
		const token = "sk-123456789012345678901234567890";
		const server = createServer((request, response) => {
			const arm = new URL(request.url ?? "/", "http://local").searchParams.get("arm") ?? "unknown";
			order.push(arm);
			response.setHeader("set-cookie", "session=opaque");
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ arm: arm === "mutation" ? arm : "normal", token, padding: "x".repeat(128) }));
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("server did not bind");
		const url = (arm: string) => `http://127.0.0.1:${address.port}/?arm=${arm}`;

		const result = await replayHttpExperiment({
			baseline: { url: url("baseline") },
			control: { url: url("control") },
			mutation: { url: url("mutation"), headers: { Authorization: `Bearer ${token}` } },
			samples: 2,
			maxResponseBytes: 96,
		});

		expect(order).toEqual(["baseline", "control", "mutation", "baseline", "control", "mutation"]);
		expect(result.samples).toHaveLength(6);
		expect(JSON.stringify(result)).not.toContain(token);
		expect(result.samples.every((entry) => entry.bodyTruncated)).toBe(true);
		expect(result.comparison.bodyChanged).toBe(true);
	});
});
