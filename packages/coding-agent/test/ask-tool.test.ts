import { describe, expect, it } from "vitest";
import { type AskToolDetails, createAskToolDefinition } from "../src/core/tools/ask.js";
import {
	type AskOptionsAnswer,
	type AskOptionsRequest,
	setCurrentUserInputBus,
	type UserInputBus,
} from "../src/core/user-input-bus.js";

function makeBus(answer: Omit<AskOptionsAnswer, "requestId">, opts?: { hasListener?: boolean }) {
	const captured: AskOptionsRequest[] = [];
	const bus: UserInputBus = {
		async askOptions(req) {
			captured.push({ requestId: "r", ...req });
			return { requestId: "r", ...answer };
		},
		onRequest() {
			return () => {};
		},
		resolve() {},
		cancelAll() {},
		hasListener() {
			return opts?.hasListener ?? true;
		},
	};
	return { bus, captured };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => c.text ?? "").join("");
}

// ToolDefinition.execute takes (toolCallId, params, signal, onUpdate, ctx); the
// ask tool only uses the first two, so the rest are passed undefined here.
function runExec(def: { execute: (...args: any[]) => any }, input: unknown) {
	return def.execute("call", input, undefined, undefined, undefined);
}

describe("ask tool execute", () => {
	it("returns a single selection", async () => {
		const { bus, captured } = makeBus({ picked: ["B"] });
		const def = createAskToolDefinition("/tmp", { bus });
		const res = await runExec(def, {
			question: "Pick",
			options: [{ label: "A" }, { label: "B", recommended: true }],
		});
		const details = res.details as AskToolDetails;
		expect(details.response).toEqual({ kind: "selection", selections: ["B"] });
		expect(text(res)).toBe("Selected: B");
		// freeform defaults ON so the user can always type a custom answer; multi off.
		expect(captured[0]?.allowFreeform).toBe(true);
		expect(captured[0]?.allowMultiple).toBe(false);
	});

	it("forces a choice when allowFreeform is explicitly false", async () => {
		const { bus, captured } = makeBus({ picked: ["A"] });
		const def = createAskToolDefinition("/tmp", { bus });
		await runExec(def, { question: "Pick", options: [{ label: "A" }], allowFreeform: false });
		expect(captured[0]?.allowFreeform).toBe(false);
	});

	it("attaches a comment to the selection", async () => {
		const { bus } = makeBus({ picked: ["A"], comment: "be careful here" });
		const def = createAskToolDefinition("/tmp", { bus });
		const res = await runExec(def, {
			question: "Pick",
			options: [{ label: "A" }, { label: "B" }],
			allowComment: true,
		});
		const details = res.details as AskToolDetails;
		expect(details.response).toEqual({ kind: "selection", selections: ["A"], comment: "be careful here" });
		expect(text(res)).toBe("Selected: A — comment: be careful here");
	});

	it("supports multi-select", async () => {
		const { bus, captured } = makeBus({ picked: ["A", "C"] });
		const def = createAskToolDefinition("/tmp", { bus });
		const res = await runExec(def, {
			question: "Pick many",
			options: [{ label: "A" }, { label: "B" }, { label: "C" }],
			allowMultiple: true,
		});
		const details = res.details as AskToolDetails;
		expect(captured[0]?.allowMultiple).toBe(true);
		expect(details.response).toEqual({ kind: "selection", selections: ["A", "C"] });
	});

	it("preserves labels longer than 60 characters for width-aware rendering", async () => {
		const label = "Completo — executar as três camadas e preservar todo o contexto necessário na opção";
		const { bus, captured } = makeBus({ picked: [label] });
		const def = createAskToolDefinition("/tmp", { bus });
		await runExec(def, { question: "Pick", options: [{ label }] });
		expect(captured[0]?.options[0]?.label).toBe(label);
	});

	it("returns a freeform answer and defaults allowFreeform on for option-less prompts", async () => {
		const { bus, captured } = makeBus({ picked: [], freeformText: "olá mundo" });
		const def = createAskToolDefinition("/tmp", { bus });
		const res = await runExec(def, { question: "Describe it" });
		const details = res.details as AskToolDetails;
		expect(captured[0]?.options).toEqual([]);
		expect(captured[0]?.allowFreeform).toBe(true);
		expect(details.response).toEqual({ kind: "freeform", text: "olá mundo" });
		expect(text(res)).toBe("User answered: olá mundo");
	});

	it("reports cancellation", async () => {
		const { bus } = makeBus({ picked: [], cancelled: true });
		const def = createAskToolDefinition("/tmp", { bus });
		const res = await runExec(def, { question: "Pick", options: [{ label: "A" }, { label: "B" }] });
		const details = res.details as AskToolDetails;
		expect(details.cancelled).toBe(true);
		expect(details.response).toBeNull();
		expect(text(res)).toBe("User cancelled the prompt.");
	});

	it("auto-selects the recommended option when no listener is bound", async () => {
		const { bus, captured } = makeBus({ picked: ["never"] }, { hasListener: false });
		const def = createAskToolDefinition("/tmp", { bus, bindTimeoutMs: 0 });
		const res = await runExec(def, {
			question: "Pick",
			options: [{ label: "A" }, { label: "B", recommended: true }],
		});
		const details = res.details as AskToolDetails;
		expect(captured).toHaveLength(0); // never reached the UI
		expect(details.response).toEqual({ kind: "selection", selections: ["B"] });
		expect(text(res)).toContain("auto");
	});

	it("falls back deterministically when there is no bus at all", async () => {
		setCurrentUserInputBus(undefined);
		const def = createAskToolDefinition("/tmp");
		const res = await runExec(def, {
			question: "Pick",
			options: [{ label: "A", recommended: true }, { label: "B" }],
		});
		const details = res.details as AskToolDetails;
		expect(details.response).toEqual({ kind: "selection", selections: ["A"] });
		expect(text(res)).toContain("no interactive input bound");
	});

	it("passes `timeout_ms` through to the input bus request", async () => {
		const { bus, captured } = makeBus({ picked: ["A"] });
		const def = createAskToolDefinition("/tmp", { bus });
		await runExec(def, { question: "Pick", options: [{ label: "A" }], timeout_ms: 5000 });
		expect(captured[0]?.timeout).toBe(5000);
	});
});
