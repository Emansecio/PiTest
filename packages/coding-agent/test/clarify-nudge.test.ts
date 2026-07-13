import { afterEach, describe, expect, it } from "vitest";
import { createClarifyNudgeExtension } from "../src/core/built-ins/clarify-nudge-extension.ts";
import { assessPromptClarity, formatClarifyNudge, isClarifyNudgeDisabled } from "../src/core/clarify-nudge.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { clearTaskRigorTurnCache } from "../src/core/task-rigor.ts";
import { createUserInputBus, setCurrentUserInputBus } from "../src/core/user-input-bus.ts";

describe("assessPromptClarity — never fires on anchored prompts", () => {
	it("a path anchor disables the nudge even on a short prompt", () => {
		expect(assessPromptClarity("corrige o bug em src/core/agent.ts").ambiguous).toBe(false);
	});

	it("a file extension anchors", () => {
		expect(assessPromptClarity("arruma o footer.ts").ambiguous).toBe(false);
	});

	it("a backticked identifier anchors", () => {
		expect(assessPromptClarity("remove o `scriptsCache` daquele modulo").ambiguous).toBe(false);
	});

	it("a camelCase/snake_case symbol anchors", () => {
		expect(assessPromptClarity("renomeia readScripts para algo melhor").ambiguous).toBe(false);
		expect(assessPromptClarity("apaga a hint_fire_tally e refaz").ambiguous).toBe(false);
	});

	it("a long, specific prose prompt without symbols does not fire (short is a precondition)", () => {
		const prompt =
			"Quando o usuario abre a tela de historico pela segunda vez na mesma sessao, a lista aparece " +
			"vazia ate ele rolar. Investiga a causa disso na tela de historico e corrige o carregamento " +
			"inicial para renderizar os itens imediatamente, mantendo o comportamento de paginacao atual.";
		expect(prompt.length).toBeGreaterThan(160);
		expect(assessPromptClarity(prompt).ambiguous).toBe(false);
	});
});

describe("assessPromptClarity — fires on vague mutating asks", () => {
	it("short + no anchor fires", () => {
		const clarity = assessPromptClarity("corrige o bug do login");
		expect(clarity.ambiguous).toBe(true);
		expect(clarity.signals).toContain("short");
		expect(clarity.signals).toContain("no-anchor");
	});

	it("deictic back-reference fires", () => {
		const clarity = assessPromptClarity("implementa aquilo que a gente conversou ontem sobre o fluxo de pagamento");
		expect(clarity.ambiguous).toBe(true);
		expect(clarity.signals).toContain("deictic-reference");
	});

	it("broad target-less scope fires", () => {
		const clarity = assessPromptClarity("melhora a performance do projeto inteiro");
		expect(clarity.ambiguous).toBe(true);
		expect(clarity.signals).toContain("broad-scope");
	});

	it("empty prompt never fires", () => {
		expect(assessPromptClarity("  ").ambiguous).toBe(false);
	});
});

describe("formatClarifyNudge", () => {
	it("mentions the ask tool, the 3-question cap, one round, and the read-first rule", () => {
		const block = formatClarifyNudge({ ambiguous: true, signals: ["short", "no-anchor"] });
		expect(block).toContain("<clarify_first>");
		expect(block).toContain("`ask` tool");
		expect(block).toContain("max 3");
		expect(block).toContain("ONE round");
		expect(block).toContain("read it instead");
		expect(block).toContain("proceed without asking");
	});
});

describe("isClarifyNudgeDisabled — opt-out", () => {
	it("false when unset, true for 1/true/yes", () => {
		expect(isClarifyNudgeDisabled({})).toBe(false);
		expect(isClarifyNudgeDisabled({ PIT_NO_CLARIFY_GATE: "1" })).toBe(true);
		expect(isClarifyNudgeDisabled({ PIT_NO_CLARIFY_GATE: "true" })).toBe(true);
		expect(isClarifyNudgeDisabled({ PIT_NO_CLARIFY_GATE: "0" })).toBe(false);
	});
});

describe("clarify-nudge extension — wiring", () => {
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

	function bindInteractiveBus(): () => void {
		const bus = createUserInputBus();
		const unsub = bus.onRequest(() => {});
		setCurrentUserInputBus(bus);
		return unsub;
	}

	afterEach(() => {
		setCurrentUserInputBus(undefined);
		clearTaskRigorTurnCache();
	});

	function fireStart(fire: ReturnType<typeof makeFakePi>["fire"], prompt: string): unknown {
		clearTaskRigorTurnCache();
		return fire("before_agent_start", { type: "before_agent_start", prompt, systemPrompt: "BASE" });
	}

	it("appends <clarify_first> for a vague mutating prompt when interactive", () => {
		bindInteractiveBus();
		const { api, fire } = makeFakePi();
		createClarifyNudgeExtension()(api as unknown as ExtensionAPI);
		const result = fireStart(fire, "corrige o bug do login") as { systemPrompt?: string } | undefined;
		expect(result?.systemPrompt).toContain("BASE");
		expect(result?.systemPrompt).toContain("<clarify_first>");
	});

	it("does nothing without an interactive listener (print/CI/subagent)", () => {
		setCurrentUserInputBus(createUserInputBus()); // bus present, no listener bound
		const { api, fire } = makeFakePi();
		createClarifyNudgeExtension()(api as unknown as ExtensionAPI);
		expect(fireStart(fire, "corrige o bug do login")).toBeUndefined();
	});

	it("does nothing for a non-mutating prompt (rigor < 2)", () => {
		bindInteractiveBus();
		const { api, fire } = makeFakePi();
		createClarifyNudgeExtension()(api as unknown as ExtensionAPI);
		expect(fireStart(fire, "explica como funciona o fluxo de compaction")).toBeUndefined();
	});

	it("does nothing for an anchored (specific) mutating prompt", () => {
		bindInteractiveBus();
		const { api, fire } = makeFakePi();
		createClarifyNudgeExtension()(api as unknown as ExtensionAPI);
		expect(fireStart(fire, "corrige o bug de login em src/core/auth/session.ts")).toBeUndefined();
	});

	it("respects PIT_NO_CLARIFY_GATE", () => {
		bindInteractiveBus();
		process.env.PIT_NO_CLARIFY_GATE = "1";
		try {
			const { api, fire } = makeFakePi();
			createClarifyNudgeExtension()(api as unknown as ExtensionAPI);
			expect(fireStart(fire, "corrige o bug do login")).toBeUndefined();
		} finally {
			delete process.env.PIT_NO_CLARIFY_GATE;
		}
	});
});
