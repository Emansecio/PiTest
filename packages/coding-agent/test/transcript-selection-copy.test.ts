import { beforeEach, describe, expect, test, vi } from "vitest";
import * as clipboard from "../src/utils/clipboard.ts";

const callCopy = (self: unknown, text: string): void => {
	(interactiveModeClass as any).prototype.copySelectionToClipboard.call(self, text);
};

let interactiveModeClass: unknown;
const copyToClipboard = vi.spyOn(clipboard, "copyToClipboard");

beforeEach(async () => {
	if (!interactiveModeClass) {
		interactiveModeClass = (await import("../src/modes/interactive/interactive-mode.ts")).InteractiveMode;
	}
	copyToClipboard.mockReset();
});

describe("InteractiveMode transcript selection clipboard feedback", () => {
	test("reports success only after the clipboard write resolves", async () => {
		let resolveCopy!: () => void;
		const pendingCopy = new Promise<void>((resolve) => {
			resolveCopy = resolve;
		});
		copyToClipboard.mockReturnValue(pendingCopy);
		const self = { showStatus: vi.fn(), showWarning: vi.fn() };

		callCopy(self, "hello");
		expect(self.showStatus).not.toHaveBeenCalled();

		resolveCopy();
		await vi.waitFor(() => expect(self.showStatus).toHaveBeenCalledOnce());
		expect(self.showWarning).not.toHaveBeenCalled();
	});

	test("handles clipboard rejection and never reports false success", async () => {
		copyToClipboard.mockRejectedValue(new Error("clipboard unavailable"));
		const self = { showStatus: vi.fn(), showWarning: vi.fn() };

		callCopy(self, "hello");

		await vi.waitFor(() =>
			expect(self.showWarning).toHaveBeenCalledWith(expect.stringContaining("clipboard unavailable")),
		);
		expect(self.showStatus).not.toHaveBeenCalled();
	});
});
