import { SPINNER_FRAME_MS } from "@pit/tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FusionLiveComponent, type FusionLiveMember } from "../../src/modes/interactive/components/fusion-live.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

// Minimal TUI stand-in: the component only needs addAnimationCallback (returns an
// unsub) and requestRender. Cast through never so we don't depend on the full TUI.
function fakeUi() {
	return { addAnimationCallback: () => () => {}, requestRender: () => {} } as never;
}

/** Capture the animation callback FusionLive registers on construction. */
function trackingUi(): { ui: never; tick: (now: number) => boolean } {
	let cb: ((now: number) => boolean) | null = null;
	const ui = {
		addAnimationCallback(fn: (now: number) => boolean) {
			cb = fn;
			return () => {
				cb = null;
			};
		},
		requestRender: () => {},
	} as never;
	return {
		ui,
		tick: (now: number) => {
			if (!cb) throw new Error("animation callback not registered");
			return cb(now);
		},
	};
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("FusionLiveComponent", () => {
	it("renders two distinct rows for identical self-fusion members (slot key, no collision)", () => {
		const c = new FusionLiveComponent(fakeUi());
		c.setSynth("claude-opus-4-8");
		c.setStage("panel");
		const base: Omit<FusionLiveMember, "index"> = {
			cli: "claude",
			model: "claude-opus-4-8",
			status: "running",
			elapsedMs: 0,
			timeoutMs: 180000,
		};
		c.upsertMember({ ...base, index: 0 });
		c.upsertMember({ ...base, index: 1 });

		const lines = c.render(120).map(stripAnsi);
		const rows = lines.filter((l) => l.includes("claude:claude-opus-4-8"));
		// The bug: identical members collided on a cli/model key → ONE row. Slot keying
		// must yield TWO distinct rows, numbered 1 and 2.
		expect(rows.length).toBe(2);
		expect(rows.some((l) => / 1 {2}claude:claude-opus-4-8/.test(l))).toBe(true);
		expect(rows.some((l) => / 2 {2}claude:claude-opus-4-8/.test(l))).toBe(true);
		// Running rows show a live elapsed clock; the "idle Ns / Ts" countdown only appears
		// once a member goes quiet, so a freshly-upserted (active) row just shows the seconds.
		expect(rows.every((l) => /\d+s/.test(l))).toBe(true);
		c.dispose();
	});

	it("freezes elapsed and shows the byte count on done", () => {
		const c = new FusionLiveComponent(fakeUi());
		c.setStage("panel");
		c.upsertMember({ index: 0, cli: "claude", model: "opus", status: "done", elapsedMs: 22000, chars: 3100 });
		const lines = c.render(120).map(stripAnsi);
		expect(lines.some((l) => l.includes("done") && l.includes("22s") && l.includes("3100 chars"))).toBe(true);
		c.dispose();
	});

	it("shows live tool activity (which/how many) on a running advisor row", () => {
		const c = new FusionLiveComponent(fakeUi());
		c.setStage("panel");
		c.upsertMember({ index: 0, cli: "claude", model: "opus", status: "running", elapsedMs: 0, timeoutMs: 180000 });
		c.recordActivity(0, "thinking");
		c.recordActivity(0, "tool", "Read");
		c.recordActivity(0, "tool", "Read");
		c.recordActivity(0, "tool", "Bash");
		const row =
			c
				.render(120)
				.map(stripAnsi)
				.find((l) => l.includes("claude:opus")) ?? "";
		// The opaque "running" clock is replaced by the real tool tally.
		expect(row).toContain("Read 2");
		expect(row).toContain("Bash 1");
		expect(row).not.toContain("running");
		c.dispose();
	});

	it("rolls the tool count into the done row", () => {
		const c = new FusionLiveComponent(fakeUi());
		c.setStage("panel");
		c.upsertMember({ index: 0, cli: "claude", model: "opus", status: "running", elapsedMs: 0 });
		c.recordActivity(0, "tool", "Grep");
		c.recordActivity(0, "tool", "Read");
		c.upsertMember({ index: 0, cli: "claude", model: "opus", status: "done", elapsedMs: 22000, chars: 3100 });
		const row =
			c
				.render(120)
				.map(stripAnsi)
				.find((l) => l.includes("claude:opus")) ?? "";
		expect(row).toContain("2 tools");
		expect(row).toContain("3100 chars");
		c.dispose();
	});

	it("inlines WHAT the advisor is thinking on the member row", () => {
		const c = new FusionLiveComponent(fakeUi());
		c.setStage("panel");
		c.upsertMember({ index: 0, cli: "claude", model: "opus", status: "running", elapsedMs: 0 });
		c.recordActivity(0, "thinking", undefined, "Checking how auth tokens are refreshed in auth-storage");
		const lines = c.render(200).map(stripAnsi);
		expect(lines.some((l) => l.includes("Checking how auth tokens are refreshed"))).toBe(true);
		c.dispose();
	});

	it("drops the inline thought once the advisor is done", () => {
		const c = new FusionLiveComponent(fakeUi());
		c.setStage("panel");
		c.upsertMember({ index: 0, cli: "claude", model: "opus", status: "running", elapsedMs: 0 });
		c.recordActivity(0, "writing", undefined, "drafting the report");
		c.upsertMember({ index: 0, cli: "claude", model: "opus", status: "done", elapsedMs: 1000, chars: 100 });
		const lines = c.render(200).map(stripAnsi);
		expect(lines.some((l) => l.includes("drafting the report"))).toBe(false);
		c.dispose();
	});

	it("shows verify-stage turn + tool tally instead of an opaque clock", () => {
		const c = new FusionLiveComponent(fakeUi());
		c.setSynth("opus");
		c.setStage("verify");
		c.recordVerifyActivity(1, "read");
		c.recordVerifyActivity(2, "grep");
		c.recordVerifyActivity(3, "read");
		// The detail line (not the header) carries the activity — match it by "against the code".
		const verifyLine =
			c
				.render(200)
				.map(stripAnsi)
				.find((l) => l.includes("against the code")) ?? "";
		expect(verifyLine).toContain("turn 3");
		expect(verifyLine).toContain("read 2");
		expect(verifyLine).toContain("grep 1");
		c.dispose();
	});

	it("names the synth as the principal in the panel header (roles are explicit)", () => {
		const c = new FusionLiveComponent(fakeUi());
		c.setSynth("claude-opus-4-8");
		c.setStage("panel");
		c.upsertMember({ index: 0, cli: "claude", model: "claude-opus-4-8", status: "running", elapsedMs: 0 });
		const header = c.render(120).map(stripAnsi)[0] ?? "";
		expect(header).toContain("advisor"); // panel members are advisors
		expect(header).toContain("synth claude-opus-4-8"); // synthesizer = active model
		c.dispose();
	});

	it("shows the brief stage (synth drafting) before any advisor rows", () => {
		const c = new FusionLiveComponent(fakeUi());
		c.setSynth("claude-opus-4-8");
		// Default stage is "brief" — the synth is preparing the advisor brief.
		const lines = c.render(120).map(stripAnsi);
		expect(lines[0]).toContain("preparing brief");
		expect(lines.some((l) => l.includes("drafting the advisor brief"))).toBe(true);
		// No advisor rows yet at the brief stage.
		expect(lines.some((l) => l.includes("claude:claude-opus-4-8"))).toBe(false);
		c.dispose();
	});

	describe("animation tick coalescing (#G)", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("returns false when spinner frame and elapsed key are unchanged", () => {
			vi.spyOn(Date, "now").mockReturnValue(1_000_000);
			const { ui, tick } = trackingUi();
			const c = new FusionLiveComponent(ui);
			c.setSynth("claude-opus-4-8");
			// Brief stage: one spinner line, no running members — elapsed key is stable.

			expect(tick(0)).toBe(true);
			expect(tick(40)).toBe(false);
			expect(tick(40)).toBe(false);

			c.dispose();
		});

		it("returns true when the spinner frame bucket advances", () => {
			vi.spyOn(Date, "now").mockReturnValue(1_000_000);
			const { ui, tick } = trackingUi();
			const c = new FusionLiveComponent(ui);
			c.setSynth("claude-opus-4-8");

			expect(tick(0)).toBe(true);
			expect(tick(SPINNER_FRAME_MS)).toBe(true);
			expect(tick(SPINNER_FRAME_MS)).toBe(false);

			c.dispose();
		});
	});

	it("unsubscribes the animation ticker on dispose (idempotent, no leak)", () => {
		let unsubbed = 0;
		const ui = { addAnimationCallback: () => () => unsubbed++, requestRender: () => {} } as never;
		const c = new FusionLiveComponent(ui);
		c.dispose();
		expect(unsubbed).toBe(1);
		// Second dispose is a no-op (no double-unsub).
		c.dispose();
		expect(unsubbed).toBe(1);
	});
});
