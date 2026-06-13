/**
 * Lazy-omission detector.
 *
 * Catches the classic "I left the rest as-is" corruption: a model writes a
 * placeholder comment — `// rest of the code remains unchanged`,
 * `# ... existing code ...`, `/* unchanged *\/`, `<!-- previous implementation -->`
 * — into the NEW content instead of the actual code. The fuzzy/exact matcher
 * can't catch this (the placeholder is syntactically valid text), so we scan the
 * written content for the elision-comment family and warn (never block).
 *
 * Pure and cheap: a line-by-line scan with two regexes, no I/O. A placeholder
 * line only counts when it is NEW relative to the original content — a legitimate
 * pre-existing `// ... existing ...` line (rare, but possible) won't fire.
 *
 * False-positive discipline: a match requires BOTH a comment opener AND an
 * elision phrase ("unchanged" / "existing code" / "rest of" / "previous
 * implementation" / "same as before" / "code here" / "stays the same" …). A bare
 * `// TODO`, `// NOTE`, or any ordinary comment never fires.
 */

export interface CodeOmissionResult {
	detected: boolean;
	/** The offending placeholder lines (trimmed), in file order, deduped. */
	markers: string[];
}

/**
 * Elision phrase family. Each alternative is the *payload* a comment must carry
 * to count as an omission placeholder. Anchored loosely so wording variants of
 * the same idea ("rest of the file", "remaining code unchanged", "existing code
 * here") all hit, while ordinary words ("unchanged behaviour is tested") do not
 * on their own — they still need a comment opener AND one of these phrases.
 *
 * The phrases are deliberately multi-word: a single word like "unchanged" or
 * "existing" alone is too weak (a real comment could mention them), so we pair
 * them with structural context ("rest"/"remaining"/"existing"/"previous" + the
 * elision verb, or the canonical "... existing code ..." marker).
 */
const ELISION_PHRASE = [
	// "... existing code ...", "... rest of code ...", "... unchanged ..."
	"\\.\\.\\.\\s*(?:existing|rest|previous|unchanged|same|remaining|original)\\b",
	"\\b(?:existing|previous|original|remaining)\\s+(?:code|implementation|content|logic|stuff|lines?|methods?|functions?|body|imports?)\\b",
	// "rest of the file/code/function ...", "remainder of ..."
	"\\b(?:rest|remainder|remaining)\\s+of\\s+(?:the\\s+)?(?:code|file|function|class|method|implementation|content|logic|lines?|block)\\b",
	// "... remains/stays unchanged", "... is unchanged", "code unchanged"
	"\\b(?:remains?|stays?|kept?|left|is|are|unchanged|untouched)\\b[^\\n]*\\bunchanged\\b",
	"\\bunchanged\\b[^\\n]*\\b(?:code|here|below|above|section|block|part|portion)\\b",
	// "same as before", "as before", "no changes here"
	"\\bsame\\s+as\\s+(?:before|above|prior)\\b",
	"\\bno\\s+change(?:s)?\\s+(?:here|needed|below|above)\\b",
	// "... omitted for brevity ...", "code omitted"
	"\\b(?:omitted|elided|truncated|snipped)\\b[^\\n]*\\b(?:brevity|clarity|space|here|code)\\b",
	"\\bcode\\s+(?:goes\\s+)?here\\b",
	// "keep the rest", "leave the rest unchanged", "preserve the rest of the file".
	// Anchored to "rest" only: "rest" is itself an elision target, whereas
	// "keep existing X" / "preserve original X" / "leave remaining X" fire on any
	// ordinary noun (behaviour, timestamps, slots) with NO actual elision — a real
	// false-positive class. Genuine "(keep|preserve) existing/previous/remaining/
	// original CODE" is already caught by the "<existing|previous|…> <code|…>"
	// alternative above, so dropping those bare targets loses no real coverage.
	"\\b(?:keep|leave|preserve)\\s+(?:the\\s+)?rest\\b",
].join("|");

/**
 * Comment-opener family across languages, each immediately followed by the
 * elision payload. We require the elision phrase to sit INSIDE the comment so a
 * line of real code that merely contains the words won't fire.
 *
 *   - `//` `/*` line/block  — C/JS/TS/Java/Go/Rust/Swift/Kotlin/C#…
 *   - `#`                   — Python/Ruby/Shell/YAML/TOML/Perl/R…
 *   - `--`                  — SQL/Lua/Haskell
 *   - `;`                   — Lisp/Clojure/ini/asm
 *   - `<!--`                — HTML/XML/Markdown
 *   - `%`                   — LaTeX/Erlang/Matlab
 *   - `*` (continuation)    — inside a JSDoc/block comment body
 */
const COMMENT_OPENERS = "(?://+|/\\*+|\\*|#+|--+|;+|<!--|%+)";

/**
 * A placeholder line: optional leading whitespace, a comment opener, optional
 * filler punctuation/words, then an elision phrase, to end-of-line. Case
 * insensitive. Built once at module load.
 */
const PHRASE_RE = new RegExp(`^\\s*${COMMENT_OPENERS}\\s*[^\\n]*?(?:${ELISION_PHRASE})`, "i");

/**
 * Bare-keyword placeholder: a comment whose ENTIRE body is a single elision word
 * (plus optional leading "..." and a trailing block-comment close). Catches the
 * minimal `/* unchanged *\/`, `// unchanged`, `# untouched`, `<!-- elided -->`.
 * Kept separate from the phrase regex because a lone "unchanged" is only an
 * elision marker when it's the whole comment — `// returns unchanged data` (real
 * words after it) must NOT fire, so we anchor the close right after the keyword.
 */
const BARE_ELISION_RE = new RegExp(
	`^\\s*${COMMENT_OPENERS}\\s*(?:\\.\\.\\.\\s*)?(?:unchanged|untouched|omitted|elided|snipped|truncated|same)\\b\\s*(?:\\.\\.\\.)?\\s*(?:\\*+/|-->|)?\\s*$`,
	"i",
);

function isPlaceholderLine(line: string): boolean {
	return PHRASE_RE.test(line) || BARE_ELISION_RE.test(line);
}

/** Trim and collapse a line for use as a marker and for set-membership. */
function normalizeLine(line: string): string {
	return line.replace(/\s+/g, " ").trim();
}

/**
 * Detect lazy-omission placeholder comments that are NEW in `newContent`
 * relative to `oldContent`. For a brand-new file pass `oldContent = ""`.
 *
 * Pure, no I/O, no throw. Returns `{ detected, markers }` where `markers` are
 * the trimmed offending lines (deduped, capped) for the warning.
 */
export function detectCodeOmission(oldContent: string, newContent: string): CodeOmissionResult {
	if (!newContent) {
		return { detected: false, markers: [] };
	}

	// Lines that already existed verbatim in the original are not the model's
	// new omission — only NEW placeholder lines count. Compare on normalized
	// form so whitespace/indent reflow doesn't make a pre-existing line "new".
	const oldLines = new Set<string>();
	if (oldContent) {
		for (const line of oldContent.split("\n")) {
			if (isPlaceholderLine(line)) {
				oldLines.add(normalizeLine(line));
			}
		}
	}

	const markers: string[] = [];
	const seen = new Set<string>();
	for (const line of newContent.split("\n")) {
		if (!isPlaceholderLine(line)) continue;
		const norm = normalizeLine(line);
		if (oldLines.has(norm)) continue; // pre-existing placeholder, not the model's elision
		if (seen.has(norm)) continue;
		seen.add(norm);
		markers.push(norm);
		if (markers.length >= MAX_MARKERS) break;
	}

	return { detected: markers.length > 0, markers };
}

/** Cap the number of reported markers so a pathological file can't bloat output. */
const MAX_MARKERS = 10;

/** Env opt-out: `PIT_NO_OMISSION_CHECK=1` disables the post-write scan. */
export function isOmissionCheckEnabled(): boolean {
	return !process.env.PIT_NO_OMISSION_CHECK;
}

/**
 * Build the warning appendix spliced onto a write/edit result when omission
 * placeholders are detected. Returns "" when nothing was detected. Framed as a
 * firm alert (the corruption is silent and high-impact) but never an error — the
 * file already landed; we want the model to re-emit the full content, not think
 * the write failed.
 */
export function formatOmissionWarning(result: CodeOmissionResult, relPath: string): string {
	if (!result.detected) return "";
	const list = result.markers.map((m) => `  ${m}`).join("\n");
	return (
		`\n⚠ Possible truncated edit in ${relPath}: the written content contains placeholder ` +
		`comment(s) that look like elided code rather than the real code:\n${list}\n` +
		`If you meant to keep that code, re-write the file with the FULL content in place of these ` +
		`placeholders — do not leave "rest unchanged" markers in the file.`
	);
}
