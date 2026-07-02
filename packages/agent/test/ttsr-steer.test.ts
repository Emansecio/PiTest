import { describe, expect, it } from "vitest";
import { formatTtsrSteerDisplayLine, isTtsrSteerMessage } from "../src/ttsr-steer.js";

function buildTtsrReminderLike(name: string, message: string) {
	const text = `<system-reminder>[TTSR:${name}] ${message}</system-reminder>`;
	const userMessage = {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		timestamp: Date.now(),
	};
	Object.defineProperty(userMessage, "_ttsr_injected", {
		value: true,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(userMessage, "_ttsr_rule", {
		value: name,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	return userMessage;
}

describe("isTtsrSteerMessage", () => {
	it("detects live messages via _ttsr_injected", () => {
		const message = buildTtsrReminderLike("no-apology", "Do not apologize.");
		expect(isTtsrSteerMessage(message)).toBe(true);
	});

	it("detects JSONL-restored messages via text marker", () => {
		const message = {
			role: "user" as const,
			content: [
				{
					type: "text" as const,
					text: "<system-reminder>[TTSR:no-apology] Do not apologize.</system-reminder>",
				},
			],
			timestamp: Date.now(),
		};
		expect(isTtsrSteerMessage(message)).toBe(true);
	});

	it("returns false for normal user messages", () => {
		expect(
			isTtsrSteerMessage({
				role: "user",
				content: [{ type: "text", text: "fix the bug in footer.ts" }],
				timestamp: Date.now(),
			}),
		).toBe(false);
	});
});

describe("formatTtsrSteerDisplayLine", () => {
	it("formats from runtime rule marker", () => {
		const message = buildTtsrReminderLike("no-apology", "Do not apologize.");
		expect(formatTtsrSteerDisplayLine(message)).toBe('Rule "no-apology" matched. Model notified.');
	});

	it("formats restored JSONL text without runtime markers", () => {
		const message = {
			role: "user" as const,
			content: [
				{
					type: "text" as const,
					text: "<system-reminder>[TTSR:stop-loop] Stop repeating the same call.</system-reminder>",
				},
			],
			timestamp: Date.now(),
		};
		expect(formatTtsrSteerDisplayLine(message)).toBe('Rule "stop-loop" matched. Model notified.');
	});
});
