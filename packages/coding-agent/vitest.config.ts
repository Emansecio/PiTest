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

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
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
		],
	},
});
