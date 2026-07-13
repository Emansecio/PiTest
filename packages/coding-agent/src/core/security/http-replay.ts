import { createHash } from "node:crypto";
import { diffLines } from "diff";
import { request } from "undici";
import { canonicalizeBody } from "./finding-validator.ts";
import { redactHttpBody, redactHttpHeaders, redactHttpUrl } from "./redaction.ts";

export type HttpExperimentArm = "baseline" | "control" | "mutation";

export interface HttpRequestSpec {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	timeoutMs?: number;
}

export interface HttpReplayInput {
	baseline: HttpRequestSpec;
	control: HttpRequestSpec;
	mutation: HttpRequestSpec;
	samples?: number;
	maxResponseBytes?: number;
}

export interface HttpReplaySample {
	arm: HttpExperimentArm;
	round: number;
	status: number;
	headers: Record<string, string>;
	body: string;
	bodyTruncated: boolean;
	durationMs: number;
}

export interface HttpExperimentComparison {
	statusChanged: boolean;
	bodyChanged: boolean;
	statusOnly: boolean;
	consistent: Record<HttpExperimentArm, boolean>;
	bodyHashes: Record<HttpExperimentArm, string>;
	statusCodes: Record<HttpExperimentArm, number[]>;
	timingMs: Record<HttpExperimentArm, { samples: number[]; median: number }>;
	bodyDiff: Array<{ type: "added" | "removed" | "unchanged"; value: string }>;
}

export interface HttpReplayResult {
	requests: Record<HttpExperimentArm, HttpRequestSpec>;
	samples: HttpReplaySample[];
	comparison: HttpExperimentComparison;
}

function hashBody(body: string): string {
	return createHash("sha256").update(canonicalizeBody(body)).digest("hex");
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
}

export function compareHttpExperiment(samples: readonly HttpReplaySample[]): HttpExperimentComparison {
	const arms: HttpExperimentArm[] = ["baseline", "control", "mutation"];
	const byArm = Object.fromEntries(arms.map((arm) => [arm, samples.filter((sample) => sample.arm === arm)])) as Record<
		HttpExperimentArm,
		HttpReplaySample[]
	>;
	for (const arm of arms) if (byArm[arm].length === 0) throw new Error(`Missing ${arm} HTTP sample`);
	const hashes = Object.fromEntries(
		arms.map((arm) => [arm, byArm[arm].map((sample) => hashBody(sample.body))]),
	) as Record<HttpExperimentArm, string[]>;
	const representative = Object.fromEntries(arms.map((arm) => [arm, hashes[arm][0] as string])) as Record<
		HttpExperimentArm,
		string
	>;
	const statuses = Object.fromEntries(arms.map((arm) => [arm, byArm[arm].map((sample) => sample.status)])) as Record<
		HttpExperimentArm,
		number[]
	>;
	const bodyChanged =
		representative.mutation !== representative.baseline && representative.mutation !== representative.control;
	const statusChanged = statuses.mutation[0] !== statuses.baseline[0] || statuses.mutation[0] !== statuses.control[0];
	const baselineBody = canonicalizeBody(byArm.baseline[0]?.body ?? "");
	const mutationBody = canonicalizeBody(byArm.mutation[0]?.body ?? "");
	return {
		statusChanged,
		bodyChanged,
		statusOnly: statusChanged && !bodyChanged,
		consistent: Object.fromEntries(arms.map((arm) => [arm, new Set(hashes[arm]).size === 1])) as Record<
			HttpExperimentArm,
			boolean
		>,
		bodyHashes: representative,
		statusCodes: statuses,
		timingMs: Object.fromEntries(
			arms.map((arm) => {
				const timings = byArm[arm].map((sample) => sample.durationMs);
				return [arm, { samples: timings, median: median(timings) }];
			}),
		) as Record<HttpExperimentArm, { samples: number[]; median: number }>,
		bodyDiff: diffLines(baselineBody, mutationBody).map((part) => ({
			type: part.added ? "added" : part.removed ? "removed" : "unchanged",
			value: part.value,
		})),
	};
}

function responseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
	return redactHttpHeaders(
		Object.fromEntries(
			Object.entries(headers).map(([name, value]) => [
				name,
				Array.isArray(value) ? value.join(", ") : (value ?? ""),
			]),
		),
	);
}

async function executeRequest(
	arm: HttpExperimentArm,
	round: number,
	spec: HttpRequestSpec,
	maxResponseBytes: number,
	signal?: AbortSignal,
): Promise<HttpReplaySample> {
	const timeoutMs = Math.max(1, Math.min(60_000, spec.timeoutMs ?? 15_000));
	const started = performance.now();
	const response = await request(spec.url, {
		method: spec.method ?? (spec.body === undefined ? "GET" : "POST"),
		headers: spec.headers,
		body: spec.body,
		signal,
		headersTimeout: timeoutMs,
		bodyTimeout: timeoutMs,
	});
	const chunks: Buffer[] = [];
	let retained = 0;
	let total = 0;
	for await (const chunk of response.body) {
		const buffer = Buffer.from(chunk);
		total += buffer.length;
		if (retained >= maxResponseBytes) continue;
		const slice = buffer.subarray(0, maxResponseBytes - retained);
		chunks.push(slice);
		retained += slice.length;
	}
	return {
		arm,
		round,
		status: response.statusCode,
		headers: responseHeaders(response.headers),
		body: redactHttpBody(Buffer.concat(chunks).toString("utf8")),
		bodyTruncated: total > maxResponseBytes,
		durationMs: Number((performance.now() - started).toFixed(3)),
	};
}

function redactedRequest(spec: HttpRequestSpec): HttpRequestSpec {
	return {
		...spec,
		url: redactHttpUrl(spec.url),
		...(spec.headers ? { headers: redactHttpHeaders(spec.headers) } : {}),
		...(spec.body !== undefined ? { body: redactHttpBody(spec.body) } : {}),
	};
}

export function buildHttpReplayResult(
	requests: Record<HttpExperimentArm, HttpRequestSpec>,
	samples: HttpReplaySample[],
): HttpReplayResult {
	return {
		requests: {
			baseline: redactedRequest(requests.baseline),
			control: redactedRequest(requests.control),
			mutation: redactedRequest(requests.mutation),
		},
		samples,
		comparison: compareHttpExperiment(samples),
	};
}

export async function replayHttpExperiment(input: HttpReplayInput, signal?: AbortSignal): Promise<HttpReplayResult> {
	const count = Math.max(1, Math.min(10, Math.floor(input.samples ?? 1)));
	const maxResponseBytes = Math.max(1, Math.min(2 * 1024 * 1024, input.maxResponseBytes ?? 256 * 1024));
	const arms: HttpExperimentArm[] = ["baseline", "control", "mutation"];
	const samples: HttpReplaySample[] = [];
	for (let round = 0; round < count; round++) {
		for (const arm of arms) samples.push(await executeRequest(arm, round, input[arm], maxResponseBytes, signal));
	}
	return buildHttpReplayResult(
		{ baseline: input.baseline, control: input.control, mutation: input.mutation },
		samples,
	);
}
