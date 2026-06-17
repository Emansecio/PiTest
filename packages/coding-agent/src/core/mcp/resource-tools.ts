/**
 * Native tools that expose MCP *resources* to the model, mirroring the Claude
 * Code / MCP SDK surface (`ListMcpResources` / `ReadMcpResource`). Resources are
 * not deferred like tools — they are few and accessed on demand — so these two
 * tools are registered eagerly whenever any connected server advertises the
 * resources capability. Output is capped with the same `capMcpText` the tool
 * wrapper uses, so a large resource can't blow past the context budget.
 */

import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { McpManager } from "./manager.ts";
import { capMcpText } from "./tools.ts";

export function createListResourcesTool(manager: McpManager): ToolDefinition {
	return {
		name: "list_mcp_resources",
		label: "list_mcp_resources",
		description:
			"List resources exposed by connected MCP servers. Optionally filter to one server by name. Returns each resource's uri, name, and description.",
		parameters: Type.Object({
			server: Type.Optional(
				Type.String({ description: "Restrict to this MCP server name (omit for all servers)." }),
			),
		}),
		prepareArguments: (args: unknown) => (args ?? {}) as Record<string, unknown>,
		async execute(_id, providedArgs, signal) {
			const { server } = (providedArgs ?? {}) as { server?: string };
			const clients = manager.connectedClients().filter((c) => (server ? c.name === server : true));
			if (clients.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: server ? `No connected MCP server named "${server}".` : "No connected MCP servers.",
						},
					],
					isError: false,
					details: undefined,
				};
			}
			const lines: string[] = [];
			for (const { name, client } of clients) {
				let resources: Awaited<ReturnType<typeof client.listResources>>;
				try {
					resources = await client.listResources(signal);
				} catch (err) {
					lines.push(`[${name}] error: ${err instanceof Error ? err.message : String(err)}`);
					continue;
				}
				if (resources.length === 0) {
					lines.push(`[${name}] (no resources)`);
					continue;
				}
				for (const r of resources) {
					const desc = r.description ? ` — ${r.description}` : "";
					const label = r.name ? ` (${r.name})` : "";
					lines.push(`[${name}] ${r.uri}${label}${desc}`);
				}
			}
			return { content: [{ type: "text", text: capMcpText(lines.join("\n")) }], isError: false, details: undefined };
		},
	};
}

export function createReadResourceTool(manager: McpManager): ToolDefinition {
	return {
		name: "read_mcp_resource",
		label: "read_mcp_resource",
		description:
			"Read a resource from a connected MCP server by uri. Provide the server name and the resource uri (as listed by list_mcp_resources).",
		parameters: Type.Object({
			server: Type.String({ description: "MCP server name that owns the resource." }),
			uri: Type.String({ description: "Resource uri to read." }),
		}),
		prepareArguments: (args: unknown) => (args ?? {}) as Record<string, unknown>,
		async execute(_id, providedArgs, signal) {
			const { server, uri } = (providedArgs ?? {}) as { server?: string; uri?: string };
			if (!server || !uri) {
				return {
					content: [{ type: "text", text: "read_mcp_resource requires both `server` and `uri`." }],
					isError: true,
					details: undefined,
				};
			}
			const client = manager.getClient(server);
			if (!client) {
				return {
					content: [{ type: "text", text: `No connected MCP server named "${server}".` }],
					isError: true,
					details: undefined,
				};
			}
			try {
				const result = await client.readResource(uri, signal);
				const blocks: Array<{ type: "text"; text: string }> = [];
				for (const c of result.contents ?? []) {
					if (typeof c.text === "string") {
						blocks.push({ type: "text", text: capMcpText(`[${c.uri}]\n${c.text}`) });
					} else if (typeof c.blob === "string") {
						blocks.push({
							type: "text",
							text: `[${c.uri}] binary resource (${c.blob.length} base64 bytes, ${c.mimeType ?? "unknown"})`,
						});
					}
				}
				if (blocks.length === 0) blocks.push({ type: "text", text: "(empty resource)" });
				return { content: blocks, isError: false, details: undefined };
			} catch (err) {
				return {
					content: [
						{ type: "text", text: `MCP resource error: ${err instanceof Error ? err.message : String(err)}` },
					],
					isError: true,
					details: undefined,
				};
			}
		},
	};
}
