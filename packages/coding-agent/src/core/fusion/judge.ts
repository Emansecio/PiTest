import type { Context } from "@pit/ai";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { JudgeAnalysis, PanelResult } from "./types.ts";

const WRITER_SYSTEM =
	"You are the writer in a model-fusion pipeline. Using the judge's analysis, write the single " +
	"best answer to the task — take the best of each member rather than discarding one wholesale. " +
	"Add a one-line rationale only when you override one member in favor of the other.";

/** Build the synthesis (writer) context from the panel answers + judge analysis. */
export function buildWriterContext(userPrompt: string, results: PanelResult[], analysis: JudgeAnalysis): Context {
	const ans = results
		.map((r, i) => `### Member ${i + 1} (${r.member.cli}:${r.member.model})\n${r.ok ? r.text : "[failed]"}`)
		.join("\n\n");
	const a = JSON.stringify(analysis, null, 2);
	const content = `## Task\n${userPrompt}\n\n## Panel answers\n${ans}\n\n## Judge analysis\n${a}`;
	return {
		systemPrompt: WRITER_SYSTEM,
		messages: [{ role: "user", content, timestamp: Date.now() }],
	};
}

const SCHEMA_PROMPT_SUFFIX =
	"\n\nYour final assistant message MUST be a single fenced ```json``` block matching the schema. No prose outside the fence.";

const StringArray = Type.Array(Type.String());

export const JUDGE_SCHEMA = Type.Object(
	{
		consensus: StringArray,
		contradictions: StringArray,
		partialCoverage: StringArray,
		uniqueInsights: StringArray,
		blindSpots: StringArray,
	},
	{ additionalProperties: false },
);

export type JudgeSchema = Static<typeof JUDGE_SCHEMA>;

const JUDGE_SYSTEM =
	"You are the judge in a model-fusion pipeline. You are given the same task answered " +
	"independently by two panel members. Produce a structured analysis: where they agree " +
	"(consensus), where they conflict (contradictions), what only one covered (partialCoverage), " +
	"non-obvious points raised by one (uniqueInsights), and gaps both missed (blindSpots). " +
	"Report only what is actually present; do not invent." +
	SCHEMA_PROMPT_SUFFIX;

export function buildJudgeContext(userPrompt: string, results: PanelResult[]): Context {
	const blocks = results
		.map(
			(r, i) =>
				`### Panel member ${i + 1} (${r.member.cli}:${r.member.model})\n${r.ok ? r.text : `[failed: ${r.error ?? "unknown"}]`}`,
		)
		.join("\n\n");
	const content = `## Original task\n${userPrompt}\n\n## Panel answers\n${blocks}`;
	return {
		systemPrompt: JUDGE_SYSTEM,
		messages: [{ role: "user", content, timestamp: Date.now() }],
	};
}

const FENCE_RE = /```(?:json)?\s*([\s\S]*?)```/;

export function parseJudgeOutput(text: string): { ok: true; value: JudgeAnalysis } | { ok: false; error: string } {
	const trimmed = text.trim();
	const fenced = FENCE_RE.exec(trimmed);
	const candidate = (fenced ? fenced[1] : trimmed).trim();
	if (!candidate) return { ok: false, error: "empty judge output" };
	let value: unknown;
	try {
		value = JSON.parse(candidate);
	} catch (err) {
		return { ok: false, error: `json parse failed: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (!Value.Check(JUDGE_SCHEMA, value)) {
		const issues = [...Value.Errors(JUDGE_SCHEMA, value)]
			.slice(0, 3)
			.map((e) => `${e.instancePath || "/"}: ${e.message}`)
			.join("; ");
		return { ok: false, error: issues || "schema mismatch" };
	}
	return { ok: true, value: value as JudgeAnalysis };
}
