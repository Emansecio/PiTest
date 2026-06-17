/**
 * End-to-end test for the stdio MCP transport against a REAL subprocess: a tiny
 * Node MCP server that speaks Content-Length-framed JSON-RPC over stdin/stdout.
 * Exercises spawn, framing, the initialize handshake, tools/list, tools/call,
 * and clean disposal (no leaked process).
 */

import { describe, expect, it } from "vitest";
import { McpClient } from "../src/core/mcp/client.js";

// A minimal stdio MCP server. Reads Content-Length frames, answers
// initialize/tools/list/tools/call. Kept as a single -e string (no fixture file).
const SERVER_SCRIPT = `
let buf = Buffer.alloc(0);
function send(obj){const b=Buffer.from(JSON.stringify(obj),'utf8');process.stdout.write('Content-Length: '+b.length+'\\r\\n\\r\\n');process.stdout.write(b);}
process.stdin.on('data', d => {
  buf = Buffer.concat([buf, d]);
  while (true) {
    const s = buf.indexOf('\\r\\n\\r\\n');
    if (s === -1) break;
    const header = buf.slice(0, s).toString('ascii');
    const m = header.match(/Content-Length: (\\d+)/i);
    if (!m) { buf = buf.slice(s+4); continue; }
    const len = parseInt(m[1],10);
    const start = s+4;
    if (buf.length < start+len) break;
    const body = buf.slice(start, start+len).toString('utf8');
    buf = buf.slice(start+len);
    let msg; try { msg = JSON.parse(body); } catch { continue; }
    if (msg.method === 'notifications/initialized') continue;
    let result;
    if (msg.method === 'initialize') result = { protocolVersion:'2025-06-18', serverInfo:{name:'stdio-test'}, capabilities:{tools:{}} };
    else if (msg.method === 'tools/list') result = { tools:[{name:'echo',description:'echoes args',inputSchema:{type:'object'}}] };
    else if (msg.method === 'tools/call') result = { content:[{type:'text', text:'echoed:'+JSON.stringify(msg.params.arguments)}] };
    else result = {};
    send({ jsonrpc:'2.0', id: msg.id, result });
  }
});
`;

describe("StdioTransport (real subprocess)", () => {
	it("spawns a node MCP server, initializes, lists and calls a tool, then disposes", async () => {
		const client = new McpClient("stdio", { command: process.execPath, args: ["-e", SERVER_SCRIPT] });
		try {
			await client.initialize(AbortSignal.timeout(10_000));
			expect(client.getTools().map((t) => t.name)).toEqual(["echo"]);
			expect(client.getCapabilities().tools).toBe(true);
			const result = await client.callTool("echo", { hi: 1 });
			expect(result.content[0]).toEqual({ type: "text", text: 'echoed:{"hi":1}' });
		} finally {
			client.dispose();
		}
	});

	it("rejects a call after the server process is gone (transport error)", async () => {
		const client = new McpClient("stdio-dead", { command: process.execPath, args: ["-e", SERVER_SCRIPT] });
		await client.initialize(AbortSignal.timeout(10_000));
		client.dispose();
		await expect(client.callTool("echo", {})).rejects.toThrow();
	});
});
