import { getModel } from "@pit/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamProxy } from "../src/proxy.js";

const mockModel = getModel("anthropic", "claude-haiku-4-5");

function hangingBodyStream(onCancel: () => void): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>({
		pull() {
			// Never settle — frozen body after a 200 OK.
			return new Promise(() => {});
		},
		cancel() {
			onCancel();
		},
	});
}

describe("streamProxy idle timeout", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("emits a retryable error when the proxy body stalls past idleTimeoutMs", async () => {
		let cancelled = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response(
					hangingBodyStream(() => {
						cancelled = true;
					}),
					{
						status: 200,
						headers: { "Content-Type": "text/event-stream" },
					},
				);
			}),
		);

		const stream = streamProxy(
			mockModel,
			{ systemPrompt: "", messages: [], tools: [] },
			{
				authToken: "tok",
				proxyUrl: "https://proxy.test",
				idleTimeoutMs: 50,
			},
		);

		const start = Date.now();
		const message = await stream.result();
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(5000);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage ?? "").toMatch(/timeout|timed out/i);
		expect(cancelled).toBe(true);
	});
});
