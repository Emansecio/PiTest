/**
 * core/wire-context.ts — the shared wire prefix + cache-retention resolution.
 *
 * PURE: no API key, no real AgentSession, no network. This layer used to be
 * copied into cache-keepalive.ts, agent-session-compaction.ts and
 * agent-session-fusion.ts, and its only compaction-side coverage sat behind
 * `describe.skipIf(!API_KEY)` — so without a key it had none. Everything here
 * must keep running with no credentials of any kind.
 */

import type { Context, Model } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildWireContext,
	effectiveWireRetention,
	modelHasShortCacheRetention,
	type WireContextAgent,
} from "../src/core/wire-context.ts";

function fakeModel(provider: string, compat?: { supportsLongCacheRetention?: boolean }): Model<any> {
	return { id: `${provider}-test`, provider, ...(compat ? { compat } : {}) } as unknown as Model<any>;
}

// ============================================================================
// modelHasShortCacheRetention
// ============================================================================

describe("modelHasShortCacheRetention", () => {
	const baseModel = fakeModel("anthropic");

	it("is false (long retention, the default) when compat is unset", () => {
		expect(modelHasShortCacheRetention(baseModel)).toBe(false);
	});

	it("is false when compat explicitly enables long retention", () => {
		expect(modelHasShortCacheRetention(fakeModel("anthropic", { supportsLongCacheRetention: true }))).toBe(false);
	});

	it("is true only when compat explicitly disables long retention", () => {
		expect(modelHasShortCacheRetention(fakeModel("anthropic", { supportsLongCacheRetention: false }))).toBe(true);
	});
});

// ============================================================================
// effectiveWireRetention
// ============================================================================

describe("effectiveWireRetention", () => {
	const anthropic = fakeModel("anthropic");
	const anthropicShortOnly = fakeModel("anthropic", { supportsLongCacheRetention: false });
	const originalEnv = process.env.PIT_CACHE_RETENTION;

	beforeEach(() => {
		delete process.env.PIT_CACHE_RETENTION;
	});
	afterEach(() => {
		if (originalEnv === undefined) delete process.env.PIT_CACHE_RETENTION;
		else process.env.PIT_CACHE_RETENTION = originalEnv;
	});

	it("defaults to 'long' for an Anthropic model with no session option", () => {
		expect(effectiveWireRetention(anthropic, undefined)).toBe("long");
	});

	it("honors an explicit session 'short'", () => {
		expect(effectiveWireRetention(anthropic, "short")).toBe("short");
	});

	it("is 'none' when the session option resolves to 'none'", () => {
		expect(effectiveWireRetention(anthropic, "none")).toBe("none");
	});

	it("demotes 'long' → 'short' when the model lacks long-retention support", () => {
		expect(effectiveWireRetention(anthropicShortOnly, "long")).toBe("short");
		// …and the same demotion applies to the implicit "long" default.
		expect(effectiveWireRetention(anthropicShortOnly, undefined)).toBe("short");
	});

	it("is 'none' for any non-Anthropic model regardless of the session option", () => {
		expect(effectiveWireRetention(fakeModel("openai"), "long")).toBe("none");
		expect(effectiveWireRetention(fakeModel("google"), "short")).toBe("none");
	});

	it("is 'none' when no model is selected yet", () => {
		expect(effectiveWireRetention(undefined, "long")).toBe("none");
	});

	it("lets PIT_CACHE_RETENTION outrank the session option (env-first)", () => {
		process.env.PIT_CACHE_RETENTION = "short";
		expect(effectiveWireRetention(anthropic, "long")).toBe("short");
		process.env.PIT_CACHE_RETENTION = "none";
		expect(effectiveWireRetention(anthropic, "long")).toBe("none");
		process.env.PIT_CACHE_RETENTION = "long";
		expect(effectiveWireRetention(anthropic, "short")).toBe("long");
	});

	it("ignores a garbage PIT_CACHE_RETENTION and falls back to the session option", () => {
		process.env.PIT_CACHE_RETENTION = "forever";
		expect(effectiveWireRetention(anthropic, "short")).toBe("short");
		expect(effectiveWireRetention(anthropic, undefined)).toBe("long");
	});

	it("env 'long' still demotes to 'short' on a model without long-retention support", () => {
		process.env.PIT_CACHE_RETENTION = "long";
		expect(effectiveWireRetention(anthropicShortOnly, "short")).toBe("short");
	});
});

// ============================================================================
// buildWireContext
// ============================================================================

const SYSTEM_PROMPT = "SESSION SYSTEM PROMPT";

/** Tool whose description has a second line and a nested per-field description — both dropped by the wire economy. */
function fakeTools(): NonNullable<Context["tools"]> {
	return [
		{
			name: "read",
			description: "Read a file\nlong prose that must never reach the wire",
			parameters: {
				type: "object",
				properties: { path: { type: "string", description: "absolute path" } },
			},
		},
	] as NonNullable<Context["tools"]>;
}

interface FakeAgent {
	/** The value under test — the narrow surface buildWireContext actually consumes. */
	agent: WireContextAgent;
	/** The live tools array the wire prefix must ship BY REFERENCE. */
	tools: NonNullable<Context["tools"]>;
	setTools(tools: NonNullable<Context["tools"]>): void;
	convertCalls(): number;
}

function fakeAgent(convertToLlm?: (messages: unknown[]) => unknown): FakeAgent {
	let convertCalls = 0;
	const state = {
		systemPrompt: SYSTEM_PROMPT,
		// App-space messages; convertToLlm below maps them to their wire shape.
		messages: [{ role: "user", content: "app-space message", timestamp: 1 }],
		tools: fakeTools(),
	};
	const agent = {
		state,
		convertToLlm:
			convertToLlm ??
			((messages: unknown[]) => {
				convertCalls++;
				return messages.map(() => ({
					role: "user",
					content: [{ type: "text", text: "wire-space message" }],
					timestamp: 1,
				}));
			}),
	};
	return {
		agent: agent as unknown as WireContextAgent,
		get tools() {
			return state.tools;
		},
		setTools: (tools) => {
			state.tools = tools;
		},
		convertCalls: () => convertCalls,
	};
}

describe("buildWireContext", () => {
	const originalEnv = process.env.PIT_NO_LAZY_TOOL_SCHEMAS;

	beforeEach(() => {
		delete process.env.PIT_NO_LAZY_TOOL_SCHEMAS;
	});
	afterEach(() => {
		if (originalEnv === undefined) delete process.env.PIT_NO_LAZY_TOOL_SCHEMAS;
		else process.env.PIT_NO_LAZY_TOOL_SCHEMAS = originalEnv;
	});

	it("assembles system prompt + convertToLlm(messages) + tools", async () => {
		const fake = fakeAgent();
		const context = await buildWireContext(fake.agent);

		expect(context.systemPrompt).toBe(SYSTEM_PROMPT);
		expect(fake.convertCalls()).toBe(1);
		// The messages are the CONVERTED ones, not agent.state.messages verbatim.
		expect(context.messages).toHaveLength(1);
		expect(JSON.stringify(context.messages)).toContain("wire-space message");
		expect(JSON.stringify(context.messages)).not.toContain("app-space message");
	});

	it("applies the lazy tool economy by default (first-line description, no nested descriptions)", async () => {
		const fake = fakeAgent();
		const context = await buildWireContext(fake.agent);

		expect(context.tools).not.toBe(fake.tools);
		const tool = context.tools?.[0];
		expect(tool?.name).toBe("read");
		expect(tool?.description).toBe("Read a file");
		const params = tool?.parameters as { properties: { path: Record<string, unknown> } };
		expect(params.properties.path.description).toBeUndefined();
		expect(params.properties.path.type).toBe("string");
		// The source tools are never mutated in place.
		expect(fake.tools[0]?.description).toContain("long prose");
	});

	it("PIT_NO_LAZY_TOOL_SCHEMAS ships the tools block untouched (same array reference)", async () => {
		process.env.PIT_NO_LAZY_TOOL_SCHEMAS = "1";
		const fake = fakeAgent();
		const context = await buildWireContext(fake.agent);

		expect(context.tools).toBe(fake.tools);
		expect(context.tools?.[0]?.description).toContain("long prose");
		const params = context.tools?.[0]?.parameters as { properties: { path: Record<string, unknown> } };
		expect(params.properties.path.description).toBe("absolute path");
	});

	it("returns the SAME compacted tools object across calls while fake.tools is unchanged (prefix identity)", async () => {
		const fake = fakeAgent();
		const first = await buildWireContext(fake.agent);
		const second = await buildWireContext(fake.agent);

		// This reference identity is what makes the prompt cache hit: the ping /
		// compaction / writer calls must ship the very tools block a real turn does.
		expect(second.tools).toBe(first.tools);
	});

	it("runs the shaper BEFORE the tool economy, so a shaped context still gets compacted tools", async () => {
		const fake = fakeAgent();
		const shaper = vi.fn(
			(prefix: Context): Context => ({
				systemPrompt: prefix.systemPrompt,
				tools: prefix.tools,
				messages: [
					...prefix.messages,
					{ role: "user", content: "trailing writer block", timestamp: 2 },
				] as Context["messages"],
			}),
		);

		const context = await buildWireContext(fake.agent, shaper);

		expect(shaper).toHaveBeenCalledTimes(1);
		// The shaper saw the UNCOMPACTED prefix (same tools ref as agent.state).
		expect(shaper.mock.calls[0]?.[0].tools).toBe(fake.tools);
		// The result carries the shaper's extra message AND compacted tools.
		expect(context.messages).toHaveLength(2);
		expect(JSON.stringify(context.messages)).toContain("trailing writer block");
		expect(context.tools?.[0]?.description).toBe("Read a file");
	});

	it("shaper output is left untouched under PIT_NO_LAZY_TOOL_SCHEMAS", async () => {
		process.env.PIT_NO_LAZY_TOOL_SCHEMAS = "1";
		const fake = fakeAgent();
		const context = await buildWireContext(fake.agent, (prefix) => ({
			...prefix,
			systemPrompt: "SHAPED",
		}));

		expect(context.systemPrompt).toBe("SHAPED");
		expect(context.tools).toBe(fake.tools);
	});

	it("awaits an async convertToLlm", async () => {
		const fake = fakeAgent(async () => [
			{ role: "user", content: [{ type: "text", text: "async-converted" }], timestamp: 1 },
		]);
		const context = await buildWireContext(fake.agent);
		expect(JSON.stringify(context.messages)).toContain("async-converted");
	});

	it("tolerates a session with no tools (empty block stays empty)", async () => {
		const fake = fakeAgent();
		fake.setTools([] as unknown as NonNullable<Context["tools"]>);
		const context = await buildWireContext(fake.agent);
		expect(context.tools).toEqual([]);
		expect(context.systemPrompt).toBe(SYSTEM_PROMPT);
	});
});
