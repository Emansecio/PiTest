/**
 * Live network E2E for `web_fetch`. Gated behind PIT_WEB_FETCH_LIVE=1 (same
 * shape as the Chrome E2E suite) and additionally excluded from
 * `vitest.unit.config.ts`, because the default suite must stay hermetic —
 * `./test.ps1` / `./test.sh` run with no network and no API keys.
 *
 *   PIT_WEB_FETCH_LIVE=1 npx vitest --run test/web-fetch-live.test.ts
 *
 * What it proves that the mocked suite cannot: real DNS + the real SSRF guard
 * on a real hostname, and that the Firecrawl v2 scrape endpoint still answers
 * WITHOUT an API key (the assumption the fallback is built on — if this test
 * starts failing with 401/402, the fallback needs a key and the docs must say
 * so).
 */

import { describe, expect, it } from "vitest";
import { createWebFetchToolDefinition, type WebFetchToolDetails } from "../src/core/tools/web-fetch.ts";
import { firecrawlScrape } from "../src/core/web-search/firecrawl.ts";

const ENABLED = process.env.PIT_WEB_FETCH_LIVE === "1";
const suite = ENABLED ? describe : describe.skip;

suite("web_fetch live", () => {
	it("fetches a real page natively and converts it to markdown", async () => {
		const def = createWebFetchToolDefinition(process.cwd());
		const result = await def.execute("live-1", { url: "https://example.com/" }, undefined, undefined, {} as never);
		const details = result.details as WebFetchToolDetails;
		expect(result.isError).toBeUndefined();
		expect(details.status).toBe(200);
		expect(details.totalChars).toBeGreaterThan(0);
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toMatch(/Example Domain/i);
	}, 30_000);

	it("blocks a real loopback hostname through real DNS", async () => {
		const def = createWebFetchToolDefinition(process.cwd());
		const result = await def.execute("live-2", { url: "http://localhost:1/" }, undefined, undefined, {} as never);
		expect(result.isError).toBe(true);
		const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		expect(text).toMatch(/loopback/);
	}, 30_000);

	it("scrapes through the real Firecrawl endpoint with no API key", async () => {
		const scraped = await firecrawlScrape("https://example.com/", { env: { ...process.env, FIRECRAWL_API_KEY: "" } });
		expect(scraped.markdown.length).toBeGreaterThan(0);
		expect(scraped.markdown).toMatch(/Example Domain/i);
	}, 60_000);
});
