/**
 * Manual QA: instantiate the real (post-Leva-2) message components and dump
 * their rendered output, stripped of ANSI, so we can eyeball the structure.
 *
 *   npx tsx scripts/qa-render-check.mts
 *
 * Not a test — meant for one-shot visual sanity-checking. Safe to delete.
 */

import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { DiagnosticsBlockComponent } from "../src/modes/interactive/components/diagnostics-block.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

process.env.COLORTERM = "truecolor";
initTheme("dark");

function show(label: string, lines: string[]): void {
	console.log(`--- ${label} (${lines.length} lines) ---`);
	for (let i = 0; i < lines.length; i++) {
		console.log(`${i}: ${JSON.stringify(stripAnsi(lines[i]))}`);
	}
	console.log("");
}

show("User (short)", new UserMessageComponent("hello world").render(60));

show(
	"Compaction collapsed",
	new CompactionSummaryMessageComponent({
		type: "compactionSummary",
		summary: "goal text",
		tokensBefore: 142_300,
		timestamp: Date.now(),
	}).render(60),
);

const compExp = new CompactionSummaryMessageComponent({
	type: "compactionSummary",
	summary: "## Goal\nfix the bug",
	tokensBefore: 142_300,
	timestamp: Date.now(),
});
compExp.setExpanded(true);
show("Compaction expanded", compExp.render(60));

show(
	"Branch collapsed",
	new BranchSummaryMessageComponent({
		type: "branchSummary",
		summary: "x",
		timestamp: Date.now(),
	}).render(60),
);

show(
	"Diagnostics collapsed",
	new DiagnosticsBlockComponent(
		"[Skill conflicts]",
		[
			{ type: "collision", source: "a", name: "x", paths: ["a", "b"] },
			{ type: "warning", source: "b", path: "y", message: "warn" },
		] as never,
		new Map(),
	).render(60),
);

const diagExp = new DiagnosticsBlockComponent(
	"[Skill conflicts]",
	[{ type: "collision", source: "a", name: "x", paths: ["a", "b"] }] as never,
	new Map(),
);
diagExp.setExpanded(true);
show("Diagnostics expanded", diagExp.render(60));
