/**
 * Built-in MCP extension.
 *
 * On startup, connects to every server in `Settings.mcp.servers` (in parallel),
 * registers each advertised tool as a Pi `ToolDefinition`, and exposes a
 * `/mcp` slash command that prints connection state.
 */

import type { ExtensionAPI } from "../extensions/types.ts";
import { McpManager, type McpSettings, wrapMcpToolAsDefinition } from "../mcp/index.ts";

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
			if (process.env.PI_DRY_RUN === "1") {
				return;
			}
			await manager.connectAll();
			for (const { prefixedName, schema } of manager.listTools()) {
				try {
					pi.registerTool(wrapMcpToolAsDefinition(manager, prefixedName, schema));
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					console.error(`[mcp] failed to register ${prefixedName}: ${message}`);
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
