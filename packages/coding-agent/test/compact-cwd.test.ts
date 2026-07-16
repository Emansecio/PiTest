import { homedir } from "node:os";
import { basename, join } from "node:path";
import { expect, it } from "vitest";
import {
	buildWorkspaceCwdLabels,
	compactCwd,
	ellipsizePathMiddle,
	resolveOrientingCwdLabel,
} from "../src/modes/interactive/display-utils.js";

it("compactCwd prefers repo-relative paths inside the git root", () => {
	const repo = join(homedir(), "PiTest");
	expect(compactCwd(repo, repo)).toBe("PiTest");
	expect(compactCwd(join(repo, "packages", "coding-agent"), repo)).toBe("PiTest/packages/coding-agent");
});

it("compactCwd falls back to home-relative paths outside the repo", () => {
	const repo = join(homedir(), "PiTest");
	const outside = join(homedir(), "other");
	expect(compactCwd(outside, repo)).toMatch(/^~[\\/]other$/);
});

it("ellipsizePathMiddle preserves head and tail segments", () => {
	const deep = "~/a/b/c/d/e/f/g/h";
	const shortened = ellipsizePathMiddle(deep, 16);
	expect(shortened).toContain("…");
	expect(shortened.endsWith("g/h") || shortened.endsWith("h")).toBe(true);
});

it("resolveOrientingCwdLabel never returns a bare ~", () => {
	const home = homedir();
	const homeLabel = `${basename(home)} (home)`;
	expect(resolveOrientingCwdLabel(home, null)).toBe(homeLabel);
	expect(resolveOrientingCwdLabel(join(home, "pit"), null)).toMatch(/^~[\\/]pit$/);
});

it("buildWorkspaceCwdLabels surfaces shell vs session divergence", () => {
	const home = homedir();
	const pit = join(home, "pit");
	const labels = buildWorkspaceCwdLabels(home, pit, null);
	expect(labels.session).toBe(`${basename(home)} (home)`);
	expect(labels.isHome).toBe(true);
	expect(labels.shellNote).toBe(`shell: ${resolveOrientingCwdLabel(pit, null)}`);
});
