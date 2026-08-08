export function resolveVitestShardCount(platform = process.platform, env = process.env) {
	const override = Number.parseInt(env.PIT_VITEST_SHARDS ?? "", 10);
	if (Number.isFinite(override) && override >= 1) return override;
	return platform === "win32" ? 3 : 1;
}

export function buildVitestShardTasks(task, count) {
	if (count <= 1) return [task];
	return Array.from({ length: count }, (_, index) => ({
		...task,
		name: `${task.name} shard ${index + 1}/${count}`,
		command: `${task.command} --shard=${index + 1}/${count}`,
	}));
}
