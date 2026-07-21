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
import { setMcpServerDisabled } from "../mcp/config-files.ts";
import {
	capMcpText,
	McpManager,
	type McpPromptDescriptor,
	type McpServerConfig,
	type McpSettings,
	type McpToolSchema,
	wrapMcpToolAsDefinition,
} from "../mcp/index.ts";
import { McpPanelComponent, type McpPanelRow, type McpPanelStatus } from "../mcp/mcp-panel.ts";
import { createListResourcesTool, createReadResourceTool } from "../mcp/resource-tools.ts";
import { getCurrentToolDiscoveryIndex } from "../tool-discovery.ts";

/** Flatten an MCP prompt result into a single user-message string. */
function promptMessagesToText(messages: Array<{ content: unknown }>): string {
	const parts: string[] = [];
	for (const m of messages) {
		const c = m.content as { type?: string; text?: string };
		if (c && c.type === "text" && typeof c.text === "string") parts.push(c.text);
	}
	return parts.join("\n\n");
}

/** Map a slash-command argument string positionally onto a prompt's declared arguments. */
function parsePromptArgs(argsStr: string, argDefs: McpPromptDescriptor["arguments"]): Record<string, string> {
	const trimmed = argsStr.trim();
	const tokens = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
	const out: Record<string, string> = {};
	(argDefs ?? []).forEach((def, i) => {
		if (tokens[i] !== undefined) out[def.name] = tokens[i];
	});
	return out;
}

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

// Default budget for the session_start connect pass. The ExtensionRunner awaits
// session_start handlers, so without a budget a single hung server (TCP accept,
// no response) stalls the whole boot for the full per-call timeouts (~55s in
// series). Servers that come up later are covered by callTool's lazy reconnect.
// Override per-session via `mcp.connectTimeoutMs` (see resolveConnectBudgetMs).
const DEFAULT_CONNECT_ALL_BUDGET_MS = 10_000;

/** Resolve the startup connect budget from settings, defaulting to current behavior. */
function resolveConnectBudgetMs(settings: McpSettings): number {
	const raw = settings.connectTimeoutMs;
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return DEFAULT_CONNECT_ALL_BUDGET_MS;
	return Math.floor(raw);
}

export interface McpExtensionOptions {
	settings: McpSettings;
	/** Working directory (for persisting enable/disable to project-scope config files). Omit to skip persistence. */
	cwd?: string;
	/** Agent dir (for persisting enable/disable to the user-scope `mcp.json`). Omit to skip persistence. */
	agentDir?: string;
	/** Called when a server's connection state changes (for status indicators). */
	onStateChange?: (state: { name: string; connected: boolean; lastError?: string }) => void;
}

export function createMcpExtension(options: McpExtensionOptions) {
	return (pi: ExtensionAPI) => {
		const servers = options.settings.servers ?? {};
		if (Object.keys(servers).length === 0) {
			return; // No MCP servers configured.
		}

		// Startup connect budget (configurable via `mcp.connectTimeoutMs`, default 10s).
		const connectBudgetMs = resolveConnectBudgetMs(options.settings);

		// Prefixed names already registered (eagerly or into the discovery index).
		// Guards the late-registration path against re-registering tools that the
		// boot pass already handled when a server merely re-emits "connected".
		const registeredNames = new Set<string>();
		const registeredToolsByServer = new Map<string, Set<string>>();

		// Eager (on-surface) tool names registered per server, so /mcp's disable can
		// pull exactly that server's tools off the active surface and enable can put
		// them back. Deferred tools live in the discovery index and aren't tracked
		// here (they're never on the surface; a call to a disabled server's deferred
		// tool simply fails to resolve until it is re-enabled).
		const eagerToolsByServer = new Map<string, Set<string>>();

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
					const definition = wrapMcpToolAsDefinition(manager, prefixedName, schema, serverName);
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
						let eager = eagerToolsByServer.get(serverName);
						if (!eager) {
							eager = new Set<string>();
							eagerToolsByServer.set(serverName, eager);
						}
						eager.add(definition.name);
					}
					registeredNames.add(prefixedName);
					let registeredForServer = registeredToolsByServer.get(serverName);
					if (!registeredForServer) {
						registeredForServer = new Set<string>();
						registeredToolsByServer.set(serverName, registeredForServer);
					}
					registeredForServer.add(prefixedName);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					console.error(`[mcp] failed to register ${prefixedName}: ${message}`);
				}
			}
			return deferredCount;
		};

		const removeUnadvertisedTools = (serverName: string): void => {
			const registeredForServer = registeredToolsByServer.get(serverName);
			if (!registeredForServer || registeredForServer.size === 0) return;
			const advertised = new Set(
				manager
					.listTools()
					.filter((tool) => tool.serverName === serverName)
					.map((tool) => tool.prefixedName),
			);
			const removed = [...registeredForServer].filter((name) => !advertised.has(name));
			if (removed.length === 0) return;
			const removedSet = new Set(removed);
			pi.setActiveTools(pi.getActiveTools().filter((name) => !removedSet.has(name)));
			const index = getCurrentToolDiscoveryIndex();
			const eager = eagerToolsByServer.get(serverName);
			for (const name of removed) {
				index?.unregister(name);
				eager?.delete(name);
				registeredNames.delete(name);
				registeredForServer.delete(name);
			}
			if (registeredForServer.size === 0) registeredToolsByServer.delete(serverName);
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

		// Resources + prompts (Phase 3). Unlike tools, these are never deferred —
		// they are few and pulled on demand. Resource access is via two eager native
		// tools (registered once any server advertises the capability); each prompt
		// becomes a slash command `/mcp__<server>__<prompt>` that injects the
		// server-rendered messages as a user turn.
		let resourceToolsRegistered = false;
		const promptedServers = new Set<string>();

		const discoverResourcesAndPrompts = async (): Promise<void> => {
			const clients = manager.connectedClients();

			if (!resourceToolsRegistered && clients.some((c) => c.client.getCapabilities().resources)) {
				try {
					pi.registerTool(createListResourcesTool(manager));
					pi.registerTool(createReadResourceTool(manager));
					const active = pi.getActiveTools();
					const toAdd = ["list_mcp_resources", "read_mcp_resource"].filter((n) => !active.includes(n));
					if (toAdd.length > 0) pi.setActiveTools([...active, ...toAdd]);
					resourceToolsRegistered = true;
				} catch (err) {
					console.error(
						`[mcp] failed to register resource tools: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}

			for (const { name, client } of clients) {
				if (promptedServers.has(name)) continue;
				if (!client.getCapabilities().prompts) {
					promptedServers.add(name); // nothing to do; don't re-check every reconnect
					continue;
				}
				let prompts: McpPromptDescriptor[];
				try {
					prompts = await client.listPrompts();
				} catch (err) {
					console.error(`[mcp] ${name} prompts/list failed: ${err instanceof Error ? err.message : String(err)}`);
					continue; // leave unmarked so a later reconnect retries
				}
				promptedServers.add(name);
				const prefix = manager.prefixFor(name) ?? `mcp__${name}__`;
				for (const prompt of prompts) {
					const commandName = `${prefix}${prompt.name}`;
					pi.registerCommand(commandName, {
						description: prompt.description ?? `MCP prompt "${prompt.name}" from ${name}`,
						getArgumentCompletions: () =>
							(prompt.arguments ?? []).map((a) => ({
								value: a.name,
								label: a.required ? `${a.name} (required)` : a.name,
								description: a.description,
							})),
						async handler(argsStr, ctx) {
							try {
								const result = await client.getPrompt(prompt.name, parsePromptArgs(argsStr, prompt.arguments));
								const text = promptMessagesToText(result.messages ?? []);
								if (!text.trim()) {
									const msg = `MCP prompt "${prompt.name}" returned no text.`;
									if (ctx.hasUI) ctx.ui.notify(msg, "warning");
									else console.log(msg);
									return;
								}
								pi.sendUserMessage(text);
							} catch (err) {
								const msg = `MCP prompt "${prompt.name}" failed: ${err instanceof Error ? err.message : String(err)}`;
								if (ctx.hasUI) ctx.ui.notify(msg, "error");
								else console.error(msg);
							}
						},
					});
				}
			}
		};

		// Track which servers we have already registered tools for, so a server
		// that transitions disconnected→connected AFTER boot (a reconnect, or one
		// that blew the 10s connect budget and only answered later) gets its tools
		// registered lazily instead of being toolless for the whole session. The
		// boot pass below sets this for every server it saw connected.
		const registeredServers = new Set<string>();
		// Set while the interactive /mcp panel is open so live state changes redraw it.
		let panelRefresh: (() => void) | undefined;
		let bootDone = false;
		let bootConnectPromise: Promise<void> | undefined;
		let bootConnectController: AbortController | undefined;
		let bootConnectTimer: ReturnType<typeof setTimeout> | undefined;

		const manager = new McpManager({
			servers,
			// Wrap the host's status callback: still forward every state change for
			// status indicators, but additionally catch post-boot reconnects so the
			// extension can register the now-available tools (listTools skips a
			// server until its entry is connected, and the lazy reconnect inside
			// callTool needs a ToolDefinition that only exists once registered).
			onStateChange: (state) => {
				options.onStateChange?.(state);
				panelRefresh?.();
				if (!bootDone) return; // Boot pass handles initial connects in one batch.
				if (!state.connected) return;
				if (registeredServers.has(state.name)) return;
				registeredServers.add(state.name);
				const deferredCount = registerNewTools();
				ensureDiscoveryActive(deferredCount);
				void discoverResourcesAndPrompts();
			},
			// Reconcile removals before registering additions so the active surface and
			// discovery index always match the server's latest catalog.
			onToolsChanged: (serverName) => {
				removeUnadvertisedTools(serverName);
				const deferredCount = registerNewTools();
				ensureDiscoveryActive(deferredCount);
			},
		});

		const connectAndRegister = async (signal: AbortSignal): Promise<void> => {
			await manager.connectAll(signal);
			// Mark every server that came up during the budget as handled, so the
			// onStateChange path below only fires for *later* transitions.
			for (const state of manager.getAllStates()) {
				if (state.connected) registeredServers.add(state.name);
			}
			const deferredCount = registerNewTools();
			ensureDiscoveryActive(deferredCount);
			await discoverResourcesAndPrompts();
		};

		const clearBootConnectTimer = (): void => {
			if (bootConnectTimer === undefined) return;
			clearTimeout(bootConnectTimer);
			bootConnectTimer = undefined;
		};

		const createBootConnectSignal = (): AbortSignal => {
			const controller = new AbortController();
			bootConnectController = controller;
			bootConnectTimer = setTimeout(() => {
				controller.abort(new Error(`MCP startup connect timed out after ${connectBudgetMs}ms`));
			}, connectBudgetMs);
			// Boot budget must not keep Node alive after natural session end.
			bootConnectTimer.unref?.();
			return controller.signal;
		};

		// Surface a compact, session-visible notice for the server(s) that missed the
		// startup connect budget (so the model learns the server exists instead of it
		// being silently dropped). A single skip names the server; several are folded
		// into one aggregated line. Only fires when the boot pass was aborted by the
		// budget timer; per-server errors during a completed pass surface via lastError.
		const notifyBudgetSkips = (): void => {
			const skipped = manager.getAllStates().filter((s) => !s.connected && !s.disabled);
			if (skipped.length === 0) return;
			// Round the budget to whole seconds for display; never show "0s" for a
			// sub-second budget. Full command/url and per-server errors stay in /mcp.
			const budgetSecs = Math.max(1, Math.round(connectBudgetMs / 1000));
			// One server: name it directly. Several: aggregate into a single line so a
			// batch of slow servers stays one quiet notice, not a wall of cards. Both
			// stay self-explanatory for the model — the server exists and connects on demand.
			const content =
				skipped.length === 1
					? `mcp: "${skipped[0].name}" did not connect within ${budgetSecs}s — will connect on demand · /mcp`
					: `mcp: ${skipped.length} servers waiting for on-demand connect (${skipped.map((s) => s.name).join(", ")}) · /mcp`;
			pi.sendMessage({ customType: "mcp.notice", content, display: true });
		};

		const startBootConnect = (): void => {
			if (bootConnectPromise) return;
			const signal = createBootConnectSignal();
			bootConnectPromise = (async () => {
				try {
					await connectAndRegister(signal);
				} catch (err) {
					if (!signal.aborted) {
						console.error(`[mcp] startup connect failed: ${err instanceof Error ? err.message : String(err)}`);
					}
				} finally {
					if (signal.aborted) notifyBudgetSkips();
					clearBootConnectTimer();
					if (bootConnectController?.signal === signal) {
						bootConnectController = undefined;
					}
					// From here on, reconnects/late connects route through onStateChange.
					bootDone = true;
				}
			})();
		};

		// Connect after session_start without blocking first prompt processing. Slow
		// or unreachable MCP servers still report status and register tools when
		// they connect; /mcp below awaits/retries explicitly when the user asks.
		// In dry-run mode we skip the network round-trip entirely — the dry-run
		// report still inspects settings.mcp.servers from settings, so the user
		// sees what is configured without paying the connect-timeout cost when
		// a server is unreachable.
		pi.on("session_start", () => {
			if (process.env.PIT_DRY_RUN === "1") {
				return;
			}
			startBootConnect();
		});

		pi.on("session_shutdown", () => {
			clearBootConnectTimer();
			bootConnectController?.abort(new Error("MCP startup connect cancelled by session shutdown"));
			manager.dispose();
		});

		// Expand `@<server>:<uri>` mentions in the user's prompt into resource content
		// (parity with Claude Code's `@server:protocol://...`). Only mentions whose
		// `<server>` is a connected MCP server with the resources capability are
		// expanded; anything else (emails, plain @handles) is left untouched. The
		// resolved content is injected as a display:false context message (LLM-visible,
		// TUI-quiet), bounded so it can't blow the before_agent_start TTFT budget.
		const MENTION_RE = /@([A-Za-z0-9_-]+):([^\s]+)/g;
		pi.on(
			"before_agent_start",
			pi.markMessageInjector(async (event) => {
				const prompt = event.prompt;
				if (!prompt.includes("@")) return;
				const seen = new Set<string>();
				const targets: Array<{ server: string; uri: string }> = [];
				for (const m of prompt.matchAll(MENTION_RE)) {
					const server = m[1];
					// Trim trailing prose punctuation a URI wouldn't really end with.
					const uri = m[2].replace(/[.,;:!?)\]}]+$/, "");
					const key = `${server} ${uri}`;
					if (seen.has(key)) continue;
					if (!manager.getClient(server)?.getCapabilities().resources) continue;
					seen.add(key);
					targets.push({ server, uri });
				}
				if (targets.length === 0) return;

				// Align with outer before_agent_start timeout (default 1s); leave a
				// small margin so the race in the runner wins cleanly on hang.
				const outerMs = Number.parseInt(process.env.PIT_EXTENSION_HOOK_TIMEOUT_MS ?? "1000", 10);
				const budgetMs = Math.max(200, (Number.isFinite(outerMs) && outerMs > 0 ? outerMs : 1000) - 100);
				const signal = AbortSignal.timeout(budgetMs);
				const blocks = await Promise.all(
					targets.map(async ({ server, uri }) => {
						const client = manager.getClient(server);
						if (!client) return `[@${server}:${uri}] server no longer connected`;
						try {
							const result = await client.readResource(uri, signal);
							const text = (result.contents ?? [])
								.map((c) =>
									typeof c.text === "string" ? c.text : c.blob ? `(binary ${c.mimeType ?? "resource"})` : "",
								)
								.filter(Boolean)
								.join("\n");
							return `[@${server}:${uri}]\n${capMcpText(text || "(empty resource)", server)}`;
						} catch (err) {
							return `[@${server}:${uri}] error: ${err instanceof Error ? err.message : String(err)}`;
						}
					}),
				);
				return {
					message: {
						customType: "mcp.resource",
						content: `Referenced MCP resources:\n\n${blocks.join("\n\n")}`,
						display: false,
					},
				};
			}),
		);

		// Add the named server's eager tools back onto the active surface (no-op for
		// servers with only deferred tools). Used after a reconnect/enable.
		const activateEagerTools = (name: string): void => {
			const eager = eagerToolsByServer.get(name);
			if (!eager || eager.size === 0) return;
			const active = pi.getActiveTools();
			const toAdd = [...eager].filter((n) => !active.includes(n));
			if (toAdd.length > 0) pi.setActiveTools([...active, ...toAdd]);
		};

		// /mcp panel actions. Each re-runs the same registration/discovery the boot
		// pass uses so tools become callable immediately, and persists enable/disable
		// so the choice survives a restart (mirrors `pit mcp enable|disable`).
		const reconnectServer = async (name: string): Promise<void> => {
			await manager.reconnect(name, AbortSignal.timeout(connectBudgetMs));
			registeredServers.add(name);
			const deferredCount = registerNewTools();
			ensureDiscoveryActive(deferredCount);
			await discoverResourcesAndPrompts();
			activateEagerTools(name);
		};

		const enableServer = async (name: string): Promise<void> => {
			await manager.enable(name, AbortSignal.timeout(connectBudgetMs));
			if (options.cwd && options.agentDir) {
				setMcpServerDisabled(name, false, servers[name] ?? {}, options.cwd, options.agentDir);
			}
			registeredServers.add(name);
			const deferredCount = registerNewTools();
			ensureDiscoveryActive(deferredCount);
			await discoverResourcesAndPrompts();
			activateEagerTools(name);
		};

		const disableServer = (name: string): void => {
			manager.disable(name);
			if (options.cwd && options.agentDir) {
				setMcpServerDisabled(name, true, servers[name] ?? {}, options.cwd, options.agentDir);
			}
			registeredServers.delete(name);
			const eager = eagerToolsByServer.get(name);
			if (eager && eager.size > 0) {
				pi.setActiveTools(pi.getActiveTools().filter((n) => !eager.has(n)));
			}
			// Drop the server's registration bookkeeping so a later re-enable
			// re-registers its tools (registerNewTools skips names still in
			// registeredNames) and its prompts (discoverResourcesAndPrompts skips
			// servers still in promptedServers). Without this, disable→enable of the
			// same server silently never re-creates its prompt slash-commands.
			promptedServers.delete(name);
			for (const prefixedName of registeredToolsByServer.get(name) ?? []) registeredNames.delete(prefixedName);
			registeredToolsByServer.delete(name);
		};

		const toggleServer = async (name: string): Promise<void> => {
			const state = manager.getState(name);
			if (!state) return;
			if (state.disabled) await enableServer(name);
			else disableServer(name);
		};

		const buildPanelRows = (): McpPanelRow[] =>
			manager.getAllStates().map((s) => {
				const status: McpPanelStatus = s.disabled ? "disabled" : s.connected ? "connected" : "disconnected";
				return {
					name: s.name,
					target: s.url,
					status,
					error: s.lastError,
					tools: s.tools.map((t) => t.name),
					deferred: shouldDeferMcpServer(s.tools.length, servers[s.name], options.settings),
				};
			});

		pi.registerCommand("mcp", {
			description: "Manage MCP servers: live status, reconnect, enable/disable.",
			async handler(_args, ctx) {
				const states = manager.getAllStates();
				if (states.length === 0) {
					const msg = "No MCP servers configured.";
					if (ctx.hasUI) ctx.ui.notify(msg, "info");
					else console.log(msg);
					return;
				}

				// On-demand recovery: a server that blew the 10s connect budget at boot
				// has no registered tools, so nothing ever re-triggers its connection
				// (the lazy callTool reconnect needs an existing ToolDefinition). Retry
				// any still-disconnected (and not deliberately disabled) server, then
				// register whatever came up. connectAll re-initializes each entry;
				// already-connected servers are idempotent, and registerNewTools skips
				// tools already registered, so boot-connected servers see identical behavior.
				const recover = async (): Promise<void> => {
					if (bootConnectPromise) {
						await bootConnectPromise;
					}
					if (manager.getAllStates().some((s) => !s.connected && !s.disabled)) {
						await connectAndRegister(AbortSignal.timeout(connectBudgetMs));
					}
				};

				// Interactive panel (live status + reconnect/enable/disable). Falls back
				// to a plain text dump in non-UI contexts (RPC / print mode).
				if (ctx.hasUI) {
					let activePanel: McpPanelComponent | undefined;
					try {
						await ctx.ui.custom<void>(
							(_tui, panelTheme, _kb, done) => {
								const panel = new McpPanelComponent(panelTheme, buildPanelRows, {
									reconnect: reconnectServer,
									toggle: toggleServer,
									close: () => done(undefined),
								});
								activePanel = panel;
								panelRefresh = () => panel.refresh();
								// Run recovery in the BACKGROUND so the panel paints on the
								// first frame instead of stalling behind two 10s connect
								// budgets (the freeze that made `/mcp` look like a model turn
								// and "open bugged"). Pending rows show "connecting…" and flip
								// to their real status live via onStateChange → panelRefresh.
								const pending = manager.getAllStates().filter((s) => !s.connected && !s.disabled);
								if (pending.length > 0 || bootConnectPromise) {
									for (const s of pending) panel.setBusy(s.name, true);
									void recover()
										.catch(() => {
											// Per-server failures already surface as row.lastError.
										})
										.finally(() => {
											for (const s of pending) activePanel?.setBusy(s.name, false);
											activePanel?.refresh();
										});
								}
								return panel;
							},
							{ inlinePlacement: "above-editor" },
						);
					} finally {
						activePanel = undefined;
						panelRefresh = undefined;
					}
					return;
				}

				// Non-UI (RPC / print): block on recovery so the text dump is final.
				await recover();
				const lines = manager.getAllStates().map((s) => {
					const deferred = shouldDeferMcpServer(s.tools.length, servers[s.name], options.settings);
					const deferredSuffix = deferred ? " (deferred — discovered on demand)" : "";
					const glyph = s.disabled ? "○" : s.connected ? "✓" : "✗";
					const disabledWord = s.disabled ? " (disabled)" : "";
					return (
						`${glyph} ${s.name} (${s.url})${disabledWord}` +
						`${s.lastError ? ` — ${s.lastError}` : ""}` +
						`${s.tools.length > 0 ? `\n    tools: ${s.tools.map((t) => t.name).join(", ")}${deferredSuffix}` : ""}`
					);
				});
				console.log(lines.join("\n"));
			},
		});
	};
}
