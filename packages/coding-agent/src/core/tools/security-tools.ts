import { readFileSync, statSync } from "node:fs";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import { getCurrentChromeDevtoolsManager, type NetworkEntry } from "../chrome/chrome-devtools-manager.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { redactSecrets } from "../secret-redactor.ts";
import { SecurityEvidenceStore } from "../security/evidence-store.ts";
import type { FindingEvent, FindingState } from "../security/finding-lifecycle.ts";
import { type FindingValidationInput, validateFinding } from "../security/finding-validator.ts";
import {
	buildHttpReplayResult,
	type HttpExperimentArm,
	type HttpReplaySample,
	type HttpRequestSpec,
	replayHttpExperiment,
} from "../security/http-replay.ts";
import { buildOpenApiInventory } from "../security/openapi-inventory.ts";
import { scanSecurityStatic } from "../security/static-scan.ts";
import { resolveToCwd } from "./path-utils.ts";

const MAX_OPENAPI_BYTES = 4 * 1024 * 1024;

export interface SecurityToolsOptions {
	agentDir?: string;
}

function jsonResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: redactSecrets(JSON.stringify(value, null, 2)).redacted }],
		details: undefined,
	};
}

const surfaceMapSchema = Type.Object(
	{
		path: Type.Optional(Type.String({ description: "Local OpenAPI/Swagger JSON or YAML file." })),
		content: Type.Optional(Type.String({ description: "Inline OpenAPI/Swagger JSON or YAML content." })),
	},
	{ additionalProperties: false },
);

const staticScanSchema = Type.Object(
	{
		path: Type.Optional(Type.String({ description: "File or directory to scan. Default: cwd." })),
		language: Type.Optional(Type.Union([Type.Literal("ts"), Type.Literal("tsx"), Type.Literal("js")])),
		pack: Type.Optional(Type.Literal("javascript-core")),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
	},
	{ additionalProperties: false },
);

const httpRequestSchema = Type.Object(
	{
		url: Type.String(),
		method: Type.Optional(Type.String()),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		body: Type.Optional(Type.String()),
		timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 60_000 })),
	},
	{ additionalProperties: false },
);

const requestPatchSchema = Type.Object(
	{
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		body: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const explicitReplaySchema = Type.Object(
	{
		baseline: httpRequestSchema,
		control: httpRequestSchema,
		mutation: httpRequestSchema,
		samples: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
		maxResponseBytes: Type.Optional(Type.Number({ minimum: 1, maximum: 2 * 1024 * 1024 })),
	},
	{ additionalProperties: false },
);

const capturedReplaySchema = Type.Object(
	{
		source: Type.Literal("chrome"),
		requestId: Type.String({ minLength: 1 }),
		hop: Type.Optional(Type.Number({ minimum: 0 })),
		control: Type.Optional(requestPatchSchema),
		mutation: requestPatchSchema,
		samples: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
		timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 60_000 })),
	},
	{ additionalProperties: false },
);

const replaySchema = Type.Union([explicitReplaySchema, capturedReplaySchema]);

const validateSchema = Type.Object(
	{
		currentState: Type.Union([Type.Literal("candidate"), Type.Literal("reproduced")]),
		marker: Type.Object({
			value: Type.String(),
			baselineBody: Type.String(),
			controlBody: Type.String(),
			mutationBody: Type.String(),
		}),
		bodies: Type.Object({ baseline: Type.String(), control: Type.String(), mutation: Type.String() }),
		reproduction: Type.Object({ attempts: Type.Array(Type.Boolean()) }),
		timing: Type.Optional(
			Type.Object({
				claimed: Type.Boolean(),
				interleaved: Type.Boolean(),
				baselineMs: Type.Array(Type.Number()),
				controlMs: Type.Array(Type.Number()),
				mutationMs: Type.Array(Type.Number()),
			}),
		),
		chain: Type.Optional(
			Type.Object({
				required: Type.Boolean(),
				complete: Type.Boolean(),
				steps: Type.Array(Type.Object({ name: Type.String(), evidenceIds: Type.Array(Type.String()) })),
			}),
		),
	},
	{ additionalProperties: false },
);

const evidenceSchema = Type.Object(
	{
		action: Type.Union([
			Type.Literal("list"),
			Type.Literal("get"),
			Type.Literal("append_finding"),
			Type.Literal("append_artifact"),
		]),
		findingId: Type.Optional(Type.String({ minLength: 1 })),
		state: Type.Optional(
			Type.Union([
				Type.Literal("candidate"),
				Type.Literal("reproduced"),
				Type.Literal("validated"),
				Type.Literal("retracted"),
			]),
		),
		summary: Type.Optional(Type.String()),
		source: Type.Optional(Type.String()),
		evidenceIds: Type.Optional(Type.Array(Type.String())),
		reason: Type.Optional(Type.String()),
		artifactName: Type.Optional(Type.String()),
		artifactContent: Type.Optional(Type.String({ maxLength: 1024 * 1024 })),
	},
	{ additionalProperties: false },
);

function requireText(value: string | undefined, name: string): string {
	if (!value?.trim()) throw new Error(`${name} is required for this action`);
	return value;
}

function findingEvent(input: Static<typeof evidenceSchema>): FindingEvent {
	const state = input.state as FindingState | undefined;
	if (!state) throw new Error("state is required for append_finding");
	if (state === "candidate") {
		return { state, summary: requireText(input.summary, "summary"), source: requireText(input.source, "source") };
	}
	if (state === "retracted") return { state, reason: requireText(input.reason, "reason"), summary: input.summary };
	return {
		state,
		summary: requireText(input.summary, "summary"),
		evidenceIds: input.evidenceIds?.filter(Boolean) ?? [],
	};
}

function requestFromPatch(
	source: NetworkEntry,
	patch: Static<typeof requestPatchSchema> | undefined,
	timeoutMs: number | undefined,
): HttpRequestSpec {
	return {
		url: source.url,
		method: source.method,
		...(patch?.headers ? { headers: patch.headers } : {}),
		...(patch?.body !== undefined ? { body: patch.body } : {}),
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
	};
}

function replaySample(arm: HttpExperimentArm, round: number, entry: NetworkEntry): HttpReplaySample {
	if (entry.status === undefined) {
		throw new Error(`Captured Chrome replay ${entry.requestId} completed without an HTTP response status`);
	}
	return {
		arm,
		round,
		status: entry.status,
		headers: entry.responseHeaders ?? {},
		body: entry.responseBody ?? "",
		bodyTruncated: entry.responseBodyTruncated ?? false,
		durationMs: entry.durationMs ?? 0,
	};
}

async function replayCapturedExperiment(input: Static<typeof capturedReplaySchema>, signal?: AbortSignal) {
	const manager = getCurrentChromeDevtoolsManager();
	if (!manager) throw new Error("Chrome DevTools is unavailable in this session");
	const source = manager.getNetworkEntry(input.requestId, input.hop);
	const count = Math.max(1, Math.min(10, Math.floor(input.samples ?? 1)));
	const arms: HttpExperimentArm[] = ["baseline", "control", "mutation"];
	const patches = { baseline: undefined, control: input.control, mutation: input.mutation } as const;
	const samples: HttpReplaySample[] = [];
	for (let round = 0; round < count; round++) {
		for (const arm of arms) {
			const entry = await manager.replayCapturedXhr(
				input.requestId,
				input.hop,
				patches[arm],
				signal,
				input.timeoutMs,
			);
			samples.push(replaySample(arm, round, entry));
		}
	}
	return buildHttpReplayResult(
		{
			baseline: requestFromPatch(source, undefined, input.timeoutMs),
			control: requestFromPatch(source, input.control, input.timeoutMs),
			mutation: requestFromPatch(source, input.mutation, input.timeoutMs),
		},
		samples,
	);
}

export function createSecuritySurfaceMapDefinition(cwd: string): ToolDefinition<typeof surfaceMapSchema, undefined> {
	return {
		name: "security_surface_map",
		activity: "navigation",
		label: "security_surface_map",
		description:
			"Parse a local OpenAPI or Swagger specification into a deterministic endpoint and request-template inventory. No remote references are fetched.",
		promptSnippet: "Inventory authorized API endpoints from local OpenAPI/Swagger content.",
		parameters: surfaceMapSchema,
		async execute(_id, input) {
			if (!!input.path === !!input.content) throw new Error("Provide exactly one of path or content");
			let content = input.content;
			if (input.path) {
				const path = resolveToCwd(input.path, cwd);
				if (statSync(path).size > MAX_OPENAPI_BYTES) throw new Error("OpenAPI file exceeds the 4 MiB limit");
				content = readFileSync(path, "utf8");
			}
			return jsonResult(await buildOpenApiInventory(content as string));
		},
	};
}

export function createSecurityStaticScanDefinition(cwd: string): ToolDefinition<typeof staticScanSchema, undefined> {
	return {
		name: "security_static_scan",
		activity: "navigation",
		label: "security_static_scan",
		description:
			"Run bundled security rule packs through Pit's existing ast_grep engine. Every match is a candidate, never a validated vulnerability.",
		promptSnippet: "Scan local JavaScript/TypeScript ASTs for security candidates.",
		parameters: staticScanSchema,
		async execute(_id, input) {
			return jsonResult(
				await scanSecurityStatic({
					path: resolveToCwd(input.path ?? ".", cwd),
					language: input.language ?? "ts",
					pack: input.pack,
					limit: input.limit,
				}),
			);
		},
	};
}

export function createSecurityHttpReplayDiffDefinition(_cwd: string): ToolDefinition<typeof replaySchema, undefined> {
	return {
		name: "security_http_replay_diff",
		activity: "navigation",
		label: "security_http_replay_diff",
		description:
			"Replay explicit HTTP requests or a captured Chrome XHR as baseline, control, and mutation in stable round order, then compare status, canonical body, headers, and timing.",
		promptSnippet: "Replay and diff baseline/control/mutation HTTP requests.",
		parameters: replaySchema,
		async execute(_id, input, signal) {
			if ("source" in input) return jsonResult(await replayCapturedExperiment(input, signal));
			return jsonResult(await replayHttpExperiment(input, signal));
		},
	};
}

export function createSecurityValidateFindingDefinition(
	_cwd: string,
): ToolDefinition<typeof validateSchema, undefined> {
	return {
		name: "security_validate_finding",
		activity: "navigation",
		label: "security_validate_finding",
		description:
			"Apply deterministic anti-false-positive checks: reproduced lifecycle, unique marker, body diff, clean reproduction, interleaved timing, and complete chain.",
		promptSnippet: "Validate a reproduced security finding with deterministic evidence checks.",
		parameters: validateSchema,
		async execute(_id, input) {
			return jsonResult(validateFinding(input as FindingValidationInput));
		},
	};
}

export function createSecurityEvidenceDefinition(
	cwd: string,
	options?: SecurityToolsOptions,
): ToolDefinition<typeof evidenceSchema, undefined> {
	return {
		name: "security_evidence",
		activity: "navigation",
		label: "security_evidence",
		description:
			"Append, list, or read redacted security evidence in Pit's agent directory. Finding lifecycle transitions are enforced before append.",
		promptSnippet: "Persist redacted evidence and lifecycle events for an authorized finding.",
		parameters: evidenceSchema,
		async execute(_id, input) {
			const store = new SecurityEvidenceStore(options?.agentDir ?? getAgentDir(), cwd);
			if (input.action === "list") return jsonResult(store.list());
			const findingId = requireText(input.findingId, "findingId");
			if (input.action === "get") return jsonResult(store.get(findingId));
			if (input.action === "append_finding") return jsonResult(store.appendFinding(findingId, findingEvent(input)));
			return jsonResult(
				store.appendArtifact(
					findingId,
					requireText(input.artifactName, "artifactName"),
					requireText(input.artifactContent, "artifactContent"),
				),
			);
		},
	};
}
