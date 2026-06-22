import { describe, expect, it } from "vitest";
import { groundDestructiveCommand, isDestructiveCommandGuardDisabled } from "../src/core/destructive-command-guard.js";

function blocks(command: string): boolean {
	return groundDestructiveCommand({ command }).action === "block";
}

function messageFor(command: string): string {
	const d = groundDestructiveCommand({ command });
	return d.action === "block" ? d.message : "";
}

describe("destructive-command-guard: rm -rf", () => {
	it("blocks a recursive force delete of a non-regenerable path", () => {
		expect(blocks("rm -rf ./src")).toBe(true);
		expect(messageFor("rm -rf ./src")).toMatch(/src/);
		expect(messageFor("rm -rf ./src")).toMatch(/re-issue the identical call/i);
	});

	it("allows recursive delete of regenerable build dirs (no noise)", () => {
		expect(blocks("rm -rf node_modules")).toBe(false);
		expect(blocks("rm -rf ./dist ./build")).toBe(false);
		expect(blocks("rm -rf node_modules/ coverage .next target")).toBe(false);
	});

	it("blocks when ANY target is non-regenerable, even mixed with regenerable ones", () => {
		expect(blocks("rm -rf node_modules src")).toBe(true);
		expect(messageFor("rm -rf node_modules src")).toMatch(/src/);
	});

	it("defers catastrophic root/home targets to the permission deny-floor (allows here)", () => {
		expect(blocks("rm -rf /")).toBe(false);
		expect(blocks("rm -rf ~")).toBe(false);
	});

	it("ignores non-recursive rm and plain commands", () => {
		expect(blocks("rm file.txt")).toBe(false);
		expect(blocks("rm -f stale.log")).toBe(false);
		expect(blocks("ls -la")).toBe(false);
		expect(blocks("echo rm -rf src")).toBe(false);
	});

	it("sees an rm in any segment of a chained command", () => {
		expect(blocks("npm run build && rm -rf src")).toBe(true);
		expect(blocks("npm run build && rm -rf dist")).toBe(false);
	});

	it("handles a sudo / flag-cluster prefix", () => {
		expect(blocks("sudo rm -fr ./important")).toBe(true);
	});
});

describe("destructive-command-guard: git", () => {
	it("blocks git reset --hard (with or without a target)", () => {
		expect(blocks("git reset --hard")).toBe(true);
		expect(blocks("git reset --hard HEAD~3")).toBe(true);
		expect(blocks("git reset -q --hard origin/main")).toBe(true);
	});

	it("allows a soft/mixed reset", () => {
		expect(blocks("git reset --soft HEAD~1")).toBe(false);
		expect(blocks("git reset HEAD file.txt")).toBe(false);
	});

	it("blocks git clean -f variants but allows a dry run", () => {
		expect(blocks("git clean -fd")).toBe(true);
		expect(blocks("git clean -fdx")).toBe(true);
		expect(blocks("git clean -n")).toBe(false);
	});

	it("blocks discarding the working tree", () => {
		expect(blocks("git checkout .")).toBe(true);
		expect(blocks("git checkout -- .")).toBe(true);
		expect(blocks("git restore .")).toBe(true);
		expect(blocks("git restore --staged --worktree .")).toBe(true);
	});

	it("allows ordinary checkout/restore", () => {
		expect(blocks("git checkout main")).toBe(false);
		expect(blocks("git checkout -b feature")).toBe(false);
		expect(blocks("git restore --staged file.ts")).toBe(false);
	});

	it("blocks force push but allows --force-with-lease and normal push", () => {
		expect(blocks("git push --force")).toBe(true);
		expect(blocks("git push -f origin main")).toBe(true);
		expect(blocks("git push origin main --force")).toBe(true);
		expect(blocks("git push --force-with-lease")).toBe(false);
		expect(blocks("git push origin main")).toBe(false);
	});
});

describe("destructive-command-guard: invariants", () => {
	it("fails open on empty / non-string input", () => {
		expect(blocks("")).toBe(false);
		expect(blocks("   ")).toBe(false);
		expect(groundDestructiveCommand({ command: undefined as unknown as string }).action).toBe("allow");
	});

	it("combines multiple impacts into one message", () => {
		const msg = messageFor("git reset --hard && rm -rf ./src");
		expect(msg).toMatch(/reset --hard/);
		expect(msg).toMatch(/src/);
	});

	it("opt-out flag is read from env", () => {
		expect(isDestructiveCommandGuardDisabled({ PIT_NO_DESTRUCTIVE_GUARD: "1" } as NodeJS.ProcessEnv)).toBe(true);
		expect(isDestructiveCommandGuardDisabled({} as NodeJS.ProcessEnv)).toBe(false);
	});
});
