import type { AgentMessage } from "@pit/agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	collectDiscardedEntries,
	searchDiscardedHistory,
	setCurrentHistoryRecallSource,
} from "../src/core/history-recall.js";
import * as bm25 from "../src/core/search/bm25.js";
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from "../src/core/session-manager.js";
import { createRecallHistoryDefinition } from "../src/core/tools/recall-history.js";

const CWD = process.cwd();

let entryCounter = 0;
let lastId: string | null = null;

function resetCounter() {
	entryCounter = 0;
	lastId = null;
}

function msgEntry(message: AgentMessage): SessionMessageEntry {
	const id = `r-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return entry;
}

function compactionEntry(firstKeptEntryId: string): CompactionEntry {
	const id = `r-${entryCounter++}`;
	const entry: CompactionEntry = {
		type: "compaction",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		summary: "prior window summary",
		firstKeptEntryId,
		tokensBefore: 10000,
	};
	lastId = id;
	return entry;
}

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistantToolCall(name: string, id: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-5",
	} as AgentMessage;
}

function toolResult(text: string): AgentMessage {
	return {
		role: "toolResult",
		content: [{ type: "text", text }],
		toolCallId: "tc-1",
		toolName: "bash",
		isError: false,
		timestamp: Date.now(),
	} as AgentMessage;
}

function assistantText(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-5",
	} as AgentMessage;
}

afterEach(() => {
	setCurrentHistoryRecallSource(undefined);
	delete process.env.PIT_NO_SECRET_REDACT;
});

describe("collectDiscardedEntries", () => {
	beforeEach(resetCounter);

	it("returns [] when there is no compaction entry", () => {
		const branch: SessionEntry[] = [msgEntry(user("hello")), msgEntry(assistantText("hi"))];
		expect(collectDiscardedEntries(branch)).toEqual([]);
	});

	it("returns entries before firstKeptEntryId, filtered to type=message", () => {
		const u1 = msgEntry(user("pre-compact user"));
		const a1 = msgEntry(assistantText("pre-compact assistant"));
		const u2 = msgEntry(user("kept user"));
		const a2 = msgEntry(assistantText("kept assistant"));
		const comp = compactionEntry(u2.id); // keep from u2 onwards
		const branch: SessionEntry[] = [u1, a1, u2, a2, comp];
		const discarded = collectDiscardedEntries(branch);
		expect(discarded.map((e) => e.id)).toEqual([u1.id, a1.id]);
	});

	it("returns [] when firstKeptEntryId is the first entry (nothing discarded)", () => {
		const u1 = msgEntry(user("first"));
		const comp = compactionEntry(u1.id);
		const branch: SessionEntry[] = [u1, comp];
		expect(collectDiscardedEntries(branch)).toEqual([]);
	});
});

describe("searchDiscardedHistory (BM25)", () => {
	beforeEach(resetCounter);

	it("ranks the entry containing the queried fact first", () => {
		const u1 = msgEntry(user("We are fixing the compaction verify pass."));
		const a1 = msgEntry(assistantText("Reading the file first."));
		const u2 = msgEntry(user("Now wire the grounding layer."));
		const u3 = msgEntry(user("Unrelated content about cooking recipes."));
		const kept = msgEntry(user("kept"));
		const comp = compactionEntry(kept.id);
		const branch: SessionEntry[] = [u1, a1, u2, u3, kept, comp];
		const discarded = collectDiscardedEntries(branch);
		const hits = searchDiscardedHistory(discarded, "compaction verify pass", 5);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].entryId).toBe(u1.id);
		expect(hits[0].snippet).toContain("compaction verify pass");
	});

	it("indexes tool-call args so a file path is searchable by name", () => {
		const call = msgEntry(assistantToolCall("read", "tc-x", { path: "src/core/compaction/compaction.ts" }));
		const kept = msgEntry(user("kept"));
		const comp = compactionEntry(kept.id);
		const discarded = collectDiscardedEntries([call, kept, comp]);
		const hits = searchDiscardedHistory(discarded, "compaction.ts", 5);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].entryId).toBe(call.id);
	});

	it("indexes tool-result bodies so an error message is recoverable", () => {
		const result = msgEntry(
			toolResult("Error: TypeError in verifySummary — missing source argument at src/foo.ts:42"),
		);
		const kept = msgEntry(user("kept"));
		const comp = compactionEntry(kept.id);
		const discarded = collectDiscardedEntries([result, kept, comp]);
		const hits = searchDiscardedHistory(discarded, "TypeError verifySummary", 5);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].snippet).toContain("TypeError");
	});

	it("returns [] for a query with no matching tokens", () => {
		const u = msgEntry(user("fix the verify pass"));
		const kept = msgEntry(user("kept"));
		const comp = compactionEntry(kept.id);
		const discarded = collectDiscardedEntries([u, kept, comp]);
		expect(searchDiscardedHistory(discarded, "zzznomatch", 5)).toEqual([]);
	});

	it("returns [] when the query is only stopwords", () => {
		const u = msgEntry(user("the and of to in is it"));
		const kept = msgEntry(user("kept"));
		const comp = compactionEntry(kept.id);
		const discarded = collectDiscardedEntries([u, kept, comp]);
		expect(searchDiscardedHistory(discarded, "the and of", 5)).toEqual([]);
	});

	it("respects the limit argument", () => {
		const entries: SessionMessageEntry[] = [];
		for (let i = 0; i < 6; i++) {
			entries.push(msgEntry(user(`compaction verify pass variant ${i}`)));
		}
		const kept = msgEntry(user("kept"));
		const comp = compactionEntry(kept.id);
		const discarded = collectDiscardedEntries([...entries, kept, comp]);
		const hits = searchDiscardedHistory(discarded, "compaction verify", 3);
		expect(hits.length).toBe(3);
	});

	it("redacts secret-shaped content out of returned snippets", () => {
		// AWS access key shape: AKIA + 16 base32 chars — the redactor rewrites it.
		const secret = "AKIAIOSFODNN7EXAMPLE";
		const u = msgEntry(user(`Use the credential ${secret} for the deploy.`));
		const kept = msgEntry(user("kept"));
		const comp = compactionEntry(kept.id);
		const discarded = collectDiscardedEntries([u, kept, comp]);
		const hits = searchDiscardedHistory(discarded, "credential deploy", 5);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].snippet).not.toContain(secret);
		expect(hits[0].snippet).toContain("[REDACTED");
	});

	it("caps snippets with a head+tail excerpt for long tool results", () => {
		const longBody = `Error: TypeError in verifySummary\n${"x".repeat(2000)}\nfinal line boom`;
		const result = msgEntry(toolResult(longBody));
		const kept = msgEntry(user("kept"));
		const comp = compactionEntry(kept.id);
		const discarded = collectDiscardedEntries([result, kept, comp]);
		const hits = searchDiscardedHistory(discarded, "TypeError verifySummary", 5);
		expect(hits.length).toBeGreaterThan(0);
		// Head (the error) and tail (the final line) survive; the bulky middle is elided.
		expect(hits[0].snippet).toContain("Error: TypeError in verifySummary");
		expect(hits[0].snippet).toContain("final line boom");
		expect(hits[0].snippet.length).toBeLessThan(longBody.length);
		expect(hits[0].snippet).toContain("…");
	});
});

describe("recall_history tool", () => {
	beforeEach(resetCounter);

	function def() {
		return createRecallHistoryDefinition(CWD);
	}

	async function run(query: string, limit?: number) {
		const input = limit === undefined ? { query } : { query, limit };
		return (await def().execute("tc-rh", input, undefined, undefined, undefined as any)) as any;
	}

	it("returns isError + unavailable when no source is published", async () => {
		setCurrentHistoryRecallSource(undefined);
		const result = await run("anything");
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/unavailable/i);
		expect(result.details.hits).toBe(0);
	});

	it("returns a graceful non-error when there is no compacted history", async () => {
		const branch: SessionEntry[] = [msgEntry(user("hi")), msgEntry(assistantText("hello"))];
		setCurrentHistoryRecallSource(() => branch);
		const result = await run("anything");
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("No compacted history");
		expect(result.details.hits).toBe(0);
	});

	it("recovers a planted fact from the discarded window", async () => {
		const planted = "Decision: use conversation-delta in the verify prompt to prevent hallucination.";
		const u1 = msgEntry(user(planted));
		const a1 = msgEntry(assistantText("Got it, wiring the source."));
		const kept = msgEntry(user("next turn"));
		const comp = compactionEntry(kept.id);
		const branch: SessionEntry[] = [u1, a1, kept, comp];
		setCurrentHistoryRecallSource(() => branch);

		const result = await run("conversation-delta verify hallucination");
		expect(result.isError).toBeFalsy();
		const text = result.content[0].text as string;
		expect(text).toContain("conversation-delta");
		expect(result.details.hits).toBeGreaterThan(0);
	});

	it("returns a non-error no-match message when the query misses", async () => {
		const u1 = msgEntry(user("fix the verify pass"));
		const kept = msgEntry(user("kept"));
		const comp = compactionEntry(kept.id);
		setCurrentHistoryRecallSource(() => [u1, kept, comp]);

		const result = await run("zzznomatch");
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("No matches");
		expect(result.details.hits).toBe(0);
	});

	it("tool name and label are recall_history", () => {
		expect(def().name).toBe("recall_history");
		expect(def().label).toBe("recall_history");
	});
});

describe("searchDiscardedHistory — Portuguese recall (N6)", () => {
	beforeEach(resetCounter);

	it("recovers accented Portuguese prose from an unaccented query (and vice-versa)", () => {
		const pt = msgEntry(user("Implementamos a função de compactação para o histórico da sessão."));
		const noise = msgEntry(assistantText("The kitchen renovation is finally complete."));
		const kept = msgEntry(user("kept"));
		const comp = compactionEntry(kept.id);
		const discarded = collectDiscardedEntries([pt, noise, kept, comp]);

		for (const query of ["função compactação", "funcao compactacao"]) {
			const hits = searchDiscardedHistory(discarded, query, 5);
			expect(hits.length).toBeGreaterThan(0);
			expect(hits[0].entryId).toBe(pt.id);
			expect(hits[0].snippet).toContain("compactação");
		}
	});

	it("does not let Portuguese stopwords dominate the ranking", () => {
		// The distinctive term is "grounding"; everything else is a PT stopword.
		const target = msgEntry(user("O agente usa grounding para evitar alucinação."));
		const filler = msgEntry(user("de da do que para com uma um os as em no na por"));
		const kept = msgEntry(user("kept"));
		const comp = compactionEntry(kept.id);
		const discarded = collectDiscardedEntries([target, filler, kept, comp]);

		// A query of only PT stopwords finds nothing (all stripped).
		expect(searchDiscardedHistory(discarded, "de da do para com", 5)).toEqual([]);
		// A content query ranks the entry with the real term first.
		const hits = searchDiscardedHistory(discarded, "grounding alucinação", 5);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits[0].entryId).toBe(target.id);
	});

	it("caches DocStats per entry object — no re-tokenization across queries", () => {
		const pt = msgEntry(user("função de compactação recuperável no histórico"));
		const kept = msgEntry(user("kept"));
		const comp = compactionEntry(kept.id);
		const discarded = collectDiscardedEntries([pt, kept, comp]);

		const spy = vi.spyOn(bm25, "computeDocStats");
		try {
			searchDiscardedHistory(discarded, "compactação", 5);
			const afterFirst = spy.mock.calls.length;
			expect(afterFirst).toBeGreaterThan(0); // tokenized once on the cold pass
			searchDiscardedHistory(discarded, "função", 5);
			// Same entry objects ⇒ cache hit ⇒ no additional tokenization.
			expect(spy.mock.calls.length).toBe(afterFirst);
		} finally {
			spy.mockRestore();
		}
	});

	it("returns byte-identical results across repeated queries (cache correctness)", () => {
		const a = msgEntry(user("A correção da função de verificação previne alucinação."));
		const b = msgEntry(assistantText("Reading src/core/history-recall.ts first."));
		const kept = msgEntry(user("kept"));
		const comp = compactionEntry(kept.id);
		const discarded = collectDiscardedEntries([a, b, kept, comp]);

		const first = searchDiscardedHistory(discarded, "função verificação", 5);
		const second = searchDiscardedHistory(discarded, "função verificação", 5);
		expect(second).toEqual(first);
	});
});
