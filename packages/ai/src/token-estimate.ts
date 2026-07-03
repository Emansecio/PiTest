/**
 * Single source of truth for chars-per-token estimation (M7) and online
 * estimate calibration (M5).
 *
 * Before this module, three unreconciled chars/token ratios coexisted:
 * 4 / 3.3 / 2 in coding-agent's compaction.ts, 3.7 in compaction/utils.ts,
 * and a hardcoded 4 in the faux provider and the overthink guard. Every
 * consumer now imports the constants (and the density heuristic that selects
 * between them) from here.
 *
 * WHICH RATIO TO USE
 * - PROSE (4 chars/token): natural-language text — user prompts, assistant
 *   narration, summaries. The classic BPE rule of thumb for English.
 * - DENSE (3.3 chars/token): code, JSON, tool outputs, XML frames. Structural
 *   symbols fragment into more tokens per char than prose.
 * - NONLATIN (2 chars/token): CJK/Cyrillic/emoji-heavy text. Non-ASCII code
 *   points cost roughly 0.5-2 tokens each; the ASCII divisors underestimate
 *   badly.
 * - SERIALIZED_SUMMARY (3.7 chars/token): the deliberate middle ground used
 *   for summarizer OUTPUT trimming and the token-economy bench scripts —
 *   summaries are prose interleaved with paths/identifiers, denser than pure
 *   prose but lighter than code. Kept as its own named constant (NOT collapsed
 *   into PROSE or DENSE) because the bench baselines are calibrated to it.
 *
 * None of these is a real tokenizer; they are wire-cost heuristics. The
 * calibration below (M5) corrects their systematic error online from real
 * provider usage, per model, at process scope.
 */

/** Chars-per-token for natural-language prose (~4 chars/token for English BPE). */
export const CHARS_PER_TOKEN_PROSE = 4;
/** Chars-per-token for dense content: code, JSON, tool output, XML frames. */
export const CHARS_PER_TOKEN_DENSE = 3.3;
/**
 * Chars-per-token for non-latin-heavy text (CJK, Cyrillic, emoji, …). Non-ASCII
 * code points cost far more BPE tokens per char than ASCII — roughly 0.5-2
 * tokens/char — so estimates fall back to this denser divisor when the
 * non-ASCII fraction crosses {@link NONLATIN_FRACTION_THRESHOLD}.
 */
export const CHARS_PER_TOKEN_NONLATIN = 2;
/**
 * Chars-per-token for serialized conversation/summary text (prose interleaved
 * with paths, identifiers, and light markup). Deliberately between PROSE and
 * DENSE; the token-economy bench baselines are calibrated against this value,
 * so it must not be silently normalized to either neighbor.
 */
export const CHARS_PER_TOKEN_SERIALIZED_SUMMARY = 3.7;

/** Non-ASCII code-point fraction above which text is classified non-latin. */
export const NONLATIN_FRACTION_THRESHOLD = 0.3;

/** Density classes the heuristic can assign to a text. */
export type TextDensity = "prose" | "dense" | "nonlatin";

/** Every text kind this module knows a chars/token ratio for. */
export type TokenTextKind = TextDensity | "serialized-summary";

/**
 * Chars-per-token ratio for a text kind.
 *
 * The `model` parameter is accepted so call sites can already thread the model
 * id through, but NO per-model-family table exists yet — dynamic per-model
 * correction is handled by the online calibration ({@link tokenEstimateFactor})
 * instead of invented static numbers. When a vetted per-family table lands, it
 * plugs in here without touching consumers.
 */
export function charsPerToken(kind: TokenTextKind, _model?: string): number {
	switch (kind) {
		case "prose":
			return CHARS_PER_TOKEN_PROSE;
		case "dense":
			return CHARS_PER_TOKEN_DENSE;
		case "nonlatin":
			return CHARS_PER_TOKEN_NONLATIN;
		case "serialized-summary":
			return CHARS_PER_TOKEN_SERIALIZED_SUMMARY;
	}
}

// Structural symbols counted by isDenseText, as char codes (precomputed once
// instead of an indexOf-scan over the 14-char string per character).
const STRUCTURAL_CODES = new Set<number>('{}[]()<>;:,="'.split("").map((c) => c.charCodeAt(0)));

/**
 * Classify text as dense (code/JSON/tool-output/XML) or prose.
 * Dense: non-alphanumeric non-space char fraction > 0.20,
 * OR structural symbol density > 0.05.
 */
export function isDenseText(text: string): boolean {
	if (text.length === 0) return false;
	let nonAlphaNum = 0;
	let structural = 0;
	for (let i = 0; i < text.length; i++) {
		const cc = text.charCodeAt(i);
		// not whitespace: space(32) tab(9) lf(10) cr(13)
		if (cc !== 32 && cc !== 9 && cc !== 10 && cc !== 13) {
			const isAlnum = (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122);
			if (!isAlnum) nonAlphaNum++;
		}
		if (STRUCTURAL_CODES.has(cc)) structural++;
	}
	return nonAlphaNum / text.length > 0.2 || structural / text.length > 0.05;
}

/**
 * Full density classification: non-latin first (non-ASCII code-point fraction
 * over {@link NONLATIN_FRACTION_THRESHOLD}, surrogate pairs counted once), then
 * the dense-vs-prose symbol heuristic.
 */
export function classifyTextDensity(text: string): TextDensity {
	if (text.length === 0) return "prose";
	let nonAscii = 0;
	let codePoints = 0;
	for (const ch of text) {
		codePoints++;
		const cp = ch.codePointAt(0);
		if (cp !== undefined && cp > 127) nonAscii++;
	}
	if (codePoints > 0 && nonAscii / codePoints > NONLATIN_FRACTION_THRESHOLD) return "nonlatin";
	return isDenseText(text) ? "dense" : "prose";
}

/**
 * Estimate tokens for a raw text string via density classification.
 * `forceDense` skips the prose/dense heuristic (tool outputs are always dense)
 * but never overrides the non-latin path — non-ASCII text underestimates even
 * with the dense divisor.
 */
export function estimateStringTokens(text: string, forceDense = false): number {
	if (text.length === 0) return 0;
	// Count non-ASCII code points (surrogate pairs counted once, so emoji = 1).
	let nonAscii = 0;
	let codePoints = 0;
	for (const ch of text) {
		codePoints++;
		const cp = ch.codePointAt(0);
		if (cp !== undefined && cp > 127) nonAscii++;
	}
	// Non-latin heavy text underestimates badly with the ASCII divisors; use a
	// denser ratio so the estimate stays close to real BPE token cost.
	if (codePoints > 0 && nonAscii / codePoints > NONLATIN_FRACTION_THRESHOLD) {
		return Math.ceil(text.length / CHARS_PER_TOKEN_NONLATIN);
	}
	const dense = forceDense || isDenseText(text);
	return Math.ceil(text.length / (dense ? CHARS_PER_TOKEN_DENSE : CHARS_PER_TOKEN_PROSE));
}

// ============================================================================
// M5 — Online calibration (EMA per model, process-scoped, never persisted)
// ============================================================================

/** EMA smoothing factor for calibration samples. */
export const TOKEN_CALIBRATION_ALPHA = 0.2;
/**
 * Minimum char-based estimate (tokens) for a sample to update the EMA. Small
 * spans carry mostly noise (rounding, per-message ceil) — learning from them
 * would let one tiny turn swing the factor.
 */
export const TOKEN_CALIBRATION_MIN_SAMPLE_TOKENS = 5_000;
/** Clamp bounds for the correction factor — estimates are never scaled beyond 2x either way. */
export const TOKEN_CALIBRATION_FACTOR_MIN = 0.5;
export const TOKEN_CALIBRATION_FACTOR_MAX = 2.0;

interface CalibrationState {
	factor: number;
	samples: number;
	lastRatio: number;
	lastEstimatedTokens: number;
	lastActualTokens: number;
}

/** Read-only snapshot of one calibration bucket (test/diagnostic surface). */
export interface TokenCalibrationSnapshot {
	factor: number;
	samples: number;
	lastRatio: number;
	lastEstimatedTokens: number;
	lastActualTokens: number;
}

const calibrationByModel = new Map<string, CalibrationState>();
let calibrationGlobal: CalibrationState | undefined;

function clampFactor(value: number): number {
	return Math.min(TOKEN_CALIBRATION_FACTOR_MAX, Math.max(TOKEN_CALIBRATION_FACTOR_MIN, value));
}

function updateState(
	state: CalibrationState | undefined,
	ratio: number,
	estimated: number,
	actual: number,
): CalibrationState {
	if (!state) {
		return { factor: ratio, samples: 1, lastRatio: ratio, lastEstimatedTokens: estimated, lastActualTokens: actual };
	}
	state.factor = clampFactor(state.factor + TOKEN_CALIBRATION_ALPHA * (ratio - state.factor));
	state.samples++;
	state.lastRatio = ratio;
	state.lastEstimatedTokens = estimated;
	state.lastActualTokens = actual;
	return state;
}

/**
 * Record one (char-based estimate, real provider usage) pair for the same span.
 * Callers own span consistency: both numbers MUST cover the same request
 * surface (the wire estimator records messages + system prompt + tool schemas
 * against `usage.totalTokens`, which bills exactly that). Samples below
 * {@link TOKEN_CALIBRATION_MIN_SAMPLE_TOKENS} estimated tokens are dropped so
 * the EMA never learns from noise. State is per-process and never persisted.
 */
export function recordTokenEstimateSample(modelId: string, estimatedTokens: number, actualTokens: number): void {
	if (!modelId) return;
	if (!Number.isFinite(estimatedTokens) || !Number.isFinite(actualTokens)) return;
	if (estimatedTokens < TOKEN_CALIBRATION_MIN_SAMPLE_TOKENS || actualTokens <= 0) return;
	const ratio = clampFactor(actualTokens / estimatedTokens);
	calibrationByModel.set(modelId, updateState(calibrationByModel.get(modelId), ratio, estimatedTokens, actualTokens));
	calibrationGlobal = updateState(calibrationGlobal, ratio, estimatedTokens, actualTokens);
}

/**
 * Correction factor for char-based token estimates. Per-model when that model
 * has samples; the process-global EMA otherwise (a model without history still
 * benefits from the process-level signal, clamped); NEUTRAL 1.0 when no pairs
 * were ever recorded — deterministic scenarios without real usage (benches,
 * tests, first turns) are byte-identical to the uncalibrated estimate.
 *
 * The factor multiplies ONLY char-based portions of an estimate (trailing
 * messages after a usage anchor, pending messages, fully unanchored spans) —
 * NEVER the real usage numbers themselves.
 */
export function tokenEstimateFactor(modelId?: string): number {
	if (modelId) {
		const state = calibrationByModel.get(modelId);
		if (state) return state.factor;
	}
	return calibrationGlobal?.factor ?? 1;
}

/** Drop all calibration state (tests). */
export function resetTokenEstimateCalibration(): void {
	calibrationByModel.clear();
	calibrationGlobal = undefined;
}

/** Snapshot of the calibration state (tests/diagnostics). */
export function inspectTokenEstimateCalibration(): {
	global?: TokenCalibrationSnapshot;
	byModel: Record<string, TokenCalibrationSnapshot>;
} {
	const byModel: Record<string, TokenCalibrationSnapshot> = {};
	for (const [model, state] of calibrationByModel) byModel[model] = { ...state };
	return { global: calibrationGlobal ? { ...calibrationGlobal } : undefined, byModel };
}
