import { cpus, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { defineConfig } from "vitest/config";

// Main process: clear parent-shell NO_COLOR/FORCE_COLOR so theme module init
// (and createTheme) is not forced into ColorMode "none". Worker forks get the
// same treatment via setupFiles (setup-color-env.ts). chalk.level=0 silences
// chalk styles without FORCE_COLOR=0 (which Theme would treat as mono).
delete process.env.NO_COLOR;
delete process.env.FORCE_COLOR;
chalk.level = 0;

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));
const aiSrcModelsCompare = fileURLToPath(new URL("../ai/src/models-compare.ts", import.meta.url));
const tuiSrcCore = fileURLToPath(new URL("../tui/src/core.ts", import.meta.url));
// Keep worker creation bounded on large hosts: Vitest workers compete with git,
// taskkill, LSP, eval kernels and E2E child processes. The explicit override is
// useful for CI/benchmark hosts; the default considers CPU, platform and RAM.
const GIB = 1024 ** 3;

export function resolveMaxVitestForks(options: {
	cpuCount?: number;
	totalMemoryBytes?: number;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
} = {}): number {
	const env = options.env ?? process.env;
	const override = Number.parseInt(env.PIT_VITEST_MAX_WORKERS ?? "", 10);
	if (Number.isFinite(override) && override >= 1) return override;
	const cpuBudget = Math.max(2, (options.cpuCount ?? cpus().length) - 4);
	const platformCap = (options.platform ?? process.platform) === "win32" ? 12 : 16;
	const ramBudget = Math.max(2, Math.floor((options.totalMemoryBytes ?? totalmem()) / (2 * GIB)));
	const ciCap = env.CI ? 3 : Number.POSITIVE_INFINITY;
	return Math.max(2, Math.min(cpuBudget, platformCap, ramBudget, ciCap));
}

const maxVitestForks = resolveMaxVitestForks();

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		setupFiles: [fileURLToPath(new URL("./test/setup-color-env.ts", import.meta.url))],
		// 60s (was 30s) gives headroom to the handful of inherently heavy tests
		// (process-spawn E2E like dry-run-cli, full AgentSession boot) so a busy
		// or thermally-throttled machine doesn't fail them spuriously. Fast tests
		// (the vast majority, <1s) are unaffected; a genuine hang still surfaces.
		testTimeout: 60000,
		// Heavy beforeAll/afterAll (spawning git children, eval kernels, runtimes)
		// need far more than the 10s default when the box is under load. Teardown can
		// queue behind spawned processes in the full suite on Windows, so give hooks
		// extra room while keeping genuine hangs bounded.
		hookTimeout: 120000,
		poolOptions: {
			forks: {
				maxForks: maxVitestForks,
			},
		},
		// Test isolation: skip the developer's `~/.claude/skills/` so test
		// fixtures stay deterministic regardless of which Claude Code skills
		// the contributor has on their machine. Real usage opts in by default.
		env: {
			// Cursor/agent shells often set TERM=dumb, which disables streaming reveal
			// and thinking-breath animation via isReducedMotion() — hermetic tests
			// need a normal terminal profile.
			TERM: "xterm-256color",
			PIT_DISABLE_CLAUDE_CODE_SKILLS: "1",
			// Same isolation for the OTHER legacy skill dirs (.codex/.cursor/.gemini
			// skills/). Without this, a contributor who has e.g. ~/.codex/skills/*
			// installed makes resource-loader's `noSkills` test (expects []) flake,
			// since discoverLegacyResources walks the real HOME. Keeps the suite
			// hermetic regardless of which legacy skills the machine has.
			PIT_NO_LEGACY_SKILLS: "1",
			// Do NOT set FORCE_COLOR here — Theme treats FORCE_COLOR=0 as ColorMode
			// "none". Chalk is pinned to level 0 at config load (see above).
		},
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@pituned\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@pituned\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@pituned\/pi-agent-core$/, replacement: agentSrcIndex },
			// Current package names (post-rebrand). The code imports `@pit/*`, so
			// without these the suite resolved them to the built `dist/` instead of
			// the source under test — stale builds silently masked source changes.
			{ find: /^@pit\/ai$/, replacement: aiSrcIndex },
			{ find: /^@pit\/ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@pit\/agent-core$/, replacement: agentSrcIndex },
			{ find: /^@pit\/tui$/, replacement: tuiSrcIndex },
			{ find: /^@pit\/tui\/core$/, replacement: tuiSrcCore },
			{ find: /^@pit\/ai\/models-compare$/, replacement: aiSrcModelsCompare },
		],
	},
});
