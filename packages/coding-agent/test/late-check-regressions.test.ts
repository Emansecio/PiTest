/**
 * Regressions for the "late check verdict" symptom: verdicts/turnos chegando
 * depois da resposta final do modelo, e checks de turnos antigos ressurgindo.
 *
 *  1. Um check que apenas ESTOURA O TIMEOUT (não falhou) é inconclusivo: o gate
 *     não pode injetar fix turns nem mensagem terminal de "still failing".
 *  2. goal_complete não pode ficar permanentemente bloqueado por um probe que
 *     estoura timeout (check pesado ≠ check vermelho).
 *  3. Um check em background que o drain já abandonou num turno anterior não
 *     ressurge no fim de um turno posterior sem relação.
 *  4. Um check backgroundado DURANTE os fix turns do gate ainda é drenado no
 *     mesmo turno (re-drain pós-gate), em vez de sobreviver ao handoff.
 */

import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { GoalManager, setCurrentGoalManager } from "../src/core/goal/goal-manager.js";
import {
	_registerBashBackgroundJobForTest,
	_resetBashBackgroundJobsForTest,
	type BashBackgroundJob,
} from "../src/core/tools/bash.js";
import { createGoalCompleteToolDefinition } from "../src/core/tools/goal-complete.js";
import { setCurrentVerificationProbe } from "../src/core/verification/verification.js";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.js";

// Dorme além do timeoutMs configurado e sai VERDE — nada está quebrado.
const NODE_SLOW_OK = `node -e "setTimeout(()=>process.exit(0),4000)"`;
// Verde rápido, mas lento o bastante para registrar um job "durante o gate".
const NODE_MEDIUM_OK = `node -e "setTimeout(()=>process.exit(0),800)"`;

function bgJob(over: Partial<BashBackgroundJob>): BashBackgroundJob {
	return {
		id: "bg-1",
		pid: 1,
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

describe("late-check regressions", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		_resetBashBackgroundJobsForTest();
		setCurrentVerificationProbe(undefined);
		setCurrentGoalManager(undefined);
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("gate: timeout do check é inconclusivo — sem fix turns, sem 'still failing'", async () => {
		const harness = await createHarness({
			settings: { verification: { command: NODE_SLOW_OK, maxAttempts: 1, timeoutMs: 800 } },
		});
		harnesses.push(harness);
		const file = join(harness.tempDir, "out.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Tudo pronto."),
			// Sobressalentes: só consumidos se o gate (indevidamente) injetar turnos.
			fauxAssistantMessage("(fix turn indevido)"),
			fauxAssistantMessage("(terminal indevido)"),
		]);

		await harness.session.prompt("crie out.txt");

		const v = harness.eventsOfType("verification");
		expect(v.some((e) => e.phase === "timeout")).toBe(true);
		expect(v.some((e) => e.phase === "failed")).toBe(false);
		// Nenhum prompt injetado após a resposta final.
		expect(getUserTexts(harness)).toEqual(["crie out.txt"]);
	}, 30_000);

	it("gate: check que estourou timeout não é re-executado nos turnos seguintes da sessão", async () => {
		const harness = await createHarness({
			settings: { verification: { command: NODE_SLOW_OK, maxAttempts: 1, timeoutMs: 700 } },
		});
		harnesses.push(harness);
		const fileA = join(harness.tempDir, "a.txt");
		const fileB = join(harness.tempDir, "b.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: fileA, content: "a" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Pronto (1)."),
			fauxAssistantMessage([fauxToolCall("write", { path: fileB, content: "b" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Pronto (2)."),
		]);

		await harness.session.prompt("crie a.txt");
		const runsAfterFirst = harness.eventsOfType("verification").filter((e) => e.phase === "running").length;
		expect(runsAfterFirst).toBe(1);

		const t0 = Date.now();
		await harness.session.prompt("crie b.txt");
		const runsAfterSecond = harness.eventsOfType("verification").filter((e) => e.phase === "running").length;

		// O segundo turno NÃO paga outra rodada fadada ao timeout.
		expect(runsAfterSecond).toBe(runsAfterFirst);
		expect(Date.now() - t0).toBeLessThan(650);
	}, 30_000);

	it("goal_complete: probe que estoura timeout não bloqueia a conclusão", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);
		setCurrentVerificationProbe(async () => ({
			ok: false,
			exitCode: 1,
			output: "(killed after timeout)",
			timedOut: true,
		}));

		const tool = createGoalCompleteToolDefinition(process.cwd());
		const r = (await tool.execute("c1", { summary: "done" }, undefined, undefined, undefined as never)) as {
			content: Array<{ type: string; text?: string }>;
			details?: { completed: boolean };
		};
		expect(r.details?.completed).toBe(true);
		expect(mgr.get()?.status).toBe("complete");
	});

	it("drain: check abandonado num turno anterior não ressurge no turno seguinte", async () => {
		const harness = await createHarness({
			settings: { pendingChecks: { enabled: true, maxWaitMs: 600, maxFixAttempts: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("Pronto — mas o check segue rodando."),
			fauxAssistantMessage("ok, vou aguardar o teste"),
			fauxAssistantMessage("resposta do segundo prompt"),
		]);

		// Job que nunca termina (simula um npm run check pesado).
		_registerBashBackgroundJobForTest(bgJob({ id: "bg-stale", command: "npm run check", exited: false }));

		await harness.session.prompt("primeiro pedido");
		const eventsAfterFirst = harness.eventsOfType("pending_check").length;
		const textsAfterFirst = getUserTexts(harness).length;
		expect(eventsAfterFirst).toBeGreaterThan(0); // o turno dono do job esperou por ele

		await harness.session.prompt("segundo pedido, sem relação");

		// O job velho (ainda rodando) NÃO pode gerar novas esperas nem novos
		// prompts injetados no segundo turno.
		expect(harness.eventsOfType("pending_check").length).toBe(eventsAfterFirst);
		expect(getUserTexts(harness).length).toBe(textsAfterFirst + 1);
	}, 30_000);

	it("re-drain: check backgroundado durante o gate é drenado no mesmo turno", async () => {
		const harness = await createHarness({
			settings: {
				verification: { command: NODE_MEDIUM_OK, maxAttempts: 1, timeoutMs: 10_000 },
				pendingChecks: { enabled: true, maxWaitMs: 5000, maxFixAttempts: 1 },
			},
		});
		harnesses.push(harness);
		const file = join(harness.tempDir, "out.txt");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: file, content: "hi" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Tudo pronto."),
		]);

		// Registra o job assim que o gate começa a rodar (após o primeiro drain),
		// simulando um check backgroundado num fix turn; ele termina verde quando
		// o drain pós-gate começa a esperar por ele. Tudo dirigido por eventos —
		// sem corridas de relógio.
		const job = bgJob({ id: "bg-mid-gate", command: "npm run check", exited: false });
		let registered = false;
		harness.session.subscribe((e: { type: string; phase?: string }) => {
			if (e.type === "verification" && e.phase === "running" && !registered) {
				registered = true;
				_registerBashBackgroundJobForTest(job);
			}
			if (e.type === "pending_check" && e.phase === "waiting" && !job.exited) {
				setTimeout(() => {
					job.exited = true;
					job.exitCode = 0;
				}, 200);
			}
		});

		await harness.session.prompt("crie out.txt");

		expect(registered).toBe(true);
		// O drain pós-gate viu o job e confirmou o resultado dentro do turno.
		const pc = harness.eventsOfType("pending_check");
		expect(pc.some((e) => e.phase === "passed")).toBe(true);
	}, 30_000);
});
