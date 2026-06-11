import type { Component } from "@pit/tui";
import { Text } from "@pit/tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
	MessageShell,
	SHELL_GUTTER_CHAR,
	SHELL_GUTTER_COLS,
} from "../src/modes/interactive/components/message-shell.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => {
	initTheme("dark");
});

/** Tiny canned-line component for tests that don't need a real Text/Markdown. */
class Canned implements Component {
	private readonly lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(_width: number): string[] {
		return this.lines.slice();
	}
	invalidate(): void {}
}

const RED = (s: string) => theme.fg("error", s);
const GREEN = (s: string) => theme.fg("success", s);

describe("MessageShell — basic gutter rendering", () => {
	it("prefixes every child line with the gutter char + space", () => {
		const shell = new MessageShell();
		shell.addChild(new Canned(["one", "two", "three"]));

		const out = shell.render(40).map(stripAnsi);

		// First line is the leading spacer (P1). Remaining: gutter + line.
		expect(out[0]).toBe("");
		expect(out[1]).toBe(`${SHELL_GUTTER_CHAR} one`);
		expect(out[2]).toBe(`${SHELL_GUTTER_CHAR} two`);
		expect(out[3]).toBe(`${SHELL_GUTTER_CHAR} three`);
		expect(out).toHaveLength(4);
	});

	it("renders empty when there are no children", () => {
		const shell = new MessageShell();
		expect(shell.render(40)).toEqual([]);
	});

	it("renders empty when children produce no lines", () => {
		const shell = new MessageShell();
		shell.addChild(new Canned([]));
		expect(shell.render(40)).toEqual([]);
	});

	it("reduces width by SHELL_GUTTER_COLS when delegating to children", () => {
		let observed = -1;
		const probe: Component = {
			render(width: number) {
				observed = width;
				return ["x"];
			},
			invalidate() {},
		};
		const shell = new MessageShell();
		shell.addChild(probe);

		shell.render(40);
		expect(observed).toBe(40 - SHELL_GUTTER_COLS);
	});

	it("handles innerWidth=1 floor when the caller gives a tiny width", () => {
		let observed = -1;
		const probe: Component = {
			render(width: number) {
				observed = width;
				return ["x"];
			},
			invalidate() {},
		};
		const shell = new MessageShell();
		shell.addChild(probe);

		shell.render(1);
		expect(observed).toBe(1); // never less than 1
	});

	it("omits the leading blank when noLeadingGap=true", () => {
		const shell = new MessageShell({ noLeadingGap: true });
		shell.addChild(new Canned(["only"]));
		const out = shell.render(20).map(stripAnsi);
		expect(out).toEqual([`${SHELL_GUTTER_CHAR} only`]);
	});
});

describe("MessageShell — label", () => {
	it("injects the label (bold) into the first content line, gutter stays in column 0", () => {
		const shell = new MessageShell({ label: "[compaction]", gutterColor: RED });
		shell.addChild(new Canned(["body line one", "body line two"]));

		const rendered = shell.render(40);
		const out = rendered.map(stripAnsi);

		// Layout: [spacer, gutter + label + content, gutter + content].
		expect(out[0]).toBe("");
		expect(out[1]).toBe(`${SHELL_GUTTER_CHAR} [compaction]  body line one`);
		expect(out[2]).toBe(`${SHELL_GUTTER_CHAR} body line two`);

		// Bold ANSI on the label.
		const firstLineWithAnsi = rendered[1];
		expect(firstLineWithAnsi).toContain("\x1b[1m");
		expect(firstLineWithAnsi).toContain("\x1b[22m");
	});

	it("ignores empty-string labels", () => {
		const shell = new MessageShell({ label: "" });
		shell.addChild(new Canned(["body"]));
		const out = shell.render(20).map(stripAnsi);
		expect(out[1]).toBe(`${SHELL_GUTTER_CHAR} body`);
	});

	it("ignores undefined labels", () => {
		const shell = new MessageShell();
		shell.addChild(new Canned(["body"]));
		const out = shell.render(20).map(stripAnsi);
		expect(out[1]).toBe(`${SHELL_GUTTER_CHAR} body`);
	});

	it("setLabel swaps the label and triggers re-render via invalidate", () => {
		const shell = new MessageShell();
		shell.addChild(new Canned(["body"]));
		expect(stripAnsi(shell.render(20)[1])).toBe(`${SHELL_GUTTER_CHAR} body`);

		shell.setLabel("[skill]");
		expect(stripAnsi(shell.render(20)[1])).toBe(`${SHELL_GUTTER_CHAR} [skill]  body`);
	});
});

describe("MessageShell — color", () => {
	it("applies gutterColor to the gutter character", () => {
		const shell = new MessageShell({ gutterColor: GREEN });
		shell.addChild(new Canned(["x"]));
		const rendered = shell.render(20);
		// Strip ANSI for content check; raw line must still contain ANSI for color check.
		expect(stripAnsi(rendered[1])).toBe(`${SHELL_GUTTER_CHAR} x`);
		expect(rendered[1]).toMatch(/\x1b\[[0-9;]+m/);
	});

	it("falls back to identity color when gutterColor is undefined (assistant case)", () => {
		const shell = new MessageShell();
		shell.addChild(new Canned(["x"]));
		const rendered = shell.render(20);
		// No fg sequence introduced by the shell for the gutter char itself.
		// (The line may still contain ANSI from inner content; here we feed a
		// plain string so we can assert the bare gutter survives.)
		expect(rendered[1].startsWith(SHELL_GUTTER_CHAR)).toBe(true);
	});

	it("setGutterColor swaps the color (used by tool exec state transitions)", () => {
		const shell = new MessageShell({ gutterColor: RED });
		shell.addChild(new Canned(["x"]));
		const beforeLine = shell.render(20)[1];

		shell.setGutterColor(GREEN);
		const afterLine = shell.render(20)[1];

		// Both have ANSI escapes; the escape sequences should differ.
		expect(beforeLine).not.toBe(afterLine);
		expect(stripAnsi(beforeLine)).toBe(stripAnsi(afterLine));
	});

	it("setGutterColor(undefined) reverts to identity", () => {
		const shell = new MessageShell({ gutterColor: RED });
		shell.addChild(new Canned(["x"]));
		shell.setGutterColor(undefined);
		const rendered = shell.render(20);
		// Bare gutter char in column 0 — color reset.
		expect(rendered[1].startsWith(SHELL_GUTTER_CHAR)).toBe(true);
	});
});

describe("MessageShell — shellDisabled (renderShell:'self' opt-out)", () => {
	it("emits children verbatim with NO gutter, NO label, NO leading blank", () => {
		const shell = new MessageShell({
			shellDisabled: true,
			gutterColor: RED,
			label: "[ignored]",
		});
		shell.addChild(new Canned(["self-rendered line 1", "self-rendered line 2"]));

		const out = shell.render(80).map(stripAnsi);
		expect(out).toEqual(["self-rendered line 1", "self-rendered line 2"]);
	});

	it("passes the FULL width through to children when disabled", () => {
		let observed = -1;
		const probe: Component = {
			render(width: number) {
				observed = width;
				return ["x"];
			},
			invalidate() {},
		};
		const shell = new MessageShell({ shellDisabled: true });
		shell.addChild(probe);

		shell.render(80);
		expect(observed).toBe(80);
	});

	it("setShellDisabled toggles between framed and passthrough at runtime", () => {
		const shell = new MessageShell({ gutterColor: RED, label: "[live]" });
		shell.addChild(new Canned(["body"]));

		const framed = shell.render(40).map(stripAnsi);
		expect(framed[1]).toBe(`${SHELL_GUTTER_CHAR} [live]  body`);

		shell.setShellDisabled(true);
		const passthrough = shell.render(40).map(stripAnsi);
		expect(passthrough).toEqual(["body"]);

		shell.setShellDisabled(false);
		expect(shell.render(40).map(stripAnsi)[1]).toBe(`${SHELL_GUTTER_CHAR} [live]  body`);
	});
});

/** Child that hands back the same array instance until `out` is reassigned —
 * mirrors how Text/Markdown signal "unchanged" per the Component contract. */
class StableChild implements Component {
	out: string[];
	constructor(out: string[]) {
		this.out = out;
	}
	render(_width: number): string[] {
		return this.out;
	}
	invalidate(): void {
		this.out = this.out.slice();
	}
}

describe("MessageShell — render memoization", () => {
	it("returns the same array instance when width, children, and props are unchanged", () => {
		const shell = new MessageShell({ gutterColor: RED, label: "[x]" });
		shell.addChild(new StableChild(["a", "b"]));

		const first = shell.render(40);
		const second = shell.render(40);
		expect(second).toBe(first);
		expect(second).toEqual(first);
	});

	it("recomputes when a child swaps its output array (no stale content)", () => {
		const child = new StableChild(["before"]);
		const shell = new MessageShell();
		shell.addChild(child);

		const first = shell.render(40);
		child.out = ["after"];
		const second = shell.render(40);

		expect(second).not.toBe(first);
		expect(stripAnsi(second[1])).toBe(`${SHELL_GUTTER_CHAR} after`);
		// The previously returned array was not mutated.
		expect(stripAnsi(first[1])).toBe(`${SHELL_GUTTER_CHAR} before`);
	});

	it("recomputes when the width changes even with unchanged child refs", () => {
		const shell = new MessageShell();
		shell.addChild(new StableChild(["x"]));
		const w40 = shell.render(40);
		const w20 = shell.render(20);
		expect(w20).not.toBe(w40);
		expect(w20).toEqual(w40); // bytes identical here — the child ignores width
	});

	it("prop setters bust the memo (label / gutter color / spinner / shellDisabled)", () => {
		const shell = new MessageShell({ gutterColor: RED });
		shell.addChild(new StableChild(["body"]));
		const base = shell.render(40);

		shell.setLabel("[new]");
		const labeled = shell.render(40);
		expect(labeled).not.toBe(base);
		expect(stripAnsi(labeled[1])).toBe(`${SHELL_GUTTER_CHAR} [new]  body`);

		shell.setGutterColor(GREEN);
		const recolored = shell.render(40);
		expect(recolored).not.toBe(labeled);
		expect(recolored[1]).not.toBe(labeled[1]);
		expect(stripAnsi(recolored[1])).toBe(stripAnsi(labeled[1]));

		shell.setGutterSpinner("⠋");
		const spun = shell.render(40);
		expect(spun).not.toBe(recolored);
		expect(stripAnsi(spun[1]).startsWith("⠋")).toBe(true);
		shell.setGutterSpinner(undefined);
		expect(stripAnsi(shell.render(40)[1]).startsWith(SHELL_GUTTER_CHAR)).toBe(true);

		shell.setShellDisabled(true);
		expect(shell.render(40).map(stripAnsi)).toEqual(["body"]);
		shell.setShellDisabled(false);
		expect(shell.render(40).map(stripAnsi)).toEqual(["", `${SHELL_GUTTER_CHAR} [new]  body`]);
	});

	it("invalidate() drops the memo and reassembles byte-identically", () => {
		const shell = new MessageShell({ gutterColor: RED, label: "[inv]" });
		shell.addChild(new StableChild(["line"]));

		const first = shell.render(40);
		shell.invalidate();
		const second = shell.render(40);

		expect(second).not.toBe(first);
		expect(second).toEqual(first);
	});

	it("memoizes the empty-collapse result too", () => {
		const shell = new MessageShell();
		const first = shell.render(40);
		expect(first).toEqual([]);
		expect(shell.render(40)).toBe(first);
	});
});

describe("MessageShell — composition", () => {
	it("works with real `Text` children at sensible widths", () => {
		const shell = new MessageShell({ gutterColor: RED });
		shell.addChild(new Text("hello world", 0, 0));

		const out = shell.render(40).map(stripAnsi);
		expect(out[0]).toBe("");
		expect(out[1]).toContain("hello world");
		expect(out[1].startsWith(SHELL_GUTTER_CHAR)).toBe(true);
	});

	it("preserves order across multiple children", () => {
		const shell = new MessageShell();
		shell.addChild(new Canned(["a", "b"]));
		shell.addChild(new Canned(["c"]));

		const out = shell.render(20).map(stripAnsi);
		expect(out).toEqual(["", `${SHELL_GUTTER_CHAR} a`, `${SHELL_GUTTER_CHAR} b`, `${SHELL_GUTTER_CHAR} c`]);
	});
});
