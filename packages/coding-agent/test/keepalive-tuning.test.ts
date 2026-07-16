import { describe, expect, test } from "vitest";
import { resolveKeepAliveOptions } from "../src/utils/env-flags.ts";

describe("resolveKeepAliveOptions", () => {
	test("default: 60s keep-alive, max at undici's 600s default", () => {
		expect(resolveKeepAliveOptions({})).toEqual({
			keepAliveTimeout: 60_000,
			keepAliveMaxTimeout: 600_000,
		});
	});

	test("PIT_KEEPALIVE_MS overrides the timeout", () => {
		expect(resolveKeepAliveOptions({ PIT_KEEPALIVE_MS: "15000" })).toEqual({
			keepAliveTimeout: 15_000,
			keepAliveMaxTimeout: 600_000,
		});
	});

	test("override above undici's max default raises keepAliveMaxTimeout to match", () => {
		expect(resolveKeepAliveOptions({ PIT_KEEPALIVE_MS: "900000" })).toEqual({
			keepAliveTimeout: 900_000,
			keepAliveMaxTimeout: 900_000,
		});
	});

	test("invalid overrides fall back to the default (fail-open)", () => {
		for (const bad of ["abc", "NaN", "", "  ", "-5", "0", "0.4", "Infinity"]) {
			expect(resolveKeepAliveOptions({ PIT_KEEPALIVE_MS: bad })?.keepAliveTimeout).toBe(60_000);
		}
	});

	test("fractional override is floored", () => {
		expect(resolveKeepAliveOptions({ PIT_KEEPALIVE_MS: "1500.9" })?.keepAliveTimeout).toBe(1500);
	});

	test("PIT_NO_KEEPALIVE_TUNING=1 disables the tuning entirely", () => {
		expect(resolveKeepAliveOptions({ PIT_NO_KEEPALIVE_TUNING: "1" })).toBeUndefined();
		expect(resolveKeepAliveOptions({ PIT_NO_KEEPALIVE_TUNING: "true", PIT_KEEPALIVE_MS: "15000" })).toBeUndefined();
		// falsy values keep the tuning on
		expect(resolveKeepAliveOptions({ PIT_NO_KEEPALIVE_TUNING: "0" })).toBeDefined();
	});
});
