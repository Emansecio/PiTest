import { describe, expect, it } from "vitest";
import { resolveMaxVitestForks, resolveVitestWorkerHeapMb } from "../vitest.config.ts";

describe("Vitest worker cap", () => {
	it("caps large Windows hosts and budgets ~4 GiB RSS per worker", () => {
		expect(
			resolveMaxVitestForks({
				cpuCount: 64,
				totalMemoryBytes: 64 * 1024 ** 3,
				platform: "win32",
				env: {} as NodeJS.ProcessEnv,
			}),
		).toBe(6);
		expect(
			resolveMaxVitestForks({
				cpuCount: 64,
				totalMemoryBytes: 8 * 1024 ** 3,
				platform: "linux",
				env: {} as NodeJS.ProcessEnv,
			}),
		).toBe(2);
		expect(
			resolveMaxVitestForks({
				cpuCount: 64,
				totalMemoryBytes: 48 * 1024 ** 3,
				platform: "linux",
				env: {} as NodeJS.ProcessEnv,
			}),
		).toBe(12);
	});

	it("honors explicit overrides and the CI cap", () => {
		expect(
			resolveMaxVitestForks({
				cpuCount: 64,
				totalMemoryBytes: 64 * 1024 ** 3,
				platform: "linux",
				env: { PIT_VITEST_MAX_WORKERS: "7" } as NodeJS.ProcessEnv,
			}),
		).toBe(7);
		expect(
			resolveMaxVitestForks({
				cpuCount: 64,
				totalMemoryBytes: 64 * 1024 ** 3,
				platform: "linux",
				env: { CI: "1" } as NodeJS.ProcessEnv,
			}),
		).toBe(3);
	});

	it("defaults worker heap above the 4 GiB V8 ceiling and honors overrides", () => {
		expect(resolveVitestWorkerHeapMb({} as NodeJS.ProcessEnv)).toBe(8192);
		expect(resolveVitestWorkerHeapMb({ PIT_VITEST_WORKER_HEAP_MB: "4096" } as NodeJS.ProcessEnv)).toBe(4096);
		expect(resolveVitestWorkerHeapMb({ PIT_VITEST_WORKER_HEAP_MB: "100" } as NodeJS.ProcessEnv)).toBe(8192);
	});
});
