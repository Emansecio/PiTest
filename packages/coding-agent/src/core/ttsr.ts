/**
 * Time-Traveling Stream Rules (TTSR).
 *
 * A rule is a regex paired with a message and a scope. While the model streams
 * a turn, accumulating text or tool-arg JSON is matched against active rules.
 * On the first match, the caller (agent-loop) is expected to abort the current
 * request, inject a `<system-reminder>` carrying `rule.message`, and retry the
 * same turn so the model "time-travels" with a hindsight signal.
 *
 * This module exposes pure data structures + a per-run matcher. It performs no
 * I/O and never aborts or replays on its own.
 */

export type TTSRScope = "assistant_text" | "tool_args" | "any";

export interface TTSRRule {
	/** Stable identifier shown to the model in the injected reminder. */
	name: string;
	/** Serialized regex source. Compiled at load time via `compileRules`. */
	regex: string;
	/** Reminder body emitted to the model on match. */
	message: string;
	/** Stream scope to monitor. Defaults to "assistant_text". */
	scope?: TTSRScope;
	/** When true, rule is skipped entirely. */
	disabled?: boolean;
}

export interface CompiledTTSRRule extends Omit<TTSRRule, "regex"> {
	regex: RegExp;
	/** Original serialized source for diagnostics. */
	originalSource: string;
	scope: TTSRScope;
}

export interface TTSRMatcher {
	/**
	 * Feed an incoming chunk for a specific scope. Returns the first rule that
	 * matches the per-scope rolling buffer, or undefined when nothing fires.
	 */
	feed(chunk: string, scope: "assistant_text" | "tool_args"): CompiledTTSRRule | undefined;
	/** Clear all rolling buffers without losing rule state. */
	reset(): void;
}

/**
 * Max characters retained per scope buffer. Older characters are dropped.
 * Override via PIT_TTSR_BUFFER_CHARS, clamped to [512, 65536]; a non-numeric
 * value falls back to the default. Parsed once at load.
 */
const DEFAULT_ROLLING_BUFFER_CHARS = 2048;

export function parseRollingBufferChars(raw: string | undefined): number {
	if (raw === undefined || raw === "") return DEFAULT_ROLLING_BUFFER_CHARS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return DEFAULT_ROLLING_BUFFER_CHARS;
	return Math.min(65536, Math.max(512, Math.floor(parsed)));
}

const ROLLING_BUFFER_CHARS = parseRollingBufferChars(
	typeof process !== "undefined" ? process.env.PIT_TTSR_BUFFER_CHARS : undefined,
);

// Dev-facing guard, emitted at most once per process: a rule whose pattern source
// is already longer than the rolling buffer can never match (the buffer drops the
// oldest chars first), so the rule silently misses. Pattern length is a cheap lower
// bound on the span the rule needs.
let bufferSpanWarningEmitted = false;

function warnIfRuleExceedsBuffer(rules: CompiledTTSRRule[]): void {
	if (bufferSpanWarningEmitted) return;
	for (const rule of rules) {
		if (rule.originalSource.length > ROLLING_BUFFER_CHARS) {
			bufferSpanWarningEmitted = true;
			console.warn(
				`TTSR: rule "${rule.name}" pattern is ${rule.originalSource.length} chars, longer than the rolling buffer (${ROLLING_BUFFER_CHARS} chars); it may never match. Raise PIT_TTSR_BUFFER_CHARS.`,
			);
			return;
		}
	}
}

/**
 * Compile a list of serialized rules. Disabled entries are dropped. Bad regex
 * patterns throw with the offending rule named so misconfigurations surface at
 * load time instead of during a hot stream.
 */
export function compileRules(rules: TTSRRule[]): CompiledTTSRRule[] {
	const compiled: CompiledTTSRRule[] = [];
	for (const rule of rules) {
		if (rule.disabled) continue;
		let compiledRegex: RegExp;
		try {
			compiledRegex = new RegExp(rule.regex);
		} catch (error) {
			throw new Error(
				`TTSR: failed to compile regex for rule "${rule.name}": ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		compiled.push({
			name: rule.name,
			regex: compiledRegex,
			originalSource: rule.regex,
			message: rule.message,
			scope: rule.scope ?? "assistant_text",
			disabled: rule.disabled,
		});
	}
	return compiled;
}

/**
 * Build a matcher with one rolling buffer per scope. Buffers are independent so
 * a tool-args match cannot bleed into assistant-text matches and vice versa.
 */
export function createMatcher(rules: CompiledTTSRRule[]): TTSRMatcher {
	warnIfRuleExceedsBuffer(rules);
	let textBuffer = "";
	let toolArgsBuffer = "";

	const ruleMatchesScope = (ruleScope: TTSRScope, feedScope: "assistant_text" | "tool_args"): boolean => {
		if (ruleScope === "any") return true;
		return ruleScope === feedScope;
	};

	return {
		feed(chunk, scope) {
			if (!chunk || rules.length === 0) return undefined;
			if (scope === "assistant_text") {
				textBuffer = (textBuffer + chunk).slice(-ROLLING_BUFFER_CHARS);
			} else {
				toolArgsBuffer = (toolArgsBuffer + chunk).slice(-ROLLING_BUFFER_CHARS);
			}
			const haystack = scope === "assistant_text" ? textBuffer : toolArgsBuffer;
			for (const rule of rules) {
				if (!ruleMatchesScope(rule.scope, scope)) continue;
				if (rule.regex.test(haystack)) {
					// Clear buffers on a hit so the same match cannot fire repeatedly
					// against later chunks while the caller is reacting to the first
					// one. Caller is expected to reset() again before each turn anyway.
					textBuffer = "";
					toolArgsBuffer = "";
					return rule;
				}
			}
			return undefined;
		},
		reset() {
			textBuffer = "";
			toolArgsBuffer = "";
		},
	};
}
