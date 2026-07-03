import { afterEach, describe, expect, it } from "vitest";
import {
	CHARS_PER_TOKEN_DENSE,
	CHARS_PER_TOKEN_NONLATIN,
	CHARS_PER_TOKEN_PROSE,
	CHARS_PER_TOKEN_SERIALIZED_SUMMARY,
	charsPerToken,
	classifyTextDensity,
	estimateStringTokens,
	inspectTokenEstimateCalibration,
	isDenseText,
	recordTokenEstimateSample,
	resetTokenEstimateCalibration,
	TOKEN_CALIBRATION_FACTOR_MAX,
	TOKEN_CALIBRATION_FACTOR_MIN,
	TOKEN_CALIBRATION_MIN_SAMPLE_TOKENS,
	tokenEstimateFactor,
} from "../src/token-estimate.ts";

describe("chars-per-token constants (M7 single source of truth)", () => {
	it("pins the audited ratios", () => {
		expect(CHARS_PER_TOKEN_PROSE).toBe(4);
		expect(CHARS_PER_TOKEN_DENSE).toBe(3.3);
		expect(CHARS_PER_TOKEN_NONLATIN).toBe(2);
		// 3.7 is deliberate (summary/bench ratio) — must NOT be normalized away.
		expect(CHARS_PER_TOKEN_SERIALIZED_SUMMARY).toBe(3.7);
	});

	it("charsPerToken maps every kind and ignores the (not-yet-tabled) model", () => {
		expect(charsPerToken("prose")).toBe(CHARS_PER_TOKEN_PROSE);
		expect(charsPerToken("dense")).toBe(CHARS_PER_TOKEN_DENSE);
		expect(charsPerToken("nonlatin")).toBe(CHARS_PER_TOKEN_NONLATIN);
		expect(charsPerToken("serialized-summary")).toBe(CHARS_PER_TOKEN_SERIALIZED_SUMMARY);
		// API is model-ready, but no per-family table exists yet: same answer.
		expect(charsPerToken("prose", "claude-opus-4-6")).toBe(charsPerToken("prose"));
	});
});

describe("density heuristic", () => {
	it("classifies plain prose as prose", () => {
		const prose = "Hello world this is a plain sentence without any symbols at all";
		expect(isDenseText(prose)).toBe(false);
		expect(classifyTextDensity(prose)).toBe("prose");
	});

	it("classifies JSON/code as dense (structural symbols > 5%)", () => {
		const dense = '{"key":"value","arr":[1,2,3],"nested":{"x":true}}'.repeat(10);
		expect(isDenseText(dense)).toBe(true);
		expect(classifyTextDensity(dense)).toBe("dense");
	});

	it("classifies XML markup as dense", () => {
		const xml = '<skills>\n<skill name="a" path="b"/>\n<skill name="c" path="d"/>\n</skills>\n'.repeat(20);
		expect(classifyTextDensity(xml)).toBe("dense");
	});

	it("classifies CJK-heavy text as nonlatin (>30% non-ASCII code points)", () => {
		const cjk = "这是一段中文文本用来测试密度分类".repeat(5);
		expect(classifyTextDensity(cjk)).toBe("nonlatin");
	});

	it("estimateStringTokens applies the matching divisor", () => {
		const prose = "word ".repeat(200);
		expect(estimateStringTokens(prose)).toBe(Math.ceil(prose.length / CHARS_PER_TOKEN_PROSE));
		expect(estimateStringTokens(prose, true)).toBe(Math.ceil(prose.length / CHARS_PER_TOKEN_DENSE));
		const cjk = "这是一段中文文本用来测试".repeat(10);
		expect(estimateStringTokens(cjk)).toBe(Math.ceil(cjk.length / CHARS_PER_TOKEN_NONLATIN));
		expect(estimateStringTokens("")).toBe(0);
	});

	it("forceDense never overrides the non-latin path", () => {
		const cjk = "这是一段中文文本用来测试".repeat(10);
		expect(estimateStringTokens(cjk, true)).toBe(Math.ceil(cjk.length / CHARS_PER_TOKEN_NONLATIN));
	});
});

describe("online calibration (M5)", () => {
	afterEach(() => {
		resetTokenEstimateCalibration();
	});

	it("is neutral (factor 1.0) with no recorded pairs", () => {
		expect(tokenEstimateFactor()).toBe(1);
		expect(tokenEstimateFactor("some-model")).toBe(1);
		expect(inspectTokenEstimateCalibration().global).toBeUndefined();
	});

	it("first sample seeds the factor at the observed ratio", () => {
		recordTokenEstimateSample("model-a", 10_000, 12_000);
		expect(tokenEstimateFactor("model-a")).toBeCloseTo(1.2, 10);
	});

	it("EMA converges toward the true ratio over repeated pairs", () => {
		for (let i = 0; i < 40; i++) {
			recordTokenEstimateSample("model-a", 10_000, 13_000);
		}
		expect(tokenEstimateFactor("model-a")).toBeCloseTo(1.3, 3);
	});

	it("clamps the factor into [0.5, 2.0]", () => {
		recordTokenEstimateSample("model-lo", 100_000, 1_000); // ratio 0.01
		recordTokenEstimateSample("model-hi", 10_000, 1_000_000); // ratio 100
		expect(tokenEstimateFactor("model-lo")).toBe(TOKEN_CALIBRATION_FACTOR_MIN);
		expect(tokenEstimateFactor("model-hi")).toBe(TOKEN_CALIBRATION_FACTOR_MAX);
	});

	it("ignores samples below the minimum estimated-token floor (noise guard)", () => {
		recordTokenEstimateSample("model-a", TOKEN_CALIBRATION_MIN_SAMPLE_TOKENS - 1, 100_000);
		expect(tokenEstimateFactor("model-a")).toBe(1);
		expect(inspectTokenEstimateCalibration().byModel["model-a"]).toBeUndefined();
	});

	it("ignores non-finite and non-positive inputs", () => {
		recordTokenEstimateSample("model-a", Number.NaN, 10_000);
		recordTokenEstimateSample("model-a", 10_000, Number.POSITIVE_INFINITY);
		recordTokenEstimateSample("model-a", 10_000, 0);
		recordTokenEstimateSample("", 10_000, 10_000);
		expect(tokenEstimateFactor("model-a")).toBe(1);
	});

	it("keeps per-model factors separate and falls back to the global EMA for unknown models", () => {
		recordTokenEstimateSample("model-a", 10_000, 15_000);
		recordTokenEstimateSample("model-b", 10_000, 8_000);
		expect(tokenEstimateFactor("model-a")).toBeCloseTo(1.5, 10);
		expect(tokenEstimateFactor("model-b")).toBeCloseTo(0.8, 10);
		// Unknown model -> global blend (seeded 1.5, then EMA toward 0.8).
		const global = tokenEstimateFactor("model-never-seen");
		expect(global).toBeGreaterThan(0.8);
		expect(global).toBeLessThan(1.5);
		expect(global).toBe(tokenEstimateFactor());
	});

	it("reset drops all state and inspect exposes samples/ratios", () => {
		recordTokenEstimateSample("model-a", 10_000, 12_000);
		const snapshot = inspectTokenEstimateCalibration();
		expect(snapshot.byModel["model-a"]?.samples).toBe(1);
		expect(snapshot.byModel["model-a"]?.lastEstimatedTokens).toBe(10_000);
		expect(snapshot.byModel["model-a"]?.lastActualTokens).toBe(12_000);
		expect(snapshot.global?.samples).toBe(1);
		resetTokenEstimateCalibration();
		expect(tokenEstimateFactor("model-a")).toBe(1);
		expect(inspectTokenEstimateCalibration().byModel).toEqual({});
	});
});
