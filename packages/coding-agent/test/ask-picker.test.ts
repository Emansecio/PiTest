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

	it("renders question, options, multi checkboxes and a freeform row", () => {
		const out = drive(
			makeReq({ allowMultiple: true, allowFreeform: true, header: "scope", context: "pick carefully" }),
		).render();
		expect(out).toContain("[scope]");
		expect(out).toContain("Which one?");
		expect(out).toContain("pick carefully");
		expect(out).toContain("[ ] Alpha");
		expect(out).toContain("Type a custom answer");
		expect(out).toContain("space to toggle");
	});
});
