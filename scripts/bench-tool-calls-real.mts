/**
 * Realistic tool-call benchmark.
 *
 * Tools do actual IO (fs.readFile + child_process exec).
 * Compares: sequential vs parallel exec, with/without TUI-like emit listener.
 */

import { exec } from "node:child_process";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { Agent } from "../packages/agent/src/agent.js";
import type { AgentEvent, AgentTool } from "../packages/agent/src/types.js";
import {
	fauxAssistantMessage,
	fauxToolCall,
	type FauxResponseStep,
	registerFauxProvider,
} from "../packages/ai/src/providers/faux.js";

const execAsync = promisify(exec);
if (process.env.BENCH_LOG) (globalThis as any).__BENCH_LOG = true;
const FANOUT = Number(process.env.BENCH_FANOUT ?? 10);
const RUNS = Number(process.env.BENCH_RUNS ?? 5);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 2);

const tmp = await mkdtemp(join(tmpdir(), "bench-"));
const sampleFile = join(tmp, "sample.txt");
await writeFile(sampleFile, "x".repeat(2048));

function readTool(): AgentTool<any> {
	return {
		name: "read_file",
		label: "read_file",
		description: "read",
		parameters: { type: "object", properties: {} } as any,
		execute: async () => {
			const text = await readFile(sampleFile, "utf8");
			return { content: [{ type: "text", text }] };
		},
	};
}

function shellTool(): AgentTool<any> {
	return {
		name: "shell_echo",
		label: "shell_echo",
		description: "echo",
		parameters: { type: "object", properties: {} } as any,
		execute: async () => {
			const { stdout } = await execAsync("echo hello");
			return { content: [{ type: "text", text: stdout }] };
		},
	};
}

function buildResponses(n: number, toolName: string): FauxResponseStep[] {
	const calls = Array.from({ length: n }, (_, i) => fauxToolCall(toolName, {}, { id: `c${i}` }));
	return [
		fauxAssistantMessage(calls, { stopReason: "toolUse" }),
		fauxAssistantMessage("done", { stopReason: "stop" }),
	];
}

interface RunOpts {
	mode: "parallel" | "sequential";
	tool: AgentTool<any>;
	listenerWorkMs?: number;
	listenerCount?: number;
	beforeToolCallMs?: number;
}

async function runOnce(opts: RunOpts): Promise<{ elapsed: number; events: number }> {
	const faux = registerFauxProvider({});
	const model = faux.getModel();
	faux.setResponses(buildResponses(FANOUT, opts.tool.name));

	const agent = new Agent({
		getApiKey: () => "k",
		initialState: { model, systemPrompt: "bench", tools: [opts.tool] },
		toolExecution: opts.mode,
		beforeToolCall: opts.beforeToolCallMs
			? async () => {
					await new Promise((r) => setTimeout(r, opts.beforeToolCallMs));
					return undefined;
				}
			: undefined,
	});

	let events = 0;
	const counts: Record<string, number> = {};
	const listenerCount = opts.listenerCount ?? 1;
	for (let i = 0; i < listenerCount; i++) {
		agent.subscribe(async (e: AgentEvent) => {
			events++;
			counts[e.type] = (counts[e.type] ?? 0) + 1;
			if (opts.listenerWorkMs) {
				// simulate async work (e.g. IO, render flush)
				await new Promise((r) => setTimeout(r, opts.listenerWorkMs));
			}
		});
	}
	(globalThis as any).__lastCounts = counts;

	const start = performance.now();
	await agent.prompt("go");
	await agent.waitForIdle();
	const elapsed = performance.now() - start;
	faux.unregister();
	return { elapsed, events };
}

function summarize(samples: number[]) {
	const s = [...samples].sort((a, b) => a - b);
	const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
	return { min: s[0], median: s[Math.floor(s.length / 2)], mean, max: s[s.length - 1] };
}

async function bench(label: string, opts: RunOpts) {
	for (let i = 0; i < WARMUP; i++) await runOnce(opts);
	const samples: number[] = [];
	let lastEvents = 0;
	for (let i = 0; i < RUNS; i++) {
		const r = await runOnce(opts);
		samples.push(r.elapsed);
		lastEvents = r.events;
	}
	const s = summarize(samples);
	console.log(
		`${label.padEnd(40)} min=${s.min.toFixed(2)}ms median=${s.median.toFixed(2)}ms mean=${s.mean.toFixed(2)}ms (events=${lastEvents})`,
	);
	return s;
}

const readToolInst = readTool();
const shellToolInst = shellTool();

console.log(`\n=== fanout=${FANOUT}, runs=${RUNS} ===`);
console.log(`\n[read_file: fs.readFile 2KB]`);
const r_par = await bench("parallel,    no listener", { mode: "parallel", tool: readToolInst });
console.log("event breakdown:", (globalThis as any).__lastCounts);
const r_seq = await bench("sequential,  no listener", { mode: "sequential", tool: readToolInst });
const r_par_tui = await bench("parallel,    listener 1ms work", {
	mode: "parallel",
	tool: readToolInst,
	listenerWorkMs: 1,
});

console.log(`\n[shell_echo: spawn echo]`);
const s_par = await bench("parallel,    no listener", { mode: "parallel", tool: shellToolInst });
const s_seq = await bench("sequential,  no listener", { mode: "sequential", tool: shellToolInst });
const s_par_tui = await bench("parallel,    listener 1ms work", {
	mode: "parallel",
	tool: shellToolInst,
	listenerWorkMs: 1,
});

console.log(`\n[beforeToolCall hook simulating async permission check]`);
const hook_par = await bench("parallel + 5ms hook x 10 tools", {
	mode: "parallel",
	tool: readToolInst,
	beforeToolCallMs: 5,
});
const hook_seq = await bench("sequential + 5ms hook x 10 tools", {
	mode: "sequential",
	tool: readToolInst,
	beforeToolCallMs: 5,
});

console.log(`\n[multi-listener: shell parallel, 5 listeners, 1ms work each]`);
const m5 = await bench("5 listeners x 1ms", {
	mode: "parallel",
	tool: shellToolInst,
	listenerWorkMs: 1,
	listenerCount: 5,
});

// === streaming scenario: many message_update events from text deltas ===
console.log(`\n[streaming: long text response, many deltas]`);
async function runStream(opts: { listenerWorkMs?: number }) {
	const faux = registerFauxProvider({ tokenSize: { min: 4, max: 4 } });
	const model = faux.getModel();
	const longText = "word ".repeat(2000); // ~2000 chunks of ~4 chars
	faux.setResponses([fauxAssistantMessage(longText, { stopReason: "stop" })]);
	const agent = new Agent({
		getApiKey: () => "k",
		initialState: { model, systemPrompt: "bench", tools: [] },
	});
	let events = 0;
	let updates = 0;
	agent.subscribe(async (e) => {
		events++;
		if (e.type === "message_update") updates++;
		if (opts.listenerWorkMs) {
			await new Promise((r) => setTimeout(r, opts.listenerWorkMs));
		}
	});
	const t0 = performance.now();
	await agent.prompt("go");
	await agent.waitForIdle();
	const elapsed = performance.now() - t0;
	faux.unregister();
	return { elapsed, events, updates };
}
async function benchStream(label: string, opts: { listenerWorkMs?: number }) {
	for (let i = 0; i < WARMUP; i++) await runStream(opts);
	const samples: number[] = [];
	let last = { events: 0, updates: 0 };
	for (let i = 0; i < RUNS; i++) {
		const r = await runStream(opts);
		samples.push(r.elapsed);
		last = r;
	}
	const s = summarize(samples);
	console.log(
		`${label.padEnd(40)} median=${s.median.toFixed(2)}ms (events=${last.events}, updates=${last.updates})`,
	);
	return s;
}
const streamNoListener = await benchStream("stream, no listener work", {});
const streamWithListener = await benchStream("stream, 0.5ms listener work", { listenerWorkMs: 0.5 });

console.log("\n=== speedups ===");
console.log(`read  parallel vs sequential: ${(r_seq.median / r_par.median).toFixed(2)}x`);
console.log(`shell parallel vs sequential: ${(s_seq.median / s_par.median).toFixed(2)}x`);
console.log(`read  listener-1ms overhead: ${(r_par_tui.median - r_par.median).toFixed(2)}ms`);
console.log(`shell listener-1ms overhead: ${(s_par_tui.median - s_par.median).toFixed(2)}ms`);

console.log(`METRIC read_parallel_ms=${r_par.median.toFixed(3)}`);
console.log(`METRIC read_sequential_ms=${r_seq.median.toFixed(3)}`);
console.log(`METRIC read_listener_overhead_ms=${(r_par_tui.median - r_par.median).toFixed(3)}`);
console.log(`METRIC shell_parallel_ms=${s_par.median.toFixed(3)}`);
console.log(`METRIC shell_sequential_ms=${s_seq.median.toFixed(3)}`);
console.log(`METRIC shell_listener_overhead_ms=${(s_par_tui.median - s_par.median).toFixed(3)}`);
console.log(`METRIC multi5_listener_ms=${m5.median.toFixed(3)}`);
console.log(`METRIC stream_no_listener_ms=${streamNoListener.median.toFixed(3)}`);
console.log(`METRIC stream_with_listener_ms=${streamWithListener.median.toFixed(3)}`);
console.log(`METRIC hook_parallel_ms=${hook_par.median.toFixed(3)}`);
console.log(`METRIC hook_sequential_ms=${hook_seq.median.toFixed(3)}`);
console.log(`METRIC total_ms=${(r_par.median + r_seq.median + s_par.median + s_seq.median).toFixed(3)}`);
