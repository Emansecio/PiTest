// suggestClosest from @pit/ai is the REAL fuzzy matcher used in production, so
// the candidate thresholds are load-bearing (a typo within distance 3 blocks;
// a genuinely different script name does not).
import { suggestClosest } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { type BashGroundingDeps, groundBashScript, isBashGroundingDisabled } from "../src/core/bash-grounding.ts";

function makeDeps(scripts: string[], overrides: Partial<BashGroundingDeps> = {}): BashGroundingDeps {
	return {
		readScripts: () => scripts,
		fuzzy: suggestClosest,
		...overrides,
	};
}

describe("groundBashScript — BLOCK on a typo'd `<runner> run <script>`", () => {
	it("blocks `npm run biuld` and suggests the close script (build)", () => {
		const decision = groundBashScript({ command: "npm run biuld" }, makeDeps(["build", "check"]));
		expect(decision.action).toBe("block");
		if (decision.action === "block") {
			expect(decision.message).toContain("biuld");
			expect(decision.message).toContain("build");
			expect(decision.message).toContain("scripts: build, check");
			expect(decision.message).toContain("re-issue the identical call");
		}
	});

	it("grounds pnpm and yarn the same way", () => {
		const pnpm = groundBashScript({ command: "pnpm run chekc" }, makeDeps(["build", "check"]));
		const yarn = groundBashScript({ command: "yarn run biuld" }, makeDeps(["build", "check"]));
		expect(pnpm.action).toBe("block");
		if (pnpm.action === "block") expect(pnpm.message).toContain("check");
		expect(yarn.action).toBe("block");
		if (yarn.action === "block") expect(yarn.message).toContain("build");
	});
});

describe("groundBashScript — ALLOW (valid script / not the run form / fail-open)", () => {
	it("allows a script that exists (npm/pnpm/yarn run)", () => {
		expect(groundBashScript({ command: "npm run build" }, makeDeps(["build", "check"]))).toEqual({ action: "allow" });
		expect(groundBashScript({ command: "pnpm run check" }, makeDeps(["build", "check"]))).toEqual({
			action: "allow",
		});
		expect(groundBashScript({ command: "yarn run test" }, makeDeps(["build", "test"]))).toEqual({ action: "allow" });
	});

	it("does NOT ground manager subcommands (install/test/ci/start/add) — not the `run X` form", () => {
		const deps = makeDeps(["build", "check"]);
		expect(groundBashScript({ command: "npm install" }, deps)).toEqual({ action: "allow" });
		expect(groundBashScript({ command: "npm test" }, deps)).toEqual({ action: "allow" });
		expect(groundBashScript({ command: "npm ci" }, deps)).toEqual({ action: "allow" });
		expect(groundBashScript({ command: "npm start" }, deps)).toEqual({ action: "allow" });
		expect(groundBashScript({ command: "pnpm add lodash" }, deps)).toEqual({ action: "allow" });
	});

	it("does NOT ground a non-runner leading token (node/git/echo run …)", () => {
		const deps = makeDeps(["build", "check"]);
		expect(groundBashScript({ command: "node run biuld" }, deps)).toEqual({ action: "allow" });
		expect(groundBashScript({ command: "git run biuld" }, deps)).toEqual({ action: "allow" });
	});

	it("allows a command with a shell metacharacter (parseSimpleArgv bails -> fail-open)", () => {
		const deps = makeDeps(["build", "check"]);
		expect(groundBashScript({ command: "npm run biuld && echo ok" }, deps)).toEqual({ action: "allow" });
		expect(groundBashScript({ command: "npm run biuld | cat" }, deps)).toEqual({ action: "allow" });
		expect(groundBashScript({ command: "npm run biuld; ls" }, deps)).toEqual({ action: "allow" });
	});

	it("fail-open: empty/erroring readScripts never blocks", () => {
		expect(groundBashScript({ command: "npm run biuld" }, makeDeps([]))).toEqual({ action: "allow" });
		expect(
			groundBashScript(
				{ command: "npm run biuld" },
				makeDeps([], {
					readScripts: () => {
						throw new Error("ENOENT");
					},
				}),
			),
		).toEqual({ action: "allow" });
	});

	it("fail-open: an unknown script with NO close real name is allowed (genuinely new script)", () => {
		const decision = groundBashScript({ command: "npm run deploy" }, makeDeps(["build", "check"]));
		expect(decision).toEqual({ action: "allow" });
	});

	it("allows the bare `run X` with no script token / empty command", () => {
		const deps = makeDeps(["build", "check"]);
		expect(groundBashScript({ command: "npm run" }, deps)).toEqual({ action: "allow" });
		expect(groundBashScript({ command: "" }, deps)).toEqual({ action: "allow" });
	});
});

describe("isBashGroundingDisabled — opt-out", () => {
	it("false when unset, true for 1/true/yes (case-insensitive)", () => {
		expect(isBashGroundingDisabled({})).toBe(false);
		expect(isBashGroundingDisabled({ PIT_NO_BASH_GROUNDING: "1" })).toBe(true);
		expect(isBashGroundingDisabled({ PIT_NO_BASH_GROUNDING: "TRUE" })).toBe(true);
		expect(isBashGroundingDisabled({ PIT_NO_BASH_GROUNDING: "yes" })).toBe(true);
		expect(isBashGroundingDisabled({ PIT_NO_BASH_GROUNDING: "0" })).toBe(false);
	});
});
