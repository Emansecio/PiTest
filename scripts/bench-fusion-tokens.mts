/**
 * Synthetic Fusion turn token model (G4 / K9c). No provider or CLI calls.
 *
 * Estimates per-stage spend using the same char→token ratio as compaction benches
 * and documents expected Fusion ledger totals for CI regression.
 *
 * Usage: npx tsx scripts/bench-fusion-tokens.mts
 */
import { estimateCharsAsTokens } from "../packages/coding-agent/src/core/compaction/utils.ts";

/** Representative Fusion turn shapes (chars) — tuned to typical advisor output. */
const USER_PROMPT_CHARS = 480;
const BRIEF_OUTPUT_CHARS = 220;
const ADVISOR_PROMPT_CHARS = 520;
const ADVISOR_RESPONSE_CHARS = 12_000;
const PANEL_MEMBERS = 2;
const JUDGE_INPUT_CHARS = 28_000;
const JUDGE_OUTPUT_CHARS = 900;
const VERIFY_TOKENS = 14_000;
const WRITER_INPUT_CHARS = 32_000;
const WRITER_OUTPUT_CHARS = 2_400;

const briefTokens = estimateCharsAsTokens(BRIEF_OUTPUT_CHARS);
const panelTokens =
	PANEL_MEMBERS * estimateCharsAsTokens(ADVISOR_PROMPT_CHARS + ADVISOR_RESPONSE_CHARS);
const judgeTokens = estimateCharsAsTokens(JUDGE_INPUT_CHARS + JUDGE_OUTPUT_CHARS);
const verifyTokens = VERIFY_TOKENS;
const writerTokens = estimateCharsAsTokens(WRITER_INPUT_CHARS + WRITER_OUTPUT_CHARS);
const fusionTotal = briefTokens + panelTokens + judgeTokens + verifyTokens + writerTokens;

console.log("bench-fusion-tokens (synthetic, no provider)");
console.log(`user_prompt_chars:      ${USER_PROMPT_CHARS}`);
console.log(`brief_tokens:           ${briefTokens}`);
console.log(`panel_tokens:           ${panelTokens} (${PANEL_MEMBERS} members)`);
console.log(`judge_tokens:           ${judgeTokens}`);
console.log(`verify_tokens:          ${verifyTokens}`);
console.log(`writer_tokens:          ${writerTokens}`);
console.log(`fusion_total_tokens:    ${fusionTotal}`);

console.log(`METRIC fusion_brief_tokens=${briefTokens}`);
console.log(`METRIC fusion_panel_tokens=${panelTokens}`);
console.log(`METRIC fusion_judge_tokens=${judgeTokens}`);
console.log(`METRIC fusion_verify_tokens=${verifyTokens}`);
console.log(`METRIC fusion_writer_tokens=${writerTokens}`);
console.log(`METRIC fusion_total_tokens=${fusionTotal}`);
console.log(`METRIC bench=fusion-tokens panel_members=${PANEL_MEMBERS}`);