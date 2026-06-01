/**
 * Built-in MCP extension.
 *
 * On startup, connects to every server in `Settings.mcp.servers` (in parallel),
 * registers each advertised tool as a Pi `ToolDefinition`, and exposes a
 * `/mcp` slash command that prints connection state.
 */

import type { ExtensionAPI } from "../extensions/types.ts";
import { McpManager, type McpSettings, wrapMcpToolAsDefinition } from "../mcp/index.ts";
import { getCurrentToolDiscoveryIndex } from "../tool-discovery.ts";

/**
 * Spike flag (env `PIT_DEFER_MCP=1`): defer MCP tool schemas off the default
 * tool surface. Instead of registering every advertised MCP tool as an active
 * `ToolDefinition` (whose full JSON Schema is sent to the model every turn),
 * register it into the hidden tool-discovery index. The model pulls a tool in
 * on demand via `search_tool_bm25`; activation is reconciled into the active
 * surface by the session. Mirrors Factory's "deferred context engine":
 * discovery (compact index) is separated from execution (full schema on use).
 *
 * Default off — when unset the original eager registration is unchanged.
 */
function deferMcpEnabled(): boolean {
	return process.env.PIT_DEFER_MCP === "1";
}

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
			await manager.connectAll();
			const defer = deferMcpEnabled();
			const index = defer ? getCurrentToolDiscoveryIndex() : undefined;
			let deferredCount = 0;
			for (const { prefixedName, schema } of manager.listTools()) {
				try {
					const definition = wrapMcpToolAsDefinition(manager, prefixedName, schema);
					if (index) {
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
			// so the model can actually find them. (It is registered but inactive by
			// default.) No-op when nothing was deferred.
			if (index && deferredCount > 0) {
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
