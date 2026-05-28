export {
	_clearResultsForTesting,
	_setResultForTesting,
	getSubagentResult,
	recordSubagentResult,
	registerAgentScheme,
	resolveAgentUrl,
} from "./agent-url.ts";
export { SubagentRegistry } from "./registry.ts";
export { modelsMatch, resolveSubagentModel, type SpawnSubagentDependencies, spawnSubagent } from "./spawn.ts";
export type {
	SpawnSubagentOptions,
	SpawnSubagentResult,
	SubagentRecord,
	SubagentStatus,
	SubagentTaskResult,
	SubagentTaskSpec,
	WorktreeSpec,
} from "./types.ts";
