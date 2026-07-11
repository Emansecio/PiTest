/**
 * Intent Gate — Band P / pillar P2. Two layers:
 *   1. the PURE validator + dosing matrix (no fs / no session), and
 *   2. the built-in extension driven through a fake ExtensionAPI + a real temp fs,
 *      with the thermostat and PlanManager stubbed via their session registries.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getRuntimeDiagnostics, resetRuntimeDiagnostics, suggestClosest, suggestClosestN } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntentGateExtension } from "../src/core/built-ins/intent-gate-extension.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import type { SymbolNameSet } from "../src/core/grounding-guard.ts";
import { type IntentGateDeps, intentGateDose, validatePlan } from "../src/core/intent-gate.ts";
import { PlanManager, setCurrentPlanManager } from "../src/core/plan/plan-manager.ts";
import { SupervisionThermostat, setCurrentSupervisionThermostat } from "../src/core/supervision-thermostat.ts";
import { expandPath, resolveReadPath, sameCanonicalName } from "../src/core/tools/path-utils.ts";

// ---------------------------------------------------------------------------
// temp fs
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) {
		const d = dirs.pop();
		if (d) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	}
});

function makeTree(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "pi-intentgate-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(root, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content, "utf-8");
	}
	return root;
}

/** Build a SymbolNameSet from original-cased names. */
function symbols(...names: string[]): SymbolNameSet {
	return { names: new Set(names), lowerSet: new Set(names.map((n) => n.toLowerCase())) };
}

function makeDeps(
	cwd: string,
	symbolSet?: SymbolNameSet,
	symbolResolve?: IntentGateDeps["symbolResolve"],
): IntentGateDeps {
	return {
		resolve: (raw) => resolveReadPath(raw, cwd),
		fileExists: (p) => existsSync(p),
		listDir: (d) => readdirSync(d),
		fuzzy: suggestClosest,
		fuzzyN: suggestClosestN,
		normalize: expandPath,
		sameName: sameCanonicalName,
		symbolSet,
		symbolResolve,
	};
}

// ---------------------------------------------------------------------------
// fake ExtensionAPI (collects handlers + captures steer messages)
// ---------------------------------------------------------------------------

type Handler = (event: any) => unknown | Promise<unknown>;

function makeFakePi() {
	const handlers = new Map<string, Handler[]>();
	const steers: Array<{ content: string; deliverAs?: string }> = [];
	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		markSideEffect<F>(handler: F): F {
			return handler;
		},
		sendMessage(message: { content: string }, options?: { deliverAs?: string }) {
			steers.push({ content: message.content, deliverAs: options?.deliverAs });
		},
	} as unknown as ExtensionAPI;
	const fire = async (event: string, payload: any): Promise<any> => {
		let result: any;
		for (const handler of handlers.get(event) ?? []) {
			const r = await handler(payload);
			if (r !== undefined && result === undefined) result = r;
		}
		return result;
	};
	return { api, fire, steers };
}

const call = (toolName: string, input: Record<string, unknown> = {}) => ({ toolName, input });

// A rigor-2 prompt (mutating action on code, no high-risk surface).
const RIGOR2_PROMPT = "fix the failing test in the code";
// A rigor-3 prompt (refactor + permission/security surface).
const RIGOR3_PROMPT = "refactor the auth permissions module";
// A trivial, answer-only prompt.
const TRIVIAL_PROMPT = "explain what the readme says";

/** assistido = padrao + one bad signal. */
function assistidoThermostat(): SupervisionThermostat {
	const t = new SupervisionThermostat({ subscribeDiagnostics: false });
	t.noteSignal("test");
	expect(t.getLevel()).toBe("assistido");
	return t;
}

beforeEach(() => {
	delete process.env.PIT_NO_INTENT_GATE;
	delete process.env.PIT_NO_SUPERVISION_THERMOSTAT;
	resetRuntimeDiagnostics();
	setCurrentPlanManager(undefined);
	setCurrentSupervisionThermostat(undefined);
});

afterEach(() => {
	setCurrentPlanManager(undefined);
	setCurrentSupervisionThermostat(undefined);
	delete process.env.PIT_NO_INTENT_GATE;
});

// ===========================================================================
// Pure: dosing matrix (§5)
// ===========================================================================

describe("intentGateDose — §5 dosing matrix", () => {
	it("assistido: blocks rigor ≥ 2, off below", () => {
		expect(intentGateDose("assistido", 3)).toBe("block");
		expect(intentGateDose("assistido", 2)).toBe("block");
		expect(intentGateDose("assistido", 1)).toBe("off");
		expect(intentGateDose("assistido", 0)).toBe("off");
	});

	it("padrao: nudge rigor 2, block rigor 3", () => {
		expect(intentGateDose("padrao", 3)).toBe("block");
		expect(intentGateDose("padrao", 2)).toBe("nudge");
		expect(intentGateDose("padrao", 1)).toBe("off");
	});

	it("leve: nudge rigor 3 only", () => {
		expect(intentGateDose("leve", 3)).toBe("nudge");
		expect(intentGateDose("leve", 2)).toBe("off");
	});
});

// ===========================================================================
// Pure: plan validator
// ===========================================================================

describe("validatePlan — path grounding against the real tree", () => {
	it("yields a warn finding with a fuzzy candidate for a misspelled basename", () => {
		const cwd = makeTree({ "src/util/helper.ts": "export const x = 1;\n" });
		const version = new PlanManager().propose([{ id: "s1", intent: "fix the bug in src/util/helpr.ts" }]);
		const findings = validatePlan(version, makeDeps(cwd));
		expect(findings).toHaveLength(1);
		expect(findings[0].kind).toBe("path");
		expect(findings[0].severity).toBe("warn");
		expect(findings[0].candidates).toContain("src/util/helper.ts");
		expect(findings[0].message).toContain("did you mean");
	});

	it("block-level finding when even the parent directory is missing", () => {
		const cwd = makeTree({ "src/util/helper.ts": "export const x = 1;\n" });
		const version = new PlanManager().propose([{ id: "s1", intent: "edit src/utl/helper.ts to add a field" }]);
		const findings = validatePlan(version, makeDeps(cwd));
		expect(findings).toHaveLength(1);
		expect(findings[0].severity).toBe("block");
		expect(findings[0].message).toContain("does not exist");
	});

	it("no findings when the cited path exists (gate would open)", () => {
		const cwd = makeTree({ "src/util/helper.ts": "export const x = 1;\n" });
		const version = new PlanManager().propose([{ id: "s1", intent: "fix src/util/helper.ts" }]);
		expect(validatePlan(version, makeDeps(cwd))).toHaveLength(0);
	});

	it("does not flag a path the plan will CREATE (producesArtifact / create verb)", () => {
		const cwd = makeTree({ "src/util/helper.ts": "export const x = 1;\n" });
		const version = new PlanManager().propose([
			{ id: "s1", intent: "create src/util/newfile.ts", producesArtifact: "src/util/newfile.ts" },
			{ id: "s2", intent: "wire src/util/newfile.ts into the index" },
		]);
		// s2 mutates newfile.ts, but s1 produces it -> not flagged.
		expect(validatePlan(version, makeDeps(cwd))).toHaveLength(0);
	});

	it("ignores non-path prose and steps without an edit verb", () => {
		const cwd = makeTree({ "src/util/helper.ts": "export const x = 1;\n" });
		const version = new PlanManager().propose([
			{ id: "s1", intent: "read src/util/ghost.ts to understand the flow (no mutation verb)" },
			{ id: "s2", intent: "consider the tradeoffs, e.g. speed vs clarity" },
		]);
		expect(validatePlan(version, makeDeps(cwd))).toHaveLength(0);
	});

	it("symbols fail-open when no resolver is wired (repo-map miss)", () => {
		const cwd = makeTree({ "src/util/helper.ts": "export const x = 1;\n" });
		const version = new PlanManager().propose([{ id: "s1", intent: "update the SomeMadeUpSymbol handler" }]);
		expect(validatePlan(version, makeDeps(cwd, symbols("OtherThing")))).toHaveLength(0);
	});

	it("symbolSet lowerSet HIT is case-insensitive and skips symbolResolve", () => {
		const cwd = makeTree({ "src/util/helper.ts": "export const x = 1;\n" });
		// CamelCase token extracted; lowerSet membership is case-insensitive.
		const version = new PlanManager().propose([{ id: "s1", intent: "update the CalculateTotal handler" }]);
		let resolveCalls = 0;
		const findings = validatePlan(
			version,
			makeDeps(cwd, symbols("calculateTotal"), () => {
				resolveCalls++;
				return [];
			}),
		);
		expect(findings).toHaveLength(0);
		expect(resolveCalls).toBe(0);
	});

	it("symbolResolve HIT allows (exact name in LSP pool)", () => {
		const cwd = makeTree({ "src/util/helper.ts": "export const x = 1;\n" });
		const version = new PlanManager().propose([{ id: "s1", intent: "update the calculateTotal handler" }]);
		const findings = validatePlan(
			version,
			makeDeps(cwd, symbols("OtherThing"), () => ["calculateTotal", "formatPrice"]),
		);
		expect(findings).toHaveLength(0);
	});

	it("symbolResolve MISS with fuzzy candidates yields a warn finding", () => {
		const cwd = makeTree({ "src/util/helper.ts": "export const x = 1;\n" });
		const version = new PlanManager().propose([{ id: "s1", intent: "update the calculateTotl handler" }]);
		const findings = validatePlan(
			version,
			makeDeps(cwd, undefined, () => ["calculateTotal", "formatPrice"]),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0].kind).toBe("symbol");
		expect(findings[0].severity).toBe("warn");
		expect(findings[0].candidates).toContain("calculateTotal");
	});

	it("symbolResolve returning undefined (LSP unavailable) fails open", () => {
		const cwd = makeTree({ "src/util/helper.ts": "export const x = 1;\n" });
		const version = new PlanManager().propose([{ id: "s1", intent: "update the TotallyMadeUp handler" }]);
		expect(
			validatePlan(
				version,
				makeDeps(cwd, symbols("OtherThing"), () => undefined),
			),
		).toHaveLength(0);
	});

	it("a throw in symbolResolve fails open", () => {
		const cwd = makeTree({ "src/util/helper.ts": "export const x = 1;\n" });
		const version = new PlanManager().propose([{ id: "s1", intent: "update the TotallyMadeUp handler" }]);
		expect(
			validatePlan(
				version,
				makeDeps(cwd, undefined, () => {
					throw new Error("LSP crashed");
				}),
			),
		).toHaveLength(0);
	});
});

// ===========================================================================
// Extension: enforcement
// ===========================================================================

describe("intent-gate extension — enforcement", () => {
	it("assistido + risky prompt blocks the first edit until a validated plan exists", async () => {
		const cwd = makeTree({ "src/util/helper.ts": "export const x = 1;\n" });
		setCurrentSupervisionThermostat(assistidoThermostat());
		const plan = new PlanManager();
		setCurrentPlanManager(plan);

		const { api, fire } = makeFakePi();
		createIntentGateExtension({ cwd })(api);
		await fire("before_agent_start", { prompt: RIGOR2_PROMPT });

		// No plan yet -> block, telling the model to call `plan`.
		const first = await fire("tool_call", call("edit", { path: "src/util/helper.ts", oldText: "1", newText: "2" }));
		expect(first?.block).toBe(true);
		expect(String(first?.reason)).toContain("plan");

		const blocked = getRuntimeDiagnostics().recent.find((e) => e.category === "guard.intent-gate");
		expect(blocked?.context?.outcome).toBe("blocked");
		expect(blocked?.context?.ruleId).toBe("intent-gate-no-plan");

		// Model proposes a grounded plan -> next edit opens the gate.
		plan.propose([{ id: "s1", intent: "fix src/util/helper.ts" }]);
		const second = await fire("tool_call", call("edit", { path: "src/util/helper.ts", oldText: "1", newText: "2" }));
		expect(second).toBeUndefined();

		// Gate is open for the rest of the cycle.
		const third = await fire("tool_call", call("write", { path: "src/util/helper.ts", content: "y" }));
		expect(third).toBeUndefined();
	});

	it("blocks once with candidates when the proposed plan has a bad path", async () => {
		const cwd = makeTree({ "src/util/helper.ts": "export const x = 1;\n" });
		setCurrentSupervisionThermostat(assistidoThermostat());
		const plan = new PlanManager();
		plan.propose([{ id: "s1", intent: "fix the bug in src/util/helpr.ts" }]);
		setCurrentPlanManager(plan);

		const { api, fire } = makeFakePi();
		createIntentGateExtension({ cwd })(api);
		await fire("before_agent_start", { prompt: RIGOR2_PROMPT });

		const first = await fire("tool_call", call("edit", { path: "src/util/helper.ts", oldText: "1", newText: "2" }));
		expect(first?.block).toBe(true);
		expect(String(first?.reason)).toContain("src/util/helper.ts");
		const ev = getRuntimeDiagnostics().recent.find((e) => e.category === "guard.intent-gate");
		expect(ev?.context?.ruleId).toBe("intent-gate-plan-findings");

		// Fixing the plan opens the gate.
		plan.revise([{ id: "s1", intent: "fix src/util/helper.ts" }]);
		const second = await fire("tool_call", call("edit", { path: "src/util/helper.ts", oldText: "1", newText: "2" }));
		expect(second).toBeUndefined();
	});

	it("leve + rigor 3: nudges (allows) instead of blocking", async () => {
		const cwd = makeTree({ "a.ts": "x\n" });
		setCurrentSupervisionThermostat(
			new SupervisionThermostat({ model: { provider: "anthropic" }, subscribeDiagnostics: false }),
		);
		setCurrentPlanManager(undefined);

		const { api, fire, steers } = makeFakePi();
		createIntentGateExtension({ cwd })(api);
		await fire("before_agent_start", { prompt: RIGOR3_PROMPT });

		const r = await fire("tool_call", call("edit", { path: "a.ts", oldText: "x", newText: "y" }));
		expect(r).toBeUndefined(); // nudge = allow
		expect(steers).toHaveLength(1);
		expect(steers[0].deliverAs).toBe("steer");
		const ev = getRuntimeDiagnostics().recent.find((e) => e.category === "guard.intent-gate");
		expect(ev?.context?.outcome).toBe("overridden");

		// Nudge fires at most once per cycle.
		await fire("tool_call", call("edit", { path: "a.ts", oldText: "x", newText: "z" }));
		expect(steers).toHaveLength(1);
	});

	it("anti-lock: degrades to a nudge after 2 blocks in a cycle", async () => {
		const cwd = makeTree({ "a.ts": "x\n" });
		setCurrentSupervisionThermostat(assistidoThermostat());
		setCurrentPlanManager(new PlanManager()); // empty -> no plan

		const { api, fire, steers } = makeFakePi();
		createIntentGateExtension({ cwd })(api);
		await fire("before_agent_start", { prompt: RIGOR2_PROMPT });

		expect((await fire("tool_call", call("edit", { path: "a.ts", oldText: "x", newText: "1" })))?.block).toBe(true);
		expect((await fire("tool_call", call("edit", { path: "a.ts", oldText: "x", newText: "2" })))?.block).toBe(true);
		// 3rd mutating call: block budget spent -> allow + one steer.
		expect(await fire("tool_call", call("edit", { path: "a.ts", oldText: "x", newText: "3" }))).toBeUndefined();
		expect(steers).toHaveLength(1);

		const events = getRuntimeDiagnostics().recent.filter((e) => e.category === "guard.intent-gate");
		expect(events.filter((e) => e.context?.outcome === "blocked")).toHaveLength(2);
		expect(events.filter((e) => e.context?.outcome === "overridden")).toHaveLength(1);
	});

	it("per-cycle reset: a new before_agent_start re-arms the gate", async () => {
		const cwd = makeTree({ "a.ts": "x\n" });
		setCurrentSupervisionThermostat(assistidoThermostat());
		setCurrentPlanManager(new PlanManager());

		const { api, fire } = makeFakePi();
		createIntentGateExtension({ cwd })(api);

		await fire("before_agent_start", { prompt: RIGOR2_PROMPT });
		expect((await fire("tool_call", call("edit", { path: "a.ts", oldText: "x", newText: "1" })))?.block).toBe(true);

		// New prompt cycle -> block budget and gate state reset.
		await fire("before_agent_start", { prompt: RIGOR2_PROMPT });
		expect((await fire("tool_call", call("edit", { path: "a.ts", oldText: "x", newText: "2" })))?.block).toBe(true);
	});

	it("kill-switch PIT_NO_INTENT_GATE=1 fails open", async () => {
		const cwd = makeTree({ "a.ts": "x\n" });
		process.env.PIT_NO_INTENT_GATE = "1";
		setCurrentSupervisionThermostat(assistidoThermostat());
		setCurrentPlanManager(new PlanManager());

		const { api, fire } = makeFakePi();
		createIntentGateExtension({ cwd })(api);
		await fire("before_agent_start", { prompt: RIGOR2_PROMPT });
		expect(await fire("tool_call", call("edit", { path: "a.ts", oldText: "x", newText: "1" }))).toBeUndefined();
	});

	it("never gates a trivial prompt (rigor 0 -> dose off)", async () => {
		const cwd = makeTree({ "a.ts": "x\n" });
		setCurrentSupervisionThermostat(assistidoThermostat());
		setCurrentPlanManager(new PlanManager());

		const { api, fire } = makeFakePi();
		createIntentGateExtension({ cwd })(api);
		await fire("before_agent_start", { prompt: TRIVIAL_PROMPT });
		expect(await fire("tool_call", call("edit", { path: "a.ts", oldText: "x", newText: "1" }))).toBeUndefined();
	});

	it("undefined thermostat registry defaults to padrao (nudge at rigor 2)", async () => {
		const cwd = makeTree({ "a.ts": "x\n" });
		setCurrentSupervisionThermostat(undefined);
		setCurrentPlanManager(undefined);

		const { api, fire, steers } = makeFakePi();
		createIntentGateExtension({ cwd })(api);
		await fire("before_agent_start", { prompt: RIGOR2_PROMPT });
		// padrao + rigor 2 = nudge, so the edit is allowed with a steer.
		expect(await fire("tool_call", call("edit", { path: "a.ts", oldText: "x", newText: "1" }))).toBeUndefined();
		expect(steers).toHaveLength(1);
	});

	it("ignores non-mutating tools", async () => {
		const cwd = makeTree({ "a.ts": "x\n" });
		setCurrentSupervisionThermostat(assistidoThermostat());
		setCurrentPlanManager(new PlanManager());

		const { api, fire } = makeFakePi();
		createIntentGateExtension({ cwd })(api);
		await fire("before_agent_start", { prompt: RIGOR2_PROMPT });
		expect(await fire("tool_call", call("read", { path: "a.ts" }))).toBeUndefined();
		expect(await fire("tool_call", call("grep", { pattern: "x" }))).toBeUndefined();
	});
});

// ===========================================================================
// Extension: LSP symbolResolve wiring (mocked)
// ===========================================================================

type FakeLspServerEntry = [string, { command: string; args: string[] }];

const lspMocks = vi.hoisted(() => ({
	getLspServers: vi.fn((): FakeLspServerEntry[] => [["typescript", { command: "fake-lsp", args: [] }]]),
	getOrCreateClient: vi.fn(async () => ({ id: "fake-client" })),
	sendRequest: vi.fn(),
}));

vi.mock("../src/core/lsp/manager.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/lsp/manager.ts")>();
	return {
		...actual,
		getConfig: () => ({ servers: { typescript: { command: "fake-lsp", args: [] } } }),
		getLspServers: lspMocks.getLspServers,
	};
});

vi.mock("../src/core/lsp/client.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/lsp/client.ts")>();
	return {
		...actual,
		getOrCreateClient: lspMocks.getOrCreateClient,
		sendRequest: lspMocks.sendRequest,
	};
});

describe("intent-gate extension — LSP symbolResolve", () => {
	beforeEach(() => {
		lspMocks.getLspServers.mockClear();
		lspMocks.getOrCreateClient.mockClear();
		lspMocks.sendRequest.mockReset();
		lspMocks.getLspServers.mockReturnValue([["typescript", { command: "fake-lsp", args: [] }]]);
		lspMocks.getOrCreateClient.mockResolvedValue({ id: "fake-client" });
	});

	it("blocks with symbol candidates when LSP confirms a typo", async () => {
		const cwd = makeTree({ "src/util/helper.ts": "export const x = 1;\n" });
		setCurrentSupervisionThermostat(assistidoThermostat());
		const plan = new PlanManager();
		// "calculateTot" is a substring of "calculateTotal" so filterWorkspaceSymbols keeps it.
		plan.propose([{ id: "s1", intent: "update the calculateTot handler" }]);
		setCurrentPlanManager(plan);

		lspMocks.sendRequest.mockResolvedValue([
			{ name: "calculateTotal", kind: 12, location: { uri: "file:///a.ts", range: {} } },
			{ name: "formatPrice", kind: 12, location: { uri: "file:///b.ts", range: {} } },
		]);

		const { api, fire } = makeFakePi();
		createIntentGateExtension({ cwd })(api);
		await fire("before_agent_start", { prompt: RIGOR2_PROMPT });

		const first = await fire("tool_call", call("edit", { path: "src/util/helper.ts", oldText: "1", newText: "2" }));
		expect(first?.block).toBe(true);
		expect(String(first?.reason)).toContain("calculateTotal");
		expect(lspMocks.sendRequest).toHaveBeenCalled();
	});

	it("opens the gate when LSP confirms the symbol exists", async () => {
		const cwd = makeTree({ "src/util/helper.ts": "export const x = 1;\n" });
		setCurrentSupervisionThermostat(assistidoThermostat());
		const plan = new PlanManager();
		plan.propose([{ id: "s1", intent: "update the calculateTotal handler" }]);
		setCurrentPlanManager(plan);

		lspMocks.sendRequest.mockResolvedValue([
			{ name: "calculateTotal", kind: 12, location: { uri: "file:///a.ts", range: {} } },
		]);

		const { api, fire } = makeFakePi();
		createIntentGateExtension({ cwd })(api);
		await fire("before_agent_start", { prompt: RIGOR2_PROMPT });

		expect(
			await fire("tool_call", call("edit", { path: "src/util/helper.ts", oldText: "1", newText: "2" })),
		).toBeUndefined();
	});

	it("fails open when LSP sendRequest throws", async () => {
		const cwd = makeTree({ "src/util/helper.ts": "export const x = 1;\n" });
		setCurrentSupervisionThermostat(assistidoThermostat());
		const plan = new PlanManager();
		plan.propose([{ id: "s1", intent: "update the TotallyMadeUp handler" }]);
		setCurrentPlanManager(plan);

		lspMocks.sendRequest.mockRejectedValue(new Error("LSP timeout"));

		const { api, fire } = makeFakePi();
		createIntentGateExtension({ cwd })(api);
		await fire("before_agent_start", { prompt: RIGOR2_PROMPT });

		expect(
			await fire("tool_call", call("edit", { path: "src/util/helper.ts", oldText: "1", newText: "2" })),
		).toBeUndefined();
	});

	it("fails open when no LSP servers are configured", async () => {
		const cwd = makeTree({ "src/util/helper.ts": "export const x = 1;\n" });
		setCurrentSupervisionThermostat(assistidoThermostat());
		const plan = new PlanManager();
		plan.propose([{ id: "s1", intent: "update the TotallyMadeUp handler" }]);
		setCurrentPlanManager(plan);

		lspMocks.getLspServers.mockReturnValue([]);

		const { api, fire } = makeFakePi();
		createIntentGateExtension({ cwd })(api);
		await fire("before_agent_start", { prompt: RIGOR2_PROMPT });

		expect(
			await fire("tool_call", call("edit", { path: "src/util/helper.ts", oldText: "1", newText: "2" })),
		).toBeUndefined();
		expect(lspMocks.sendRequest).not.toHaveBeenCalled();
	});
});
