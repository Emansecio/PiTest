/**
 * Realistic persistence benchmark.
 *
 * Microbench (bench-persistence.mts) measured ONLY the hot-path time of the
 * caller — fire-and-forget queue returns in ~0.03ms because it just pushes to
 * an array. Total disk work is the same. The 279x speedup it reports is
 * misleading for sessions where the next call is gated on the previous one
 * having durably landed.
 *
 * This bench measures END-TO-END wall: how long until every byte is acked
 * (sync) OR the queue has fully drained (async), per simulated turn.
 *
 * Session model: 30 turns. Each turn writes 5 entries back-to-back (1 user,
 * 1 assistant, 3 tool results) then sleeps 50ms to emulate the gap between
 * persistence and the next provider response.
 *
 * Strategies:
 *   A) sync   : current implementation (appendFileSync)
 *   B) queue  : async queue, hot-path returns immediately, single drain at
 *               turn end (closest realistic equivalent: agent_end waits for
 *               drain before returning)
 *   C) queue+ : async queue, drain ONCE at session end (most aggressive;
 *               crash window = whole session for unflushed entries)
 *
 * Metric: per-turn median wall, plus session-total wall. Comparison includes
 * "wall delta" vs sync so the real wall saved is visible.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { appendFile as appendFileP, mkdtemp as mkdtempP } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const TURNS = 30;
const ENTRIES_PER_TURN = 5;
const TURN_GAP_MS = 50;
const RUNS = 8;
const WARMUP = 2;

const entry = {
	type: "message",
	id: "abc123",
	parentId: "def456",
	timestamp: new Date().toISOString(),
	message: {
		role: "assistant",
		content: [{ type: "text", text: "x".repeat(500) }],
		api: "anthropic",
		provider: "anthropic",
		model: "claude-sonnet-4",
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
		stopReason: "stop",
		timestamp: Date.now(),
	},
};
const line = `${JSON.stringify(entry)}\n`;

async function makeTmp() {
	const d = await mkdtempP(join(tmpdir(), "pbench-real-"));
	const f = join(d, "session.jsonl");
	writeFileSync(f, "");
	return f;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A) sync: current implementation
async function runSync(): Promise<{ session: number; turn: number[] }> {
	const f = await makeTmp();
	const turn: number[] = [];
	const t0 = performance.now();
	for (let t = 0; t < TURNS; t++) {
		const tT = performance.now();
		for (let i = 0; i < ENTRIES_PER_TURN; i++) {
			appendFileSync(f, line);
		}
		turn.push(performance.now() - tT);
		if (t < TURNS - 1) await sleep(TURN_GAP_MS);
	}
	return { session: performance.now() - t0, turn };
}

// B) queue with drain at end of each turn (caller waits before yielding)
async function runQueueDrainPerTurn(): Promise<{ session: number; turn: number[] }> {
	const f = await makeTmp();
	const queue: string[] = [];
	let working = false;
	let drainResolve: (() => void) | null = null;

	const drain = (): Promise<void> => {
		if (!working && queue.length === 0) return Promise.resolve();
		return new Promise((r) => {
			drainResolve = r;
		});
	};

	const enqueue = (s: string) => {
		queue.push(s);
		if (working) return;
		working = true;
		void (async () => {
			try {
				while (queue.length > 0) {
					const batch = queue.splice(0, queue.length).join("");
					await appendFileP(f, batch);
				}
			} finally {
				working = false;
				if (drainResolve) {
					const r = drainResolve;
					drainResolve = null;
					r();
				}
			}
		})();
	};

	const turn: number[] = [];
	const t0 = performance.now();
	for (let t = 0; t < TURNS; t++) {
		const tT = performance.now();
		for (let i = 0; i < ENTRIES_PER_TURN; i++) enqueue(line);
		await drain();
		turn.push(performance.now() - tT);
		if (t < TURNS - 1) await sleep(TURN_GAP_MS);
	}
	return { session: performance.now() - t0, turn };
}

// C) queue, drain only at session end (aggressive)
async function runQueueDrainSession(): Promise<{ session: number; turn: number[] }> {
	const f = await makeTmp();
	const queue: string[] = [];
	let working = false;
	let drainResolve: (() => void) | null = null;

	const drain = (): Promise<void> => {
		if (!working && queue.length === 0) return Promise.resolve();
		return new Promise((r) => {
			drainResolve = r;
		});
	};

	const enqueue = (s: string) => {
		queue.push(s);
		if (working) return;
		working = true;
		void (async () => {
			try {
				while (queue.length > 0) {
					const batch = queue.splice(0, queue.length).join("");
					await appendFileP(f, batch);
				}
			} finally {
				working = false;
				if (drainResolve) {
					const r = drainResolve;
					drainResolve = null;
					r();
				}
			}
		})();
	};

	const turn: number[] = [];
	const t0 = performance.now();
	for (let t = 0; t < TURNS; t++) {
		const tT = performance.now();
		for (let i = 0; i < ENTRIES_PER_TURN; i++) enqueue(line);
		turn.push(performance.now() - tT);
		if (t < TURNS - 1) await sleep(TURN_GAP_MS);
	}
	await drain();
	return { session: performance.now() - t0, turn };
}

function summarize(samples: number[]) {
	const s = [...samples].sort((a, b) => a - b);
	const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
	return { min: s[0], median: s[Math.floor(s.length / 2)], mean, max: s[s.length - 1] };
}

async function run(label: string, fn: () => Promise<{ session: number; turn: number[] }>) {
	for (let i = 0; i < WARMUP; i++) await fn();
	const sessionSamples: number[] = [];
	const turnSamples: number[] = [];
	for (let i = 0; i < RUNS; i++) {
		const r = await fn();
		sessionSamples.push(r.session);
		for (const t of r.turn) turnSamples.push(t);
	}
	const session = summarize(sessionSamples);
	const turn = summarize(turnSamples);
	console.log(
		`${label.padEnd(40)} session=${session.median.toFixed(0)}ms (idle removed: ${(
			session.median -
			TURN_GAP_MS * (TURNS - 1)
		).toFixed(0)}ms)  turn=${turn.median.toFixed(2)}ms (max ${turn.max.toFixed(2)}ms)`,
	);
	return { session, turn };
}

console.log(
	`\n=== ${TURNS} turns x ${ENTRIES_PER_TURN} entries, ${TURN_GAP_MS}ms idle gap, ${RUNS} runs ===\n`,
);
console.log("(idle removed = wall - expected sleep total; isolates persistence cost)\n");

const a = await run("A: sync (current)               ", runSync);
const b = await run("B: queue, drain per turn        ", runQueueDrainPerTurn);
const c = await run("C: queue, drain at session end  ", runQueueDrainSession);

const sleepBudget = TURN_GAP_MS * (TURNS - 1);
const persistA = a.session.median - sleepBudget;
const persistB = b.session.median - sleepBudget;
const persistC = c.session.median - sleepBudget;
console.log(
	`\n=== persistence-only cost (median, idle removed) ===\nA sync   : ${persistA.toFixed(0)}ms\nB drainPerTurn : ${persistB.toFixed(0)}ms  (save ${(persistA - persistB).toFixed(0)}ms, ${((persistA / Math.max(1, persistB)) * 1).toFixed(2)}x)\nC drainSession : ${persistC.toFixed(0)}ms  (save ${(persistA - persistC).toFixed(0)}ms, ${((persistA / Math.max(1, persistC)) * 1).toFixed(2)}x)`,
);

console.log(`\nMETRIC sync_session_ms=${a.session.median.toFixed(0)}`);
console.log(`METRIC sync_turn_ms=${a.turn.median.toFixed(2)}`);
console.log(`METRIC queue_per_turn_session_ms=${b.session.median.toFixed(0)}`);
console.log(`METRIC queue_per_turn_turn_ms=${b.turn.median.toFixed(2)}`);
console.log(`METRIC queue_per_session_session_ms=${c.session.median.toFixed(0)}`);
console.log(`METRIC queue_per_session_turn_ms=${c.turn.median.toFixed(2)}`);
console.log(`METRIC persist_only_sync_ms=${persistA.toFixed(0)}`);
console.log(`METRIC persist_only_queue_turn_ms=${persistB.toFixed(0)}`);
console.log(`METRIC persist_only_queue_session_ms=${persistC.toFixed(0)}`);
console.log(`METRIC total_ms=${a.session.median.toFixed(0)}`);
