import type { AgentMessage } from "@pit/agent-core";
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../../src/core/messages.ts";
import { MESSAGE_RELAY_CUSTOM_TYPE } from "../../src/core/messaging/index.ts";

describe("inter-agent relay (display-only)", () => {
	it("relay custom messages are dropped from the LLM context (model-invisible)", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "the task" }], timestamp: 1 },
			{
				role: "custom",
				customType: MESSAGE_RELAY_CUSTOM_TYPE,
				content: "🗨 `Worker` → `Main`: where is auth?",
				display: true,
				timestamp: 2,
			} as unknown as AgentMessage,
		];
		const llm = convertToLlm(messages);
		expect(llm).toHaveLength(1); // only the user task survives
		const json = JSON.stringify(llm);
		expect(json).toContain("the task");
		expect(json).not.toContain("🗨");
		expect(json).not.toContain("where is auth?");
	});

	it("non-relay custom messages still reach the model", () => {
		const messages: AgentMessage[] = [
			{
				role: "custom",
				customType: "pi.some-other-note",
				content: "a visible note",
				display: false,
				timestamp: 1,
			} as unknown as AgentMessage,
		];
		expect(JSON.stringify(convertToLlm(messages))).toContain("a visible note");
	});
});
