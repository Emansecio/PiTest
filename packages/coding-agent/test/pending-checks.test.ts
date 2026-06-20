import { describe, expect, it } from "vitest";
import type { BashBackgroundJob } from "../src/core/tools/bash.js";
import { isVerificationJobCommand, pendingVerificationJobs } from "../src/core/verification/pending-checks.js";

describe("isVerificationJobCommand", () => {
	it("matches package-manager check scripts", () => {
		for (const cmd of [
			"npm test",
			"npm t",
			"npm run check",
			"pnpm run typecheck",
			"yarn lint",
			"npm run test:unit",
			"bun run ci",
			"cd packages/x && npm run check",
		]) {
			expect(isVerificationJobCommand(cmd), cmd).toBe(true);
		}
	});

	it("matches direct test runners / type-checkers / linters", () => {
		for (const cmd of [
			"vitest run",
			"npx vitest",
			"jest --ci",
			"tsc --noEmit",
			"biome check .",
			"eslint src",
			"go test ./...",
			"cargo test",
			"pytest -q",
		]) {
			expect(isVerificationJobCommand(cmd), cmd).toBe(true);
		}
	});

	it("excludes watchers, dev servers, and unrelated commands", () => {
		for (const cmd of [
			"npm run dev",
			"npm run start",
			"vitest --watch",
			"npm run test:watch",
			"jest --watch",
			"npm run serve",
			"node server.js",
			"npm install",
			"git push",
			"npm run build",
		]) {
			expect(isVerificationJobCommand(cmd), cmd).toBe(false);
		}
	});
});

function job(over: Partial<BashBackgroundJob>): BashBackgroundJob {
	return {
		id: "bg-1",
		pid: 123,
		command: "npm run check",
		startedAt: 0,
		promotedAt: 0,
		exited: false,
		exitCode: null,
		ringBuffer: "",
		ringTruncated: false,
		kill: () => {},
		...over,
	};
}

describe("pendingVerificationJobs", () => {
	it("returns only still-running verification jobs", () => {
		const jobs = [
			job({ id: "bg-1", command: "npm run check", exited: false }),
			job({ id: "bg-2", command: "npm run check", exited: true, exitCode: 0 }),
			job({ id: "bg-3", command: "npm run dev", exited: false }),
			job({ id: "bg-4", command: "vitest run", exited: false }),
		];
		expect(pendingVerificationJobs(jobs).map((j) => j.id)).toEqual(["bg-1", "bg-4"]);
	});

	it("is empty when nothing is pending", () => {
		expect(pendingVerificationJobs([])).toEqual([]);
		expect(pendingVerificationJobs([job({ command: "npm run dev" })])).toEqual([]);
	});
});
