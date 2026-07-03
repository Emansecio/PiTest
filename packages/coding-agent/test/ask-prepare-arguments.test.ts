import { describe, expect, it } from "vitest";
import { prepareAskArguments } from "../src/core/tools/ask.ts";

/**
 * prepareAskArguments runs pre-validation (schema validation lives downstream
 * in the wrapped tool path, not in a direct `execute()` call — see
 * bash-prepare-arguments.test.ts for the established pattern this mirrors).
 * `timeout` was the schema key before the ask/bash/debug timeout-unit fix;
 * `timeout_ms` is now canonical, but harnesses still sending the old key must
 * keep working with identical millisecond semantics.
 */
describe("prepareAskArguments — legacy timeout alias", () => {
	it("renames the legacy `timeout` key to `timeout_ms`", () => {
		expect(prepareAskArguments({ question: "Pick", timeout: 5000 })).toEqual({
			question: "Pick",
			timeout_ms: 5000,
		});
	});

	it("prefers `timeout_ms` when both keys are present (canonical wins)", () => {
		expect(prepareAskArguments({ question: "Pick", timeout: 1000, timeout_ms: 5000 })).toEqual({
			question: "Pick",
			timeout_ms: 5000,
		});
	});

	it("keeps the same reference when nothing changes (no timeout key)", () => {
		const input = { question: "Pick" };
		expect(prepareAskArguments(input)).toBe(input);
	});

	it("passes through non-object input untouched", () => {
		expect(prepareAskArguments(null)).toBe(null);
		expect(prepareAskArguments(undefined)).toBe(undefined);
	});
});
