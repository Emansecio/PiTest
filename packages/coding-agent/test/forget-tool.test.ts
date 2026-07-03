import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type HindsightBank, openBank } from "../src/core/hindsight/bank.js";
import { createForgetToolDefinition, type ForgetToolDetails } from "../src/core/tools/forget.js";

const tempFiles: string[] = [];

function freshBank(): HindsightBank {
	const path = join(tmpdir(), `forget-test-${randomUUID()}.jsonl`);
	tempFiles.push(path);
	return openBank(path);
}

async function runForget(
	bank: HindsightBank,
	input: { id?: string; subject?: string; tags?: string[] },
	options?: { agentScope?: string },
) {
	const def = createForgetToolDefinition("/tmp", { bank, ...options });
	// forget ignores signal/onUpdate/ctx; pass placeholders to satisfy the signature.
	const result = await def.execute("test-call", input, undefined, undefined, undefined as never);
	return result as { details: ForgetToolDetails; isError?: boolean; content: Array<{ text: string }> };
}

afterEach(() => {
	while (tempFiles.length > 0) {
		const f = tempFiles.pop();
		if (f && existsSync(f)) rmSync(f, { force: true });
	}
});

describe("forget tool", () => {
	it("deletes by id", async () => {
		const bank = freshBank();
		const entry = bank.add({ kind: "fact", subject: "auth", body: "JWT uses RS256" });
		const res = await runForget(bank, { id: entry.id });
		expect(res.details.deleted).toBe(true);
		expect(bank.get(entry.id)).toBeUndefined();
	});

	it("deletes by unique subject without an id", async () => {
		const bank = freshBank();
		const entry = bank.add({ kind: "decision", subject: "db-choice", body: "Postgres over Mongo" });
		const res = await runForget(bank, { subject: "db-choice" });
		expect(res.details.deleted).toBe(true);
		expect(bank.get(entry.id)).toBeUndefined();
	});

	it("matches subject case-insensitively", async () => {
		const bank = freshBank();
		const entry = bank.add({ kind: "fact", subject: "Caching", body: "TTL 5m" });
		const res = await runForget(bank, { subject: "  caching " });
		expect(res.details.deleted).toBe(true);
		expect(bank.get(entry.id)).toBeUndefined();
	});

	it("refuses to delete when a subject is ambiguous and lists candidate ids", async () => {
		const bank = freshBank();
		const a = bank.add({ kind: "fact", subject: "perf", body: "memoize layout" });
		const b = bank.add({ kind: "fact", subject: "perf", body: "async persist" });
		const res = await runForget(bank, { subject: "perf" });
		expect(res.details.deleted).toBe(false);
		expect(res.isError).toBe(true);
		expect(res.details.candidates).toEqual([a.id, b.id]);
		// nothing deleted
		expect(bank.get(a.id)).toBeDefined();
		expect(bank.get(b.id)).toBeDefined();
	});

	it("reports not-found for an unknown subject (flagged as an error — nothing was deleted)", async () => {
		const bank = freshBank();
		bank.add({ kind: "fact", subject: "known", body: "x" });
		const res = await runForget(bank, { subject: "nope" });
		expect(res.details.deleted).toBe(false);
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/No hindsight entry found with subject/);
	});

	it("deletes by tags (AND across all given tags)", async () => {
		const bank = freshBank();
		const entry = bank.add({ kind: "pattern", subject: "x", body: "y", tags: ["perf", "tui"] });
		bank.add({ kind: "pattern", subject: "z", body: "w", tags: ["perf"] });
		const res = await runForget(bank, { tags: ["perf", "tui"] });
		expect(res.details.deleted).toBe(true);
		expect(bank.get(entry.id)).toBeUndefined();
	});

	it("lists candidates when tags match multiple entries", async () => {
		const bank = freshBank();
		const a = bank.add({ kind: "fact", body: "a", tags: ["api"] });
		const b = bank.add({ kind: "fact", body: "b", tags: ["api", "extra"] });
		const res = await runForget(bank, { tags: ["API"] });
		expect(res.details.deleted).toBe(false);
		expect(res.isError).toBe(true);
		expect(res.details.candidates).toEqual([a.id, b.id]);
	});

	it("narrows by subject + tags combined", async () => {
		const bank = freshBank();
		bank.add({ kind: "fact", subject: "auth", body: "a", tags: ["jwt"] });
		const target = bank.add({ kind: "fact", subject: "auth", body: "b", tags: ["oauth"] });
		const res = await runForget(bank, { subject: "auth", tags: ["oauth"] });
		expect(res.details.deleted).toBe(true);
		expect(bank.get(target.id)).toBeUndefined();
	});

	it("errors when neither id, subject, nor tags is provided", async () => {
		const bank = freshBank();
		const res = await runForget(bank, {});
		expect(res.isError).toBe(true);
		expect(res.details.deleted).toBe(false);
	});

	it("scoped forget cannot delete a foreign-scope entry by id (reports not-found, nothing deleted)", async () => {
		const bank = freshBank();
		const foreign = bank.add({ kind: "fact", subject: "other-agent-fact", body: "x", agentScope: "explore" });
		const res = await runForget(bank, { id: foreign.id }, { agentScope: "review" });
		expect(res.details.deleted).toBe(false);
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toMatch(/No hindsight entry found with id/);
		expect(bank.get(foreign.id)).toBeDefined();
	});

	it("scoped forget deletes its own-scope entry by id", async () => {
		const bank = freshBank();
		const own = bank.add({ kind: "fact", subject: "own-fact", body: "x", agentScope: "review" });
		const res = await runForget(bank, { id: own.id }, { agentScope: "review" });
		expect(res.details.deleted).toBe(true);
		expect(bank.get(own.id)).toBeUndefined();
	});

	it("scoped forget deletes a global (unscoped) entry by id", async () => {
		const bank = freshBank();
		const global = bank.add({ kind: "fact", subject: "global-fact", body: "x" });
		const res = await runForget(bank, { id: global.id }, { agentScope: "review" });
		expect(res.details.deleted).toBe(true);
		expect(bank.get(global.id)).toBeUndefined();
	});
});
