import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadToolDefinition } from "../src/core/tools/read.js";

/**
 * Audit fix (2026-06): the read tool appended a hashline `<anchors>` block to
 * every full, untruncated read, but its only consumer is the `edit_v2`
 * hashline editor — off the default surface, so in default sessions the block
 * was pure context dead weight (~0.5k tokens per full read). The option now
 * accepts a getter so the session gates anchors on the LIVE tool surface; the
 * getter is evaluated per read, picking up surface changes after the
 * definition is built (e.g. an extension activating edit_v2 mid-session).
 */
describe("read anchors surface gate", () => {
	let tempRoot: string;
	let filePath: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-anchors-gate-"));
		filePath = join(tempRoot, "sample.ts");
		writeFileSync(filePath, 'export const value = 1;\nexport const other = "two";\n');
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	async function runRead(embedHashlineAnchors: boolean | (() => boolean)): Promise<string> {
		const def = createReadToolDefinition(tempRoot, { embedHashlineAnchors });
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute("call-1", { path: filePath } as never, undefined, undefined, ctx)) as {
			content: Array<{ type: string; text?: string }>;
		};
		return result.content[0]?.text ?? "";
	}

	it("boolean true embeds anchors (back-compat)", async () => {
		expect(await runRead(true)).toContain("<anchors>");
	});

	it("getter returning false suppresses anchors", async () => {
		expect(await runRead(() => false)).not.toContain("<anchors>");
	});

	it("emits an anchor for EVERY window (stride=1), not every third", async () => {
		// A small file well under the anchor byte budget must get per-window anchors
		// so edit_v2 can target any line boundary. stride=3 would skip L2/L3/L5…
		const many = join(tempRoot, "many.ts");
		writeFileSync(many, Array.from({ length: 8 }, (_, i) => `const v${i} = ${i};`).join("\n"));
		const def = createReadToolDefinition(tempRoot, { embedHashlineAnchors: true });
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute("c-many", { path: many } as never, undefined, undefined, ctx)) as {
			content: Array<{ type: string; text?: string }>;
		};
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("stride=1");
		// Consecutive windows present — stride=3 would omit L2 and L3.
		expect(text).toMatch(/# L1 [0-9a-f]{8}/);
		expect(text).toMatch(/# L2 [0-9a-f]{8}/);
		expect(text).toMatch(/# L3 [0-9a-f]{8}/);
	});

	it("getter is evaluated per read, tracking live surface changes", async () => {
		let active = false;
		const def = createReadToolDefinition(tempRoot, { embedHashlineAnchors: () => active });
		const ctx = {} as Parameters<typeof def.execute>[4];
		const first = (await def.execute("c1", { path: filePath } as never, undefined, undefined, ctx)) as {
			content: Array<{ type: string; text?: string }>;
		};
		expect(first.content[0]?.text ?? "").not.toContain("<anchors>");
		active = true;
		const second = (await def.execute("c2", { path: filePath } as never, undefined, undefined, ctx)) as {
			content: Array<{ type: string; text?: string }>;
		};
		expect(second.content[0]?.text ?? "").toContain("<anchors>");
	});
});
