import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		poolOptions: {
			forks: {
				maxForks: process.env.CI ? 3 : undefined,
			},
		},
	},
	resolve: {
		alias: [{ find: /^@pit\/ai$/, replacement: aiSrcIndex }],
	},
});
