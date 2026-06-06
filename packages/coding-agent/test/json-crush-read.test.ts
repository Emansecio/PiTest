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

function withFlag(value: string | undefined, fn: () => Promise<void>): Promise<void> {
	const prev = process.env.PIT_JSON_CRUSH;
	if (value === undefined) delete process.env.PIT_JSON_CRUSH;
	else process.env.PIT_JSON_CRUSH = value;
	return fn().finally(() => {
		if (prev === undefined) delete process.env.PIT_JSON_CRUSH;
		else process.env.PIT_JSON_CRUSH = prev;
	});
}

describe("read + json-crush (phase 3, behind PIT_JSON_CRUSH)", () => {
	it("crushes a large JSON file when the flag is on", async () => {
		await withFlag("1", async () => {
			const text = await runRead(bigJson);
			expect(text).toContain("items elided"); // structural crush, not blind cut
			expect(text).toContain('"status"'); // schema preserved
			expect(text).toContain("item-0"); // head sample
			expect(text).toContain("item-1999"); // tail sample
			expect(text).toContain("crushed to schema"); // recovery footer
			expect(text.length).toBeLessThan(bigJson.length / 4); // real reduction
		});
	});

	it("falls back to the blind head-cut when the flag is off", async () => {
		await withFlag(undefined, async () => {
			const text = await runRead(bigJson);
			expect(text).not.toContain("items elided");
			// minified single line > 50KB → firstLineExceedsLimit recovery hint
			expect(text.toLowerCase()).toContain("exceeds");
		});
	});

	it("leaves non-JSON files to the normal truncation even with the flag on", async () => {
		await withFlag("1", async () => {
			const bigLog = Array.from({ length: 5000 }, (_, i) => `line ${i} of a big log file`).join("\n");
			const text = await runRead(bigLog, "app.log");
			expect(text).not.toContain("items elided");
			expect(text).toContain("Showing lines"); // normal head-truncation notice
		});
	});
});
