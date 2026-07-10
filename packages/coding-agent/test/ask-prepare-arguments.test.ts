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

describe("prepareAskArguments — JSON-stringified options", () => {
	it("parses options from a JSON string", () => {
		const options = [{ label: "Yes" }, { label: "No", recommended: true }];
		expect(
			prepareAskArguments({
				question: "Proceed?",
				options: JSON.stringify(options),
			}),
		).toEqual({
			question: "Proceed?",
			options,
		});
	});

	it("leaves options alone when the string is not valid JSON", () => {
		const input = { question: "Proceed?", options: "not json" };
		expect(prepareAskArguments(input)).toEqual(input);
	});

	it("leaves options alone when JSON parses to a non-array", () => {
		const input = { question: "Proceed?", options: JSON.stringify({ label: "Yes" }) };
		expect(prepareAskArguments(input)).toEqual(input);
	});

	it("keeps the same reference when options is already an array", () => {
		const input = { question: "Proceed?", options: [{ label: "Yes" }] };
		expect(prepareAskArguments(input)).toBe(input);
	});

	it("composes timeout alias with options coercion", () => {
		const options = [{ label: "A" }];
		expect(
			prepareAskArguments({
				question: "Pick",
				timeout: 3000,
				options: JSON.stringify(options),
			}),
		).toEqual({
			question: "Pick",
			timeout_ms: 3000,
			options,
		});
	});
});
