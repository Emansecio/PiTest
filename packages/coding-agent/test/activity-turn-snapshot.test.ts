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

describe("full-turn work-phase layout snapshot", () => {
	it("produces the correct component sequence and rendered output", () => {
		const chat: any[] = [];
		const ui = fakeTui();
		const stacker = new ActivityStacker(ui, (c) => chat.push(c));

		// nav(read) + nav(grep) + action(edit) → ONE work phase (the edit is promoted
		// to its own line INSIDE the phase, it no longer fragments the burst).
		stacker.placeCall(navExec("read"));
		stacker.placeCall(navExec("grep"));
		stacker.placeCall(editExec());

		// assistant message 1
		const msg1 = new AssistantMessageComponent(undefined, false, undefined, undefined, ui, false);
		msg1.updateContent({
			role: "assistant",
			content: [{ type: "text", text: "I'll update the manual." }],
		} as any);
		stacker.divide();
		chat.push(msg1);

		// new work phase after divide
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
		// Activity blocks stack tight. The agent-text boundary is symmetric: the
		// AssistantMessage brings its leading blank and the stacker adds one before
		// the next real activity block.
		expect(names).toEqual([
			"WorkGroupComponent",
			"AssistantMessageComponent",
			"Spacer",
			"WorkGroupComponent",
			"AssistantMessageComponent",
		]);

		// --- assert rendered output ---
		const joined = chat
			.flatMap((c) => c.render(120))
			.map(stripAnsi)
			.join("\n");

		// The first phase was sealed by divide() → it collapses to one dense summary
		// line that reabsorbs the promoted edit into the counter (`1 file·1 search·1
		// edit`). No airy separator, no leftover "Explored" verb.
		expect(joined).toContain("1 file");
		expect(joined).toContain("1 search");
		expect(joined).toContain("1 edit");
		expect(joined).not.toContain(" · ");
		expect(joined).not.toContain("Explored");

		// Expanding that sealed phase (ctrl+o) reveals the edit as its own verb-led line.
		const phase1 = chat[0];
		phase1.setExpanded(true);
		expect(phase1.render(120).map(stripAnsi).join("\n")).toContain("Edited");

		// first assistant narration
		expect(joined).toContain("I'll update");

		// deliverable text + marker glyph
		expect(joined).toContain("Pronto");
		expect(joined).toMatch(/[●◉]/);

		// no generic "Did" verb
		expect(joined).not.toContain("Did");

		// activity components carry no gutter bar
		for (const c of chat) {
			if (c.constructor.name === "WorkGroupComponent") {
				for (const l of c.render(120)) {
					expect(stripAnsi(l)).not.toContain("│");
				}
			}
		}
	});

	it("two work phases are separate instances in chat order", () => {
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

		const phases = chat.filter((c) => c.constructor.name === "WorkGroupComponent");
		expect(phases.length).toBe(2);
		expect(phases[0]).not.toBe(phases[1]);
	});
});
