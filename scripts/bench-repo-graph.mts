import { performance } from "node:perf_hooks";
import {
	clearComposeContextMemoForTest,
	composeContext,
} from "../packages/coding-agent/src/core/conditioning/context-composer.ts";
import {
	clearLivingRepoMapMemoForTest,
	getLivingRepoMap,
	type RepoMapEntry,
} from "../packages/coding-agent/src/core/repo-map/living-index.ts";

const cwd = process.cwd();

async function measureMemoBypassedRefresh(samples = 10): Promise<number[]> {
	const values: number[] = [];
	for (let i = 0; i < samples; i++) {
		clearLivingRepoMapMemoForTest();
		const started = performance.now();
		await getLivingRepoMap(cwd);
		values.push(performance.now() - started);
	}
	return values;
}

async function measureWarmMemo(samples = 10): Promise<number[]> {
	const values: number[] = [];
	for (let i = 0; i < samples; i++) {
		clearLivingRepoMapMemoForTest();
		await getLivingRepoMap(cwd);
		const started = performance.now();
		await getLivingRepoMap(cwd);
		values.push(performance.now() - started);
	}
	return values;
}

async function measureConcurrentSingleFlight(): Promise<number> {
	clearLivingRepoMapMemoForTest();
	const started = performance.now();
	await Promise.all(Array.from({ length: 7 }, () => getLivingRepoMap(cwd)));
	return performance.now() - started;
}

const refreshSamples = await measureMemoBypassedRefresh();
const warmMemoSamples = await measureWarmMemo();
const concurrentSingleFlightMs = await measureConcurrentSingleFlight();

const { map } = await getLivingRepoMap(cwd);
const withoutEdges: RepoMapEntry[] = map.entries.map(({ deps: _deps, ...entry }) => entry);

function measurePrompt(prompt: string, entries: RepoMapEntry[]) {
	clearComposeContextMemoForTest();
	const result = composeContext({ entries, prompt, level: "padrao" });
	return { approxTokens: result.approxTokens, predicted: result.predicted };
}

function percentile(values: number[], fraction: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

const prompts = {
	naturalLanguage:
		"Revise o Graph que o Pit tem atualmente, se é robusto, inteligente e de fato proporciona economia.",
	codeSymbol: "Review `MAX_SYMBOLS_PER_FILE` and its direct dependents",
};

const context = Object.fromEntries(
	Object.entries(prompts).map(([name, prompt]) => {
		const withGraph = measurePrompt(prompt, map.entries);
		const withoutGraph = measurePrompt(prompt, withoutEdges);
		return [name, { withGraph, withoutGraph, graphTokenDelta: withGraph.approxTokens - withoutGraph.approxTokens }];
	}),
);

console.log(
	JSON.stringify(
		{
			memoBypassedRefreshMs: {
				p50: Number(percentile(refreshSamples, 0.5).toFixed(2)),
				p95: Number(percentile(refreshSamples, 0.95).toFixed(2)),
				samples: refreshSamples.map((value) => Number(value.toFixed(2))),
			},
			warmMemoMs: {
				p50: Number(percentile(warmMemoSamples, 0.5).toFixed(2)),
				p95: Number(percentile(warmMemoSamples, 0.95).toFixed(2)),
				samples: warmMemoSamples.map((value) => Number(value.toFixed(2))),
			},
			concurrentSingleFlightMs: Number(concurrentSingleFlightMs.toFixed(2)),
			entries: map.entries.length,
			context,
		},
		null,
		2,
	),
);
