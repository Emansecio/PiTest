/**
 * Kill-switch flags must follow the repo convention: `isTruthyEnvFlag`
 * (1/true/yes/on/y/…), never a literal `=== "1"` comparison — the literal form
 * makes `FLAG=true` a silent no-op. One case per flag migrated in the
 * token-economy pass, asserting the non-"1" truthy spelling works.
 */

import { afterEach, describe, expect, it } from "vitest";
import { isReadDedupeDisabled, isStaleReadWarningDisabled } from "../src/core/agent-session.ts";
import { SettingsManager } from "../src/core/settings-manager.js";

const TOUCHED = ["PIT_NO_READ_DEDUPE", "PIT_READ_DEDUPE", "PIT_NO_STALE_READ_WARNING", "PIT_NO_PENDING_CHECKS"];

afterEach(() => {
	for (const name of TOUCHED) delete process.env[name];
});

describe("PIT_NO_READ_DEDUPE (+ legacy PIT_READ_DEDUPE=0 alias)", () => {
	it("is on by default", () => {
		expect(isReadDedupeDisabled({})).toBe(false);
	});

	it("accepts every truthy spelling, not just '1'", () => {
		for (const value of ["1", "true", "TRUE", "yes"]) {
			expect(isReadDedupeDisabled({ PIT_NO_READ_DEDUPE: value })).toBe(true);
		}
	});

	it("keeps the legacy inverted-polarity alias working", () => {
		expect(isReadDedupeDisabled({ PIT_READ_DEDUPE: "0" })).toBe(true);
		expect(isReadDedupeDisabled({ PIT_READ_DEDUPE: "1" })).toBe(false);
	});

	it("reads process.env when no env is passed", () => {
		process.env.PIT_NO_READ_DEDUPE = "true";
		expect(isReadDedupeDisabled()).toBe(true);
	});
});

describe("PIT_NO_STALE_READ_WARNING", () => {
	it("is on by default and honors truthy spellings", () => {
		expect(isStaleReadWarningDisabled({})).toBe(false);
		expect(isStaleReadWarningDisabled({ PIT_NO_STALE_READ_WARNING: "1" })).toBe(true);
		expect(isStaleReadWarningDisabled({ PIT_NO_STALE_READ_WARNING: "true" })).toBe(true);
		expect(isStaleReadWarningDisabled({ PIT_NO_STALE_READ_WARNING: "0" })).toBe(false);
	});
});

describe("PIT_NO_PENDING_CHECKS", () => {
	it("forces pending checks off for '1' and for 'true'", () => {
		for (const value of ["1", "true"]) {
			process.env.PIT_NO_PENDING_CHECKS = value;
			expect(SettingsManager.inMemory().getPendingChecksSettings().enabled).toBe(false);
		}
	});

	it("leaves the setting alone when unset or falsy", () => {
		expect(SettingsManager.inMemory().getPendingChecksSettings().enabled).toBe(true);
		process.env.PIT_NO_PENDING_CHECKS = "0";
		expect(SettingsManager.inMemory().getPendingChecksSettings().enabled).toBe(true);
	});
});
