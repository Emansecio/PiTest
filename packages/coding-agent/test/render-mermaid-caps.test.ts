import { describe, expect, it } from "vitest";
import { createRenderMermaidToolDefinition } from "../src/core/tools/render-mermaid.ts";

const def = createRenderMermaidToolDefinition("/tmp");

async function run(source: string): Promise<{ mode?: string; nodeCount?: number; edgeCount?: number }> {
	const ctx = {} as Parameters<typeof def.execute>[4];
	const result = (await def.execute("c", { source }, undefined, undefined, ctx)) as {
		details?: { mode?: string; nodeCount?: number; edgeCount?: number };
	};
	return result.details ?? {};
}

describe("render_mermaid complexity caps", () => {
	it("renders a small flowchart as ascii", async () => {
		const d = await run("graph TD\nA-->B\nB-->C");
		expect(d.mode).toBe("ascii");
	});

	it("falls back when the source exceeds the byte cap", async () => {
		const big = `graph TD\n${Array.from({ length: 7000 }, (_, i) => `A-->N${i}`).join("\n")}`;
		expect(big.length).toBeGreaterThan(50_000);
		const d = await run(big);
		expect(d.mode).toBe("fallback");
	});

	it("falls back when the node count exceeds the cap (source still under byte cap)", async () => {
		const lines = ["graph TD"];
		for (let i = 0; i < 600; i++) lines.push(`N${i}-->M${i}`);
		const source = lines.join("\n");
		expect(source.length).toBeLessThan(50_000);
		const d = await run(source);
		expect(d.mode).toBe("fallback");
	});
});
