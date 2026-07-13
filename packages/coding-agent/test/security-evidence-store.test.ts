import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecurityEvidenceStore } from "../src/core/security/evidence-store.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pit-security-evidence-"));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("SecurityEvidenceStore", () => {
	it("appends, lists, and gets lifecycle evidence", () => {
		const store = new SecurityEvidenceStore(root, "C:/target");
		store.appendFinding("finding-1", { state: "candidate", summary: "sink", source: "security_static_scan" });
		store.appendFinding("finding-1", { state: "reproduced", summary: "twice", evidenceIds: ["ev-1"] });

		expect(store.list()).toEqual([{ findingId: "finding-1", state: "reproduced", summary: "twice", eventCount: 2 }]);
		expect(store.get("finding-1")).toHaveLength(2);
	});

	it("rejects illegal lifecycle transitions", () => {
		const store = new SecurityEvidenceStore(root, "C:/target");
		store.appendFinding("finding-1", { state: "candidate", summary: "sink", source: "security_static_scan" });
		expect(() =>
			store.appendFinding("finding-1", { state: "validated", summary: "skip", evidenceIds: ["ev-1"] }),
		).toThrow(/candidate.*validated/i);
	});

	it("redacts nested secrets before writing evidence and artifacts", () => {
		const token = "sk-123456789012345678901234567890";
		const store = new SecurityEvidenceStore(root, "C:/target");
		store.appendFinding("finding-secret", {
			state: "candidate",
			summary: `sink ${token}`,
			source: "security_static_scan",
		});
		store.appendArtifact("finding-secret", "http-response", `Authorization: Bearer ${token}`);

		const raw = readFileSync(store.path, "utf8");
		expect(raw).not.toContain(token);
		expect(raw).toContain("[REDACTED:");
	});
});
