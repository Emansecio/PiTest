import { beforeAll, describe, expect, test } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

/**
 * `buildStartupHeaderText` gates + builds the startup hint header. The audit fix
 * removed the `APP_NAME !== "pit"` exclusion so the vanilla product shows the
 * essentials line + rotating tip too; only quietStartup (without --verbose)
 * suppresses them.
 */
describe("startup header hints", () => {
	const build = Reflect.get(InteractiveMode.prototype, "buildStartupHeaderText") as (
		this: unknown,
		isResumed: boolean,
	) => { collapsed: () => string; expanded: () => string } | null;

	function fakeThis(opts: { verbose?: boolean; quietStartup: boolean }) {
		return {
			options: { verbose: opts.verbose },
			settingsManager: { getQuietStartup: () => opts.quietStartup },
		};
	}

	test("shows essentials for the vanilla app (not quiet, not verbose)", () => {
		const header = build.call(fakeThis({ quietStartup: false }), false);
		expect(header).not.toBeNull();
		const collapsed = header?.collapsed() ?? "";
		expect(collapsed).toContain("commands");
		expect(collapsed).toContain("bash");
		expect(collapsed).toContain("more");
		// First-run (not resumed) collapsed view also carries a rotating tip.
		expect(collapsed).toContain("tip:");
	});

	test("resumed sessions drop the rotating tip but keep essentials", () => {
		const header = build.call(fakeThis({ quietStartup: false }), true);
		const collapsed = header?.collapsed() ?? "";
		expect(collapsed).toContain("commands");
		expect(collapsed).not.toContain("tip:");
	});

	test("quietStartup suppresses the header unless --verbose overrides it", () => {
		expect(build.call(fakeThis({ quietStartup: true }), false)).toBeNull();
		expect(build.call(fakeThis({ quietStartup: true, verbose: true }), false)).not.toBeNull();
	});

	test("expanded view lists the full shortcut set", () => {
		const header = build.call(fakeThis({ quietStartup: false }), false);
		const expanded = header?.expanded() ?? "";
		expect(expanded).toContain("to interrupt");
		expect(expanded).toContain("to select model");
	});
});
