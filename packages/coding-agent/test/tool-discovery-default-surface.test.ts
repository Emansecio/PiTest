/**
 * Regression for the tool-discovery consolidation:
 * - search_tool_bm25 joins the default active surface (gated by toolDiscovery),
 *   so the model can actually discover hidden tools — it was previously in limbo
 *   (active surface never included it, yet it was excluded from the index).
 * - _seedToolDiscovery derives its exclude-set from the single source
 *   `_defaultActiveToolNames`, so already-active tools (grep, lsp, web_search…)
 *   no longer appear redundantly as "hidden"; only opt-in capability tools do.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { getCurrentToolDiscoveryIndex } from "../src/core/tool-discovery.js";
import type { ToolDef } from "../src/core/tools/index.js";

describe("tool discovery default surface", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-discovery-surface-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore Windows handle race */
			}
		}
	});

	async function createDefaultSession() {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory(tempDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		return session;
	}

	it("activates search_tool_bm25 by default so discovery is usable", async () => {
		const session = await createDefaultSession();
		expect(session.getActiveToolNames()).toContain("search_tool_bm25");
		await session.dispose();
	});

	it("hides only opt-in capability tools — never the already-active ones", async () => {
		const session = await createDefaultSession();
		const active = new Set(session.getActiveToolNames());
		const index = getCurrentToolDiscoveryIndex();
		const hidden = new Set((index?.listHidden() ?? []).map((entry) => entry.name));

		// Consolidation invariant: a tool is never both active and hidden.
		for (const name of hidden) {
			expect(active.has(name)).toBe(false);
		}
		// Already-active features must not leak into the discovery index.
		for (const activeName of ["grep", "find", "ls", "lsp", "debug", "web_search", "eval", "search_tool_bm25"]) {
			expect(hidden.has(activeName)).toBe(false);
		}
		// Opt-in capabilities stay discoverable.
		expect(hidden.has("calc")).toBe(true);
		expect(hidden.has("ast_grep")).toBe(true);
		await session.dispose();
	});

	it("drops search_tool_bm25 from the active surface when toolDiscovery is disabled", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ toolDiscovery: { enabled: false } }));
		const session = await createDefaultSession();
		expect(session.getActiveToolNames()).not.toContain("search_tool_bm25");
		await session.dispose();
	});

	it("bakes the discovery nudge into the system prompt from boot (stable cache prefix)", async () => {
		const session = await createDefaultSession();
		// There ARE hidden opt-in tools, so the nudge must be present immediately —
		// in the cacheable prefix at construction, not added on a later rebuild
		// (which would flip the prefix 0→N and re-charge the prompt cache once).
		expect(session.systemPrompt).toContain("not in the active set but can be discovered");
		// A no-op surface rebuild must not churn the cacheable prefix: the nudge's
		// presence is driven by the stable per-session snapshot, not the live index.
		const before = session.getCachePrefixDiagnostics().rebuilds;
		session.setActiveToolsByName([...session.getActiveToolNames()]);
		expect(session.getCachePrefixDiagnostics().rebuilds).toBe(before);
		await session.dispose();
	});

	it("omits the discovery nudge when toolDiscovery is disabled (no hidden tools)", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ toolDiscovery: { enabled: false } }));
		const session = await createDefaultSession();
		expect(session.systemPrompt).not.toContain("not in the active set but can be discovered");
		await session.dispose();
	});

	it("re-syncs the hidden-tool snapshot after late (MCP-style) registration, without churning the prefix", async () => {
		const session = await createDefaultSession();
		const internals = session as unknown as {
			_resyncHiddenToolSnapshot: () => void;
			_hiddenToolCountSnapshot: number;
		};
		const index = getCurrentToolDiscoveryIndex()!;
		// Coding hidden tools already make the nudge present (snapshot > 0).
		expect(internals._hiddenToolCountSnapshot).toBeGreaterThan(0);
		const rebuildsBefore = session.getCachePrefixDiagnostics().rebuilds;
		const snapBefore = internals._hiddenToolCountSnapshot;

		// Simulate the MCP-defer path registering a tool into the index AFTER the
		// constructor snapshot (this is what session_start does), then the re-sync.
		index.register({
			name: "mcp__fake__do_thing",
			description: "fake deferred tool",
			definition: {} as unknown as ToolDef,
		});
		internals._resyncHiddenToolSnapshot();

		// Snapshot reflects the new hidden tool, but the nudge was already present so
		// the cacheable prefix is unchanged — no churn.
		expect(internals._hiddenToolCountSnapshot).toBe(snapBefore + 1);
		expect(session.getCachePrefixDiagnostics().rebuilds).toBe(rebuildsBefore);
		expect(session.systemPrompt).toContain("not in the active set but can be discovered");
		await session.dispose();
	});

	it("re-sync is a no-op when the hidden-tool count is unchanged", async () => {
		const session = await createDefaultSession();
		const internals = session as unknown as {
			_resyncHiddenToolSnapshot: () => void;
			_hiddenToolCountSnapshot: number;
		};
		const rebuildsBefore = session.getCachePrefixDiagnostics().rebuilds;
		const snapBefore = internals._hiddenToolCountSnapshot;
		internals._resyncHiddenToolSnapshot(); // index unchanged since boot
		expect(internals._hiddenToolCountSnapshot).toBe(snapBefore);
		expect(session.getCachePrefixDiagnostics().rebuilds).toBe(rebuildsBefore);
		await session.dispose();
	});
});
