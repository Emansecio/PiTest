import { describe, expect, it } from "vitest";
import { buildVitestShardTasks, resolveVitestShardCount } from "../../../scripts/vitest-shards.mjs";

describe("Vitest check sharding", () => {
	it("defaults Windows full checks to three sequential shards", () => {
		expect(resolveVitestShardCount("win32", {} as NodeJS.ProcessEnv)).toBe(3);
		expect(resolveVitestShardCount("linux", {} as NodeJS.ProcessEnv)).toBe(1);
	});

	it("honors a positive override", () => {
		expect(resolveVitestShardCount("win32", { PIT_VITEST_SHARDS: "5" } as NodeJS.ProcessEnv)).toBe(5);
	});

	it("builds stable shard commands", () => {
		expect(buildVitestShardTasks({ name: "vitest", command: "npx vitest --run", cwd: "pkg" }, 2)).toEqual([
			{ name: "vitest shard 1/2", command: "npx vitest --run --shard=1/2", cwd: "pkg" },
			{ name: "vitest shard 2/2", command: "npx vitest --run --shard=2/2", cwd: "pkg" },
		]);
	});
});
