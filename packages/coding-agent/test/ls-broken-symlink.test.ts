import { describe, expect, it } from "vitest";
import { createLsToolDefinition } from "../src/core/tools/ls.js";

/**
 * `ls` stats every entry to add the `/` directory suffix. stat() follows
 * symlinks, so a dangling link (or a no-permission entry) throws — and the old
 * code dropped rejected results, making the entry vanish from the listing. The
 * directory entry exists; it must still appear (marked `@`), never silently
 * disappear, or the model concludes a file is missing.
 */
type ToolText = { content: Array<{ type: string; text?: string }> };

function textOf(result: unknown): string {
	return (result as ToolText).content[0]?.text ?? "";
}

describe("ls broken-symlink / unstatable entry never vanishes", () => {
	it("keeps an entry whose stat throws, marked with @", async () => {
		const def = createLsToolDefinition("/cwd", {
			operations: {
				exists: async () => true,
				readdir: async () => ["real.ts", "dangling.ts", "sub"],
				stat: async (p: string) => {
					if (p.endsWith("dangling.ts")) throw new Error("ENOENT: broken symlink target");
					// The directory being listed and `sub` are directories; the `.ts` file is not.
					return { isDirectory: () => !p.endsWith(".ts") };
				},
			},
		});
		const ctx = {} as Parameters<typeof def.execute>[4];
		const res = await def.execute("c", { path: "." }, undefined, undefined, ctx);
		const out = textOf(res);
		// All three entries present; the unstatable one is kept and marked.
		expect(out).toContain("real.ts");
		expect(out).toContain("sub/");
		expect(out).toContain("dangling.ts@");
	});
});
