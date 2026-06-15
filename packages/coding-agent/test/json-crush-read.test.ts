import { describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.js";

const bigJson = JSON.stringify(
	Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `item-${i}`, status: i % 2 ? "ok" : "err" })),
);

function readToolWith(content: string) {
	return createReadTool("/work", {
		operations: {
			readFile: async () => Buffer.from(content, "utf-8"),
			access: async () => {},
			detectImageMimeType: async () => null,
		},
		embedHashlineAnchors: false,
	});
}

async function runRead(content: string, path = "data.json"): Promise<string> {
	const def = readToolWith(content);
	const res = await def.execute("t1", { path });
	return (res.content[0] as { text: string }).text;
}

// json-crush is ON by default; PIT_NO_JSON_CRUSH=1 opts out.
function withCrush(enabled: boolean, fn: () => Promise<void>): Promise<void> {
	const prev = process.env.PIT_NO_JSON_CRUSH;
	if (enabled) delete process.env.PIT_NO_JSON_CRUSH;
	else process.env.PIT_NO_JSON_CRUSH = "1";
	return fn().finally(() => {
		if (prev === undefined) delete process.env.PIT_NO_JSON_CRUSH;
		else process.env.PIT_NO_JSON_CRUSH = prev;
	});
}

describe("read + json-crush (on by default, opt out with PIT_NO_JSON_CRUSH)", () => {
	it("crushes a large JSON file by default", async () => {
		await withCrush(true, async () => {
			const text = await runRead(bigJson);
			expect(text).toContain("items elided"); // structural crush, not blind cut
			expect(text).toContain('"status"'); // schema preserved
			expect(text).toContain("item-0"); // head sample
			expect(text).toContain("item-1999"); // tail sample
			expect(text).toContain("crushed to schema"); // recovery footer
			expect(text.length).toBeLessThan(bigJson.length / 4); // real reduction
		});
	});

	it("falls back to the blind head-cut when crush is disabled", async () => {
		await withCrush(false, async () => {
			const text = await runRead(bigJson);
			expect(text).not.toContain("items elided");
			// minified single line > 50KB → firstLineExceedsLimit recovery hint
			expect(text.toLowerCase()).toContain("exceeds");
		});
	});

	it("leaves non-JSON files to the normal truncation even when enabled", async () => {
		await withCrush(true, async () => {
			const bigLog = Array.from({ length: 5000 }, (_, i) => `line ${i} of a big log file`).join("\n");
			const text = await runRead(bigLog, "app.log");
			expect(text).not.toContain("items elided");
			expect(text).toContain("Showing lines"); // normal head-truncation notice
		});
	});
});
