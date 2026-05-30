/**
 * Visual prototype for Leva 2 (MessageShell unification).
 *
 * Prints BEFORE / AFTER renderings for each of the 9 message-block roles, side
 * by side, so we can eyeball the visual delta before refactoring 9 real
 * components.
 *
 * Run:
 *   cd packages/coding-agent
 *   npx tsx test/prototype-message-shell.mts
 *
 * Design decisions baked in (per investigation report):
 *   D1 = B  → no bg on any block; gutter is the ONLY block marker
 *   D2 = yes → assistant gets a tênue (muted) gutter
 *   D3 = yes → bash uses the unified shell (no top+bottom DynamicBorders)
 *   D4 = yes → new theme keys (prototype uses literal colors; production
 *              would route through `theme.fg("gutter*")`)
 *   D5 = inheritance → not relevant for the visual prototype, only for the
 *                       eventual migration plan
 *
 * The prototype DOES NOT import the real components — by design — to keep
 * the visual focused on the shell and avoid having to spin up a session,
 * tools manager, etc. It DOES use real `Markdown` and `Box` from `pi-tui`
 * so the inner content rendering matches production.
 */

import { Box, Markdown, type Component, visibleWidth } from "@pit/tui";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.js";

// Force truecolor so the prototype looks the same in CI / piped runs as in a
// real terminal. Without this, theme.fg() may fall back to 8-color sequences
// and the comparison becomes useless.
process.env.COLORTERM = "truecolor";
initTheme("dark");

const TERM_WIDTH = 80; // emulate a typical narrow-ish terminal
const COL_GAP = 4;

// =============================================================================
// Mock "current shells" (BEFORE): replicate the visual idioms in production
// without instantiating real components. Each helper returns lines.
// =============================================================================

function currentUserShell(text: string, width: number): string[] {
	// Box(1,1, userMessageBg) — full-row bg.
	const inner = lines(text).map((l) => ` ${l} `);
	const padded = [""].concat(inner).concat([""]);
	const bg = (s: string) => theme.bg("userMessageBg", s);
	return padded.map((line) => bg(line.padEnd(width, " ")));
}

function currentAssistantShell(text: string, width: number): string[] {
	// No shell — just markdown lines.
	return renderMarkdown(text, width);
}

function currentToolShell(title: string, body: string, state: "pending" | "success" | "error", width: number): string[] {
	const bgKey = state === "pending" ? "toolPendingBg" : state === "success" ? "toolSuccessBg" : "toolErrorBg";
	const bg = (s: string) => theme.bg(bgKey as never, s);
	const header = ` ${theme.bold(theme.fg("toolTitle", title))} `;
	const bodyLines = lines(body).map((l) => ` ${theme.fg("toolOutput", l)} `);
	const padded = [""].concat([header]).concat(bodyLines).concat([""]);
	return padded.map((line) => bg(line.padEnd(width, " ")));
}

function currentBashShell(command: string, output: string, width: number): string[] {
	// DynamicBorder pair: `─` repeated across the width in `bashMode` color.
	const border = theme.fg("bashMode", "─".repeat(width));
	const header = ` ${theme.fg("bashMode", theme.bold(`$ ${command}`))}`;
	const bodyLines = lines(output).map((l) => ` ${theme.fg("muted", l)}`);
	return [border, header, ...bodyLines, border];
}

function currentCustomShell(label: string, body: string, width: number): string[] {
	// Box(1,1, customMessageBg) — purple-ish bg.
	const bg = (s: string) => theme.bg("customMessageBg", s);
	const header = ` ${theme.fg("customMessageLabel", `\x1b[1m[${label}]\x1b[22m`)} `;
	const bodyLines = lines(body).map((l) => ` ${theme.fg("customMessageText", l)} `);
	const padded = [""].concat([header]).concat(bodyLines).concat([""]);
	return padded.map((line) => bg(line.padEnd(width, " ")));
}

function currentDiagnosticsShell(label: string, body: string, width: number): string[] {
	const header = `${theme.fg("warning", label)} ${theme.fg("dim", "(ctrl+x to expand)")}`;
	const bodyLines = lines(body).map((l) => `  ${l}`);
	return [header, ...bodyLines];
}

// =============================================================================
// Prototype MessageShell (AFTER): gutter-only, no bg. The clean direction.
// =============================================================================

type Role = "user" | "assistant" | "toolPending" | "toolSuccess" | "toolError" | "bash" | "custom" | "diagnostics";

const GUTTER_CHAR = "│"; // P3 — thin vertical instead of chunky `▎`

// Per-role gutter colors. Production would route through theme.fg("gutter*")
// etc., but to keep the prototype standalone we inline the hex.
// `undefined` = no color override (default fg). Used for assistant per P5
// — keeps the "neutral reading area" feel while still anchoring an axis.
const GUTTER_COLOR: Record<Role, string | undefined> = {
	user: "#5f87ff", // blue
	assistant: undefined, // default fg — P5
	toolPending: "#808080", // muted gray
	toolSuccess: "#b5bd68", // green
	toolError: "#cc6666", // red
	bash: "#b5bd68", // green — bashMode
	custom: "#9575cd", // purple — customMessageLabel
	diagnostics: "#ffff00", // yellow — warning
};

const RGB_RE = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i;

/**
 * Wrap text with a 24-bit fg sequence; cheap inline alternative to theme.fg.
 * When `hex` is `undefined`, returns the text untouched (default fg). This
 * lets the assistant role keep its gutter char in the terminal default color
 * — P5: assistant is the "neutral reading area".
 */
function fg(hex: string | undefined, text: string): string {
	if (!hex) return text;
	const m = RGB_RE.exec(hex);
	if (!m) return text;
	const r = Number.parseInt(m[1], 16);
	const g = Number.parseInt(m[2], 16);
	const b = Number.parseInt(m[3], 16);
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

interface ShellOptions {
	/**
	 * Optional role label rendered on the FIRST line, right of the gutter.
	 * Kept short — "you", "agent", "bash", etc. Falls back to no label if
	 * `undefined`, matching the current assistant pattern where the role is
	 * implicit from spatial flow.
	 */
	label?: string;
	/** Bold the label tag. */
	boldLabel?: boolean;
}

/**
 * Wrap a content component's rendered lines with a left gutter. The prototype
 * is a function instead of a class — production version will be a Component
 * subclass with the same signature.
 *
 * Width math: gutter eats 2 columns (1 char + 1 space), inner content renders
 * at `width - 2` so total width stays bounded.
 */
function applyShell(role: Role, content: Component, width: number, options: ShellOptions = {}): string[] {
	const innerWidth = Math.max(1, width - 2);
	const innerLines = content.render(innerWidth);
	const gutter = fg(GUTTER_COLOR[role], GUTTER_CHAR);
	const result: string[] = [];

	for (let i = 0; i < innerLines.length; i++) {
		let line = innerLines[i];
		// On the first line, optionally append a role label after a single space.
		// Keeps the label visually attached to the gutter rather than floating
		// inside the content area.
		if (i === 0 && options.label) {
			const labelText = options.boldLabel ? `\x1b[1m${options.label}\x1b[22m` : options.label;
			line = `${fg(GUTTER_COLOR[role], labelText)}  ${line}`;
		}
		result.push(`${gutter} ${line}`);
	}

	// P1 — spacer ONLY before each block (not after). Two consecutive blocks
	// in the chat now share a single blank line between them instead of two,
	// recovering ~30% vertical density. The very first block in chat gets a
	// leading blank from its own shell, matching the current Spacer(1) habit.
	return ["", ...result];
}

/** Same as applyShell but for plain text content (no Markdown). */
function shellFromText(role: Role, text: string, width: number, options: ShellOptions = {}): string[] {
	const innerWidth = Math.max(1, width - 2);
	const innerLines = lines(text);
	const gutter = fg(GUTTER_COLOR[role], GUTTER_CHAR);
	const result: string[] = [];

	for (let i = 0; i < innerLines.length; i++) {
		let line = innerLines[i];
		if (i === 0 && options.label) {
			const labelText = options.boldLabel ? `\x1b[1m${options.label}\x1b[22m` : options.label;
			line = `${fg(GUTTER_COLOR[role], labelText)}  ${line}`;
		}
		// Pad to innerWidth so visually the gutter sits next to a consistent
		// content lane even when content is short. Skipped — current production
		// doesn't pad either; trailing space hurts copy-paste. Mirroring that.
		void innerWidth;
		result.push(`${gutter} ${line}`);
	}

	return ["", ...result];
}

// =============================================================================
// Tiny "content" wrapper that just returns canned lines, so we can reuse
// applyShell for both Markdown and plain text.
// =============================================================================

class TextContent implements Component {
	private readonly text: string;
	constructor(text: string) {
		this.text = text;
	}
	render(width: number): string[] {
		// Naive word wrap — production uses pi-tui's wrapTextWithAnsi but for
		// canned demo text the lines are already short.
		void width;
		return lines(this.text);
	}
	invalidate(): void {}
}

class MarkdownContent implements Component {
	private inner: Markdown;
	constructor(text: string) {
		this.inner = new Markdown(text, 0, 0, getMarkdownTheme());
	}
	render(width: number): string[] {
		return this.inner.render(width);
	}
	invalidate(): void {
		this.inner.invalidate?.();
	}
}

// =============================================================================
// Helpers
// =============================================================================

function lines(text: string): string[] {
	return text.split("\n");
}

function renderMarkdown(text: string, width: number): string[] {
	return new Markdown(text, 0, 0, getMarkdownTheme()).render(width);
}

function banner(text: string, color: "before" | "after"): void {
	const tag = color === "before" ? fg("#cc6666", `[BEFORE]`) : fg("#b5bd68", `[AFTER]`);
	console.log("");
	console.log(`${tag} ${fg("#d4d4d4", text)}`);
	console.log(fg("#505050", "─".repeat(TERM_WIDTH)));
}

function section(title: string): void {
	console.log("");
	console.log(fg("#f0c674", `\x1b[1m━━ ${title} ━━\x1b[22m`));
}

function printLines(lns: string[]): void {
	for (const l of lns) console.log(l);
}

// =============================================================================
// Demo data
// =============================================================================

const USER_TEXT = "find every callsite of `executeBash` and tell me which ones don't pass an abort signal";

const ASSISTANT_TEXT =
	"Looking at the codebase. I'll grep for `executeBash(` first, then narrow to the ones without an abort signal.\n\n" +
	"Found 6 callsites total; 2 of them omit the abort signal:\n\n" +
	"- `src/modes/interactive/interactive-mode.ts:5421` — passes args directly\n" +
	"- `src/cli/print-mode.ts:142` — wraps result for print mode\n";

const TOOL_CALL_BODY = `read C:/PiTest/packages/coding-agent/src/core/agent-session.ts:300-400`;

const TOOL_RESULT_BODY =
	"299  // Retry state\n300  private _retryAbortController: AbortController | undefined = undefined;\n301  private _retryAttempt = 0;\n302  // ...";

const BASH_CMD = "npm run check";

const BASH_OUTPUT =
	"> biome check --error-on-warnings . && tsgo --noEmit\n" +
	"Checked 701 files in 251ms. No fixes applied.\n" +
	"> node scripts/check-browser-smoke.mjs\n" +
	"> node scripts/check-generated-models.mjs";

const COMPACTION_SUMMARY = "Compacted from 142,300 tokens (ctrl+x to expand)";

const DIAGNOSTICS_BODY = "[Skill conflicts] 2 collisions + 1 warning (ctrl+x to expand)";

// =============================================================================
// Run
// =============================================================================

function runBefore(): void {
	section("BEFORE — current shells (bg-row idioms + bash borders)");

	banner("User message — solid bg row", "before");
	printLines(currentUserShell(USER_TEXT, TERM_WIDTH));

	banner("Assistant message — no shell, just markdown", "before");
	printLines(currentAssistantShell(ASSISTANT_TEXT, TERM_WIDTH));

	banner("Tool execution (pending → success)", "before");
	printLines(currentToolShell("read", TOOL_CALL_BODY, "pending", TERM_WIDTH));
	console.log("");
	printLines(currentToolShell("read", TOOL_RESULT_BODY, "success", TERM_WIDTH));

	banner("Tool execution (error)", "before");
	printLines(currentToolShell("bash", "Command failed: exit 1", "error", TERM_WIDTH));

	banner("Bash execution — par de DynamicBorders + verde", "before");
	printLines(currentBashShell(BASH_CMD, BASH_OUTPUT, TERM_WIDTH));

	banner("Compaction summary — bg roxo", "before");
	printLines(currentCustomShell("compaction", COMPACTION_SUMMARY, TERM_WIDTH));

	banner("Branch summary — bg roxo", "before");
	printLines(currentCustomShell("branch", "Branch summary (ctrl+x to expand)", TERM_WIDTH));

	banner("Skill invocation — bg roxo", "before");
	printLines(currentCustomShell("skill", "attio", TERM_WIDTH));

	banner("Custom message — bg roxo (variável)", "before");
	printLines(currentCustomShell("hindsight", "Saved 1 entry to bank", TERM_WIDTH));

	banner("Diagnostics — sem shell, label warning", "before");
	printLines(currentDiagnosticsShell("[Skill conflicts]", "2 collisions + 1 warning (ctrl+x to expand)", TERM_WIDTH));
}

function runAfter(): void {
	section("AFTER v2 — P1 spacer-leading, P2 brackets, P3 thin char, P5 assistant sem cor");

	banner("User — gutter azul (sem label; cor já comunica)", "after");
	printLines(shellFromText("user", USER_TEXT, TERM_WIDTH));

	banner("Assistant — gutter dim (tênue) com markdown completo", "after");
	printLines(applyShell("assistant", new MarkdownContent(ASSISTANT_TEXT), TERM_WIDTH));

	banner("Tool execution (pending → success)", "after");
	printLines(shellFromText("toolPending", `${theme.bold("read")}  ${TOOL_CALL_BODY}`, TERM_WIDTH));
	printLines(shellFromText("toolSuccess", `${theme.bold("read")}  ${TOOL_CALL_BODY}\n${TOOL_RESULT_BODY}`, TERM_WIDTH));

	banner("Tool execution (error)", "after");
	printLines(shellFromText("toolError", `${theme.bold("bash")}  Command failed: exit 1`, TERM_WIDTH));

	banner("Bash — mesmo shell, gutter verde", "after");
	printLines(shellFromText("bash", `${theme.bold(`$ ${BASH_CMD}`)}\n${BASH_OUTPUT}`, TERM_WIDTH));

	banner("Compaction summary — gutter roxo + [bracket label]", "after");
	printLines(shellFromText("custom", COMPACTION_SUMMARY, TERM_WIDTH, { label: "[compaction]", boldLabel: true }));

	banner("Branch summary — gutter roxo + [bracket label]", "after");
	printLines(shellFromText("custom", "Branch summary (ctrl+x to expand)", TERM_WIDTH, {
		label: "[branch]",
		boldLabel: true,
	}));

	banner("Skill invocation — gutter roxo + [bracket label]", "after");
	printLines(shellFromText("custom", "attio", TERM_WIDTH, { label: "[skill]", boldLabel: true }));

	banner("Custom message (extensão) — gutter roxo + [bracket label]", "after");
	printLines(shellFromText("custom", "Saved 1 entry to bank", TERM_WIDTH, { label: "[hindsight]", boldLabel: true }));

	banner("Diagnostics — gutter amarelo", "after");
	printLines(shellFromText("diagnostics", "[Skill conflicts] 2 collisions + 1 warning (ctrl+x to expand)", TERM_WIDTH));
}

function runComboFlow(): void {
	section("FLUXO COMPLETO — sequência típica de um turno (AFTER)");
	console.log(
		fg(
			"#808080",
			"User pede algo → Assistant pensa → 3 tool calls em série → Assistant resposta final → User próximo turno.\n",
		),
	);

	printLines(shellFromText("user", "fix the failing test in footer-stats-cache.test.ts", TERM_WIDTH));
	printLines(applyShell("assistant", new MarkdownContent("Vou ler o teste e o componente afetado primeiro."), TERM_WIDTH));
	printLines(shellFromText("toolSuccess", `${theme.bold("read")}  test/footer-stats-cache.test.ts`, TERM_WIDTH));
	printLines(shellFromText("toolSuccess", `${theme.bold("read")}  src/modes/interactive/components/footer.ts`, TERM_WIDTH));
	printLines(shellFromText("toolSuccess", `${theme.bold("edit")}  src/modes/interactive/components/footer.ts (3 edits)`, TERM_WIDTH));
	printLines(shellFromText("bash", `${theme.bold("$ npx vitest --run test/footer-stats-cache.test.ts")}\n10 passed`, TERM_WIDTH));
	printLines(applyShell("assistant", new MarkdownContent("Pronto. 10/10 passando."), TERM_WIDTH));
	printLines(shellFromText("user", "show me the diff", TERM_WIDTH));
}

console.log("");
console.log(fg("#f0c674", "\x1b[1m═══ MessageShell prototype (Leva 2) ═══\x1b[22m"));
console.log(fg("#808080", `Width emulado: ${TERM_WIDTH} colunas. Rode em terminal ANSI truecolor.`));

runBefore();
runAfter();
runComboFlow();

// Hint at where this lives in the migration
console.log("");
console.log(fg("#505050", "─".repeat(TERM_WIDTH)));
console.log(fg("#808080", "Esse é só o protótipo. Em produção:"));
console.log(fg("#808080", "  • gutters viriam de theme.fg('gutter*'), não hex inline"));
console.log(fg("#808080", "  • MessageShell será classe (extends Container) com cache e dispose"));
console.log(fg("#808080", "  • opt-out via renderShell:'self' e custom renderers continua funcionando"));
console.log(fg("#808080", "  • OSC133 markers preservados (user/assistant) com posição relaxada"));
console.log("");

void visibleWidth; // import warm — used in production version for label padding math
