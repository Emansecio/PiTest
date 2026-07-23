/**
 * Read tool consumption of the graph-prefetch warm cache (P6):
 * `read.ts` consults `ReadToolOptions.warmFileCache` before its own
 * `ops.readFile`, with a hit conditioned on the LIVE stat's `(mtimeMs, size)`
 * matching the cached entry exactly. Each test seeds the cache with content
 * that intentionally differs from what is really on disk, so a passing
 * assertion proves which source (cache vs disk) the tool actually used.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.js";
import { WarmFileCache } from "../src/core/tools/warm-file-cache.js";

const dir = mkdtempSync(join(tmpdir(), "pit-warm-cache-"));

function textOf(res: { content: Array<{ type: string; text?: string }> }): string {
	const c = res.content[0];
	return c?.type === "text" ? (c.text ?? "") : "";
}

describe("read tool: warm-file-cache consumption (P6)", () => {
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("serves the cached body on a stat-matching hit, skipping the disk read", async () => {
		const filePath = join(dir, "hit.ts");
		writeFileSync(filePath, "real disk content\n");
		const st = statSync(filePath);
		const cache = new WarmFileCache();
		cache.set(filePath, { content: "WARM CACHE MARKER\n", mtimeMs: st.mtimeMs, size: st.size });
		const tool = createReadTool(dir, { embedHashlineAnchors: false, warmFileCache: cache });

		const result = await tool.execute("t1", { path: "hit.ts" });

		expect(textOf(result)).toContain("WARM CACHE MARKER");
		expect(textOf(result)).not.toContain("real disk content");
	});

	it("falls through to disk on an mtime mismatch (file changed since warming)", async () => {
		const filePath = join(dir, "miss-mtime.ts");
		writeFileSync(filePath, "real disk content v2\n");
		const st = statSync(filePath);
		const cache = new WarmFileCache();
		cache.set(filePath, { content: "STALE MARKER\n", mtimeMs: st.mtimeMs - 1000, size: st.size });
		const tool = createReadTool(dir, { embedHashlineAnchors: false, warmFileCache: cache });

		const result = await tool.execute("t1", { path: "miss-mtime.ts" });

		expect(textOf(result)).toContain("real disk content v2");
		expect(textOf(result)).not.toContain("STALE MARKER");
	});

	it("falls through to disk on a size mismatch even when mtime matches", async () => {
		const filePath = join(dir, "miss-size.ts");
		writeFileSync(filePath, "real disk content v3\n");
		const st = statSync(filePath);
		const cache = new WarmFileCache();
		cache.set(filePath, { content: "SIZE MISMATCH MARKER\n", mtimeMs: st.mtimeMs, size: st.size + 1 });
		const tool = createReadTool(dir, { embedHashlineAnchors: false, warmFileCache: cache });

		const result = await tool.execute("t1", { path: "miss-size.ts" });

		expect(textOf(result)).toContain("real disk content v3");
		expect(textOf(result)).not.toContain("SIZE MISMATCH MARKER");
	});

	it("is a silent miss (never throws) when the cache has no entry for the path at all", async () => {
		const filePath = join(dir, "no-entry.ts");
		writeFileSync(filePath, "plain disk content\n");
		const cache = new WarmFileCache();
		const tool = createReadTool(dir, { embedHashlineAnchors: false, warmFileCache: cache });

		const result = await tool.execute("t1", { path: "no-entry.ts" });

		expect(textOf(result)).toContain("plain disk content");
	});

	it("leaves default behavior unaffected when no warmFileCache is configured at all", async () => {
		const filePath = join(dir, "no-cache.ts");
		writeFileSync(filePath, "plain disk content\n");
		const tool = createReadTool(dir, { embedHashlineAnchors: false });

		const result = await tool.execute("t1", { path: "no-cache.ts" });

		expect(textOf(result)).toContain("plain disk content");
	});

	it("also serves the outline path from the warm cache on a stat-matching hit", async () => {
		const filePath = join(dir, "outline-hit.ts");
		writeFileSync(filePath, "export function real() {}\n");
		const st = statSync(filePath);
		const cache = new WarmFileCache();
		cache.set(filePath, { content: "export function warmed() {}\n", mtimeMs: st.mtimeMs, size: st.size });
		const tool = createReadTool(dir, { embedHashlineAnchors: false, warmFileCache: cache });

		const result = await tool.execute("t1", { path: "outline-hit.ts", outline: true });

		expect(textOf(result)).toContain("warmed");
		expect(textOf(result)).not.toContain("real");
	});

	it("outline path falls through to disk on a stat mismatch", async () => {
		const filePath = join(dir, "outline-miss.ts");
		writeFileSync(filePath, "export function real() {}\n");
		const st = statSync(filePath);
		const cache = new WarmFileCache();
		cache.set(filePath, { content: "export function warmed() {}\n", mtimeMs: st.mtimeMs - 1, size: st.size });
		const tool = createReadTool(dir, { embedHashlineAnchors: false, warmFileCache: cache });

		const result = await tool.execute("t1", { path: "outline-miss.ts", outline: true });

		expect(textOf(result)).toContain("real");
		expect(textOf(result)).not.toContain("warmed");
	});

	it("a hit still renders correctly with dedup/anchors layered on top (end-to-end sanity)", async () => {
		const filePath = join(dir, "hit-full.ts");
		writeFileSync(filePath, "disk body — never shown\n");
		const st = statSync(filePath);
		const cache = new WarmFileCache();
		cache.set(filePath, { content: "export const warmedValue = 1;\n", mtimeMs: st.mtimeMs, size: st.size });
		const tool = createReadTool(dir, { warmFileCache: cache });

		const result = await tool.execute("t1", { path: "hit-full.ts" });

		expect(textOf(result)).toContain("export const warmedValue = 1;");
		expect(textOf(result)).not.toContain("never shown");
	});
});
