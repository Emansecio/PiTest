/**
 * Microbench: appendFileSync vs async write queue vs group-commit.
 *
 * Simulates 100 message_end events writing JSONL entries.
 */

import { appendFile, appendFileSync, mkdtemp, rm, writeFileSync } from "node:fs";
import { appendFile as appendFileP } from "node:fs/promises";
import { mkdtemp as mkdtempP } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const N = 100;
const RUNS = 10;
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
	const d = await mkdtempP(join(tmpdir(), "pbench-"));
	const f = join(d, "session.jsonl");
	writeFileSync(f, "");
	return { d, f };
}

// Strategy A: appendFileSync (current implementation)
async function syncAppend(): Promise<number> {
	const { f } = await makeTmp();
	const t0 = performance.now();
	for (let i = 0; i < N; i++) {
		appendFileSync(f, line);
	}
	return performance.now() - t0;
}

// Strategy B: async appendFile awaited sequentially
async function asyncAppendSerial(): Promise<number> {
	const { f } = await makeTmp();
	const t0 = performance.now();
	for (let i = 0; i < N; i++) {
		await appendFileP(f, line);
	}
	return performance.now() - t0;
}

// Strategy C: fire-and-forget queue with single writer worker
async function asyncQueue(): Promise<number> {
	const { f } = await makeTmp();
	const queue: string[] = [];
	let working = false;
	let drainResolve: (() => void) | null = null;

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

	const drain = (): Promise<void> => {
		if (!working && queue.length === 0) return Promise.resolve();
		return new Promise((r) => {
			drainResolve = r;
		});
	};

	const t0 = performance.now();
	for (let i = 0; i < N; i++) {
		enqueue(line);
	}
	const hotPath = performance.now() - t0;
	await drain();
	const total = performance.now() - t0;
	// return the hot path time (what user perceives in event loop)
	return hotPath;
}

// Strategy D: group commit — flush every K writes or T ms (whichever first)
async function groupCommit(): Promise<number> {
	const { f } = await makeTmp();
	const queue: string[] = [];
	let timer: NodeJS.Timeout | null = null;
	let flushing: Promise<void> | null = null;
	const FLUSH_EVERY_MS = 8;

	const flushNow = async () => {
		if (queue.length === 0) return;
		const batch = queue.splice(0, queue.length).join("");
		await appendFileP(f, batch);
	};

	const schedule = () => {
		if (timer) return;
		timer = setTimeout(() => {
			timer = null;
			flushing = flushNow();
		}, FLUSH_EVERY_MS);
	};

	const t0 = performance.now();
	for (let i = 0; i < N; i++) {
		queue.push(line);
		schedule();
	}
	const hotPath = performance.now() - t0;
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
	await flushNow();
	if (flushing) await flushing;
	return hotPath;
}

function summarize(samples: number[]) {
	const s = [...samples].sort((a, b) => a - b);
	const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
	return { min: s[0], median: s[Math.floor(s.length / 2)], mean };
}

async function run(label: string, fn: () => Promise<number>) {
	for (let i = 0; i < WARMUP; i++) await fn();
	const samples: number[] = [];
	for (let i = 0; i < RUNS; i++) samples.push(await fn());
	const s = summarize(samples);
	console.log(`${label.padEnd(40)} min=${s.min.toFixed(2)}ms median=${s.median.toFixed(2)}ms mean=${s.mean.toFixed(2)}ms`);
	return s;
}

console.log(`\n=== ${N} appends per run, ${RUNS} runs ===\n`);
const a = await run("A: appendFileSync (current)", syncAppend);
const b = await run("B: async appendFile (await each)", asyncAppendSerial);
const c = await run("C: async queue (fire-and-forget hot path)", asyncQueue);
const d = await run("D: group commit 8ms (hot path)", groupCommit);

console.log("\n=== speedups vs current ===");
console.log(`B vs A: ${(a.median / b.median).toFixed(2)}x`);
console.log(`C vs A: ${(a.median / c.median).toFixed(2)}x`);
console.log(`D vs A: ${(a.median / d.median).toFixed(2)}x`);

console.log(`METRIC sync_ms=${a.median.toFixed(3)}`);
console.log(`METRIC async_serial_ms=${b.median.toFixed(3)}`);
console.log(`METRIC async_queue_hot_ms=${c.median.toFixed(3)}`);
console.log(`METRIC group_commit_hot_ms=${d.median.toFixed(3)}`);
console.log(`METRIC total_ms=${(a.median + b.median).toFixed(3)}`);
