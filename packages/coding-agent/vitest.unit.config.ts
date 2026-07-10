/**
 * Fast unit subset for local dev loops.
 *
 * Excludes integration-heavy tests (process spawn, real bash/python, chrome,
 * shell-backed `!command` auth, verification gates). Full gate still runs
 * `vitest.config.ts` via `npm run test` / pre-push `npm run check`.
 */
import { defaultExclude, defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "./vitest.config.js";

const integrationTests = [
	"test/auth-storage-shell.test.ts",
	"test/bash-auto-background.test.ts",
	"test/bash-abort-during-startup.test.ts",
	"test/bash-close-hang-windows.test.ts",
	"test/bash-no-autobg-check.test.ts",
	"test/chrome-devtools-e2e.test.ts",
	"test/clipboard-image.test.ts",
	"test/clipboard-image-bmp-conversion.test.ts",
	"test/coordinator-async-reinject.test.ts",
	"test/dap/**",
	"test/dry-run-cli.test.ts",
	"test/eval-kernel-*.test.ts",
	"test/find-grep-git-and-postfilter.test.ts",
	"test/footer-data-provider.test.ts",
	"test/git-update.test.ts",
	"test/git-update-*.test.ts",
	"test/model-registry-shell.test.ts",
	"test/package-command-paths.test.ts",
	"test/pending-checks*.test.ts",
	"test/resilience/**",
	"test/resolve-config-value-ttl.test.ts",
	"test/stdout-cleanliness.test.ts",
	"test/tools.test.ts",
	"test/verification-gate.test.ts",
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
