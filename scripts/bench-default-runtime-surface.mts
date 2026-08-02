/** Measure the real default AgentSession surface without making a provider call. */

import { homedir } from "node:os";
import { join } from "node:path";
import { getModel } from "../packages/ai/src/index.ts";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { DefaultResourceLoader } from "../packages/coding-agent/src/core/resource-loader.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { agentToolToWireSurface, compactWireToolSurface } from "../packages/coding-agent/src/core/tool-wire-schema.ts";
import { resolveBenchRoot } from "./lib/bench-root.mts";

const cwd = resolveBenchRoot();
const agentDir = join(homedir(), ".pit", "agent");
const settingsManager = SettingsManager.create(cwd, agentDir);
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
await resourceLoader.reload();

const { session } = await createAgentSession({
	cwd,
	agentDir,
	model: getModel("anthropic", "claude-sonnet-5")!,
	settingsManager,
	sessionManager: SessionManager.inMemory(cwd),
	resourceLoader,
});

try {
	const systemPromptChars = session.agent.state.systemPrompt.length;
	const wireTools = session.agent.state.tools.map(agentToolToWireSurface).map(compactWireToolSurface);
	const toolChars = JSON.stringify(wireTools).length;
	const totalChars = systemPromptChars + toolChars;
	console.log(`METRIC active_tool_count=${session.getActiveToolNames().length}`);
	console.log(`METRIC active_tools=${session.getActiveToolNames().join(",")}`);
	console.log(`METRIC system_prompt_chars=${systemPromptChars}`);
	console.log(`METRIC tool_schema_chars=${toolChars}`);
	console.log(`METRIC prompt_and_schema_chars=${totalChars}`);
	console.log(`METRIC prompt_and_schema_tokens=${Math.round(totalChars / 3.7)}`);
	console.log(`METRIC full_skill_catalog=${session.agent.state.systemPrompt.includes("<available_skills>") ? 1 : 0}`);
	console.log(`METRIC lazy_skill_hint=${session.agent.state.systemPrompt.includes("Specialized skills are available on demand.") ? 1 : 0}`);
} finally {
	// The benchmark must not keep Chrome/LSP background handles alive after the
	// numbers are printed. A bounded cleanup keeps it usable in CI as well as
	// from a developer shell.
	await Promise.race([
		session.dispose(),
		new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
	]);
	process.exit(0);
}
