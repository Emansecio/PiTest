import { visibleWidth } from "@pit/tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AskOptionsRequest } from "../src/core/user-input-bus.js";
import { type AskPickerResolveResult, createAskPicker } from "../src/modes/interactive/components/ask-picker.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const SPACE = " ";
const CTRL_G = "\x07";
const ALT_O = "\x1bo";

function makeReq(overrides: Partial<AskOptionsRequest>): AskOptionsRequest {
	return {
		requestId: "r",
		question: "Which one?",
		options: [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }],
		source: {},
		...overrides,
	};
}

function drive(req: AskOptionsRequest): {
	send: (data: string) => void;
	result: () => AskPickerResolveResult | null;
	render: (w?: number) => string;
} {
	let result: AskPickerResolveResult | null = null;
	const { component } = createAskPicker(req, (r) => {
		result = r;
	});
	return {
		send: (data) => component.handleInput?.(data),
		result: () => result,
		render: (w = 80) => stripAnsi(component.render(w).join("\n")),
	};
}

describe("ask picker", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("single-select: arrow + enter resolves the highlighted option", () => {
		const p = drive(makeReq({}));
		p.send(DOWN); // → Beta
		p.send(ENTER);
		expect(p.result()).toEqual({ picked: ["Beta"], cancelled: false });
	});

	it("multi-select: space toggles, enter confirms the checked set", () => {
		const p = drive(makeReq({ allowMultiple: true }));
		p.send(SPACE); // check Alpha
		p.send(DOWN);
		p.send(DOWN); // → Gamma
		p.send(SPACE); // check Gamma
		p.send(ENTER);
		expect(p.result()).toEqual({ picked: ["Alpha", "Gamma"], cancelled: false });
	});

	it("freeform row: selecting it then typing resolves freeform text", () => {
		const p = drive(makeReq({ options: [{ label: "Alpha" }], allowFreeform: true }));
		p.send(DOWN); // → freeform row (index 1)
		p.send(ENTER); // enter freeform mode
		for (const ch of "custom") p.send(ch);
		p.send(ENTER); // submit
		expect(p.result()).toEqual({ picked: [], freeformText: "custom", cancelled: false });
	});

	it("freeform-only: drops straight into the text field", () => {
		const p = drive(makeReq({ options: [], allowFreeform: true }));
		for (const ch of "hello") p.send(ch);
		p.send(ENTER);
		expect(p.result()).toEqual({ picked: [], freeformText: "hello", cancelled: false });
	});

	it("esc cancels at the list level", () => {
		const p = drive(makeReq({}));
		p.send(ESC);
		expect(p.result()).toEqual({ picked: [], cancelled: true });
	});

	it("comment: ctrl+g opens the field, type, save, then confirm attaches the comment", () => {
		const p = drive(makeReq({ allowComment: true }));
		p.send(CTRL_G); // open comment field
		for (const ch of "note") p.send(ch);
		p.send(ENTER); // save comment, back to list
		p.send(ENTER); // confirm Alpha
		expect(p.result()).toEqual({ picked: ["Alpha"], comment: "note", cancelled: false });
	});

	it("overlay toggle key invokes the visibility hook", () => {
		let toggles = 0;
		const { component } = createAskPicker(makeReq({}), () => {}, { onToggleVisibility: () => toggles++ });
		component.handleInput?.(ALT_O);
		expect(toggles).toBe(1);
	});

	it("never renders an option line wider than the terminal", () => {
		// Regression: a long label + long description must not overflow `width`
		// (previously crashed TUI.doRender with "Rendered line exceeds terminal width").
		const width = 60;
		const { component } = createAskPicker(
			makeReq({
				options: [
					{
						label: "Yes, rebuild the tui and coding-agent dist then run the test",
						description:
							"tsgo -p tsconfig.build.json in both packages, then run edit-tool-no-full-redraw plus the affected suite",
						recommended: true,
					},
					{ label: "x".repeat(200) },
				],
			}),
			() => {},
		);
		for (const line of component.render(width)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("never renders a header or question line wider than the terminal", () => {
		// Regression: a long single-line question (or header) used to be pushed
		// raw by renderHeader and overflow `width`, crashing TUI.doRender.
		const width = 60;
		const { component } = createAskPicker(
			// Overlay mode renders the question (inline mode defers it to the call line),
			// so exercise the long-question clamp here.
			makeReq({
				displayMode: "overlay",
				header: "h".repeat(120),
				question: `Como tratar o ${"fade-in ".repeat(40)}de blocos do P5?`,
				options: [{ label: "Sim" }, { label: "Não" }],
			}),
			() => {},
		);
		for (const line of component.render(width)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("overlay mode renders question, options, multi checkboxes and a freeform row", () => {
		const out = drive(
			makeReq({
				displayMode: "overlay",
				allowMultiple: true,
				allowFreeform: true,
				header: "scope",
				context: "pick carefully",
			}),
		).render();
		expect(out).toContain("Ask");
		expect(out).toContain("scope");
		expect(out).toContain("Which one?");
		expect(out).toContain("pick carefully");
		expect(out).toContain("Context");
		expect(out).toMatch(/└─/);
		expect(out).toContain("☐ Alpha");
		expect(out).toContain("type custom answer");
		expect(out).toContain("space toggle");
		expect(out).toContain("↑↓ navigate");
		expect(out).toContain("close");
	});

	it("single-select hint uses navigate/select/close labels", () => {
		const out = drive(makeReq({})).render();
		expect(out).toContain("↑↓ navigate");
		expect(out).toMatch(/\bselect\b/);
		expect(out).toMatch(/\bclose\b/);
		expect(out).not.toContain("↑↓ move");
		expect(out).not.toContain("to choose");
		expect(out).not.toContain("to cancel");
	});

	it("inline mode omits the question (the ask call line already shows it) but keeps header, context and options", () => {
		const out = drive(makeReq({ header: "scope", context: "pick carefully" })).render();
		expect(out).toContain("Ask");
		expect(out).toContain("scope");
		expect(out).toContain("pick carefully");
		expect(out).toContain("Context");
		expect(out).toMatch(/└─/);
		expect(out).toContain("Alpha");
		expect(out).not.toContain("Which one?");
	});

	it("focused option shows its full description; an unfocused one clips with an ellipsis", () => {
		const desc = `protege a articulação do joelho de carga acumulada ${"rápido demais ".repeat(4)}na readaptação`;
		const out = drive(
			makeReq({
				options: [
					{ label: "Recomp", description: desc, recommended: true },
					{ label: "Bulk", description: desc },
				],
			}),
		).render(80);
		// The recommended row is focused by default → its description is shown in full.
		expect(out).toContain("readaptação");
		// The unfocused row clips its description, so the cut is marked with an ellipsis.
		expect(out).toContain("…");
	});

	it("renders the recommended badge", () => {
		const out = drive(makeReq({ options: [{ label: "Alpha", recommended: true }, { label: "Beta" }] })).render();
		expect(out).toContain("recommended");
	});

	it("paints selectedBg on the focused option row (U01)", () => {
		let result: AskPickerResolveResult | null = null;
		const { component } = createAskPicker(makeReq({}), (r) => {
			result = r;
		});
		void result;
		const raw = component.render(80).join("\n");
		// paintSelectedRow applies theme.bg("selectedBg", …) → CSI 48;…
		expect(raw).toMatch(/\x1b\[48;/);
		expect(stripAnsi(raw)).toContain("Alpha");
	});

	it("hard-breaks long URL tokens across lines (T01)", () => {
		const url = `https://example.com/${"a".repeat(80)}`;
		const width = 40;
		const { component } = createAskPicker(
			makeReq({
				question: `See ${url}`,
				displayMode: "overlay",
			}),
			() => {},
		);
		const lines = component.render(width);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		const plain = stripAnsi(lines.join("\n"));
		// URL must appear across more than one content line (not a single truncated row).
		const urlFragments = plain.split("\n").filter((l) => l.includes("example.com") || l.includes("aaa"));
		expect(urlFragments.length).toBeGreaterThanOrEqual(2);
	});
});
