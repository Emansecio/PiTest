/**
 * Measure prompt token budget: system prompt + tool definitions.
 * Approximates tokens via 4 chars/token (close to gpt/claude).
 *
 * Output METRIC lines for autoresearch.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { compactWireToolSurface } from "../packages/coding-agent/src/core/tool-wire-schema.ts";
import { buildSystemPrompt } from "../packages/coding-agent/src/core/system-prompt.ts";
import { loadProjectContextFiles } from "../packages/coding-agent/src/core/resource-loader.ts";
import { createAllTools } from "../packages/coding-agent/src/core/tools/index.ts";

const APPROX_CHARS_PER_TOKEN = 3.7;
const toToks = (chars: number) => Math.round(chars / APPROX_CHARS_PER_TOKEN);

type ContextFile = { path: string; content: string };
type Skill = { name: string; description: string; filePath: string; disableModelInvocation?: boolean };

function loadContextFiles(cwd: string): ContextFile[] {
	return loadProjectContextFiles({ cwd, agentDir: join(homedir(), ".pit", "agent") });
}

// Approximate the user's installed skill catalog by counting every SKILL.md
// under ~/.pit/agent/skills/ and reading the YAML frontmatter (name +
// description). This is exactly what formatSkillsForPrompt would emit.
function loadSkills(): Skill[] {
	const skillsDir = join(homedir(), ".pit", "agent", "skills");
	if (!existsSync(skillsDir)) return [];
	const out: Skill[] = [];
	for (const entry of readdirSync(skillsDir)) {
		const skillFile = join(skillsDir, entry, "SKILL.md");
		if (!existsSync(skillFile)) continue;
		try {
			const raw = readFileSync(skillFile, "utf8");
			const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
			if (!fmMatch) continue;
			const fm = fmMatch[1];
			const nameMatch = fm.match(/^name:\s*(.+)$/m);
			const descMatch = fm.match(/^description:\s*(.+(?:\n[ \t]+.+)*)/m);
			if (!nameMatch || !descMatch) continue;
			const disableModelInvocation = /^disable-model-invocation:\s*true/m.test(fm);
			out.push({
				name: nameMatch[1].trim(),
				description: descMatch[1].replace(/\n[ \t]+/g, " ").trim(),
				filePath: skillFile,
				disableModelInvocation: disableModelInvocation || undefined,
			});
		} catch {}
	}
	return out;
}

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

const contextFiles = loadContextFiles(process.cwd());
const skills = loadSkills();
const systemPrompt = buildSystemPrompt({
	cwd: process.cwd(),
	selectedTools: tools.map((t) => t.name),
	toolSnippets,
	promptGuidelines: guidelinesFromTools,
	contextFiles,
	skills,
});

const ctxChars = contextFiles.reduce((n, f) => n + f.content.length, 0);
const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
const SKILL_XML_OVERHEAD = 60; // approximate per-skill XML wrapper bytes
const skillsChars = visibleSkills.reduce(
	(n, s) => n + s.name.length + s.description.length + s.filePath.length + SKILL_XML_OVERHEAD,
	0,
);

const wireTools = tools.map((t) =>
	compactWireToolSurface({
		name: t.name,
		description: (t as { promptSnippet?: string }).promptSnippet ?? t.description.split("\n")[0],
		parameters: t.parameters,
	}),
);
const toolBreakdown = tools.map((t, i) => ({
	name: t.name,
	descChars: t.description.length,
	paramChars: JSON.stringify(t.parameters).length,
	wireDescChars: wireTools[i].description.length,
	wireParamChars: JSON.stringify(wireTools[i].parameters).length,
}));
const totalDescChars = toolBreakdown.reduce((n, b) => n + b.descChars, 0);
const totalParamChars = toolBreakdown.reduce((n, b) => n + b.paramChars, 0);
const totalWireDescChars = toolBreakdown.reduce((n, b) => n + b.wireDescChars, 0);
const totalWireParamChars = toolBreakdown.reduce((n, b) => n + b.wireParamChars, 0);

const sysChars = systemPrompt.length;
const allChars = sysChars + totalDescChars + totalParamChars;
const wirePrefixChars = sysChars + totalWireDescChars + totalWireParamChars;
const contextFileNames = contextFiles.map((f) => f.path.split(/[\\/]/).pop()).join(", ") || "(none)";

console.log(`\nsystem_prompt (final): ${sysChars} chars (~${toToks(sysChars)} toks)`);
console.log(`  - context files:     ${ctxChars} chars (${contextFileNames})`);
console.log(`  - skills (${visibleSkills.length}):       ~${skillsChars} chars (estimated)`);
console.log(`tool descriptions:     ${totalDescChars} chars (~${toToks(totalDescChars)} toks)`);
console.log(`tool parameters:       ${totalParamChars} chars (~${toToks(totalParamChars)} toks)`);
console.log(`wire tool desc:        ${totalWireDescChars} chars (~${toToks(totalWireDescChars)} toks)`);
console.log(`wire tool params:      ${totalWireParamChars} chars (~${toToks(totalWireParamChars)} toks)`);
console.log(`---`);
console.log(`prompt prefix total:   ${allChars} chars (~${toToks(allChars)} toks)`);
console.log(`wire prefix total:     ${wirePrefixChars} chars (~${toToks(wirePrefixChars)} toks)`);
console.log(`\nper-tool:`);
for (const b of toolBreakdown.sort((a, b) => b.descChars - a.descChars)) {
	console.log(`  ${b.name.padEnd(8)} desc=${b.descChars} param=${b.paramChars}`);
}

console.log(`\nMETRIC prompt_prefix_chars=${allChars}`);
console.log(`METRIC prompt_prefix_tokens=${toToks(allChars)}`);
console.log(`METRIC system_prompt_chars=${sysChars}`);
console.log(`METRIC context_files_chars=${ctxChars}`);
console.log(`METRIC skills_chars=${skillsChars}`);
console.log(`METRIC skills_visible=${visibleSkills.length}`);
console.log(`METRIC tool_desc_chars=${totalDescChars}`);
console.log(`METRIC tool_param_chars=${totalParamChars}`);
console.log(`METRIC wire_prefix_chars=${wirePrefixChars}`);
console.log(`METRIC wire_prefix_tokens=${toToks(wirePrefixChars)}`);
console.log(`METRIC wire_tool_desc_chars=${totalWireDescChars}`);
console.log(`METRIC wire_tool_param_chars=${totalWireParamChars}`);
