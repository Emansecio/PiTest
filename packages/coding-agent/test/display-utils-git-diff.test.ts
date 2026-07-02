import { beforeAll, describe, expect, it } from "vitest";
import { formatGitBranchWithDiff, formatGitDiffSuffixPlain } from "../src/modes/interactive/display-utils.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

describe("formatGitBranchWithDiff", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("returns branch only when clean", () => {
		expect(formatGitBranchWithDiff("main", { files: 0, insertions: 0, deletions: 0 })).toBe("main");
	});

	it("formats line deltas", () => {
		const plain = stripAnsi(formatGitBranchWithDiff("main", { files: 1, insertions: 12, deletions: 3 }));
		expect(plain).toBe("main · +12 -3");
		expect(formatGitDiffSuffixPlain({ files: 1, insertions: 12, deletions: 3 })).toBe("+12 -3");
	});

	it("formats untracked-only working tree", () => {
		const plain = stripAnsi(formatGitBranchWithDiff("main", { files: 2, insertions: 0, deletions: 0 }));
		expect(plain).toBe("main · 2 files");
	});
});
