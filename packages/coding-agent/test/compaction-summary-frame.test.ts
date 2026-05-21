import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	computeOperationLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
	type OperationLists,
} from "../src/core/compaction/utils.js";

function usage(): Usage {
	return {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(content: AssistantMessage["content"]): AgentMessage {
	return {
		role: "assistant",
		content,
		usage: usage(),
		stopReason: "stop",
		timestamp: 1,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

function toolCall(name: string, args: Record<string, unknown>) {
	return { type: "toolCall" as const, name, id: `${name}-id`, arguments: args };
}

describe("structured summary frame", () => {
	it("createFileOps initializes all operation buckets", () => {
		const ops = createFileOps();
		expect(ops.read.size).toBe(0);
		expect(ops.written.size).toBe(0);
		expect(ops.edited.size).toBe(0);
		expect(ops.searches.size).toBe(0);
		expect(ops.shellCmds.size).toBe(0);
		expect(ops.mcpCalls.size).toBe(0);
	});

	it("extracts grep/glob searches", () => {
		const ops = createFileOps();
		extractFileOpsFromMessage(
			assistant([
				toolCall("grep", { pattern: "TODO", path: "src" }),
				toolCall("glob", { pattern: "**/*.ts" }),
				toolCall("search", { query: "needle" }),
			]),
			ops,
		);
		expect([...ops.searches]).toEqual(expect.arrayContaining(["TODO", "**/*.ts", "needle"]));
		expect(ops.searches.size).toBe(3);
	});

	it("extracts bash shell commands", () => {
		const ops = createFileOps();
		extractFileOpsFromMessage(
			assistant([toolCall("bash", { command: "ls -la" }), toolCall("shell", { cmd: "npm test" })]),
			ops,
		);
		expect([...ops.shellCmds]).toEqual(expect.arrayContaining(["ls -la", "npm test"]));
	});

	it("extracts MCP tool calls with server.tool labels", () => {
		const ops = createFileOps();
		extractFileOpsFromMessage(
			assistant([
				toolCall("mcp__github__create_issue", { title: "x" }),
				toolCall("mcp__slack__send_message", { channel: "general" }),
			]),
			ops,
		);
		expect([...ops.mcpCalls]).toEqual(expect.arrayContaining(["github.create_issue", "slack.send_message"]));
	});

	it("ignores tool calls without identifiable args", () => {
		const ops = createFileOps();
		extractFileOpsFromMessage(
			assistant([
				toolCall("grep", {}), // no pattern → ignored
				toolCall("bash", {}), // no command → ignored
				toolCall("read", {}), // no path → ignored
			]),
			ops,
		);
		expect(ops.searches.size).toBe(0);
		expect(ops.shellCmds.size).toBe(0);
		expect(ops.read.size).toBe(0);
	});

	it("collapses identical commands to one entry (deduped via Set)", () => {
		const ops = createFileOps();
		extractFileOpsFromMessage(
			assistant([
				toolCall("bash", { command: "ls" }),
				toolCall("bash", { command: "ls" }),
				toolCall("bash", { command: "ls" }),
			]),
			ops,
		);
		expect(ops.shellCmds.size).toBe(1);
	});

	it("computeOperationLists returns sorted arrays", () => {
		const ops = createFileOps();
		ops.shellCmds.add("z");
		ops.shellCmds.add("a");
		ops.searches.add("b");
		ops.searches.add("a");
		const lists = computeOperationLists(ops);
		expect(lists.shellCmds).toEqual(["a", "z"]);
		expect(lists.searches).toEqual(["a", "b"]);
	});

	it("formatFileOperations 2-arg overload stays backwards-compatible", () => {
		const out = formatFileOperations(["a.ts"], ["b.ts"]);
		expect(out).toContain("<read-files>\na.ts\n</read-files>");
		expect(out).toContain("<modified-files>\nb.ts\n</modified-files>");
		expect(out).not.toContain("<searches>");
		expect(out).not.toContain("<shell-commands>");
		expect(out).not.toContain("<mcp-calls>");
	});

	it("formatFileOperations renders structured frame when given OperationLists", () => {
		const lists: OperationLists = {
			readFiles: ["a.ts"],
			modifiedFiles: ["b.ts"],
			searches: ["TODO"],
			shellCmds: ["npm test"],
			mcpCalls: ["github.create_issue"],
		};
		const out = formatFileOperations(lists);
		expect(out).toContain("<read-files>");
		expect(out).toContain("<modified-files>");
		expect(out).toContain("<searches>\nTODO\n</searches>");
		expect(out).toContain("<shell-commands>\nnpm test\n</shell-commands>");
		expect(out).toContain("<mcp-calls>\ngithub.create_issue\n</mcp-calls>");
	});

	it("formatFileOperations omits empty sections in structured mode", () => {
		const out = formatFileOperations({
			readFiles: [],
			modifiedFiles: ["only.ts"],
			searches: [],
			shellCmds: [],
			mcpCalls: [],
		});
		expect(out).not.toContain("<read-files>");
		expect(out).not.toContain("<searches>");
		expect(out).toContain("<modified-files>");
	});

	it("formatFileOperations returns empty string when nothing to report", () => {
		expect(formatFileOperations([], [])).toBe("");
		expect(
			formatFileOperations({ readFiles: [], modifiedFiles: [], searches: [], shellCmds: [], mcpCalls: [] }),
		).toBe("");
	});

	it("truncates very long search patterns to keep summary bounded", () => {
		const ops = createFileOps();
		const long = "x".repeat(500);
		extractFileOpsFromMessage(assistant([toolCall("grep", { pattern: long })]), ops);
		const entry = [...ops.searches][0];
		expect(entry.length).toBeLessThan(long.length);
		expect(entry.endsWith("…")).toBe(true);
	});
});
