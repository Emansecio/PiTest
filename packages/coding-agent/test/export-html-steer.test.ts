import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("export HTML injected steer rendering", () => {
	const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
	const templateCss = readFileSync(new URL("../src/core/export-html/template.css", import.meta.url), "utf-8");

	it("detects overthink and TTSR system-reminders for compact display", () => {
		expect(templateJs).toMatch(/getInjectedSteerDisplay/);
		expect(templateJs).toMatch(/OVERTHINK_STEER_TEXT_MARKER/);
		expect(templateJs).toMatch(/TTSR_STEER_TEXT_MARKER/);
	});

	it("renders a single compact steer line instead of markdown body", () => {
		expect(templateJs).toMatch(/renderInjectedSteerHtml/);
		expect(templateJs).toMatch(/steer-message/);
		expect(templateJs).toMatch(/Model notified\./);
	});

	it("shows compact steer labels in the sidebar tree", () => {
		expect(templateJs).toMatch(/tree-steer/);
	});

	it("styles steer messages in CSS", () => {
		expect(templateCss).toMatch(/\.steer-message/);
		expect(templateCss).toMatch(/\.steer-label/);
	});
});
