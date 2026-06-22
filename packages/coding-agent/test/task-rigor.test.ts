import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { createTaskRigorExtension } from "../src/core/built-ins/task-rigor-extension.ts";
import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI } from "../src/core/extensions/types.ts";
import {
	appendTaskRigorPrompt,
	classifyTaskRigor,
	formatTaskRigorPrompt,
	isTaskRigorDisabled,
} from "../src/core/task-rigor.ts";

type BeforeStartHandler = (event: BeforeAgentStartEvent) => BeforeAgentStartEventResult | undefined;

function makeFakePi() {
	const handlers: BeforeStartHandler[] = [];
	const api = {
		on(event: string, handler: BeforeStartHandler) {
			if (event === "before_agent_start") handlers.push(handler);
		},
	} as unknown as ExtensionAPI;
	const fire = (prompt: string): BeforeAgentStartEventResult | undefined => {
		let result: BeforeAgentStartEventResult | undefined;
		let systemPrompt = "base";
		for (const handler of handlers) {
			const handlerResult = handler({
				type: "before_agent_start",
				prompt,
				systemPrompt,
				systemPromptOptions: { cwd: "C:\\PiTest" },
			});
			if (!handlerResult) continue;
			result = handlerResult;
			systemPrompt = handlerResult.systemPrompt ?? systemPrompt;
		}
		return result;
	};
	return { api, fire };
}

describe("classifyTaskRigor", () => {
	it("leaves read-only prompts at rigor 0", () => {
		expect(classifyTaskRigor("explique este arquivo").rigor).toBe(0);
	});

	it("classifies documentation creation as low risk", () => {
		const rigor = classifyTaskRigor("crie um relatorio.md robusto");
		expect(rigor).toMatchObject({ risk: "low", rigor: 1 });
	});

	it("classifies normal code fixes as medium risk", () => {
		const rigor = classifyTaskRigor("corrigir erro TypeScript no componente");
		expect(rigor).toMatchObject({ risk: "medium", rigor: 2 });
	});

	it("classifies agent/config surfaces as high risk", () => {
		const rigor = classifyTaskRigor("implementar ajuste no LSP e verification do agent loop");
		expect(rigor).toMatchObject({ risk: "high", rigor: 3 });
		expect(rigor.reasons).toContain("agent/config surface");
	});
});

describe("task rigor prompt helpers", () => {
	it("formats no block for rigor 0", () => {
		expect(formatTaskRigorPrompt({ risk: "simple", rigor: 0, reasons: [] })).toBe("");
	});

	it("appends a compact rigor block", () => {
		const result = appendTaskRigorPrompt("base", { risk: "medium", rigor: 2, reasons: ["code-affecting action"] });
		expect(result).toContain("<task_rigor>");
		expect(result).toContain("Rigor 2");
		expect(result).toContain("do not report done while verification is red");
	});
});

describe("isTaskRigorDisabled", () => {
	it("is controlled by PIT_NO_TASK_RIGOR", () => {
		expect(isTaskRigorDisabled({})).toBe(false);
		expect(isTaskRigorDisabled({ PIT_NO_TASK_RIGOR: "yes" })).toBe(true);
		expect(isTaskRigorDisabled({ PIT_NO_TASK_RIGOR: "0" })).toBe(false);
	});
});

describe("createTaskRigorExtension", () => {
	it("injects a system prompt block and records diagnostics for risky prompts", () => {
		resetRuntimeDiagnostics();
		const { api, fire } = makeFakePi();
		createTaskRigorExtension()(api);

		const result = fire("implementar ajuste no LSP e verification do agent loop");

		expect(result?.systemPrompt).toContain("Rigor 3");
		const diagnostic = getRuntimeDiagnostics().recent.find((event) => event.source === "task-rigor-extension");
		expect(diagnostic?.category).toBe("quality.rigor");
		expect(diagnostic?.context?.note).toContain("rigor=3");
	});

	it("does not inject for simple read-only prompts", () => {
		const { api, fire } = makeFakePi();
		createTaskRigorExtension()(api);
		expect(fire("explique o que este arquivo faz")).toBeUndefined();
	});
});
