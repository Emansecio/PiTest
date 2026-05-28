/**
 * Benchmark for the tool-rewrite registry.
 *
 * Runs a curated corpus of broken tool calls through the live registry,
 * measures how many each tier catches, and reports the latency overhead per
 * call. Used to track regressions and to ground the "% of errors eliminated"
 * claim against deterministic synthetic data.
 *
 * Categories:
 *  - tier1-alias        — args reshape that should auto-rewrite to a valid call
 *  - tier2-bash-sub     — bash invocations that should reject with a dedicated-tool suggestion
 *  - tier3-block        — calls that should be blocked pre-flight as no-op / unsafe
 *  - control-passes     — well-formed calls that MUST pass through untouched
 *  - misses             — broken calls the registry intentionally cannot catch (sets ceiling)
 *
 * Each entry carries `baselineFails: true | false`:
 *  - true  → without the registry, this call would have produced an error
 *            (validation reject, execute-then-fail, no-op confusion, etc.)
 *  - false → the call is well-formed; we only want to confirm the registry
 *            does NOT misfire on it.
 *
 * Reduction estimate:
 *    rescued = entries where baselineFails && (rewritten or rejected by registry)
 *    rescue_rate = rescued / total_baselineFails_entries
 *
 * Emits METRIC lines for autoresearch.
 *
 * Run:
 *   npx tsx scripts/bench-tool-rewrites.mts                              # synthetic corpus
 *   npx tsx scripts/bench-tool-rewrites.mts --replay <glob> [<glob>...]  # replay real sessions
 *   BENCH_VERBOSE=1 npx tsx scripts/bench-tool-rewrites.mts
 *
 * --replay accepts one or more glob patterns to pi session JSONL files. The
 * canonical location is `~/.pi/agent/sessions/**\/*.jsonl`. The benchmark
 * extracts every (toolCall, toolResult) pair from the matched files and
 * reports — against the ACTUAL outcomes recorded in those sessions:
 *   - true positives:  registry would have caught an error before execution
 *   - false positives: registry would have intervened on a call that succeeded
 *   - false negatives: errors the registry cannot catch (ceiling)
 *   - true negatives:  good calls correctly passed through
 */

import { createReadStream } from "node:fs";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { glob } from "glob";
import type { AgentToolCall } from "@earendil-works/pi-agent-core";
import { createDefaultToolErrorHintRegistry } from "../packages/coding-agent/src/core/tool-error-hint-rules.ts";
import { createDefaultToolRewriteRegistry } from "../packages/coding-agent/src/core/tool-rewrite-rules.ts";

type Tier = "auto" | "suggest" | "block" | "pass";
type Category = "tier1-alias" | "tier2-bash-sub" | "tier3-block" | "control-passes" | "misses";

interface BenchEntry {
	/** Short description shown in the per-entry verbose dump. */
	label: string;
	category: Category;
	call: AgentToolCall;
	expected: {
		tier: Tier;
		/** Specific rule id that should fire. Skipped for `pass` and `misses`. */
		ruleId?: string;
	};
	/** Whether this call would have failed without the registry intervening. */
	baselineFails: boolean;
}

let nextId = 0;
function call(name: string, args: Record<string, unknown>): AgentToolCall {
	nextId += 1;
	return { type: "toolCall", id: `bench-${nextId}`, name, arguments: args };
}

const CORPUS: BenchEntry[] = [
	// ───── tier1-alias ─────
	{
		label: "read({start_line, end_line}) → offset/limit",
		category: "tier1-alias",
		call: call("read", { path: "foo.ts", start_line: 10, end_line: 20 }),
		expected: { tier: "auto", ruleId: "read-start-end-line-to-offset-limit" },
		baselineFails: true,
	},
	{
		label: "read({path: 'foo.ts:10-20'}) → split range",
		category: "tier1-alias",
		call: call("read", { path: "foo.ts:10-20" }),
		expected: { tier: "auto", ruleId: "read-path-range-suffix" },
		baselineFails: true,
	},
	{
		label: "read({offset: '5', limit: '10'}) → numeric coerce",
		category: "tier1-alias",
		call: call("read", { path: "foo.ts", offset: "5", limit: "10" }),
		expected: { tier: "auto", ruleId: "read-numeric-offset-limit" },
		// TypeBox Convert would also fix this, but the rule absorbs it first
		// so its behaviour is deterministic regardless of the underlying coercer.
		baselineFails: false,
	},

	// ───── tier2-bash-sub ─────
	{
		label: "bash('cat foo.ts')",
		category: "tier2-bash-sub",
		call: call("bash", { command: "cat foo.ts" }),
		expected: { tier: "suggest", ruleId: "bash-cat-to-read" },
		baselineFails: true,
	},
	{
		label: "bash('head -n 20 foo.ts')",
		category: "tier2-bash-sub",
		call: call("bash", { command: "head -n 20 foo.ts" }),
		expected: { tier: "suggest", ruleId: "bash-head-tail-to-read" },
		baselineFails: true,
	},
	{
		label: "bash('tail -n 10 foo.ts')",
		category: "tier2-bash-sub",
		call: call("bash", { command: "tail -n 10 foo.ts" }),
		expected: { tier: "suggest", ruleId: "bash-head-tail-to-read" },
		baselineFails: true,
	},
	{
		label: "bash('sed -n \\'10,20p\\' foo.ts')",
		category: "tier2-bash-sub",
		call: call("bash", { command: "sed -n '10,20p' foo.ts" }),
		expected: { tier: "suggest", ruleId: "bash-sed-range-to-read" },
		baselineFails: true,
	},
	{
		label: "bash('grep -r foo src/')",
		category: "tier2-bash-sub",
		call: call("bash", { command: "grep -r foo src/" }),
		expected: { tier: "suggest", ruleId: "bash-grep-to-grep" },
		baselineFails: true,
	},
	{
		label: "bash('rg foo src/')",
		category: "tier2-bash-sub",
		call: call("bash", { command: "rg foo src/" }),
		expected: { tier: "suggest", ruleId: "bash-grep-to-grep" },
		baselineFails: true,
	},
	{
		label: "bash('ag foo src/')",
		category: "tier2-bash-sub",
		call: call("bash", { command: "ag foo src/" }),
		expected: { tier: "suggest", ruleId: "bash-grep-to-grep" },
		baselineFails: true,
	},
	{
		label: "bash('find . -name *.ts')",
		category: "tier2-bash-sub",
		call: call("bash", { command: "find . -name '*.ts'" }),
		expected: { tier: "suggest", ruleId: "bash-find-to-find" },
		baselineFails: true,
	},
	{
		label: "bash('fd ts')",
		category: "tier2-bash-sub",
		call: call("bash", { command: "fd ts" }),
		expected: { tier: "suggest", ruleId: "bash-find-to-find" },
		baselineFails: true,
	},
	{
		label: "bash('ls src/')",
		category: "tier2-bash-sub",
		call: call("bash", { command: "ls src/" }),
		expected: { tier: "suggest", ruleId: "bash-ls-to-ls" },
		baselineFails: true,
	},
	{
		label: "bash('dir src')",
		category: "tier2-bash-sub",
		call: call("bash", { command: "dir src" }),
		expected: { tier: "suggest", ruleId: "bash-ls-to-ls" },
		baselineFails: true,
	},
	{
		label: "bash('wc -l foo.ts')",
		category: "tier2-bash-sub",
		call: call("bash", { command: "wc -l foo.ts" }),
		expected: { tier: "suggest", ruleId: "bash-wc-l-suggest-read" },
		baselineFails: true,
	},

	// ───── tier3-block ─────
	{
		label: "edit no-op (oldText === newText)",
		category: "tier3-block",
		call: call("edit", { path: "x", edits: [{ oldText: "foo", newText: "foo" }] }),
		expected: { tier: "block", ruleId: "edit-noop-old-equals-new" },
		baselineFails: true,
	},
	{
		label: "edit no-op multi-word",
		category: "tier3-block",
		call: call("edit", { path: "x", edits: [{ oldText: "bar baz qux", newText: "bar baz qux" }] }),
		expected: { tier: "block", ruleId: "edit-noop-old-equals-new" },
		baselineFails: true,
	},
	{
		label: "read({offset: 0}) — 1-indexed violation",
		category: "tier3-block",
		call: call("read", { path: "x", offset: 0 }),
		expected: { tier: "block", ruleId: "read-offset-zero" },
		baselineFails: true,
	},
	{
		label: "read({offset: -5}) — negative bounds",
		category: "tier3-block",
		call: call("read", { path: "x", offset: -5 }),
		expected: { tier: "block", ruleId: "read-negative-bounds" },
		baselineFails: true,
	},
	{
		label: "read({limit: 0}) — zero limit",
		category: "tier3-block",
		call: call("read", { path: "x", limit: 0 }),
		expected: { tier: "block", ruleId: "read-negative-bounds" },
		baselineFails: true,
	},
	{
		label: "bash('rm -rf /') — unsafe",
		category: "tier3-block",
		call: call("bash", { command: "rm -rf /" }),
		expected: { tier: "block", ruleId: "bash-unsafe-rm-root" },
		baselineFails: true,
	},

	// ───── control-passes (must NOT trigger any rule) ─────
	{
		label: "read({path}) — plain",
		category: "control-passes",
		call: call("read", { path: "foo.ts" }),
		expected: { tier: "pass" },
		baselineFails: false,
	},
	{
		label: "read({path, offset, limit}) — already correct shape",
		category: "control-passes",
		call: call("read", { path: "foo.ts", offset: 5, limit: 10 }),
		expected: { tier: "pass" },
		baselineFails: false,
	},
	{
		label: "bash('git status') — legitimate bash",
		category: "control-passes",
		call: call("bash", { command: "git status" }),
		expected: { tier: "pass" },
		baselineFails: false,
	},
	{
		label: "bash('cat foo | grep bar') — pipe disables Tier 2",
		category: "control-passes",
		call: call("bash", { command: "cat foo.ts | grep bar" }),
		expected: { tier: "pass" },
		baselineFails: false,
	},
	{
		label: "bash('ls -la') — flag skips Tier 2",
		category: "control-passes",
		call: call("bash", { command: "ls -la" }),
		expected: { tier: "pass" },
		baselineFails: false,
	},
	{
		label: "bash('ls > out.txt') — redirect skips Tier 2",
		category: "control-passes",
		call: call("bash", { command: "ls > out.txt" }),
		expected: { tier: "pass" },
		baselineFails: false,
	},
	{
		label: "edit real change",
		category: "control-passes",
		call: call("edit", { path: "x", edits: [{ oldText: "foo", newText: "bar" }] }),
		expected: { tier: "pass" },
		baselineFails: false,
	},
	{
		label: "write new file",
		category: "control-passes",
		call: call("write", { path: "x", content: "hello" }),
		expected: { tier: "pass" },
		baselineFails: false,
	},

	// ───── misses (registry deliberately cannot catch these) ─────
	{
		label: "read({path: 'nonexistent.ts'}) — ENOENT only at runtime",
		category: "misses",
		call: call("read", { path: "nonexistent.ts" }),
		expected: { tier: "pass" },
		baselineFails: true,
	},
	{
		label: "bash('node missing.js') — runtime exec failure",
		category: "misses",
		call: call("bash", { command: "node missing.js" }),
		expected: { tier: "pass" },
		baselineFails: true,
	},
	{
		label: "edit oldText that does not exist — caught by edit-diff",
		category: "misses",
		call: call("edit", { path: "x", edits: [{ oldText: "doesnotexist", newText: "y" }] }),
		expected: { tier: "pass" },
		baselineFails: true,
	},
	{
		label: "write to a read-only file — caught by filesystem",
		category: "misses",
		call: call("write", { path: "/protected/path", content: "x" }),
		expected: { tier: "pass" },
		baselineFails: true,
	},
];

interface EntryResult {
	entry: BenchEntry;
	actualTier: Tier;
	actualRuleId: string | undefined;
	matchedExpectation: boolean;
	durationUs: number;
}

function runOnce(): EntryResult[] {
	// Synthetic mode exercises every rule, including opt-in tiers (Tier 2), so
	// the smoke test catches regressions even on tiers that are off by default
	// in production. Replay mode uses the production defaults.
	const registry = createDefaultToolRewriteRegistry({ enableTier2: true });
	const results: EntryResult[] = [];
	for (const entry of CORPUS) {
		const start = performance.now();
		const outcome = registry.apply(entry.call);
		const durationUs = (performance.now() - start) * 1000;

		let actualTier: Tier;
		let actualRuleId: string | undefined;
		if (outcome.kind === "pass") {
			actualTier = "pass";
			actualRuleId = undefined;
		} else if (outcome.kind === "rewritten") {
			actualTier = "auto";
			// Use the first rule id when multiple chained; matches single-rule expected.ruleId.
			actualRuleId = outcome.ruleIds[0];
		} else {
			// outcome.kind === "rejected" — distinguish suggest vs block by rule id lookup.
			// The registry doesn't expose the tier post-hoc, so fall back to the expected
			// tier when the rule id matches what we expected; otherwise label as "block"
			// since both suggest and block produce "rejected".
			actualRuleId = outcome.ruleId;
			actualTier = entry.expected.ruleId === outcome.ruleId ? entry.expected.tier : "block";
		}

		const matched =
			actualTier === entry.expected.tier &&
			(entry.expected.ruleId === undefined || actualRuleId === entry.expected.ruleId);

		results.push({ entry, actualTier, actualRuleId, durationUs, matchedExpectation: matched });
	}
	return results;
}

function pct(numerator: number, denominator: number): number {
	if (denominator === 0) return 0;
	return numerator / denominator;
}

function fmtPct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function fmtMicro(value: number): string {
	return `${value.toFixed(2)}µs`;
}

function summarize(results: EntryResult[]): void {
	const verbose = process.env.BENCH_VERBOSE === "1";

	const byCategory = new Map<Category, EntryResult[]>();
	for (const result of results) {
		const bucket = byCategory.get(result.entry.category) ?? [];
		bucket.push(result);
		byCategory.set(result.entry.category, bucket);
	}

	console.log("=== Tool-rewrite registry benchmark ===");
	console.log(`Corpus size: ${results.length}`);
	console.log("");

	const categoryOrder: Category[] = ["tier1-alias", "tier2-bash-sub", "tier3-block", "control-passes", "misses"];
	for (const category of categoryOrder) {
		const bucket = byCategory.get(category) ?? [];
		if (bucket.length === 0) continue;
		const matched = bucket.filter((r) => r.matchedExpectation).length;
		const total = bucket.length;
		console.log(`[${category}]  ${matched}/${total} matched expectation (${fmtPct(pct(matched, total))})`);
		if (verbose || matched < total) {
			for (const result of bucket) {
				const status = result.matchedExpectation ? "✓" : "✗";
				const expected = `${result.entry.expected.tier}${result.entry.expected.ruleId ? ` (${result.entry.expected.ruleId})` : ""}`;
				const actual = `${result.actualTier}${result.actualRuleId ? ` (${result.actualRuleId})` : ""}`;
				console.log(`  ${status} ${result.entry.label}`);
				if (!result.matchedExpectation) {
					console.log(`      expected: ${expected}`);
					console.log(`      actual:   ${actual}`);
				}
			}
		}
		console.log("");
	}

	// Rescue rate — what fraction of would-have-failed calls did the registry catch?
	const failingEntries = results.filter((r) => r.entry.baselineFails);
	const rescuedEntries = failingEntries.filter((r) => r.actualTier !== "pass");
	const rescueRate = pct(rescuedEntries.length, failingEntries.length);

	// False-positive rate — controls that the registry incorrectly intervened on.
	const controlEntries = results.filter((r) => r.entry.category === "control-passes");
	const falsePositives = controlEntries.filter((r) => r.actualTier !== "pass");
	const falsePositiveRate = pct(falsePositives.length, controlEntries.length);

	console.log("=== Aggregate ===");
	console.log(
		`Rescue rate:        ${rescuedEntries.length}/${failingEntries.length} broken calls caught (${fmtPct(rescueRate)})`,
	);
	console.log(
		`Misses:             ${failingEntries.length - rescuedEntries.length}/${failingEntries.length} broken calls slipped through (${fmtPct(1 - rescueRate)})`,
	);
	console.log(
		`False positives:    ${falsePositives.length}/${controlEntries.length} controls misfired on (${fmtPct(falsePositiveRate)})`,
	);
	console.log("");

	// Latency summary across all entries.
	const sorted = [...results].map((r) => r.durationUs).sort((a, b) => a - b);
	const p50 = sorted[Math.floor(sorted.length * 0.5)];
	const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
	const maxDuration = sorted[sorted.length - 1];
	const sum = sorted.reduce((acc, value) => acc + value, 0);
	const mean = sum / sorted.length;

	console.log("=== Latency per apply() call ===");
	console.log(`  p50: ${fmtMicro(p50)}`);
	console.log(`  p99: ${fmtMicro(p99)}`);
	console.log(`  max: ${fmtMicro(maxDuration)}`);
	console.log(`  avg: ${fmtMicro(mean)}`);
	console.log("");

	// METRIC lines for autoresearch / CI scraping.
	console.log("=== Machine-readable metrics ===");
	console.log(`METRIC bench-tool-rewrites.corpus_size=${results.length}`);
	console.log(`METRIC bench-tool-rewrites.rescue_rate=${rescueRate.toFixed(4)}`);
	console.log(`METRIC bench-tool-rewrites.rescued_count=${rescuedEntries.length}`);
	console.log(`METRIC bench-tool-rewrites.broken_count=${failingEntries.length}`);
	console.log(`METRIC bench-tool-rewrites.false_positive_rate=${falsePositiveRate.toFixed(4)}`);
	console.log(`METRIC bench-tool-rewrites.latency_p50_us=${p50.toFixed(2)}`);
	console.log(`METRIC bench-tool-rewrites.latency_p99_us=${p99.toFixed(2)}`);
	for (const category of categoryOrder) {
		const bucket = byCategory.get(category) ?? [];
		if (bucket.length === 0) continue;
		const matched = bucket.filter((r) => r.matchedExpectation).length;
		console.log(`METRIC bench-tool-rewrites.${category}.coverage=${pct(matched, bucket.length).toFixed(4)}`);
		console.log(`METRIC bench-tool-rewrites.${category}.entries=${bucket.length}`);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Replay mode — measure the registry against ACTUAL recorded sessions
// ─────────────────────────────────────────────────────────────────────────────

interface ReplayCall {
	sessionFile: string;
	toolCallId: string;
	name: string;
	arguments: Record<string, unknown>;
	actualOutcome: "success" | "error" | "unknown";
	/** Joined text content of the matching toolResult message. Empty when missing. */
	errorText: string;
}

interface AssistantContentBlock {
	type: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}

interface ToolResultContentBlock {
	type: string;
	toolCallId?: string;
	text?: string;
}

interface MessageEvent {
	type: "message";
	message: {
		role: "user" | "assistant" | "toolResult";
		content?: AssistantContentBlock[] | ToolResultContentBlock[] | string;
		toolCallId?: string;
		isError?: boolean;
	};
}

async function parseSessionFile(file: string): Promise<ReplayCall[]> {
	const calls = new Map<string, ReplayCall>();
	const stream = createReadStream(file, { encoding: "utf-8" });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });

	for await (const line of lines) {
		if (!line) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// Partial trailing line from a crashed write — skip.
			continue;
		}
		if (!parsed || typeof parsed !== "object") continue;
		const event = parsed as Partial<MessageEvent>;
		if (event.type !== "message") continue;
		const message = event.message;
		if (!message || typeof message !== "object") continue;

		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content as AssistantContentBlock[]) {
				if (block.type !== "toolCall") continue;
				if (!block.id || !block.name) continue;
				if (!block.arguments || typeof block.arguments !== "object") continue;
				calls.set(block.id, {
					sessionFile: file,
					toolCallId: block.id,
					name: block.name,
					arguments: block.arguments as Record<string, unknown>,
					actualOutcome: "unknown",
					errorText: "",
				});
			}
			continue;
		}

		if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			const existing = calls.get(message.toolCallId);
			if (!existing) continue;
			existing.actualOutcome = message.isError === true ? "error" : "success";
			if (Array.isArray(message.content)) {
				const parts: string[] = [];
				for (const block of message.content as ToolResultContentBlock[]) {
					if (block && block.type === "text" && typeof block.text === "string") {
						parts.push(block.text);
					}
				}
				existing.errorText = parts.join("\n");
			}
		}
	}

	return Array.from(calls.values());
}

async function loadReplayCalls(patterns: string[]): Promise<ReplayCall[]> {
	const files = new Set<string>();
	for (const pattern of patterns) {
		const matched = await glob(pattern, { absolute: true, nodir: true });
		for (const file of matched) {
			if (file.endsWith(".jsonl")) {
				files.add(file);
			}
		}
	}
	if (files.size === 0) return [];
	const all: ReplayCall[] = [];
	for (const file of files) {
		try {
			const calls = await parseSessionFile(file);
			for (const c of calls) all.push(c);
		} catch (error) {
			console.warn(`Skipped ${file}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return all;
}

interface ReplayClassification {
	call: ReplayCall;
	registryAction: "pass" | "auto" | "intervene";
	registryRuleIds: string[];
	/**
	 *  true_positive  : registry would have intervened AND actual outcome was error
	 *  false_positive : registry would have intervened AND actual outcome was success
	 *  rewrite_assist : registry auto-rewrote silently — neutral
	 *  false_negative : registry passed AND actual outcome was error
	 *  true_negative  : registry passed AND actual outcome was success
	 *  unknown        : actual outcome was unknown (no matching toolResult)
	 */
	bucket: "true_positive" | "false_positive" | "rewrite_assist" | "false_negative" | "true_negative" | "unknown";
	/**
	 * Tier 4 hint rules that would have fired on this call's error. Empty when
	 * the call did not error or when no rule matched.
	 */
	hintRuleIds: string[];
}

function classifyReplay(calls: ReplayCall[]): ReplayClassification[] {
	const rewriteRegistry = createDefaultToolRewriteRegistry();
	const hintRegistry = createDefaultToolErrorHintRegistry();
	const results: ReplayClassification[] = [];
	for (const call of calls) {
		const outcome = rewriteRegistry.apply({
			type: "toolCall",
			id: call.toolCallId,
			name: call.name,
			arguments: call.arguments,
		});

		let action: ReplayClassification["registryAction"];
		let ruleIds: string[] = [];
		if (outcome.kind === "pass") {
			action = "pass";
		} else if (outcome.kind === "rewritten") {
			action = "auto";
			ruleIds = outcome.ruleIds;
		} else {
			action = "intervene";
			ruleIds = [outcome.ruleId];
		}

		let bucket: ReplayClassification["bucket"];
		if (action === "auto") {
			bucket = "rewrite_assist";
		} else if (action === "pass") {
			if (call.actualOutcome === "error") bucket = "false_negative";
			else if (call.actualOutcome === "success") bucket = "true_negative";
			else bucket = "unknown";
		} else {
			if (call.actualOutcome === "error") bucket = "true_positive";
			else if (call.actualOutcome === "success") bucket = "false_positive";
			else bucket = "unknown";
		}

		// Tier 4 only fires on actual errors that REACH execution. The rewrite
		// registry's true_positive/false_positive buckets are intervened-before-
		// execution so Tier 4 does not apply there — only false_negative
		// (pass-through that errored at runtime) is a valid hint target.
		let hintRuleIds: string[] = [];
		if (bucket === "false_negative") {
			const hintOutcome = hintRegistry.apply(
				{ type: "toolCall", id: call.toolCallId, name: call.name, arguments: call.arguments },
				{ content: [{ type: "text", text: call.errorText }], details: undefined },
			);
			hintRuleIds = hintOutcome.hints.map((h) => h.ruleId);
		}

		results.push({ call, registryAction: action, registryRuleIds: ruleIds, bucket, hintRuleIds });
	}
	return results;
}

function summarizeReplay(results: ReplayClassification[]): void {
	const verbose = process.env.BENCH_VERBOSE === "1";
	const total = results.length;

	const counts = {
		true_positive: 0,
		false_positive: 0,
		rewrite_assist: 0,
		false_negative: 0,
		true_negative: 0,
		unknown: 0,
	};
	for (const r of results) counts[r.bucket] += 1;

	const actualErrors = counts.true_positive + counts.false_negative;
	const actualSuccesses = counts.false_positive + counts.true_negative + counts.rewrite_assist;
	const rescueRate = pct(counts.true_positive, actualErrors);
	const falsePositiveRate = pct(counts.false_positive, actualSuccesses);

	const ruleFires = new Map<string, number>();
	for (const r of results) {
		for (const id of r.registryRuleIds) {
			ruleFires.set(id, (ruleFires.get(id) ?? 0) + 1);
		}
	}
	const rulesSorted = Array.from(ruleFires.entries()).sort((a, b) => b[1] - a[1]);

	const perTool = new Map<string, { total: number; errors: number; rescued: number }>();
	for (const r of results) {
		const bucket = perTool.get(r.call.name) ?? { total: 0, errors: 0, rescued: 0 };
		bucket.total += 1;
		if (r.call.actualOutcome === "error") bucket.errors += 1;
		if (r.bucket === "true_positive") bucket.rescued += 1;
		perTool.set(r.call.name, bucket);
	}
	const perToolSorted = Array.from(perTool.entries()).sort((a, b) => b[1].total - a[1].total);

	console.log("=== Tool-rewrite registry replay benchmark ===");
	console.log(`Calls analyzed:     ${total}`);
	console.log(`Actual successes:   ${actualSuccesses}`);
	console.log(`Actual errors:      ${actualErrors}`);
	console.log(`Unknown outcomes:   ${counts.unknown}  (no matching tool-result event)`);
	console.log("");

	console.log("=== Confusion buckets ===");
	console.log(
		`true_positive   ${counts.true_positive.toString().padStart(5)}  — registry would have blocked an error`,
	);
	console.log(
		`false_positive  ${counts.false_positive.toString().padStart(5)}  — registry would have blocked a success`,
	);
	console.log(
		`rewrite_assist  ${counts.rewrite_assist.toString().padStart(5)}  — registry silently rewrote args (neutral)`,
	);
	console.log(`false_negative  ${counts.false_negative.toString().padStart(5)}  — error the registry can't catch`);
	console.log(`true_negative   ${counts.true_negative.toString().padStart(5)}  — success correctly passed through`);
	console.log("");

	console.log("=== Aggregate ===");
	console.log(
		`Rescue rate:        ${counts.true_positive}/${actualErrors} real errors caught (${fmtPct(rescueRate)})`,
	);
	console.log(
		`False positive:     ${counts.false_positive}/${actualSuccesses} successes misfired on (${fmtPct(falsePositiveRate)})`,
	);
	console.log(`Silent rewrites:    ${counts.rewrite_assist}/${total} calls auto-corrected before execution`);
	console.log("");

	// Tier 4 coverage: of the false_negative errors (failures that slipped past
	// the rewrite registry), how many would now carry a hint? This is the
	// realistic measure of Tier 4's impact since real workloads dominate the
	// false_negative bucket.
	const falseNegatives = results.filter((r) => r.bucket === "false_negative");
	const hintedFalseNegatives = falseNegatives.filter((r) => r.hintRuleIds.length > 0);
	const tier4Coverage = pct(hintedFalseNegatives.length, falseNegatives.length);
	const hintRuleFires = new Map<string, number>();
	for (const r of falseNegatives) {
		for (const id of r.hintRuleIds) {
			hintRuleFires.set(id, (hintRuleFires.get(id) ?? 0) + 1);
		}
	}
	const hintRulesSorted = Array.from(hintRuleFires.entries()).sort((a, b) => b[1] - a[1]);

	console.log("=== Tier 4 hint coverage (post-hoc enrichment) ===");
	console.log(
		`Errors enriched:    ${hintedFalseNegatives.length}/${falseNegatives.length} false_negative errors got a [hint] block (${fmtPct(tier4Coverage)})`,
	);
	if (hintRulesSorted.length > 0) {
		console.log("Top Tier 4 rules:");
		for (const [ruleId, n] of hintRulesSorted.slice(0, 12)) {
			console.log(`  ${n.toString().padStart(5)}  ${ruleId}`);
		}
	}
	console.log("");
	console.log("");

	if (rulesSorted.length > 0) {
		console.log("=== Top rules by fire count ===");
		for (const [ruleId, n] of rulesSorted.slice(0, 12)) {
			console.log(`  ${n.toString().padStart(5)}  ${ruleId}`);
		}
		console.log("");
	}

	console.log("=== Per-tool breakdown ===");
	console.log("  tool                       total   errors   rescued");
	for (const [tool, stats] of perToolSorted) {
		const rescuePct = stats.errors > 0 ? fmtPct(stats.rescued / stats.errors) : "  -  ";
		console.log(
			`  ${tool.padEnd(24)}  ${stats.total.toString().padStart(5)}    ${stats.errors.toString().padStart(5)}    ${stats.rescued.toString().padStart(5)} (${rescuePct})`,
		);
	}
	console.log("");

	if (verbose) {
		console.log("=== Verbose: every intervention ===");
		for (const r of results) {
			if (r.bucket !== "true_positive" && r.bucket !== "false_positive" && r.bucket !== "rewrite_assist") {
				continue;
			}
			console.log(
				`  [${r.bucket}] ${r.call.name}  rules=${r.registryRuleIds.join(",")}  outcome=${r.call.actualOutcome}`,
			);
			console.log(`      ${JSON.stringify(r.call.arguments).slice(0, 200)}`);
		}
		console.log("");
	}

	console.log("=== Machine-readable metrics ===");
	console.log(`METRIC bench-tool-rewrites-replay.calls=${total}`);
	console.log(`METRIC bench-tool-rewrites-replay.actual_errors=${actualErrors}`);
	console.log(`METRIC bench-tool-rewrites-replay.actual_successes=${actualSuccesses}`);
	console.log(`METRIC bench-tool-rewrites-replay.true_positive=${counts.true_positive}`);
	console.log(`METRIC bench-tool-rewrites-replay.false_positive=${counts.false_positive}`);
	console.log(`METRIC bench-tool-rewrites-replay.rewrite_assist=${counts.rewrite_assist}`);
	console.log(`METRIC bench-tool-rewrites-replay.false_negative=${counts.false_negative}`);
	console.log(`METRIC bench-tool-rewrites-replay.true_negative=${counts.true_negative}`);
	console.log(`METRIC bench-tool-rewrites-replay.rescue_rate=${rescueRate.toFixed(4)}`);
	console.log(`METRIC bench-tool-rewrites-replay.false_positive_rate=${falsePositiveRate.toFixed(4)}`);
	console.log(`METRIC bench-tool-rewrites-replay.tier4_coverage=${tier4Coverage.toFixed(4)}`);
	console.log(`METRIC bench-tool-rewrites-replay.tier4_errors_enriched=${hintedFalseNegatives.length}`);
	console.log(`METRIC bench-tool-rewrites-replay.tier4_errors_total=${falseNegatives.length}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const replayIdx = args.indexOf("--replay");

if (replayIdx >= 0) {
	const patterns = args.slice(replayIdx + 1);
	if (patterns.length === 0) {
		console.error("--replay requires one or more glob patterns.");
		process.exit(2);
	}
	const calls = await loadReplayCalls(patterns);
	if (calls.length === 0) {
		console.error(`No tool calls found in matched files. Patterns: ${patterns.join(" ")}`);
		process.exit(2);
	}
	const classifications = classifyReplay(calls);
	summarizeReplay(classifications);
} else {
	// Warm up: first apply() pays a bit of V8 inline-cache cost; pre-warm so the
	// latency numbers reflect steady state, not cold start.
	const warmupResults = runOnce();
	void warmupResults; // explicit discard

	const results = runOnce();
	summarize(results);

	// Non-zero exit on misfire so this benchmark doubles as a smoke test in CI.
	const anyMismatch = results.some((r) => !r.matchedExpectation);
	if (anyMismatch) {
		process.exitCode = 1;
	}
}
