import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { complete } from "../src/stream.js";
import type { Api, Context, Model, StreamOptions } from "../src/types.js";
import { live } from "./live.js";
import { resolveApiKey } from "./oauth.js";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

const oauthTokens = await Promise.all([resolveApiKey("openai-codex")]);
const [openaiCodexToken] = oauthTokens;

async function expectResponseId<TApi extends Api>(model: Model<TApi>, options: StreamOptionsWithExtras = {}) {
	const context: Context = {
		systemPrompt: "You are a helpful assistant. Be concise.",
		messages: [{ role: "user", content: "Reply with exactly: response id test", timestamp: Date.now() }],
	};

	const response = await complete(model, context, options);

	expect(response.stopReason, response.errorMessage).not.toBe("error");
	expect(response.responseId).toBeTruthy();
	expect(typeof response.responseId).toBe("string");
}

describe("responseId E2E Tests", () => {
	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider", () => {
		const llm = getModel("anthropic", "claude-sonnet-5");

		it("should expose responseId", { retry: 3, timeout: 30000 }, async () => {
			await expectResponseId(llm);
		});
	});

	describe("OpenAI Codex Provider", () => {
		it.skipIf(!openaiCodexToken)(
			"should expose responseId",
			{ retry: 3, timeout: 30000 },
			live("openai-codex", async () => {
				const llm = getModel("openai-codex", "gpt-5.5");
				await expectResponseId(llm, { apiKey: openaiCodexToken });
			}),
		);
	});
});
