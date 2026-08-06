import { describe, expect, it } from "vitest";
import { resolveMaxVitestForks } from "../vitest.config.ts";

describe("Vitest worker cap", () => {
	it("caps large Windows hosts and considers RAM", () => {
		expect(
			resolveMaxVitestForks({
				cpuCount: 64,
				totalMemoryBytes: 64 * 1024 ** 3,
				platform: "win32",
				env: {} as NodeJS.ProcessEnv,
			}),
		).toBe(12);
		expect(
			resolveMaxVitestForks({
				cpuCount: 64,
				totalMemoryBytes: 8 * 1024 ** 3,
				platform: "linux",
				env: {} as NodeJS.ProcessEnv,
			}),
		).toBe(4);
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
});
