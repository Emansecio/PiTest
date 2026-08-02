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

	it("grows a dim elapsed clock after the quiet window, escalating to `quiet` in warning", () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const c = new AgentsLiveComponent(fakeUi());
		c.upsertStart("slow");
		// Inside the 5s window: no clock yet.
		expect(lines(c)[0]).not.toContain("·6s");
		// Past the window with a recent event: dim total elapsed.
		vi.setSystemTime(1_000_000 + 6_000);
		c.upsertProgress("slow", 2, "bash");
		expect(lines(c)[0]).toContain("·6s");
		expect(lines(c)[0]).not.toContain("quiet");
		// 2m10s with no event since (past the per-turn-granularity window): the
		// clock escalates to `quiet <since last event>`.
		vi.setSystemTime(1_000_000 + 6_000 + 130_000);
		const row = lines(c)[0] ?? "";
		expect(row).toContain("quiet 2m10s");
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
