/**
 * Tool-call latency benchmark for the agent loop.
 *
 * Two scenarios:
 *  - fanout: 1 turn with N parallel tool calls (measures per-call overhead inside one batch)
 *  - turns: N turns of 1 tool call each (measures per-turn overhead: convert/transform/emit)
 *
 * Emits METRIC lines for autoresearch.
 */

import { performance } from "node:perf_hooks";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	type FauxResponseStep,
	registerFauxProvider,
} from "@earendil-works/pi-ai";

const FANOUT_CALLS = Number(process.env.BENCH_FANOUT ?? 20);
const TURN_COUNT = Number(process.env.BENCH_TURNS ?? 30);
const RUNS = Number(process.env.BENCH_RUNS ?? 5);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 2);

function makeNoopTool(name: string): AgentTool<any> {
	return {
		name,
		label: name,
		description: `noop ${name}`,
		parameters: { type: "object", properties: {} } as any,
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	};
}

const TOOLS: AgentTool<any>[] = [
	makeNoopTool("noop_a"),
	makeNoopTool("noop_b"),
	makeNoopTool("noop_c"),
];

function fanoutResponses(n: number): FauxResponseStep[] {
	const calls = Array.from({ length: n }, (_, i) =>
		fauxToolCall(TOOLS[i % TOOLS.length].name, {}, { id: `c${i}` }),
	);
	const first = fauxAssistantMessage(calls, { stopReason: "toolUse" });
	const done = fauxAssistantMessage("done", { stopReason: "stop" });
	return [first, done];
}

function turnsResponses(n: number): FauxResponseStep[] {
	const steps: FauxResponseStep[] = [];
	for (let i = 0; i < n; i++) {
		steps.push(
			fauxAssistantMessage([fauxToolCall(TOOLS[i % TOOLS.length].name, {}, { id: `t${i}` })], {
				stopReason: "toolUse",
			}),
		);
	}
	steps.push(fauxAssistantMessage("done", { stopReason: "stop" }));
	return steps;
}

async function runOnce(scenario: "fanout" | "turns"): Promise<number> {
	const faux = registerFauxProvider({});
	const model = faux.getModel();
	faux.setResponses(scenario === "fanout" ? fanoutResponses(FANOUT_CALLS) : turnsResponses(TURN_COUNT));

	const agent = new Agent({
		getApiKey: () => "k",
		initialState: { model, systemPrompt: "bench", tools: TOOLS },
	});

	const start = performance.now();
	await agent.prompt("go");
	await agent.waitForIdle();
	const elapsed = performance.now() - start;

	faux.unregister();
	return elapsed;
}

function stats(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	const sum = values.reduce((a, b) => a + b, 0);
	return {
		min: sorted[0],
		median: sorted[Math.floor(sorted.length / 2)],
		mean: sum / values.length,
		max: sorted[sorted.length - 1],
	};
}

async function benchScenario(name: "fanout" | "turns") {
	for (let i = 0; i < WARMUP; i++) await runOnce(name);
	const samples: number[] = [];
	for (let i = 0; i < RUNS; i++) samples.push(await runOnce(name));
	const s = stats(samples);
	console.log(
		`${name}: min=${s.min.toFixed(2)}ms median=${s.median.toFixed(2)}ms mean=${s.mean.toFixed(2)}ms max=${s.max.toFixed(2)}ms`,
	);
	return s;
}

const fan = await benchScenario("fanout");
const tur = await benchScenario("turns");

const fanPerCall = fan.median / FANOUT_CALLS;
const turPerTurn = tur.median / TURN_COUNT;
const total = fan.median + tur.median;

console.log(`fanout per call: ${fanPerCall.toFixed(3)}ms`);
console.log(`turns  per turn: ${turPerTurn.toFixed(3)}ms`);

console.log(`METRIC total_ms=${total.toFixed(3)}`);
console.log(`METRIC fanout_median_ms=${fan.median.toFixed(3)}`);
console.log(`METRIC turns_median_ms=${tur.median.toFixed(3)}`);
console.log(`METRIC fanout_per_call_ms=${fanPerCall.toFixed(3)}`);
console.log(`METRIC turns_per_turn_ms=${turPerTurn.toFixed(3)}`);
