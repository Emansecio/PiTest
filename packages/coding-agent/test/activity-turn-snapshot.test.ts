import type { TUI } from "@pit/tui";
import { beforeAll, describe, expect, it } from "vitest";
import { ActivityStacker } from "../src/modes/interactive/activity-stacker.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

beforeAll(() => initTheme("dark"));

function fakeTui(): TUI {
	return {
		requestRender() {},
		addAnimationCallback() {
			return () => {};
		},
	} as unknown as TUI;
}

function makeExec(overrides: Partial<ToolExecutionComponent>): ToolExecutionComponent {
	return {
		setActivityChild() {},
		setExpanded() {},
		getActivityState: () => "success",
		isAborted: () => false,
		getResultDetails: () => undefined,
		getArgs: () => ({}),
		render: () => [],
		...overrides,
	} as unknown as ToolExecutionComponent;
}

function navExec(toolName: "read" | "grep"): ToolExecutionComponent {
	return makeExec({
		getActivityFamily: () => "navigation",
		getToolName: () => toolName,
		getArgs: () => (toolName === "read" ? { file_path: "src/foo.ts" } : { pattern: "TODO" }),
	});
}

function editExec(): ToolExecutionComponent {
	return makeExec({
		getActivityFamily: () => "action",
		getToolName: () => "edit",
		getArgs: () => ({ path: "server/foo.ts" }),
		getResultDetails: () => ({ diff: "+  1 a\n-  2 b" }),
	});
}

describe("full-turn Amp-layout snapshot", () => {
	it("produces the correct component sequence and rendered output", () => {
		const chat: any[] = [];
		const ui = fakeTui();
		const stacker = new ActivityStacker(ui, (c) => chat.push(c));

		// nav(read) + nav(grep) → same NavGroup
		stacker.placeCall(navExec("read"));
		stacker.placeCall(navExec("grep"));

		// action(edit) → own ActivityLine, closes the group
		stacker.placeCall(editExec());

		// assistant message 1
		const msg1 = new AssistantMessageComponent(undefined, false, undefined, undefined, ui, false);
		msg1.updateContent({
			role: "assistant",
			content: [{ type: "text", text: "I'll update the manual." }],
		} as any);
		stacker.divide();
		chat.push(msg1);

		// new nav group after divide
		stacker.placeCall(navExec("read"));

		// assistant message 2 (deliverable)
		const msg2 = new AssistantMessageComponent(undefined, false, undefined, undefined, ui, false);
		msg2.updateContent({
			role: "assistant",
			content: [{ type: "text", text: "Pronto." }],
		} as any);
		stacker.divide();
		chat.push(msg2);
		msg2.markAsDeliverable();

		// --- assert component sequence ---
		const names = chat.map((c) => c.constructor.name);
		// Activity blocks stack tight (no Spacer between them); the breathing room
		// comes from the AssistantMessage boundary, which brings its own leading blank.
		expect(names).toEqual([
			"NavGroupComponent",
			"ActivityLineComponent",
			"AssistantMessageComponent",
			"NavGroupComponent",
			"AssistantMessageComponent",
		]);

		// --- assert rendered output ---
		const joined = chat
			.flatMap((c) => c.render(120))
			.map(stripAnsi)
			.join("\n");

		// nav group folded verb
		expect(joined).toContain("Explored");

		// action line verb
		expect(joined).toContain("Edited");

		// first assistant narration
		expect(joined).toContain("I'll update");

		// deliverable text
		expect(joined).toContain("Pronto");

		// deliverable marker glyph
		expect(joined).toMatch(/[●◉]/);

		// no generic "Did" verb
		expect(joined).not.toContain("Did");
		expect(joined).not.toContain("Did 1 question");

		// activity components carry no gutter bar
		for (const c of chat) {
			const name = c.constructor.name;
			if (name === "NavGroupComponent" || name === "ActivityLineComponent") {
				for (const l of c.render(120)) {
					expect(stripAnsi(l)).not.toContain("│");
				}
			}
		}
	});

	it("two NavGroups are separate instances in chat order", () => {
		const chat: any[] = [];
		const ui = fakeTui();
		const stacker = new ActivityStacker(ui, (c) => chat.push(c));

		stacker.placeCall(navExec("read"));
		stacker.placeCall(navExec("grep"));
		stacker.placeCall(editExec());

		const msg1 = new AssistantMessageComponent(undefined, false, undefined, undefined, ui, false);
		msg1.updateContent({ role: "assistant", content: [{ type: "text", text: "A" }] } as any);
		stacker.divide();
		chat.push(msg1);

		stacker.placeCall(navExec("read"));

		const msg2 = new AssistantMessageComponent(undefined, false, undefined, undefined, ui, false);
		msg2.updateContent({ role: "assistant", content: [{ type: "text", text: "B" }] } as any);
		stacker.divide();
		chat.push(msg2);

		const navGroups = chat.filter((c) => c.constructor.name === "NavGroupComponent");
		expect(navGroups.length).toBe(2);
		expect(navGroups[0]).not.toBe(navGroups[1]);
	});
});
