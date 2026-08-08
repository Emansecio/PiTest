export function resolveVitestShardCount(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): number;
export function buildVitestShardTasks<T extends { name: string; command: string; cwd?: string }>(task: T, count: number): T[];
