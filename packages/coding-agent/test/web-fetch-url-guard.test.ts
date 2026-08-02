/**
 * SSRF guard for `web_fetch` (`core/web-search/url-guard.ts`).
 *
 * The guard is the only thing standing between a model-supplied URL and the
 * loopback interface / LAN / cloud-metadata endpoint, so the allow cases matter
 * as much as the deny cases: a guard that rejects everything is not a guard,
 * it is an outage. DNS is injected throughout — this suite performs no real
 * resolution and no sockets.
 */

import { describe, expect, it } from "vitest";
import {
	assertUrlAllowed,
	checkUrlAllowed,
	classifyIpAddress,
	type DnsResolver,
	UrlBlockedError,
} from "../src/core/web-search/url-guard.ts";

/** DNS stub: one fixed answer set for every hostname. */
const resolvesTo =
	(...addresses: string[]): DnsResolver =>
	async () =>
		addresses;

const PUBLIC_DNS = resolvesTo("93.184.216.34");

describe("classifyIpAddress", () => {
	it("passes public addresses", () => {
		expect(classifyIpAddress("93.184.216.34")).toBeUndefined();
		expect(classifyIpAddress("8.8.8.8")).toBeUndefined();
		expect(classifyIpAddress("2606:2800:220:1:248:1893:25c8:1946")).toBeUndefined();
	});

	it("rejects every non-public IPv4 range", () => {
		expect(classifyIpAddress("127.0.0.1")).toContain("loopback");
		expect(classifyIpAddress("10.1.2.3")).toContain("private");
		expect(classifyIpAddress("172.16.0.1")).toContain("private");
		expect(classifyIpAddress("172.31.255.255")).toContain("private");
		expect(classifyIpAddress("192.168.1.1")).toContain("private");
		expect(classifyIpAddress("169.254.169.254")).toContain("link-local");
		expect(classifyIpAddress("0.0.0.0")).toContain("this-network");
	});

	it("does not over-reject the neighbours of the private ranges", () => {
		// 172.15/16 and 172.32/16 sit just outside 172.16.0.0/12.
		expect(classifyIpAddress("172.15.0.1")).toBeUndefined();
		expect(classifyIpAddress("172.32.0.1")).toBeUndefined();
		expect(classifyIpAddress("169.253.0.1")).toBeUndefined();
		expect(classifyIpAddress("11.0.0.1")).toBeUndefined();
	});

	it("rejects non-public IPv6, including the v4-in-v6 smuggling forms", () => {
		expect(classifyIpAddress("::1")).toContain("loopback");
		expect(classifyIpAddress("::")).toContain("unspecified");
		expect(classifyIpAddress("fc00::1")).toContain("unique local");
		expect(classifyIpAddress("fd12:3456::1")).toContain("unique local");
		expect(classifyIpAddress("fe80::1")).toContain("link-local");
		// v4-mapped and NAT64 wrappers around a private v4 address.
		expect(classifyIpAddress("::ffff:10.0.0.1")).toContain("private");
		expect(classifyIpAddress("::ffff:169.254.169.254")).toContain("link-local");
		expect(classifyIpAddress("64:ff9b::127.0.0.1")).toContain("loopback");
	});

	it("fails closed on garbage", () => {
		expect(classifyIpAddress("not-an-ip")).toBeDefined();
		expect(classifyIpAddress("999.1.1.1")).toBeDefined();
	});
});

describe("checkUrlAllowed", () => {
	it("allows a plain https URL on a public address", async () => {
		const result = await checkUrlAllowed("https://example.com/docs?q=1", { resolve: PUBLIC_DNS });
		expect(result.allowed).toBe(true);
		expect(result.url?.host).toBe("example.com");
		expect(result.addresses).toEqual(["93.184.216.34"]);
	});

	it("rejects non-http(s) schemes", async () => {
		for (const url of ["file:///etc/passwd", "ftp://example.com/x", "data:text/html,hi"]) {
			const result = await checkUrlAllowed(url, { resolve: PUBLIC_DNS });
			expect(result.allowed, url).toBe(false);
			expect(result.reason, url).toMatch(/scheme/);
		}
	});

	it("rejects credentials embedded in the URL", async () => {
		const result = await checkUrlAllowed("https://user:pass@example.com/", { resolve: PUBLIC_DNS });
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/credentials/);
	});

	it("rejects a hostname that resolves to loopback", async () => {
		const result = await checkUrlAllowed("http://localhost:8080/admin", { resolve: resolvesTo("127.0.0.1") });
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/loopback/);
	});

	it("rejects a hostname whose answer set MIXES public and private addresses", async () => {
		// DNS-rebinding shape: one good answer is not enough.
		const result = await checkUrlAllowed("https://rebind.example/", {
			resolve: resolvesTo("93.184.216.34", "10.0.0.5"),
		});
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/10\.0\.0\.5/);
	});

	it("rejects literal private / link-local / IPv6-loopback hosts without touching DNS", async () => {
		const explodingResolver: DnsResolver = async () => {
			throw new Error("DNS must not be consulted for a literal IP host");
		};
		for (const [url, pattern] of [
			["http://10.0.0.1/", /private/],
			["http://192.168.0.1/", /private/],
			["http://169.254.169.254/latest/meta-data/", /link-local/],
			["http://[::1]:3000/", /loopback/],
			["http://[fc00::1]/", /unique local/],
		] as const) {
			const result = await checkUrlAllowed(url, { resolve: explodingResolver });
			expect(result.allowed, url).toBe(false);
			expect(result.reason, url).toMatch(pattern);
		}
	});

	it("rejects the numeric-host spellings of 127.0.0.1", async () => {
		// The WHATWG URL parser normalizes these to dotted-quad before we classify.
		for (const url of ["http://2130706433/", "http://0x7f000001/", "http://127.1/"]) {
			const result = await checkUrlAllowed(url, { resolve: PUBLIC_DNS });
			expect(result.allowed, url).toBe(false);
			expect(result.reason, url).toMatch(/loopback/);
		}
	});

	it("fails closed when DNS resolution fails or returns nothing", async () => {
		const failed = await checkUrlAllowed("https://nope.example/", {
			resolve: async () => {
				throw new Error("ENOTFOUND");
			},
		});
		expect(failed.allowed).toBe(false);
		expect(failed.reason).toMatch(/DNS resolution failed/);

		const empty = await checkUrlAllowed("https://nope.example/", { resolve: resolvesTo() });
		expect(empty.allowed).toBe(false);
		expect(empty.reason).toMatch(/no addresses/);
	});

	it("rejects a non-absolute URL", async () => {
		const result = await checkUrlAllowed("/relative/path", { resolve: PUBLIC_DNS });
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/not a valid absolute URL/);
	});
});

describe("assertUrlAllowed", () => {
	it("returns the parsed URL when allowed", async () => {
		const url = await assertUrlAllowed("https://example.com/a", { resolve: PUBLIC_DNS });
		expect(url.pathname).toBe("/a");
	});

	it("throws UrlBlockedError with the reason when rejected", async () => {
		await expect(assertUrlAllowed("http://169.254.169.254/", { resolve: PUBLIC_DNS })).rejects.toThrow(
			UrlBlockedError,
		);
		await expect(assertUrlAllowed("http://169.254.169.254/", { resolve: PUBLIC_DNS })).rejects.toThrow(/link-local/);
	});
});
