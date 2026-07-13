// suggestClosest from @pit/ai is the REAL fuzzy matcher used in production, so
// the candidate thresholds are load-bearing (a typo within distance 3 blocks;
// a genuinely different script name does not).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suggestClosest } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { type BashGroundingDeps, groundBashScript, isBashGroundingDisabled } from "../src/core/bash-grounding.ts";
import { createBashGroundingExtension } from "../src/core/built-ins/bash-grounding-extension.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

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

describe("bash-grounding extension — scripts cache invalidation on package.json mutation", () => {
	type Handler = (event: Record<string, unknown>) => unknown;

	function makeFakePi() {
		const handlers = new Map<string, Handler[]>();
		const api = {
			on(event: string, handler: Handler) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
		};
		const fire = (event: string, payload: Record<string, unknown>): unknown => {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) {
				const r = handler(payload);
				if (r !== undefined && result === undefined) result = r;
			}
			return result;
		};
		return { api, fire };
	}

	function withProject(
		scripts: Record<string, string>,
		fn: (cwd: string, fire: ReturnType<typeof makeFakePi>["fire"]) => void,
	) {
		const cwd = mkdtempSync(join(tmpdir(), "pit-bash-ground-cache-"));
		try {
			writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts }));
			const { api, fire } = makeFakePi();
			createBashGroundingExtension({ cwd })(api as unknown as ExtensionAPI);
			fn(cwd, fire);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}

	it("re-reads the manifest after a successful edit of package.json (new script becomes groundable)", () => {
		withProject({ build: "b" }, (cwd, fire) => {
			// Prime the cache: "biuld" is a typo of the (only) real script.
			const blocked = fire("tool_call", { toolName: "bash", input: { command: "npm run biuld" } }) as
				| { block?: boolean }
				| undefined;
			expect(blocked?.block).toBe(true);

			// The model adds a `lint` script; the successful edit result must drop the cache.
			writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { build: "b", lint: "l" } }));
			fire("tool_result", { toolName: "edit", input: { path: join(cwd, "package.json") }, isError: false });

			// Fresh cache: "lnit" now has a close candidate (lint) -> block. A stale
			// cache (["build"]) would have no close candidate and fail-open (allow).
			const afterEdit = fire("tool_call", { toolName: "bash", input: { command: "npm run lnit" } }) as
				| { block?: boolean; reason?: string }
				| undefined;
			expect(afterEdit?.block).toBe(true);
			expect(afterEdit?.reason).toContain("lint");
		});
	});

	it("keeps the stale cache when the mutation errored or touched another file", () => {
		withProject({ build: "b" }, (cwd, fire) => {
			expect(
				(fire("tool_call", { toolName: "bash", input: { command: "npm run biuld" } }) as { block?: boolean })
					?.block,
			).toBe(true);
			writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { build: "b", lint: "l" } }));

			// Errored edit of package.json -> no invalidation.
			fire("tool_result", { toolName: "edit", input: { path: join(cwd, "package.json") }, isError: true });
			// Successful edit of a different file -> no invalidation.
			fire("tool_result", { toolName: "write", input: { path: join(cwd, "readme.md") }, isError: false });
			// Non-mutating tool on package.json -> no invalidation.
			fire("tool_result", { toolName: "read", input: { path: join(cwd, "package.json") }, isError: false });

			// Cache still ["build"]: "lnit" has no close candidate -> fail-open allow.
			expect(fire("tool_call", { toolName: "bash", input: { command: "npm run lnit" } })).toBeUndefined();
		});
	});
});
