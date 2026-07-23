import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PIN_CAP, PinManager, setCurrentPinManager } from "../src/core/pins.js";
import { createPinToolDefinition, type PinToolDetails } from "../src/core/tools/pin.js";

afterEach(() => setCurrentPinManager(undefined));

// ToolDefinition.execute takes (toolCallId, params, signal, onUpdate, ctx).
function runExec(def: { execute: (...args: any[]) => any }, input: unknown) {
	return def.execute("call", input, undefined, undefined, undefined);
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => c.text ?? "").join("");
}

const cwd = process.cwd();

describe("pin tool", () => {
	it("add_fact pins a fact created by the model", async () => {
		const mgr = new PinManager();
		setCurrentPinManager(mgr);
		const def = createPinToolDefinition(cwd);

		const res = await runExec(def, { op: "add_fact", text: "never touch CHANGELOG.md" });
		expect(text(res)).toContain("Pinned #p1");
		expect(mgr.list()).toHaveLength(1);
		expect(mgr.list()[0]?.createdBy).toBe("model");
	});

	it("add_fact requires text and surfaces validation errors", async () => {
		setCurrentPinManager(new PinManager());
		const def = createPinToolDefinition(cwd);
		const res = await runExec(def, { op: "add_fact" });
		expect(res.isError).toBe(true);
		expect((res.details as PinToolDetails).error).toContain("text");
	});

	it("add_file resolves the path against cwd and pins it", async () => {
		const mgr = new PinManager();
		setCurrentPinManager(mgr);
		const def = createPinToolDefinition(cwd);

		const res = await runExec(def, { op: "add_file", path: "src/foo.ts" });
		expect(text(res)).toContain("Pinned #p1");
		expect(mgr.list()).toHaveLength(1);
		expect(mgr.list()[0]?.kind).toBe("file");
		expect(mgr.list()[0]?.displayPath).toBe("src/foo.ts");
	});

	it("add_file dedupes and reports 'Already pinned' without minting a new id", async () => {
		const mgr = new PinManager();
		setCurrentPinManager(mgr);
		const def = createPinToolDefinition(cwd);

		await runExec(def, { op: "add_file", path: "src/foo.ts" });
		const second = await runExec(def, { op: "add_file", path: "src/foo.ts" });
		expect(text(second)).toContain("Already pinned #p1");
		expect(mgr.list()).toHaveLength(1);
	});

	it("add_file requires path", async () => {
		setCurrentPinManager(new PinManager());
		const def = createPinToolDefinition(cwd);
		const res = await runExec(def, { op: "add_file" });
		expect(res.isError).toBe(true);
		expect((res.details as PinToolDetails).error).toContain("path");
	});

	it("surfaces the cap error message verbatim (no stack)", async () => {
		const mgr = new PinManager();
		setCurrentPinManager(mgr);
		for (let i = 0; i < PIN_CAP; i++) mgr.pinFact(`fact ${i}`, "user");
		const def = createPinToolDefinition(cwd);

		const res = await runExec(def, { op: "add_fact", text: "one too many" });
		expect(res.isError).toBe(true);
		expect((res.details as PinToolDetails).error).toMatch(/limit/i);
		expect(text(res)).toMatch(/limit/i);
	});

	it("remove: the model can remove its own pin", async () => {
		const mgr = new PinManager();
		setCurrentPinManager(mgr);
		const item = mgr.pinFact("model note", "model");
		const def = createPinToolDefinition(cwd);

		const res = await runExec(def, { op: "remove", id: item.id });
		expect(text(res)).toContain(`Unpinned #${item.id}`);
		expect(mgr.isEmpty()).toBe(true);
	});

	it("remove: the model cannot remove a user-created pin — explains why", async () => {
		const mgr = new PinManager();
		setCurrentPinManager(mgr);
		const item = mgr.pinFact("owned by the human", "user");
		const def = createPinToolDefinition(cwd);

		const res = await runExec(def, { op: "remove", id: item.id });
		expect(res.isError).toBe(true);
		const message = (res.details as PinToolDetails).error ?? "";
		expect(message).toContain("user");
		expect(message).toContain("/unpin");
		expect(mgr.list()).toHaveLength(1);
	});

	it("remove: an unknown id is reported distinctly from an owned-by-user id", async () => {
		setCurrentPinManager(new PinManager());
		const def = createPinToolDefinition(cwd);
		const res = await runExec(def, { op: "remove", id: "p99" });
		expect(res.isError).toBe(true);
		expect((res.details as PinToolDetails).error).toContain("No pin with id p99");
	});

	it("remove requires an id", async () => {
		setCurrentPinManager(new PinManager());
		const def = createPinToolDefinition(cwd);
		const res = await runExec(def, { op: "remove" });
		expect(res.isError).toBe(true);
		expect((res.details as PinToolDetails).error).toContain("id");
	});

	it("list returns every pin, dense one-line-per-item", async () => {
		const mgr = new PinManager();
		setCurrentPinManager(mgr);
		mgr.pinFact("fact one", "user");
		mgr.pinFile(join(cwd, "a.ts"), cwd, "model");
		const def = createPinToolDefinition(cwd);

		const res = await runExec(def, { op: "list" });
		expect((res.details as PinToolDetails).items).toHaveLength(2);
		expect(text(res)).toContain("fact one");
		expect(text(res)).toContain("a.ts");
	});

	it("list on an empty set says so", async () => {
		setCurrentPinManager(new PinManager());
		const def = createPinToolDefinition(cwd);
		const res = await runExec(def, { op: "list" });
		expect(text(res)).toContain("no pins");
	});

	it("is a graceful no-op when no manager is bound", async () => {
		setCurrentPinManager(undefined);
		const def = createPinToolDefinition(cwd);
		const res = await runExec(def, { op: "list" });
		expect((res.details as PinToolDetails).error).toContain("unavailable");
	});
});
