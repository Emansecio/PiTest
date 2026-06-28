/**
 * Fast unit subset for local dev loops.
 *
 * Excludes integration-heavy tests (process spawn, real bash/python, chrome).
 * Full gate still runs `vitest.config.ts` via `npm run test`.
 */
import { defaultExclude, defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.js";

const integrationTests = [
	"test/bash-auto-background.test.ts",
	"test/bash-close-hang-windows.test.ts",
	"test/bash-abort-during-startup.test.ts",
	"test/chrome-devtools-e2e.test.ts",
	"test/clipboard-image.test.ts",
	"test/clipboard-image-bmp-conversion.test.ts",
	"test/coordinator-async-reinject.test.ts",
	"test/dap/**",
	"test/dry-run-cli.test.ts",
	"test/eval-kernel-*.test.ts",
	"test/footer-data-provider.test.ts",
	"test/git-update.test.ts",
	"test/resilience/**",
	"test/stdout-cleanliness.test.ts",
];

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			name: "unit",
			exclude: [...defaultExclude, ...integrationTests],
		},
	}),
);