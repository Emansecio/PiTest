/**
 * M14 — Histerese pós-falha: após uma falha transiente (auth/rede) em
 * runAutoCompaction, `lastCompactionDeficit` deve ser zerado para que o próximo
 * turno possa disparar a compactação normalmente, sem a penalidade extra de +8 192
 * tokens que o mecanismo de coalescing imporia.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@pit/agent-core";
import { getModel } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import * as compactionModule from "../src/core/agent-session-compaction.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const mockState = vi.hoisted(() => ({
	compactShouldThrow: true,
}));

vi.mock("../src/core/compaction/index.js", () => ({
	adaptiveKeepRecentTokens: () => undefined,
	calculateContextTokens: (usage: { totalTokens?: number }) => usage.totalTokens ?? 0,
	collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
	compact: async () => {
		if (mockState.compactShouldThrow) throw new Error("ECONNRESET: socket hang up");
		return { summary: "compacted", firstKeptEntryId: "entry-1", tokensBefore: 100, details: {} };
	},
	computeDynamicReserve: (_contextWindow: number, configuredReserve: number) => configuredReserve,
	estimateContextTokens: () => ({ tokens: 0, usageTokens: 0, trailingTokens: 0, lastUsageIndex: null }),
	estimateWireTokens: () => ({
		tokens: 0,
		usageTokens: 0,
		trailingTokens: 0,
		lastUsageIndex: null,
		messageTokens: 0,
		systemTokens: 0,
		toolTokens: 0,
		pendingTokens: 0,
	}),
	generateBranchSummary: async () => ({ summary: "", aborted: false, readFiles: [], modifiedFiles: [] }),
	prepareCompaction: () => ({
		firstKeptEntryId: "entry-1",
		messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 }],
		turnPrefixMessages: [],
	}),
	proactivePruneFloor: () => 0,
	shouldCompact: (
		contextTokens: number,
		contextWindow: number,
		settings: { enabled: boolean; reserveTokens: number },
		lastCompactionDeficit = 0,
	) => {
		if (!settings.enabled || contextWindow <= 0) return false;
		const threshold = contextWindow - settings.reserveTokens;
		if (contextTokens <= threshold) return false;
		const deficit = contextTokens - threshold;
		// Mirror the real coalescing guard (COALESCING_THRESHOLD_TOKENS = 8 192)
		if (lastCompactionDeficit === 0) return true;
		return deficit > lastCompactionDeficit + 8192;
	},
	shouldCompactSoft: () => false,
	sumMessageTokens: () => 0,
}));

function compactionController(session: AgentSession): compactionModule.CompactionController {
	return session.compaction;
}

describe("compaction deficit reset on transient failure (M14)", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pit-deficit-reset-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		mockState.compactShouldThrow = true;

		const model = getModel("anthropic", "claude-sonnet-5")!;
		const agent = new Agent({ initialState: { model, systemPrompt: "Test", tools: [] } });
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(async () => {
		await session.dispose();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true });
			} catch {
				/* ignore Windows handle race */
			}
		}
	});

	it("deve zerar lastCompactionDeficit após falha transiente (rede/auth)", async () => {
		const ctx = compactionController(session);

		// Simula o estado que checkPresendOverflow / checkCompaction deixaria antes
		// de chamar runAutoCompaction quando o contexto está acima do threshold.
		ctx.lastCompactionDeficit = 8192;

		// A compactação falha com erro de rede — deve retornar false mas NÃO manter
		// o déficit positivo.
		const result = await compactionModule.runAutoCompaction(ctx, "threshold", false);

		expect(result).toBe(false);
		expect(ctx.lastCompactionDeficit).toBe(0);
	});

	it("não bloqueia retry subsequente via shouldCompact após falha transiente", async () => {
		const ctx = compactionController(session);

		// Primeiro disparo: falha transiente → déficit zerado
		ctx.lastCompactionDeficit = 8192;
		await compactionModule.runAutoCompaction(ctx, "threshold", false);
		expect(ctx.lastCompactionDeficit).toBe(0);

		// Segundo disparo: agora com déficit = 0, shouldCompact não precisa de margem
		// extra — o mock de shouldCompact retorna true sem a penalidade de +8 192.
		// Aqui verificamos apenas que o déficit continua em 0 mesmo após a segunda
		// falha (não houve acumulação).
		const result2 = await compactionModule.runAutoCompaction(ctx, "threshold", false);
		expect(result2).toBe(false);
		expect(ctx.lastCompactionDeficit).toBe(0);
	});

	it("zera lastCompactionDeficit mesmo quando a falha é diferente de AbortError", async () => {
		const ctx = compactionController(session);
		ctx.lastCompactionDeficit = 4096;

		const events: Array<{ type: string; errorMessage?: string }> = [];
		session.subscribe((event) => {
			if (event.type === "compaction_end") {
				events.push({ type: event.type, errorMessage: (event as { errorMessage?: string }).errorMessage });
			}
		});

		await compactionModule.runAutoCompaction(ctx, "threshold", false);

		// O evento de erro deve ser emitido
		expect(events).toHaveLength(1);
		expect(events[0]!.errorMessage).toContain("ECONNRESET");

		// O déficit deve estar zerado — próxima verificação pode disparar normalmente
		expect(ctx.lastCompactionDeficit).toBe(0);
	});
});
