import { describe, expect, it } from "vitest";
import type { Diagnostic, WorkspaceEdit } from "../src/core/lsp/types.ts";
import {
	collectAffectedUris,
	diffNewErrors,
	type FileSnapshot,
	isRefactorTransactionDisabled,
	type NewError,
	type RenameTransactionDeps,
	runRenameTransaction,
} from "../src/core/refactor-transaction.ts";

// -----------------------------------------------------------------------------
// Helpers — build the kind of WorkspaceEdit an `lsp rename` actually returns.
// -----------------------------------------------------------------------------

const URI_A = "file:///proj/a.ts";
const URI_B = "file:///proj/b.ts";

/** A rename touching two files via `changes` (the common server shape). */
function renameEdit(): WorkspaceEdit {
	return {
		changes: {
			[URI_A]: [{ range: range(0, 6, 0, 9), newText: "bar" }],
			[URI_B]: [{ range: range(2, 0, 2, 3), newText: "bar" }],
		},
	};
}

function range(sl: number, sc: number, el: number, ec: number) {
	return { start: { line: sl, character: sc }, end: { line: el, character: ec } };
}

function errorDiag(line: number, message: string): Diagnostic {
	return { range: range(line, 0, line, 5), severity: 1, message };
}

function warningDiag(line: number, message: string): Diagnostic {
	return { range: range(line, 0, line, 5), severity: 2, message };
}

/**
 * Build a deps object backed by an in-memory "disk" so we can assert that a
 * rollback restored EXACT original bytes. `serverDiagnostics` controls what the
 * recheck "sees" after apply (the simulated new state).
 */
function makeDeps(opts: {
	disk: Record<string, string>;
	baseline: Map<string, Diagnostic[]>;
	afterApply: Map<string, Diagnostic[]>;
	recheckThrows?: boolean;
	recheckEmpty?: boolean;
}) {
	const calls = {
		applied: 0,
		applyBeforeRecheck: false,
		recheckCalledAfterApply: false,
		restoreArgs: null as FileSnapshot[] | null,
		baselineUris: null as string[] | null,
	};
	let applyHappened = false;

	const deps: RenameTransactionDeps = {
		captureDiagnosticsBaseline: async (uris) => {
			calls.baselineUris = uris;
			return opts.baseline;
		},
		readFile: async (uri) => {
			if (!(uri in opts.disk)) throw new Error(`no such file: ${uri}`);
			return opts.disk[uri];
		},
		applyWorkspaceEdit: async (edit) => {
			calls.applied++;
			applyHappened = true;
			// Simulate the edit landing: rewrite each affected file on the fake disk.
			for (const uri of collectAffectedUris(edit)) {
				opts.disk[uri] = `EDITED:${opts.disk[uri] ?? ""}`;
			}
		},
		recheckDiagnostics: async (_uris) => {
			calls.recheckCalledAfterApply = applyHappened;
			if (opts.recheckThrows) throw new Error("server indexing");
			if (opts.recheckEmpty) return new Map();
			return opts.afterApply;
		},
		restoreFiles: async (snaps) => {
			calls.restoreArgs = snaps;
			// Simulate atomic restore writing original bytes back to disk.
			for (const s of snaps) opts.disk[s.uri] = s.content;
		},
	};
	return { deps, calls };
}

// -----------------------------------------------------------------------------

describe("collectAffectedUris", () => {
	it("collects URIs from `changes`", () => {
		expect(collectAffectedUris(renameEdit()).sort()).toEqual([URI_A, URI_B]);
	});

	it("collects URIs from documentChanges text edits and ignores resource ops", () => {
		const edit: WorkspaceEdit = {
			documentChanges: [
				{ textDocument: { uri: URI_A, version: 1 }, edits: [{ range: range(0, 0, 0, 1), newText: "x" }] },
				// A create resource op must NOT be treated as an affected text file.
				{ kind: "create", uri: "file:///proj/new.ts" },
			],
		};
		expect(collectAffectedUris(edit)).toEqual([URI_A]);
	});

	it("ignores entries with zero text edits", () => {
		expect(collectAffectedUris({ changes: { [URI_A]: [] } })).toEqual([]);
	});
});

describe("diffNewErrors", () => {
	it("flags only errors absent from the baseline for the same file", () => {
		const baseline = new Map<string, Diagnostic[]>([[URI_A, [errorDiag(1, "pre-existing")]]]);
		const current = new Map<string, Diagnostic[]>([
			[URI_A, [errorDiag(1, "pre-existing"), errorDiag(9, "brand new")]],
		]);
		const out = diffNewErrors(baseline, current);
		expect(out).toHaveLength(1);
		expect(out[0].diagnostic.message).toBe("brand new");
		expect(out[0].uri).toBe(URI_A);
	});

	it("ignores warnings entirely", () => {
		const baseline = new Map<string, Diagnostic[]>();
		const current = new Map<string, Diagnostic[]>([[URI_A, [warningDiag(3, "just a warning")]]]);
		expect(diffNewErrors(baseline, current)).toEqual([]);
	});

	it("does not flag a pre-existing error that is still present", () => {
		const baseline = new Map<string, Diagnostic[]>([[URI_A, [errorDiag(1, "broken")]]]);
		const current = new Map<string, Diagnostic[]>([[URI_A, [errorDiag(1, "broken")]]]);
		expect(diffNewErrors(baseline, current)).toEqual([]);
	});
});

describe("isRefactorTransactionDisabled", () => {
	it("is OFF by default (feature ON)", () => {
		expect(isRefactorTransactionDisabled({})).toBe(false);
	});
	it("is ON only for truthy escape values", () => {
		expect(isRefactorTransactionDisabled({ PIT_NO_REFACTOR_TX: "1" })).toBe(true);
		expect(isRefactorTransactionDisabled({ PIT_NO_REFACTOR_TX: "true" })).toBe(true);
		expect(isRefactorTransactionDisabled({ PIT_NO_REFACTOR_TX: "0" })).toBe(false);
		expect(isRefactorTransactionDisabled({ PIT_NO_REFACTOR_TX: "" })).toBe(false);
	});
});

describe("runRenameTransaction — clean rename", () => {
	it("commits and does NOT roll back when no new error appears", async () => {
		const disk = { [URI_A]: "let foo = 1", [URI_B]: "\n\nfoo()" };
		const { deps, calls } = makeDeps({
			disk,
			baseline: new Map([
				[URI_A, []],
				[URI_B, []],
			]),
			afterApply: new Map([
				[URI_A, []],
				[URI_B, [warningDiag(0, "unused")]], // warnings don't trigger rollback
			]),
		});

		const res = await runRenameTransaction(renameEdit(), deps);

		expect(res.rolledBack).toBe(false);
		expect(res.newErrors).toEqual([]);
		expect(res.degraded).toBeUndefined();
		expect(calls.applied).toBe(1);
		expect(calls.recheckCalledAfterApply).toBe(true);
		// restoreFiles must NOT have been called on a clean rename.
		expect(calls.restoreArgs).toBeNull();
		// The edit stays on disk.
		expect(disk[URI_A]).toBe("EDITED:let foo = 1");
		expect(disk[URI_B]).toBe("EDITED:\n\nfoo()");
	});
});

describe("runRenameTransaction — rename that breaks the build", () => {
	it("rolls back and restores the EXACT original snapshots", async () => {
		const ORIGINAL_A = "let foo = 1";
		const ORIGINAL_B = "\n\nfoo()";
		const disk = { [URI_A]: ORIGINAL_A, [URI_B]: ORIGINAL_B };
		const { deps, calls } = makeDeps({
			disk,
			baseline: new Map([
				[URI_A, []],
				[URI_B, []],
			]),
			// After the rename, b.ts has a fresh error the baseline lacked.
			afterApply: new Map([
				[URI_A, []],
				[URI_B, [errorDiag(2, "Cannot find name 'bar'")]],
			]),
		});

		const res = await runRenameTransaction(renameEdit(), deps);

		expect(res.rolledBack).toBe(true);
		expect(res.newErrors).toHaveLength(1);
		expect(res.newErrors[0].uri).toBe(URI_B);
		expect(res.newErrors[0].diagnostic.message).toBe("Cannot find name 'bar'");

		// restoreFiles was called with the EXACT original content (not the edited
		// bytes). This is the load-bearing assertion: a wrong rollback (snapshot
		// captured after apply, or wrong content) would fail here.
		expect(calls.restoreArgs).not.toBeNull();
		const restored = new Map((calls.restoreArgs as FileSnapshot[]).map((s) => [s.uri, s.content]));
		expect(restored.get(URI_A)).toBe(ORIGINAL_A);
		expect(restored.get(URI_B)).toBe(ORIGINAL_B);

		// And the fake disk is back to the pre-rename state.
		expect(disk[URI_A]).toBe(ORIGINAL_A);
		expect(disk[URI_B]).toBe(ORIGINAL_B);

		// Ordering invariant: apply happened before recheck.
		expect(calls.recheckCalledAfterApply).toBe(true);
		expect(calls.applied).toBe(1);
	});

	it("snapshots BEFORE applying (proves rollback uses pre-edit content)", async () => {
		// If the implementation snapshotted AFTER apply, the restored content would
		// be the EDITED bytes and this test would fail.
		const ORIGINAL = "original-source";
		const disk = { [URI_A]: ORIGINAL };
		const edit: WorkspaceEdit = { changes: { [URI_A]: [{ range: range(0, 0, 0, 1), newText: "x" }] } };
		const { deps, calls } = makeDeps({
			disk,
			baseline: new Map([[URI_A, []]]),
			afterApply: new Map([[URI_A, [errorDiag(0, "new error")]]]),
		});

		const res = await runRenameTransaction(edit, deps);

		expect(res.rolledBack).toBe(true);
		const snap = (calls.restoreArgs as FileSnapshot[])[0];
		expect(snap.content).toBe(ORIGINAL);
		expect(snap.content).not.toContain("EDITED:");
	});
});

describe("runRenameTransaction — fail-safe / degraded paths (never a false rollback)", () => {
	it("applies without transaction when PIT_NO_REFACTOR_TX is set", async () => {
		const disk = { [URI_A]: "x", [URI_B]: "y" };
		const { deps, calls } = makeDeps({ disk, baseline: new Map(), afterApply: new Map() });

		const res = await runRenameTransaction(renameEdit(), deps, { PIT_NO_REFACTOR_TX: "1" });

		expect(res.rolledBack).toBe(false);
		expect(res.degraded).toBe("disabled");
		expect(calls.applied).toBe(1);
		expect(calls.recheckCalledAfterApply).toBe(false); // recheck never ran
		expect(calls.restoreArgs).toBeNull();
	});

	it("commits (no rollback) when recheck throws — transient indexing must not revert a wanted rename", async () => {
		const disk = { [URI_A]: "x", [URI_B]: "y" };
		const { deps, calls } = makeDeps({
			disk,
			baseline: new Map([
				[URI_A, []],
				[URI_B, []],
			]),
			afterApply: new Map(),
			recheckThrows: true,
		});

		const res = await runRenameTransaction(renameEdit(), deps);

		expect(res.rolledBack).toBe(false);
		expect(res.degraded).toBe("recheck-unavailable");
		expect(calls.applied).toBe(1);
		expect(calls.restoreArgs).toBeNull(); // edit stays — no false rollback
	});

	it("commits when recheck returns no diagnostics (no signal)", async () => {
		const disk = { [URI_A]: "x", [URI_B]: "y" };
		const { deps, calls } = makeDeps({
			disk,
			baseline: new Map([[URI_A, []]]),
			afterApply: new Map(),
			recheckEmpty: true,
		});

		const res = await runRenameTransaction(renameEdit(), deps);

		expect(res.rolledBack).toBe(false);
		expect(res.degraded).toBe("recheck-unavailable");
		expect(calls.restoreArgs).toBeNull();
	});

	it("applies and skips verification when there are no affected text files", async () => {
		const edit: WorkspaceEdit = {
			documentChanges: [{ kind: "create", uri: "file:///proj/new.ts" }],
		};
		const { deps, calls } = makeDeps({ disk: {}, baseline: new Map(), afterApply: new Map() });

		const res = await runRenameTransaction(edit, deps);

		expect(res.rolledBack).toBe(false);
		expect(res.degraded).toBe("no-affected-files");
		expect(calls.applied).toBe(1);
		expect(calls.restoreArgs).toBeNull();
	});
});

describe("runRenameTransaction — error scoping", () => {
	it("does NOT roll back when the only error pre-existed the rename", async () => {
		const disk = { [URI_A]: "x", [URI_B]: "y" };
		const preExisting: NewError = { uri: URI_B, diagnostic: errorDiag(5, "already broken") };
		const { deps, calls } = makeDeps({
			disk,
			baseline: new Map([[URI_B, [preExisting.diagnostic]]]),
			// Same error still present after the rename — not introduced BY it.
			afterApply: new Map([[URI_B, [errorDiag(5, "already broken")]]]),
		});

		const res = await runRenameTransaction(renameEdit(), deps);

		expect(res.rolledBack).toBe(false);
		expect(res.newErrors).toEqual([]);
		expect(calls.restoreArgs).toBeNull();
	});
});
