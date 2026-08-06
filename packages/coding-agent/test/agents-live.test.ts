import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentsLiveComponent } from "../src/modes/interactive/components/agents-live.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const PREV_MOTION = process.env.PIT_REDUCED_MOTION;

beforeAll(() => {
	initTheme("dark");
	// Deterministic settles: ColorEase snaps under reduced motion, so a row shows
	// its ✓/✗ immediately instead of holding the spinner through a live crossfade.
	process.env.PIT_REDUCED_MOTION = "1";
});

afterAll(() => {
	if (PREV_MOTION === undefined) delete process.env.PIT_REDUCED_MOTION;
	else process.env.PIT_REDUCED_MOTION = PREV_MOTION;
});

afterEach(() => {
	vi.useRealTimers();
});

// Minimal TUI stand-in: the strip only needs addAnimationCallback (returning an
// unsub) and requestRender. Cast through never so the test does not depend on
// the full TUI surface.
function fakeUi() {
	return { addAnimationCallback: () => () => {}, requestRender: () => {} } as never;
}

function lines(c: AgentsLiveComponent, width = 120): string[] {
	return c.render(width).map(stripAnsi);
}

describe("AgentsLiveComponent", () => {
	it("renders a single agent as one bare line (no header, no connector)", () => {
		const c = new AgentsLiveComponent(fakeUi());
		c.upsertStart("provas");
		c.upsertProgress("provas", 3, "find");
		const out = lines(c);
		expect(out.length).toBe(1);
		expect(out[0]).toContain("Agent “provas”·turn 3·find");
		expect(out[0]).not.toContain("├");
		expect(out[0]).not.toContain("Agents·");
		c.dispose();
	});

	it("grows a header and tree connectors from two agents up", () => {
		const c = new AgentsLiveComponent(fakeUi());
		c.upsertStart("provas");
		c.upsertStart("copy-hero");
		c.upsertStart("design-pricing");
		c.upsertProgress("provas", 3, "find");
		c.upsertProgress("copy-hero", 1, "read");
		// formatTokens keeps a decimal only below 10k: 9300 → "9.3k".
		c.complete("design-pricing", "done", 4, 9300);

		const out = lines(c);
		// Header counts SETTLED/total, then one row per agent in insertion order.
		expect(out[0]).toContain("Agents·1/3");
		// Mixed settled+running: header lead is a quiet mark, not a braille spinner.
		expect(out[0]?.startsWith("·")).toBe(true);
		expect(out[1]).toContain("├");
		expect(out[1]).toContain("provas·turn 3·find");
		expect(out[2]).toContain("├");
		expect(out[2]).toContain("copy-hero·turn 1·read");
		expect(out[3]?.startsWith("└")).toBe(true);
		expect(out[3]).toContain("✓ design-pricing·4 turns·9.3k tok");
		// The `Agent “x”` spelling belongs to the single-agent shape only.
		expect(out.some((l) => l.includes("Agent “"))).toBe(false);
		c.dispose();
	});

	it("header lead is outcome when all settled, quiet mark when mixed, spinner only when all live", () => {
		const c = new AgentsLiveComponent(fakeUi());
		c.upsertStart("a");
		c.upsertStart("b");
		// All live: lead is some spinner frame (not · and not ✓).
		const allLive = lines(c)[0] ?? "";
		expect(allLive).toContain("Agents·0/2");
		expect(allLive.startsWith("·")).toBe(false);
		expect(allLive.startsWith("✓")).toBe(false);

		c.complete("a", "done", 1);
		const mixed = lines(c)[0] ?? "";
		expect(mixed.startsWith("·")).toBe(true);
		expect(mixed).toContain("Agents·1/2");

		c.complete("b", "done", 1);
		const done = lines(c)[0] ?? "";
		expect(done.startsWith("✓")).toBe(true);
		expect(done).toContain("Agents·2/2");
		c.dispose();
	});

	it("marks an errored agent as failed and settles only when every agent is done", () => {
		const c = new AgentsLiveComponent(fakeUi());
		c.upsertStart("faq");
		c.upsertStart("provas");
		c.complete("faq", "error", 2);
		expect(c.allSettled()).toBe(false);

		const failRow = lines(c).find((l) => l.includes("faq")) ?? "";
		expect(failRow).toContain("✗ faq·failed·2 turns");

		c.complete("provas", "done", 5);
		expect(c.allSettled()).toBe(true);
		expect(c.hasAgents()).toBe(true);
		c.dispose();
	});

	it("does not let a stale terminal event overwrite the first terminal outcome", () => {
		const c = new AgentsLiveComponent(fakeUi());
		c.upsertStart("a");
		c.complete("a", "error", 2, 100);
		c.complete("a", "done", 9, 9000);
		const row = lines(c).find((line) => line.includes("a")) ?? "";
		expect(row).toContain("failed");
		expect(row).toContain("2 turns");
		expect(row).not.toContain("9 turns");
		c.dispose();
	});

	it("caps the strip at 10 rows and folds the rest into `+N more`", () => {
		const c = new AgentsLiveComponent(fakeUi());
		for (let i = 1; i <= 12; i++) c.upsertStart(`agent-${i}`);
		const out = lines(c);
		// header + 10 rows + the overflow line.
		expect(out.length).toBe(12);
		expect(out[0]).toContain("Agents·0/12");
		expect(out[out.length - 1]).toContain("+2 more");
		expect(out.some((l) => l.includes("agent-11"))).toBe(false);

		// Progress updates a row in place — no new lines, same agent count.
		c.upsertProgress("agent-1", 7, "bash");
		const after = lines(c);
		expect(after.length).toBe(out.length);
		expect(after.some((l) => l.includes("agent-1·turn 7·bash"))).toBe(true);
		c.dispose();
	});

	it("summarizes a multi run (failure leads, counts + summed tokens)", () => {
		const c = new AgentsLiveComponent(fakeUi());
		c.upsertStart("a");
		c.upsertStart("b");
		c.upsertStart("faq");
		c.complete("a", "done", 3, 4000);
		c.complete("b", "done", 2, 5300);
		c.complete("faq", "error", 1);

		const summary = stripAnsi(c.summaryLine());
		expect(summary.startsWith("✗")).toBe(true);
		expect(summary).toContain("3 agents");
		expect(summary).toContain("2✓");
		expect(summary).toContain("1✗");
		expect(summary).toContain("9.3k tok"); // 4000 + 5300, summed then compacted
		c.dispose();
	});

	it("does not present cancelled agents as successful", () => {
		const c = new AgentsLiveComponent(fakeUi());
		c.upsertStart("cancelled-one");
		c.upsertStart("cancelled-two");
		c.complete("cancelled-one", "cancelled", 1);
		c.complete("cancelled-two", "cancelled", 1);
		const summary = stripAnsi(c.summaryLine());
		expect(summary.startsWith("-")).toBe(true);
		expect(summary).toContain("2-");
		expect(lines(c)[0]).toContain("Agents");
		expect(lines(c)[0]?.startsWith("-")).toBe(true);
		expect(lines(c).some((line) => line.includes("cancelled"))).toBe(true);
		c.dispose();
	});

	it("keeps terminal state visible at narrow widths", () => {
		const c = new AgentsLiveComponent(fakeUi());
		c.upsertStart("a-very-long-subagent-handle");
		c.complete("a-very-long-subagent-handle", "error", 2);
		const out = lines(c, 30);
		expect(out[0]).toContain("failed");
		expect(out[0]?.length).toBeLessThanOrEqual(30);
		c.dispose();
	});

	it("summarizes a single run with the handle and its metrics", () => {
		const c = new AgentsLiveComponent(fakeUi());
		c.upsertStart("provas");
		c.complete("provas", "done", 4, 9300);
		const summary = stripAnsi(c.summaryLine());
		expect(summary.startsWith("✓")).toBe(true);
		expect(summary).toContain("provas");
		expect(summary).toContain("4 turns");
		expect(summary).toContain("9.3k tok");
		// No agent reported tokens → the token clause disappears entirely.
		const bare = new AgentsLiveComponent(fakeUi());
		bare.upsertStart("solo");
		bare.complete("solo", "done", 2);
		expect(stripAnsi(bare.summaryLine())).not.toContain("tok");
		bare.dispose();
		c.dispose();
	});

	it("shows live cumulative tokens on a running row (↑Nk)", () => {
		const c = new AgentsLiveComponent(fakeUi());
		c.upsertStart("provas");
		c.upsertProgress("provas", 2, "read", 9300);
		expect(lines(c)[0]).toContain("Agent “provas”·turn 2·read·↑9.3k");
		// No tokens reported yet → no ↑ clause at all.
		const bare = new AgentsLiveComponent(fakeUi());
		bare.upsertStart("solo");
		bare.upsertProgress("solo", 1, "grep");
		expect(lines(bare)[0]).not.toContain("↑");
		bare.dispose();
		c.dispose();
	});

	it("grows elapsed → waiting… → quiet as silence lengthens", () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const c = new AgentsLiveComponent(fakeUi());
		c.upsertStart("slow");
		// Inside the 5s window: no clock yet.
		expect(lines(c)[0]).not.toContain("·6s");
		// Past the window with a recent event: dim total elapsed.
		vi.setSystemTime(1_000_000 + 6_000);
		c.upsertProgress("slow", 2, "bash");
		expect(lines(c)[0]).toContain("·6s");
		expect(lines(c)[0]).not.toContain("waiting");
		expect(lines(c)[0]).not.toContain("quiet");
		// 15s with no event: soft "waiting…" (still under the 120s warning).
		vi.setSystemTime(1_000_000 + 6_000 + 15_000);
		expect(lines(c)[0]).toContain("waiting…");
		expect(lines(c)[0]).not.toContain("quiet");
		// 2m10s with no event since: escalates to `quiet <since last event>`.
		vi.setSystemTime(1_000_000 + 6_000 + 130_000);
		const row = lines(c)[0] ?? "";
		expect(row).toContain("quiet 2m10s");
		expect(row).not.toContain("waiting");
		c.dispose();
	});

	it("stale progress after completion never revives a settled row", () => {
		const c = new AgentsLiveComponent(fakeUi());
		c.upsertStart("a");
		c.upsertStart("b");
		c.complete("a", "done", 3, 1000);
		// Reordered/late progress for the finished agent: ignored, row stays ✓.
		c.upsertProgress("a", 4, "bash");
		expect(c.allSettled()).toBe(false);
		const rowA = lines(c).find((l) => l.includes("a·")) ?? "";
		expect(rowA).toContain("✓ a·3 turns");
		expect(rowA).not.toContain("turn 4");
		c.complete("b", "done", 1);
		expect(c.allSettled()).toBe(true);
		// An explicit re-start DOES revive (deliberate second wave on the handle).
		c.upsertStart("a");
		expect(c.allSettled()).toBe(false);
		// Revive clears the previous wave's settle residue: row is live again
		// (Agent “a” spelling for the single-live case after b is also done —
		// wait, b is done and a is running → multi shape). No ✓, no stale turns.
		const revived = lines(c).find((l) => l.includes("a")) ?? "";
		expect(revived).not.toContain("✓");
		expect(revived).toContain("turn 1");
		expect(revived).not.toContain("3 turns");
		c.dispose();
	});

	it("never regresses a running row when progress arrives out of order", () => {
		const c = new AgentsLiveComponent(fakeUi());
		c.upsertStart("gate [attempt 2 worker]");
		c.upsertProgress("gate [attempt 2 worker]", 4, "write", 800);
		c.upsertProgress("gate [attempt 2 worker]", 2, "read", 500);
		const row = lines(c)[0] ?? "";
		expect(row).toContain("turn 4");
		expect(row).toContain("↑800");
		c.dispose();
	});

	it("collapse preview paints the dense summary as a single line", () => {
		const c = new AgentsLiveComponent(fakeUi());
		c.upsertStart("a");
		c.upsertStart("b");
		c.complete("a", "done", 2, 1000);
		c.complete("b", "done", 3, 2000);
		// Multi-row while settled.
		expect(lines(c).length).toBeGreaterThan(1);
		c.enterCollapsePreview();
		expect(c.isCollapsePreview()).toBe(true);
		const preview = lines(c);
		expect(preview.length).toBe(1);
		expect(preview[0]).toContain("2 agents");
		// A new start cancels the preview beat.
		c.upsertStart("c");
		expect(c.isCollapsePreview()).toBe(false);
		expect(lines(c).length).toBeGreaterThan(1);
		c.dispose();
	});

	it("auto-hides without agents and disposes idempotently", () => {
		const c = new AgentsLiveComponent(fakeUi());
		expect(c.render(120)).toEqual([]);
		expect(c.hasAgents()).toBe(false);
		expect(c.allSettled()).toBe(false);
		expect(c.summaryLine()).toBe("");

		c.upsertStart("x");
		expect(c.render(120).length).toBe(1);
		c.dispose();
		c.dispose();
		expect(c.hasAgents()).toBe(false);
		expect(c.render(120)).toEqual([]);
	});
});
