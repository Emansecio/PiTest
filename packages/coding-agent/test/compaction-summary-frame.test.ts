import type { AgentMessage } from "@pit/agent-core";
import type { AssistantMessage, Usage } from "@pit/ai";
import { describe, expect, it, vi } from "vitest";

const { recordDiagnosticMock } = vi.hoisted(() => ({
	recordDiagnosticMock: vi.fn(),
}));

vi.mock("@pit/ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@pit/ai")>();
	return { ...actual, recordDiagnostic: recordDiagnosticMock };
});

import {
	computeFileLists,
	computeOperationLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
	formatStructuredSummaryMarkdown,
	normalizeStructuredSummaryOutput,
	type OperationLists,
	parseStructuredSummaryJson,
	trimSummaryProseAgainstOperations,
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
		model: "claude-sonnet-5",
	};
}

function toolCall(name: string, args: Record<string, unknown>) {
	return { type: "toolCall" as const, name, id: `${name}-id`, arguments: args };
}

describe("structured summary frame", () => {
	it("parseStructuredSummaryJson + formatStructuredSummaryMarkdown (C2)", () => {
		const json = JSON.stringify({
			goal: ["ship feature"],
			constraints: ["no regressions"],
			done: ["tests green"],
			inProgress: ["docs"],
			blocked: [],
			keyDecisions: ["JSON-primary: fewer output tokens"],
			nextSteps: ["run check"],
			criticalContext: [],
		});
		const parsed = parseStructuredSummaryJson(`\`\`\`json\n${json}\n\`\`\``);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const md = formatStructuredSummaryMarkdown(parsed.value);
		expect(md).toContain("## Goal");
		expect(md).toContain("ship feature");
		expect(md).toContain("[x] tests green");
		expect(normalizeStructuredSummaryOutput(`\`\`\`json\n${json}\n\`\`\``)).toContain("## Next Steps");
	});

	it("parses the optional corrections field and merges it as a self-check section (M15)", () => {
		const json = JSON.stringify({
			goal: ["ship feature"],
			constraints: [],
			done: [],
			inProgress: [],
			blocked: [],
			keyDecisions: [],
			nextSteps: [],
			criticalContext: [],
			corrections: ["Omitted error: TypeError in verifySummary", "Omitted path: src/core/compaction/compaction.ts"],
		});
		const parsed = parseStructuredSummaryJson(`\`\`\`json\n${json}\n\`\`\``);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const md = formatStructuredSummaryMarkdown(parsed.value);
		expect(md).toContain("## Corrections (self-check)");
		expect(md).toContain("- Omitted error: TypeError in verifySummary");
		expect(md).toContain("- Omitted path: src/core/compaction/compaction.ts");
	});

	it("emits NO corrections section when the field is absent or empty (legacy output byte-identical)", () => {
		const base = {
			goal: ["g"],
			constraints: [],
			done: [],
			inProgress: [],
			blocked: [],
			keyDecisions: [],
			nextSteps: [],
			criticalContext: [],
		};
		const withoutField = parseStructuredSummaryJson(JSON.stringify(base));
		expect(withoutField.ok).toBe(true);
		if (!withoutField.ok) return;
		expect(formatStructuredSummaryMarkdown(withoutField.value)).not.toContain("Corrections");
		const withEmpty = parseStructuredSummaryJson(JSON.stringify({ ...base, corrections: [] }));
		expect(withEmpty.ok).toBe(true);
		if (!withEmpty.ok) return;
		expect(formatStructuredSummaryMarkdown(withEmpty.value)).toBe(
			formatStructuredSummaryMarkdown(withoutField.value),
		);
	});

	it("normalizeStructuredSummaryOutput records diagnostic on JSON fallback (C2)", () => {
		recordDiagnosticMock.mockClear();
		const out = normalizeStructuredSummaryOutput("not json at all");
		expect(out).toBe("not json at all");
		expect(recordDiagnosticMock).toHaveBeenCalledWith(
			expect.objectContaining({ category: "compaction.summary-json-fallback" }),
		);
	});
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

	describe("per-category cap (most-recent 30)", () => {
		it("caps searches/shellCmds/mcpCalls to the 30 most-recently inserted", () => {
			const ops = createFileOps();
			for (let i = 0; i < 100; i++) {
				ops.searches.add(`search-${i}`);
				ops.shellCmds.add(`cmd-${i}`);
				ops.mcpCalls.add(`srv.tool-${i}`);
			}
			const lists = computeOperationLists(ops);
			expect(lists.searches.length).toBe(30);
			expect(lists.shellCmds.length).toBe(30);
			expect(lists.mcpCalls.length).toBe(30);
			// Tail = recency: entries 70..99 survive, 0..69 dropped.
			expect(lists.searches).toContain("search-99");
			expect(lists.searches).toContain("search-70");
			expect(lists.searches).not.toContain("search-69");
			expect(lists.searches).not.toContain("search-0");
		});

		it("caps readFiles and modifiedFiles to the 30 most-recent", () => {
			const ops = createFileOps();
			for (let i = 0; i < 100; i++) ops.read.add(`r-${i}.ts`);
			for (let i = 0; i < 100; i++) ops.edited.add(`m-${i}.ts`);
			const lists = computeFileLists(ops);
			expect(lists.readFiles.length).toBe(30);
			expect(lists.modifiedFiles.length).toBe(30);
			expect(lists.readFiles).toContain("r-99.ts");
			expect(lists.readFiles).not.toContain("r-69.ts");
			expect(lists.modifiedFiles).toContain("m-99.ts");
			expect(lists.modifiedFiles).not.toContain("m-69.ts");
		});

		it("does not change small lists (≤30) — behavior identical", () => {
			const ops = createFileOps();
			for (let i = 0; i < 30; i++) ops.searches.add(`s-${i}`);
			const lists = computeOperationLists(ops);
			expect(lists.searches.length).toBe(30);
			expect(lists.searches).toContain("s-0");
			expect(lists.searches).toContain("s-29");
		});

		it("trimSummaryProseAgainstOperations removes duplicate path/search lines (C2)", () => {
			const lists: OperationLists = {
				readFiles: ["src/foo.ts"],
				modifiedFiles: ["src/bar.ts"],
				searches: ["TODO"],
				shellCmds: ["npm test"],
				mcpCalls: [],
			};
			const before = [
				"## Progress",
				"### Done",
				"- [x] read src/foo.ts",
				"- src/foo.ts",
				"- `src/bar.ts`",
				"- TODO",
				"- npm test",
				"- [x] fixed the bug in handler",
			].join("\n");
			const after = trimSummaryProseAgainstOperations(before, lists);
			expect(after).toContain("fixed the bug");
			expect(after).not.toContain("src/foo.ts");
			expect(after).not.toContain("src/bar.ts");
			expect(after).not.toContain("npm test");
		});

		it("output stays sorted after the tail cap", () => {
			const ops = createFileOps();
			// Insert in reverse so insertion-tail and sort disagree, proving sort runs last.
			for (let i = 99; i >= 0; i--) ops.searches.add(`cmd-${String(i).padStart(3, "0")}`);
			const lists = computeOperationLists(ops);
			const sorted = [...lists.searches].sort();
			expect(lists.searches).toEqual(sorted);
			expect(lists.searches.length).toBe(30);
			// Tail of insertion order = the 30 lowest indices here (000..029).
			expect(lists.searches[0]).toBe("cmd-000");
		});
	});
});
