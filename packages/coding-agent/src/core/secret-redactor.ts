/**
 * Secret redaction for the DISK EGRESS of the agent (session JSONL, memory,
 * file-digests). The live in-memory message array is NEVER touched — the user
 * needs the real credential in the active turn — only the bytes that land on
 * disk are scrubbed, because the repo (with the .pit session dir) gets pushed to
 * multiple remotes and a verbatim credential on disk is a real leak vector.
 *
 * Default ON. Set PIT_NO_SECRET_REDACT=1 (or true/yes) to disable entirely.
 *
 * Design notes:
 *   - Patterns are compiled ONCE at module load (module-level const array).
 *   - Each match is replaced by `[REDACTED:<type>]`, which contains no JSON
 *     metacharacters, so applying redaction to an ALREADY-serialized JSONL line
 *     keeps it valid JSON (round-trips through JSON.parse). The replacement is a
 *     plain literal — no `$` backreference expansion in the output.
 *   - A cheap `indicator` pre-scan short-circuits the common case (text with no
 *     secret-shaped substring) so the hot append path pays almost nothing.
 *   - Patterns are deliberately specific (fixed prefixes / structural anchors)
 *     to avoid eating commit hashes, file paths, or prose. Generic
 *     `password=`/`api_key=`/`secret=` only fire on an explicit assignment with
 *     a non-trivial value.
 */

import { isTruthyEnvFlag } from "../utils/env-flags.ts";

interface SecretPattern {
	type: string;
	re: RegExp;
}

// Each RegExp is global (so replaceAll-style scanning hits every occurrence) and
// compiled exactly once here. Order matters only for overlapping shapes: the
// more specific provider prefixes run before the generic `Bearer`/assignment
// patterns so a known token gets its precise type label.
const PATTERNS: readonly SecretPattern[] = [
	// AWS access key id — fixed AKIA prefix + 16 base32 chars.
	{ type: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
	// AWS secret access key declared via an explicit aws_secret(_access)?_key
	// assignment (40 base64-ish chars). The bare 40-char token is intentionally
	// NOT matched globally — too many false positives (hashes) — so we anchor on
	// the key name.
	{
		type: "aws-secret-key",
		re: /\baws_secret(?:_access)?_key\b\s*[=:]\s*['"]?([A-Za-z0-9/+]{40})['"]?/gi,
	},
	// Anthropic API key.
	{ type: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
	// OpenAI-style key (sk- followed by 20+ alphanumerics). Runs AFTER the
	// Anthropic pattern so sk-ant-… is labeled anthropic, not openai.
	{ type: "openai-key", re: /\bsk-[A-Za-z0-9]{20,}\b/g },
	// Google API key.
	{ type: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	// GitHub tokens (personal / oauth / server / user-to-server).
	{ type: "github-token", re: /\bgh[posu]_[A-Za-z0-9]{36,}\b/g },
	// Slack token (bot/user/app/refresh/legacy).
	{ type: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
	// JWT (three base64url segments). The header segment starts `eyJ`, which is
	// `{"` base64url-encoded, a strong structural anchor.
	{
		type: "jwt",
		re: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
	},
	// Authorization: Bearer <token>. Keep the header name, redact the token.
	{
		type: "bearer-token",
		re: /\b(Authorization\s*[:=]\s*Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
	},
	// PEM private key blocks (RSA/EC/OPENSSH/DSA/PGP/generic). Redact the whole
	// block including the BEGIN/END armor.
	{
		type: "private-key",
		re: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9]+ )?PRIVATE KEY-----/g,
	},
	// Generic credential assignment, in two safe shapes so we redact config/env
	// dumps without eating source code like `const password = userInput;`:
	//   (a) a QUOTED value:  password = "hunter2"  /  api_key: 'abc…'
	//   (b) a TIGHT bare value with no spaces around the separator: PASSWORD=hunter2
	//       (the env/dotenv/config shape). A spaced unquoted RHS (`x = ident`) is
	//       treated as code and left alone.
	// Anchored on an explicit key=value assignment so prose ("the password is on
	// the wiki") is untouched.
	{
		// The quoted alt tolerates a backslash immediately before/after the quote so
		// it also matches the ALREADY JSON-serialized line, where `KEY="value"` (the
		// dominant dotenv/config shape) appears as `KEY=\"value\"`. The value class
		// excludes backslash so it STOPS at the `\` before the closing `\"` instead
		// of greedily swallowing the structural quote (which would corrupt the JSON).
		// Without this, the quoted form matched neither alt and leaked verbatim to
		// the pushed .jsonl. Group 1 = quote, group 2 = quoted value, group 3 = bare.
		type: "credential",
		re: /\b(?:password|passwd|pwd|api[_-]?key|secret|access[_-]?token|auth[_-]?token|client[_-]?secret)\b(?:\s*[=:]\s*\\?(['"])([^'"\\]{4,})\\?\1|[=:]([^\s'"&]{6,}))/gi,
	},
];

// Cheap substring/shape probe to skip the regex passes on the overwhelmingly
// common no-secret line. If none of these appear, no pattern can match.
//
// Two tiers, because the patterns above differ in case-sensitivity:
//   - CASE_SENSITIVE_INDICATORS back the case-SENSITIVE regexes (no /i flag:
//     AKIA / sk- / AIza / ghp_ / eyJ / PRIVATE KEY …), so a plain `includes`
//     mirrors the regex exactly and is the cheapest possible probe.
//   - CASE_INSENSITIVE_INDICATOR_RE backs the /i regexes (credential,
//     aws-secret-key, bearer-token). The anchor can appear in ANY case
//     (`API_KEY=`, `AWS_SECRET_ACCESS_KEY=`, `Password=`, `Bearer` — uppercase
//     is the dominant dotenv/env convention), so the probe must be /i too;
//     otherwise the gate rejects exactly the secrets these regexes exist to
//     catch and they leak verbatim to disk.
const CASE_SENSITIVE_INDICATORS: readonly string[] = [
	"AKIA",
	"sk-",
	"AIza",
	"ghp_",
	"gho_",
	"ghs_",
	"ghu_",
	"xox",
	"eyJ",
	"PRIVATE KEY",
];

// One compiled /i regex (alternation over the /i anchors) instead of a
// lowercased copy of the text per append — no per-call allocation.
const CASE_INSENSITIVE_INDICATOR_RE = /Bearer|password|passwd|pwd|api[_-]?key|secret|token|aws_secret/i;

function hasIndicator(text: string): boolean {
	for (const ind of CASE_SENSITIVE_INDICATORS) {
		if (text.includes(ind)) return true;
	}
	return CASE_INSENSITIVE_INDICATOR_RE.test(text);
}

export interface RedactionResult {
	redacted: string;
	count: number;
}

/**
 * Replace every recognized secret in `text` with `[REDACTED:<type>]` and return
 * the scrubbed string plus the number of substitutions. Pure: no I/O, no env
 * read (the kill-switch is checked by the wired call sites via
 * {@link isSecretRedactionEnabled}). Safe to apply to a serialized JSONL line —
 * the replacement contains no JSON metacharacters.
 */
export function redactSecrets(text: string): RedactionResult {
	if (!text || !hasIndicator(text)) {
		return { redacted: text, count: 0 };
	}
	let count = 0;
	let out = text;
	for (const { type, re } of PATTERNS) {
		// Reset lastIndex defensively: the regex is shared and global, and a prior
		// partial use could otherwise resume mid-string.
		re.lastIndex = 0;
		const replacement = `[REDACTED:${type}]`;
		out = out.replace(re, (...args) => {
			count++;
			const full = args[0] as string;
			// Bearer: group 1 is the `Authorization: Bearer ` prefix to keep; redact
			// only the token that follows it.
			if (type === "bearer-token" && typeof args[1] === "string") {
				return `${args[1]}${replacement}`;
			}
			// Credential assignment: keep the `key=`/`key: ` prefix (and an opening
			// quote when present), redact only the value. The value is whichever
			// alternative captured it — group 2 (quoted) or group 3 (tight bare).
			if (type === "credential") {
				let value: string | undefined;
				if (typeof args[2] === "string") value = args[2];
				else if (typeof args[3] === "string") value = args[3];
				if (value !== undefined) {
					const valueStart = full.lastIndexOf(value);
					const prefix = valueStart > 0 ? full.slice(0, valueStart) : full;
					return `${prefix}${replacement}`;
				}
			}
			return replacement;
		});
	}
	return { redacted: out, count };
}

let cachedDisabled: boolean | undefined;

/**
 * Whether disk-egress redaction is active. Default ON; disabled by
 * PIT_NO_SECRET_REDACT=1/true/yes. The env var is read exactly once and cached
 * so the hot persist path does not re-parse it on every write.
 */
export function isSecretRedactionEnabled(): boolean {
	if (cachedDisabled === undefined) {
		cachedDisabled = isTruthyEnvFlag(process.env.PIT_NO_SECRET_REDACT);
	}
	return !cachedDisabled;
}

/**
 * Redact `text` for disk egress, honoring the kill-switch. When redaction is
 * disabled, returns the input unchanged. This is the single entry point the
 * write paths call.
 */
export function redactForDisk(text: string): string {
	if (!isSecretRedactionEnabled()) return text;
	return redactSecrets(text).redacted;
}

/** Test-only: reset the cached env read so a test can flip PIT_NO_SECRET_REDACT. */
export function _resetSecretRedactionCacheForTest(): void {
	cachedDisabled = undefined;
}
