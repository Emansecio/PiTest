import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { stream } from "../src/stream.js";
import type { Api, Context, Model, StreamOptions } from "../src/types.js";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { resolveApiKey } from "./oauth.js";

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([resolveApiKey("anthropic"), resolveApiKey("openai-codex")]);
const [anthropicOAuthToken, openaiCodexToken] = oauthTokens;

async function testTokensOnAbort<TApi extends Api>(llm: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "Write a long poem with 20 stanzas about the beauty of nature.",
				timestamp: Date.now(),
			},
		],
		systemPrompt: "You are a helpful assistant.",
	};

	const controller = new AbortController();
	const response = stream(llm, context, { ...options, signal: controller.signal });

	let abortFired = false;
	let text = "";
	for await (const event of response) {
		if (!abortFired && (event.type === "text_delta" || event.type === "thinking_delta")) {
			text += event.delta;
			if (text.length >= 1000) {
				abortFired = true;
				controller.abort();
			}
		}
	}

	const msg = await response.result();

	expect(msg.stopReason).toBe("aborted");

	// OpenAI providers, OpenAI Codex, and Amazon Bedrock only send usage in the final chunk,
	// so when aborted they have no token stats. Anthropic and Google send usage information early in the stream.
	// MiniMax and Kimi report input tokens but not output tokens differently on aborted requests.
	if (
		llm.api === "openai-completions" ||
		llm.api === "mistral-conversations" ||
		llm.api === "openai-responses" ||
		llm.api === "azure-openai-responses" ||
		llm.api === "openai-codex-responses" ||
		llm.provider === "amazon-bedrock"
	) {
		expect(msg.usage.input).toBe(0);
		expect(msg.usage.output).toBe(0);
	} else if (llm.provider === "minimax") {
		// MiniMax M2.7 does not report token usage for aborted requests.
		expect(msg.usage.input).toBe(0);
		expect(msg.usage.output).toBe(0);
	} else if (llm.provider === "kimi-coding") {
		// Kimi reports input tokens early but output tokens only in the final chunk.
		expect(msg.usage.input).toBeGreaterThan(0);
		expect(msg.usage.output).toBe(0);
	} else {
		expect(msg.usage.input).toBeGreaterThan(0);
		expect(msg.usage.output).toBeGreaterThan(0);

		// Some providers (Copilot) have zero cost rates
		if (llm.cost.input > 0) {
			expect(msg.usage.cost.input).toBeGreaterThan(0);
			expect(msg.usage.cost.total).toBeGreaterThan(0);
		}
	}
}

describe("Token Statistics on Abort", () => {
	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider", () => {
		const llm = getModel("google", "gemini-2.5-flash");

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm, { thinking: { enabled: true } });
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		void _compat;
		const llm: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
		};

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider", () => {
		const llm = getModel("openai", "gpt-5.4-mini");

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm, { reasoningEffort: "low" });
		});
	});

	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider", () => {
		const llm = getModel("anthropic", "claude-sonnet-4-6");

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!process.env.MINIMAX_API_KEY)("MiniMax Provider", () => {
		const llm = getModel("minimax", "MiniMax-M2.7");

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!process.env.KIMI_API_KEY)("Kimi For Coding Provider", () => {
		const llm = getModel("kimi-coding", "kimi-for-coding");

		it("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	describe.skipIf(!process.env.XIAOMI_API_KEY)("Xiaomi MiMo (API billing) Provider", () => {
		const llm = getModel("xiaomi", "mimo-v2.5-pro");

		// FIXME(xiaomi): Xiaomi's Anthropic-compatible stream does not populate
		// usage in the message_start event the way Anthropic does — usage only
		// arrives at message_stop. Aborting mid-stream therefore loses input/output
		// token counts. Non-streaming usage works (see total-tokens.test.ts).
		// Re-enable once upstream sends usage in message_start.
		it.skip("should include token stats when aborted mid-stream", { retry: 3, timeout: 30000 }, async () => {
			await testTokensOnAbort(llm);
		});
	});

	// =========================================================================
	// OAuth-based providers (credentials from ~/.pit/agent/oauth.json)
	// =========================================================================

	describe("Anthropic OAuth Provider", () => {
		const llm = getModel("anthropic", "claude-sonnet-4-6");

		it.skipIf(!anthropicOAuthToken)(
			"should include token stats when aborted mid-stream",
			{ retry: 3, timeout: 30000 },
			async () => {
				await testTokensOnAbort(llm, { apiKey: anthropicOAuthToken });
			},
		);
	});

	describe("OpenAI Codex Provider", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.5 - should include token stats when aborted mid-stream",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.5");
				await testTokensOnAbort(llm, { apiKey: openaiCodexToken });
			},
		);
	});
});
