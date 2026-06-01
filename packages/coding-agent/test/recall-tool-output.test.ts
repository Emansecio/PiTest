import { afterEach, describe, expect, it } from "vitest";
import { createDeferredOutputStore, setCurrentDeferredOutputStore } from "../src/core/deferred-output-store.js";
import { createRecallToolOutputDefinition } from "../src/core/tools/recall-tool-output.js";

const CWD = process.cwd();

afterEach(() => {
	setCurrentDeferredOutputStore(undefined);
});

describe("recall_tool_output tool", () => {
	it("returns content for a valid id when store is set", async () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);
		const id = store.put("the full tool output text");

		const def = createRecallToolOutputDefinition(CWD);
		const result = (await def.execute("tc1", { id }, undefined, undefined, undefined as any)) as any;

		expect(result.isError).toBeFalsy();
		const text = result.content.find((b: any) => b.type === "text")?.text;
		expect(text).toBe("the full tool output text");
		expect(result.details?.found).toBe(true);
		store.dispose();
	});

	it("returns isError and message for unknown id when store is set", async () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);

		const def = createRecallToolOutputDefinition(CWD);
		const result = (await def.execute("tc2", { id: "d999" }, undefined, undefined, undefined as any)) as any;

		expect(result.isError).toBe(true);
		const text = result.content.find((b: any) => b.type === "text")?.text;
		expect(text).toContain("d999");
		expect(result.details?.found).toBe(false);
		store.dispose();
	});

	it("returns isError and unavailable message when no store is set", async () => {
		setCurrentDeferredOutputStore(undefined);
		const def = createRecallToolOutputDefinition(CWD);
		const result = (await def.execute("tc3", { id: "d1" }, undefined, undefined, undefined as any)) as any;

		expect(result.isError).toBe(true);
		const text = result.content.find((b: any) => b.type === "text")?.text;
		expect(text).toMatch(/unavailable/i);
	});

	it("tool name and label are recall_tool_output", () => {
		const def = createRecallToolOutputDefinition(CWD);
		expect(def.name).toBe("recall_tool_output");
		expect(def.label).toBe("recall_tool_output");
	});
});
