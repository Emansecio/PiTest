import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deriveGoalContract } from "../src/core/goal/goal-contract.js";
import { validateGoalEvidence } from "../src/core/goal/goal-receipt.js";

describe("goal evidence receipts", () => {
	it("classifies changed, referenced, deleted, and attested evidence", () => {
		const contract = deriveGoalContract("Ship it");
		const result = validateGoalEvidence(
			contract,
			[
				{
					id: "c1",
					outcome: "done",
					evidence: [
						{ kind: "path", path: "package.json" },
						{ kind: "claim", note: "The runtime behavior was checked." },
					],
				},
			],
			process.cwd(),
			["package.json", "removed-file.ts"],
		);
		expect(result.valid).toBe(true);
		expect(result.criteria[0]?.evidence.map((evidence) => evidence.kind)).toEqual(["changed-file", "attested"]);
	});

	it("rejects missing, unknown, and outside paths", () => {
		const contract = deriveGoalContract("Ship it");
		const result = validateGoalEvidence(
			contract,
			[
				{ id: "c1", outcome: "done", evidence: [{ kind: "path", path: "../outside.txt" }] },
				{ id: "extra", outcome: "done", evidence: [{ kind: "claim", note: "x" }] },
			],
			process.cwd(),
		);
		expect(result.valid).toBe(false);
		expect(result.errors.some((error) => error.includes("invalid path evidence"))).toBe(true);
		expect(result.errors).toContain("unknown criterion extra");
	});

	it("rejects a workspace symlink whose real target is outside the workspace", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pit-goal-evidence-root-"));
		const outside = mkdtempSync(join(tmpdir(), "pit-goal-evidence-outside-"));
		try {
			writeFileSync(join(outside, "secret.txt"), "outside", "utf8");
			mkdirSync(join(cwd, "links"));
			symlinkSync(outside, join(cwd, "links", "external"), process.platform === "win32" ? "junction" : "dir");
			const contract = deriveGoalContract("Ship it");

			const result = validateGoalEvidence(
				contract,
				[
					{
						id: "c1",
						outcome: "done",
						evidence: [{ kind: "path", path: "links/external/secret.txt" }],
					},
				],
				cwd,
			);

			expect(result.valid).toBe(false);
			expect(result.errors.some((error) => error.includes("invalid path evidence"))).toBe(true);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("matches evidence and mutation paths case-insensitively only on Windows", () => {
		const contract = deriveGoalContract("Ship it");
		const platform = vi.spyOn(process, "platform", "get");
		try {
			platform.mockReturnValue("win32");
			const windows = validateGoalEvidence(
				contract,
				[{ id: "c1", outcome: "done", evidence: [{ kind: "path", path: "package.json" }] }],
				process.cwd(),
				["PACKAGE.JSON"],
			);
			expect(windows.valid).toBe(true);
			expect(windows.criteria[0]?.evidence[0]?.kind).toBe("changed-file");

			platform.mockReturnValue("linux");
			const posix = validateGoalEvidence(
				contract,
				[{ id: "c1", outcome: "done", evidence: [{ kind: "path", path: "package.json" }] }],
				process.cwd(),
				["PACKAGE.JSON"],
			);
			expect(posix.valid).toBe(false);
			expect(posix.criteria[0]?.evidence[0]?.kind).toBe("referenced-file");
		} finally {
			platform.mockRestore();
		}
	});
});
