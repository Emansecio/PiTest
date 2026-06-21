/**
 * Curated built-in agent types shipped with the binary, mirroring Claude Code's
 * stock Explore / Plan / code-reviewer / general-purpose presets. These seed
 * `loadAgentTypes` so a `task({type})` call works out of the box with zero config;
 * a user (`~/.pit/agents`) or project (`<cwd>/.pit/agents`) file of the same name
 * overrides the built-in.
 */

import type { AgentTypeDef } from "./agent-types.ts";

export const BUILT_IN_AGENT_TYPES: AgentTypeDef[] = [
	{
		name: "explore",
		description: "Read-only codebase search — locates code and reports concise findings without editing.",
		systemPrompt:
			"You are an exploration agent. Search the codebase broadly to locate the relevant code, symbols, and call sites for the task. Report concise, grounded conclusions with file:line references and a short summary of how the pieces connect. You are read-only: never edit, write, or run mutating commands.",
		tools: ["read", "grep", "find", "ls", "bash"],
		model: "haiku",
		thinkingLevel: "low",
		memory: true,
		source: "builtin",
	},
	{
		name: "plan",
		description: "Architects a step-by-step implementation plan — read-only, no edits.",
		systemPrompt:
			"You are a planning agent. Analyze the request and the existing code, then return a clear step-by-step implementation plan. Name the critical files to touch, the order of changes, and the key trade-offs or risks. You are read-only: do not implement, edit, or write files — produce the plan only.",
		tools: ["read", "grep", "find", "ls"],
		thinkingLevel: "high",
		source: "builtin",
	},
	{
		name: "review",
		description: "Critical code/diff reviewer — flags bugs and quality issues, does not fix them.",
		systemPrompt:
			"You are a critical code reviewer. Inspect the diff or code for correctness bugs, edge cases, security risks, and quality problems. Report each issue with a file:line anchor, a short explanation of why it is wrong, and its severity. You are read-only: point out problems precisely — do not fix or edit anything.",
		tools: ["read", "grep", "find", "ls"],
		thinkingLevel: "high",
		memory: true,
		source: "builtin",
	},
	{
		name: "general",
		description: "General-purpose subagent — completes an isolated sub-task with full tools.",
		systemPrompt:
			"You are a general-purpose subagent. Complete the assigned isolated sub-task end to end and return a self-contained result the caller can act on without further context. Use whatever tools the task requires.",
		source: "builtin",
	},
];
