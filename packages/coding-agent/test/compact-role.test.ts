import type { ThinkingLevel } from "@pit/agent-core";
import { type Api, type Model, streamSimple } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { CompactionController, resolveCompactModel } from "../src/core/agent-session-compaction.js";
import { resolveRole } from "../src/core/model-resolver.js";
import type { ModelRoleSettings } from "../src/core/settings-manager.js";

// Two mock models: a "session" opus and a "compact" haiku (cheaper/faster).
const sessionModel: Model<"anthropic-messages"> = {
	id: "claude-opus-4-8",
	name: "Claude Opus 4.8",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
	contextWindow: 200000,
	maxTokens: 8192,
};
const compactModel: Model<"anthropic-messages"> = {
	id: "claude-haiku-4-5",
	name: "Claude Haiku 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
	contextWindow: 200000,
	maxTokens: 8192,
};
const availableModels: Model<Api>[] = [sessionModel, compactModel];

function roleSettings(compact?: { model: string; thinkingLevel?: ThinkingLevel }): ModelRoleSettings {
	return compact ? { modelRoles: { compact } } : { modelRoles: {} };
}

describe("resolveRole — compact role", () => {
	it("resolves the configured compact model + thinking level", () => {
		const resolved = resolveRole({
			role: "compact",
			availableModels,
			settings: roleSettings({ model: "anthropic/claude-haiku-4-5", thinkingLevel: "low" }),
			cwd: "/repo",
		});
		expect(resolved).toBeDefined();
		expect(resolved!.model.id).toBe("claude-haiku-4-5");
		expect(resolved!.thinkingLevel).toBe("low");
	});

	it("returns undefined when no compact role is configured", () => {
		const resolved = resolveRole({
			role: "compact",
			availableModels,
			settings: roleSettings(),
			cwd: "/repo",
		});
		expect(resolved).toBeUndefined();
	});

	it("returns undefined when the configured pattern matches no model", () => {
		const resolved = resolveRole({
			role: "compact",
			availableModels,
			settings: roleSettings({ model: "anthropic/no-such-model" }),
			cwd: "/repo",
		});
		expect(resolved).toBeUndefined();
	});
});

describe("resolveCompactModel — fail-open routing", () => {
	function makeCtx(opts: {
		roleSettings: ModelRoleSettings;
		getApiKeyAndHeaders?: (
			m: Model<any>,
		) => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string> }>;
	}): CompactionController {
		const host = {
			cwd: "/repo",
			settingsManager: { getModelRoleSettings: () => opts.roleSettings },
			modelRegistry: {
				getAll: () => availableModels,
				getApiKeyAndHeaders:
					opts.getApiKeyAndHeaders ??
					(async (m: Model<any>) => ({ ok: true, apiKey: `key-${m.id}`, headers: { "x-model": m.id } })),
			},
			agent: { streamFn: streamSimple },
			getCompactionRequestAuth: async (m: Model<any>) => ({ apiKey: `key-${m.id}`, headers: { "x-model": m.id } }),
		};
		return new CompactionController(host as unknown as CompactionController["host"]);
	}

	const sessionAuth = { apiKey: "key-session", headers: { "x-model": "session" } };
	const sessionThinking: ThinkingLevel = "high";

	it("routes to the compact model when the role is configured and auth resolves", async () => {
		const ctx = makeCtx({
			roleSettings: roleSettings({ model: "anthropic/claude-haiku-4-5", thinkingLevel: "low" }),
		});
		const result = await resolveCompactModel(ctx, sessionModel, sessionAuth, sessionThinking);
		expect(result.model.id).toBe("claude-haiku-4-5");
		expect(result.apiKey).toBe("key-claude-haiku-4-5");
		expect(result.thinkingLevel).toBe("low");
	});

	it("falls back to the session model when no compact role is configured", async () => {
		const ctx = makeCtx({ roleSettings: roleSettings() });
		const result = await resolveCompactModel(ctx, sessionModel, sessionAuth, sessionThinking);
		expect(result.model.id).toBe("claude-opus-4-8");
		expect(result.apiKey).toBe("key-session");
		expect(result.thinkingLevel).toBe("high");
	});

	it("falls back to the session model when the compact role resolves to nothing", async () => {
		const ctx = makeCtx({ roleSettings: roleSettings({ model: "anthropic/no-such-model" }) });
		const result = await resolveCompactModel(ctx, sessionModel, sessionAuth, sessionThinking);
		expect(result.model.id).toBe("claude-opus-4-8");
		expect(result.apiKey).toBe("key-session");
	});

	it("fails open to the session model when the compact model auth is missing", async () => {
		const ctx = makeCtx({
			roleSettings: roleSettings({ model: "anthropic/claude-haiku-4-5" }),
			getApiKeyAndHeaders: async () => ({ ok: false }),
		});
		const result = await resolveCompactModel(ctx, sessionModel, sessionAuth, sessionThinking);
		expect(result.model.id).toBe("claude-opus-4-8");
		expect(result.apiKey).toBe("key-session");
	});

	it("uses the session thinking level when falling back", async () => {
		const ctx = makeCtx({ roleSettings: roleSettings() });
		const result = await resolveCompactModel(ctx, sessionModel, sessionAuth, "medium");
		expect(result.thinkingLevel).toBe("medium");
	});
});
