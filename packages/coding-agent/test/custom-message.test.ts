/**
 * Rendering tests for CustomMessageComponent. The `mcp.notice` customType must
 * render as one quiet muted line (a `◦` aside), NOT the loud default card
 * (leading spacer + purple box + bold `[customType]` header) that unknown
 * customTypes fall back to.
 */

import { describe, expect, it } from "vitest";
import type { CustomMessage } from "../src/core/messages.js";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

function makeMessage(customType: string, content: string): CustomMessage {
	return { role: "custom", customType, content, display: true, timestamp: Date.now() };
}

describe("CustomMessageComponent — mcp.notice", () => {
	it("renders the skip notice as a single muted ◦ line, no box, no label", () => {
		initTheme("dark");
		const content = `mcp: "slow" did not connect within 1s — will connect on demand · /mcp`;
		const lines = new CustomMessageComponent(makeMessage("mcp.notice", content)).render(120);
		const plain = lines.map(stripAnsi);
		const nonEmpty = plain.filter((l) => l.trim().length > 0);

		// Exactly one rendered line — the compact route adds no spacer/box.
		expect(lines).toHaveLength(1);
		expect(nonEmpty).toHaveLength(1);
		// The `◦` bullet prefix and the /mcp pointer both survive.
		expect(plain[0]).toContain("◦");
		expect(plain[0]).toContain("/mcp");
		expect(plain[0]).toContain(`"slow"`);
		// None of the loud default-card artifacts: no `[mcp.notice]` header.
		expect(plain.join("\n")).not.toContain("[mcp.notice]");
	});

	it("still renders an unknown customType as the loud default card (contrast)", () => {
		initTheme("dark");
		const lines = new CustomMessageComponent(makeMessage("some.other", "hello there")).render(120);
		const plain = lines.map(stripAnsi).join("\n");

		// The default path keeps the bold `[customType]` header and spans multiple
		// lines (spacer + box), so mcp.notice diverging from it is meaningful.
		expect(plain).toContain("[some.other]");
		expect(lines.length).toBeGreaterThan(1);
	});
});

const DOOM_LOOP_BODY =
	"<doom-loop-reminder>\n" +
	"You have made 4 consecutive identical calls to `read`. This indicates you are not making progress.\n" +
	"</doom-loop-reminder>";

describe("CustomMessageComponent — pi.doom-loop-pause", () => {
	it("renders tier-2 pause as a single muted ◦ line, no box, no label", () => {
		initTheme("dark");
		const content = `${DOOM_LOOP_BODY}\n\nYou have made 4 identical calls without progress. Do NOT repeat this call again.`;
		const lines = new CustomMessageComponent(makeMessage("pi.doom-loop-pause", content)).render(120);
		const plain = lines.map(stripAnsi);
		const nonEmpty = plain.filter((l) => l.trim().length > 0);

		expect(lines).toHaveLength(1);
		expect(nonEmpty).toHaveLength(1);
		expect(plain[0]).toContain("◦");
		expect(plain[0]).toContain("doom-loop pause");
		expect(plain[0]).toContain("4×");
		expect(plain[0]).toContain("`read`");
		expect(plain.join("\n")).not.toContain("[pi.doom-loop-pause]");
		expect(plain.join("\n")).not.toContain("<doom-loop-reminder>");
	});
});

describe("CustomMessageComponent — pi.doom-loop-recovery", () => {
	it("renders tier-3 recovery as a single muted ◦ line, no box, no label", () => {
		initTheme("dark");
		const content =
			"<doom-loop-reminder>\n" +
			"You have made 6 consecutive identical calls to `bash`. This indicates you are not making progress.\n" +
			"</doom-loop-reminder>\n\n" +
			"You have repeated 6 calls to `bash` with no progress. STOP repeating this call.";
		const lines = new CustomMessageComponent(makeMessage("pi.doom-loop-recovery", content)).render(120);
		const plain = lines.map(stripAnsi);
		const nonEmpty = plain.filter((l) => l.trim().length > 0);

		expect(lines).toHaveLength(1);
		expect(nonEmpty).toHaveLength(1);
		expect(plain[0]).toContain("◦");
		expect(plain[0]).toContain("doom-loop recovery");
		expect(plain[0]).toContain("6×");
		expect(plain[0]).toContain("`bash`");
		expect(plain.join("\n")).not.toContain("[pi.doom-loop-recovery]");
		expect(plain.join("\n")).not.toContain("STOP repeating");
	});
});
