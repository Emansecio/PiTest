/**
 * Built-in MCP extension.
 *
 * On startup, connects to every server in `Settings.mcp.servers` (in parallel),
 * registers each advertised tool as a Pi `ToolDefinition` — eagerly onto the
 * active surface for small servers, or deferred into the tool-discovery index
 * for grab-bag servers (see `mcp.defer`) — and exposes a `/mcp` slash command
 * that prints connection state.
 */

import type { ExtensionAPI } from "../extensions/types.ts";
import { McpManager, type McpServerConfig, type McpSettings, wrapMcpToolAsDefinition } from "../mcp/index.ts";
import { getCurrentToolDiscoveryIndex } from "../tool-discovery.ts";

/** Default tool-count threshold for `mcp.defer: "auto"` — a server advertising at least this many tools is deferred. */
const DEFAULT_DEFER_THRESHOLD = 10;

/**
 * Decide whether a server's MCP tools should be deferred off the active surface
 * (registered into the tool-discovery index and pulled in on demand via
 * `search_tool_bm25`) instead of registered eagerly (full JSON Schema re-sent to
 * the model every turn). Deferral is what keeps a grab-bag server (Notion/Chrome/
 * Desktop Commander, 17-25+ tools) from permanently bloating the prompt and
 * churning the cache prefix; small focused servers stay eager so they are
 * immediately callable without a discovery round-trip.
 *
 * Precedence: per-server `defer` override → legacy env `PIT_DEFER_MCP=1` (forces
 * always) → global `mcp.defer` policy (default `"auto"`: defer only servers with
 * at least `deferThreshold` tools).
 *
 * Exported for unit testing the policy in isolation.
 */
export function shouldDeferMcpServer(
	toolCount: number,
	serverConfig: McpServerConfig | undefined,
	settings: McpSettings,
): boolean {
	if (serverConfig?.defer !== undefined) return serverConfig.defer;
	if (process.env.PIT_DEFER_MCP === "1") return true;
	const mode = settings.defer ?? "auto";
	if (mode === "always") return true;
	if (mode === "never") return false;
	const threshold = settings.deferThreshold ?? DEFAULT_DEFER_THRESHOLD;
	return toolCount >= threshold;
}

// Global budget for the session_start connect pass. The ExtensionRunner awaits
// session_start handlers, so without a budget a single hung server (TCP accept,
// no response) stalls the whole boot for the full per-call timeouts (~55s in
// series). Servers that come up later are covered by callTool's lazy reconnect.
const CONNECT_ALL_BUDGET_MS = 10_000;

export interface McpExtensionOptions {
	settings: McpSettings;
	/** Called when a server's connection state changes (for status indicators). */
	onStateChange?: (state: { name: string; connected: boolean; lastError?: string }) => void;
}

export function createMcpExtension(options: McpExtensionOptions) {
	return (pi: ExtensionAPI) => {
		const servers = options.settings.servers ?? {};
		if (Object.keys(servers).length === 0) {
			return; // No MCP servers configured.
		}

		const manager = new McpManager({
			servers,
			onStateChange: options.onStateChange,
		});

		// Connect on session_start so we capture failures into status diagnostics.
		// In dry-run mode we skip the network round-trip entirely — the dry-run
		// report still inspects settings.mcp.servers from settings, so the user
		// sees what is configured without paying the connect-timeout cost when
		// a server is unreachable.
		pi.on("session_start", async () => {
			if (process.env.PIT_DRY_RUN === "1") {
				return;
			}
			await manager.connectAll(AbortSignal.timeout(CONNECT_ALL_BUDGET_MS));
			const allTools = manager.listTools();
			// Per-server tool counts drive the "auto" deferral decision.
			const toolCountByServer = new Map<string, number>();
			for (const { serverName } of allTools) {
				toolCountByServer.set(serverName, (toolCountByServer.get(serverName) ?? 0) + 1);
			}
			// Deferral needs the discovery index (it's where hidden tools live and
			// what search_tool_bm25 ranks over). When tool discovery is disabled the
			// index is undefined and every tool stays eager — there is nowhere to hide.
			const index = getCurrentToolDiscoveryIndex();
			const deferByServer = new Map<string, boolean>();
			for (const [serverName, count] of toolCountByServer) {
				deferByServer.set(
					serverName,
					index !== undefined && shouldDeferMcpServer(count, servers[serverName], options.settings),
				);
			}
			let deferredCount = 0;
			for (const { serverName, prefixedName, schema } of allTools) {
				try {
					const definition = wrapMcpToolAsDefinition(manager, prefixedName, schema);
					if (index && deferByServer.get(serverName)) {
						// Deferred: keep the full schema OFF the active surface; the model
						// finds it via search_tool_bm25 and the session activates it.
						index.register({
							name: definition.name,
							description: typeof definition.description === "string" ? definition.description : "",
							promptSnippet: typeof definition.promptSnippet === "string" ? definition.promptSnippet : undefined,
							definition,
						});
						deferredCount++;
					} else {
						pi.registerTool(definition);
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					console.error(`[mcp] failed to register ${prefixedName}: ${message}`);
				}
			}
			// With tools deferred, the discovery tool must be on the active surface
			// so the model can actually find them. (It is registered but may be
			// inactive when tool discovery is otherwise off.) No-op when nothing was
			// deferred or when search_tool_bm25 is already active.
			if (deferredCount > 0) {
				const active = pi.getActiveTools();
				if (!active.includes("search_tool_bm25")) {
					pi.setActiveTools([...active, "search_tool_bm25"]);
				}
			}
		});

		pi.on("session_shutdown", () => {
			manager.dispose();
		});

		pi.registerCommand("mcp", {
			description: "List configured MCP servers and their connection state.",
			async handler(_args, ctx) {
				const states = manager.getAllStates();
				if (states.length === 0) {
					const msg = "No MCP servers configured.";
					if (ctx.hasUI) ctx.ui.notify(msg, "info");
					else console.log(msg);
					return;
				}
				const lines = states.map(
					(s) =>
						`${s.connected ? "✓" : "✗"} ${s.name} (${s.url})` +
						`${s.lastError ? ` — ${s.lastError}` : ""}` +
						`${s.tools.length > 0 ? `\n    tools: ${s.tools.map((t) => t.name).join(", ")}` : ""}`,
				);
				const out = lines.join("\n");
				if (ctx.hasUI) ctx.ui.notify(out, "info");
				else console.log(out);
			},
		});
	};
}
