import { cpus } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Pin chalk to level 0 in the main vitest process (and thus every worker it
// forks) so a shell-exported FORCE_COLOR cannot inject ANSI escapes into
// rendered text. `new Chalk()` reads FORCE_COLOR at import time, before
// `test.env` is applied, so setting it here is what actually takes effect.
process.env.FORCE_COLOR = "0";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		// 60s (was 30s) gives headroom to the handful of inherently heavy tests
		// (process-spawn E2E like dry-run-cli, full AgentSession boot) so a busy
		// or thermally-throttled machine doesn't fail them spuriously. Fast tests
		// (the vast majority, <1s) are unaffected; a genuine hang still surfaces.
		testTimeout: 60000,
		// Heavy beforeAll/afterAll (spawning git children, eval kernels, runtimes)
		// need far more than the 10s default when the box is under load — match the
		// 60s test budget so setup/teardown never times out spuriously. A hook that
		// blows this is treated as a genuine hang (fail fast) rather than waited on
		// longer; contention is kept in check by the reduced maxForks below.
		hookTimeout: 60000,
		poolOptions: {
			forks: {
				// Default forks one worker per core. With every core busy, the OS and
				// the processes these tests SPAWN (tsx boots, git children, and the
				// taskkill/AgentSession.dispose teardown) get starved and blow their
				// per-hook deadline — which made a DIFFERENT teardown flake each full
				// run on Windows. Use only HALF the cores for vitest workers so the
				// other half stays free for spawned work + the scheduler; hooks then
				// finish well inside the 60s budget. Floor of 2 for small CI boxes.
				maxForks: Math.max(2, Math.floor(cpus().length / 2)),
			},
		},
		// Test isolation: skip the developer's `~/.claude/skills/` so test
		// fixtures stay deterministic regardless of which Claude Code skills
		// the contributor has on their machine. Real usage opts in by default.
		env: {
			PIT_DISABLE_CLAUDE_CODE_SKILLS: "1",
			// Force chalk to level 0 so diff/inverse highlight does not inject ANSI
			// escapes into rendered text. Tests assert on plain substrings (e.g.
			// `toContain("line 50 changed")`); a shell-exported FORCE_COLOR would
			// otherwise wrap tokens in \x1b[7m…\x1b[27m and break those asserts.
			FORCE_COLOR: "0",
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
		],
	},
});
