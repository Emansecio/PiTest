/**
 * Measure prompt token budget: system prompt + tool definitions.
 * Approximates tokens via 4 chars/token (close to gpt/claude).
 *
 * Output METRIC lines for autoresearch.
 */
import { buildSystemPrompt } from "../packages/coding-agent/src/core/system-prompt.ts";
import { createAllTools } from "../packages/coding-agent/src/core/tools/index.ts";

const APPROX_CHARS_PER_TOKEN = 3.7;
const toToks = (s: string) => Math.round(s.length / APPROX_CHARS_PER_TOKEN);

const toolsMap = createAllTools(process.cwd());
const tools = Object.values(toolsMap);
const toolSnippets: Record<string, string> = {};
for (const t of tools) {
	toolSnippets[t.name] = (t as any).promptSnippet ?? t.description.split("\n")[0];
}

const guidelinesFromTools: string[] = [];
for (const t of tools) {
	const pg = (t as any).promptGuidelines;
	if (Array.isArray(pg)) guidelinesFromTools.push(...pg);
}

const systemPrompt = buildSystemPrompt({
	cwd: process.cwd(),
	selectedTools: tools.map((t) => t.name),
	toolSnippets,
	promptGuidelines: guidelinesFromTools,
});

let totalDescChars = 0;
let totalParamChars = 0;
const toolBreakdown: Array<{ name: string; descChars: number; paramChars: number }> = [];
for (const t of tools) {
	const descChars = t.description.length;
	const paramChars = JSON.stringify(t.parameters).length;
	totalDescChars += descChars;
	totalParamChars += paramChars;
	toolBreakdown.push({ name: t.name, descChars, paramChars });
}

const sysChars = systemPrompt.length;
const allChars = sysChars + totalDescChars + totalParamChars;

console.log(`\nsystem_prompt:        ${sysChars} chars (~${toToks(systemPrompt)} toks)`);
console.log(`tool descriptions:    ${totalDescChars} chars (~${Math.round(totalDescChars / APPROX_CHARS_PER_TOKEN)} toks)`);
console.log(`tool parameters:      ${totalParamChars} chars (~${Math.round(totalParamChars / APPROX_CHARS_PER_TOKEN)} toks)`);
console.log(`---`);
console.log(`prompt prefix total:  ${allChars} chars (~${Math.round(allChars / APPROX_CHARS_PER_TOKEN)} toks)`);
console.log(`\nper-tool:`);
for (const b of toolBreakdown.sort((a, b) => b.descChars - a.descChars)) {
	console.log(`  ${b.name.padEnd(8)} desc=${b.descChars} param=${b.paramChars}`);
}

console.log(`\nMETRIC prompt_prefix_chars=${allChars}`);
console.log(`METRIC prompt_prefix_tokens=${Math.round(allChars / APPROX_CHARS_PER_TOKEN)}`);
console.log(`METRIC system_prompt_chars=${sysChars}`);
console.log(`METRIC tool_desc_chars=${totalDescChars}`);
console.log(`METRIC tool_param_chars=${totalParamChars}`);
