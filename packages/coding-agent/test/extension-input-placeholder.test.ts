import { beforeAll, describe, expect, it } from "vitest";
import { ExtensionInputComponent } from "../src/modes/interactive/components/extension-input.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

describe("ExtensionInputComponent placeholder (U03)", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("renders a dim placeholder hint above the input when provided", () => {
		const component = new ExtensionInputComponent(
			"Enter value",
			"e.g. my-project",
			() => {},
			() => {},
		);
		const plain = stripAnsi(component.render(60).join("\n"));
		expect(plain).toContain("Enter value");
		expect(plain).toContain("e.g. my-project");
	});

	it("omits the hint line when placeholder is undefined", () => {
		const component = new ExtensionInputComponent(
			"Enter value",
			undefined,
			() => {},
			() => {},
		);
		const plain = stripAnsi(component.render(60).join("\n"));
		expect(plain).toContain("Enter value");
		expect(plain).not.toContain("e.g.");
	});
});
