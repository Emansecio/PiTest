/**
 * Built-in MCP extension.
 *
 * On startup, connects to every server in `Settings.mcp.servers` (in parallel),
 * registers each advertised tool as a Pi `ToolDefinition` — eagerly onto the
 * active surface for small servers, or deferred into the tool-discovery index
 * for grab-bag servers (see `mcp.defer`) — and exposes a `/mcp` slash command
 * that prints connection state.
 */

import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import type { ExtensionAPI } from "../extensions/types.ts";
import {
	McpManager,
	type McpServerConfig,
	type McpSettings,
	type McpToolSchema,
	wrapMcpToolAsDefinition,
} from "../mcp/index.ts";
import { getCurrentToolDiscoveryIndex } from "../tool-discovery.ts";

/**
 * Derive BM25 index tags for a deferred MCP tool from its input schema: the
 * parameter names (and any string `description` on each property). The MCP wire
 * schema (`tools.ts` → `wrapMcpToolAsDefinition`) never populates `promptSnippet`
 * or `tags`, so without this a deferred tool is indexed on name+description only
 * — a query phrased after the tool's *arguments* (e.g. "issue id", "channel")
 * would never surface it via search_tool_bm25. Mirrors the built-in seed in
 * agent-session.ts, which feeds promptGuidelines in as tags.
 */
function deriveMcpToolTags(schema: McpToolSchema): string[] {
	const properties = schema.inputSchema?.properties;
	if (!properties || typeof properties !== "object") return [];
	const tags: string[] = [];
	for (const [paramName, propSchema] of Object.entries(properties as Record<string, unknown>)) {
		tags.push(paramName);
		if (propSchema && typeof propSchema === "object") {
			const description = (propSchema as { description?: unknown }).description;
			if (typeof description === "string" && description.length > 0) {
				tags.push(description);
			}
		}
	}
	return tags;
}

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
 * Precedence: per-server `defer` override → legacy env `PIT_DEFER_MCP` truthy (forces
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
	if (isTruthyEnvFlag(process.env.PIT_DEFER_MCP)) return true;
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

		// Prefixed names already registered (eagerly or into the discovery index).
		// Guards the late-registration path against re-registering tools that the
		// boot pass already handled when a server merely re-emits "connected".
		const registeredNames = new Set<string>();

		// Register every not-yet-registered tool advertised by `manager.listTools()`
		// (which already filters to connected servers). Eager tools land on the
		// active surface; deferred tools go into the discovery index. Returns how
		// many tools were newly deferred so the caller can activate search_tool_bm25.
		// Shared by the boot pass and the post-boot reconnect path so a server that
		// blew the connect budget — or dropped and came back — still gets its tools.
		const registerNewTools = (): number => {
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
				if (registeredNames.has(prefixedName)) continue;
				try {
					const definition = wrapMcpToolAsDefinition(manager, prefixedName, schema);
					if (index && deferByServer.get(serverName)) {
						// Deferred: keep the full schema OFF the active surface; the model
						// finds it via search_tool_bm25 and the session activates it. Index
						// the parameter names/descriptions as tags so a query phrased after
						// the tool's arguments still ranks it (the MCP wrapper never sets
						// promptSnippet, so there is nothing else to widen the doc with).
						index.register({
							name: definition.name,
							description: typeof definition.description === "string" ? definition.description : "",
							tags: deriveMcpToolTags(schema),
							definition,
						});
						deferredCount++;
					} else {
						pi.registerTool(definition);
					}
					registeredNames.add(prefixedName);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					console.error(`[mcp] failed to register ${prefixedName}: ${message}`);
				}
			}
			return deferredCount;
		};

		// With tools deferred, the discovery tool must be on the active surface so
		// the model can actually find them. (It is registered but may be inactive
		// when tool discovery is otherwise off.) No-op when nothing was deferred or
		// when search_tool_bm25 is already active.
		const ensureDiscoveryActive = (deferredCount: number): void => {
			if (deferredCount <= 0) return;
			const active = pi.getActiveTools();
			if (!active.includes("search_tool_bm25")) {
				pi.setActiveTools([...active, "search_tool_bm25"]);
			}
		};

		// Track which servers we have already registered tools for, so a server
		// that transitions disconnected→connected AFTER boot (a reconnect, or one
		// that blew the 10s connect budget and only answered later) gets its tools
		// registered lazily instead of being toolless for the whole session. The
		// boot pass below sets this for every server it saw connected.
		const registeredServers = new Set<string>();
		let bootDone = false;

		const manager = new McpManager({
			servers,
			// Wrap the host's status callback: still forward every state change for
			// status indicators, but additionally catch post-boot reconnects so the
			// extension can register the now-available tools (listTools skips a
			// server until its entry is connected, and the lazy reconnect inside
			// callTool needs a ToolDefinition that only exists once registered).
			onStateChange: (state) => {
				options.onStateChange?.(state);
				if (!bootDone) return; // Boot pass handles initial connects in one batch.
				if (!state.connected) return;
				if (registeredServers.has(state.name)) return;
				registeredServers.add(state.name);
				const deferredCount = registerNewTools();
				ensureDiscoveryActive(deferredCount);
			},
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
			// Mark every server that came up during the budget as handled, so the
			// onStateChange path below only fires for *later* transitions.
			for (const state of manager.getAllStates()) {
				if (state.connected) registeredServers.add(state.name);
			}
			const deferredCount = registerNewTools();
			ensureDiscoveryActive(deferredCount);
			// From here on, reconnects/late connects route through onStateChange.
			bootDone = true;
		});

		pi.on("session_shutdown", () => {
			manager.dispose();
		});

		pi.registerCommand("mcp", {
			description: "List configured MCP servers and their connection state.",
			async handler(_args, ctx) {
				// On-demand recovery: a server that blew the 10s connect budget at boot
				// has no registered tools, so nothing ever re-triggers its connection
				// (the lazy callTool reconnect needs an existing ToolDefinition). Retry
				// any still-disconnected server here, then register whatever came up.
				// connectAll re-initializes each entry; already-connected servers are
				// idempotent, and registerNewTools skips tools already registered, so
				// boot-connected servers see identical behavior.
				if (manager.getAllStates().some((s) => !s.connected)) {
					await manager.connectAll(AbortSignal.timeout(CONNECT_ALL_BUDGET_MS));
					for (const state of manager.getAllStates()) {
						if (state.connected) registeredServers.add(state.name);
					}
					const deferredCount = registerNewTools();
					ensureDiscoveryActive(deferredCount);
				}
				const states = manager.getAllStates();
				if (states.length === 0) {
					const msg = "No MCP servers configured.";
					if (ctx.hasUI) ctx.ui.notify(msg, "info");
					else console.log(msg);
					return;
				}
				const lines = states.map((s) => {
					const deferred = shouldDeferMcpServer(s.tools.length, servers[s.name], options.settings);
					const deferredSuffix = deferred ? " (deferred — discovered on demand)" : "";
					return (
						`${s.connected ? "✓" : "✗"} ${s.name} (${s.url})` +
						`${s.lastError ? ` — ${s.lastError}` : ""}` +
						`${s.tools.length > 0 ? `\n    tools: ${s.tools.map((t) => t.name).join(", ")}${deferredSuffix}` : ""}`
					);
				});
				const out = lines.join("\n");
				if (ctx.hasUI) ctx.ui.notify(out, "info");
				else console.log(out);
			},
		});
	};
}
