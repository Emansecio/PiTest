/**
 * bench/analyze-ttfe — decompõe o "tempo-até-código" (firstEditMs) a partir dos
 * streams preservados de uma rodada: o que cada agente FAZ antes do 1º edit
 * (quantos reads/searches/shells, quantos turnos/round-trips ao modelo), e
 * quanto tempo por round-trip. Sinal direto de exploração redundante.
 *
 * Uso: npx tsx bench/analyze-ttfe.mts <outDir-da-rodada>
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { categorize } from "./lib.mts";

type Cat = "read" | "edit" | "write" | "shell" | "search" | "list" | "other";

interface Step {
	cat: Cat;
	name: string;
}

/** Ordered tool calls + assistant-turn count, split at the FIRST edit/write. */
interface Decomp {
	beforeEdit: Step[];
	turnsBeforeEdit: number;
	totalTurns: number;
	foundEdit: boolean;
}

function isEditCat(c: Cat): boolean {
	return c === "edit" || c === "write";
}

/** Pit stream: tool_execution_start.toolName (ordered), turn_start = a turn. */
function decompPit(jsonl: string): Decomp {
	const steps: Step[] = [];
	let turns = 0;
	let turnsBeforeEdit = -1;
	let foundEdit = false;
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let ev: any;
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		if (ev.type === "turn_start") turns++;
		else if (ev.type === "tool_execution_start") {
			const name = String(ev.toolName ?? "?");
			const cat = categorize(name) as Cat;
			if (isEditCat(cat) && !foundEdit) {
				foundEdit = true;
				turnsBeforeEdit = turns;
			}
			if (!foundEdit) steps.push({ cat, name });
		}
	}
	return { beforeEdit: steps, turnsBeforeEdit: turnsBeforeEdit < 0 ? turns : turnsBeforeEdit, totalTurns: turns, foundEdit };
}

/** CC stream: each `assistant` event is a turn; tool_use blocks (ordered). */
function decompCC(jsonl: string): Decomp {
	const steps: Step[] = [];
	let turns = 0;
	let turnsBeforeEdit = -1;
	let foundEdit = false;
	for (const line of jsonl.split("\n")) {
		if (!line.trim()) continue;
		let ev: any;
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
			turns++;
			for (const c of ev.message.content) {
				if (c?.type !== "tool_use") continue;
				const name = String(c.name ?? "?");
				const cat = categorize(name) as Cat;
				if (isEditCat(cat) && !foundEdit) {
					foundEdit = true;
					turnsBeforeEdit = turns;
				}
				if (!foundEdit) steps.push({ cat, name });
			}
		}
	}
	return { beforeEdit: steps, turnsBeforeEdit: turnsBeforeEdit < 0 ? turns : turnsBeforeEdit, totalTurns: turns, foundEdit };
}

function tally(steps: Step[]): Record<Cat, number> {
	const t: Record<Cat, number> = { read: 0, edit: 0, write: 0, shell: 0, search: 0, list: 0, other: 0 };
	for (const s of steps) t[s.cat]++;
	return t;
}

function loadFirstEditMs(outDir: string, id: string, agent: string): number | null {
	const p = join(outDir, id, "result.json");
	if (!existsSync(p)) return null;
	const j = JSON.parse(readFileSync(p, "utf8"));
	const r = (j.runs ?? []).find((x: any) => x.agent === agent);
	return typeof r?.firstEditMs === "number" ? r.firstEditMs : null;
}

function main(): void {
	const outDir = process.argv[2];
	if (!outDir || !existsSync(outDir)) {
		console.error("uso: npx tsx bench/analyze-ttfe.mts <outDir-da-rodada>");
		process.exit(2);
	}
	const ids = readdirSync(outDir, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(join(outDir, d.name, "pit.jsonl")))
		.map((d) => d.name)
		.sort();

	const rows: string[] = [];
	rows.push("| cenário | agente | reads | search | shell | tools antes | turnos antes | 1º-edit (s) | s/round-trip |");
	rows.push("|-|-|-|-|-|-|-|-|-|");

	const agg = { pit: { reads: 0, search: 0, shell: 0, tools: 0, turns: 0, edit: 0, perRT: [] as number[] }, cc: { reads: 0, search: 0, shell: 0, tools: 0, turns: 0, edit: 0, perRT: [] as number[] } };

	for (const id of ids) {
		for (const agent of ["pit", "cc"] as const) {
			const f = join(outDir, id, `${agent}.jsonl`);
			if (!existsSync(f)) continue;
			const jsonl = readFileSync(f, "utf8");
			const d = agent === "pit" ? decompPit(jsonl) : decompCC(jsonl);
			const t = tally(d.beforeEdit);
			const ms = loadFirstEditMs(outDir, id, agent);
			const editS = ms === null ? Number.NaN : ms / 1000;
			const perRT = d.turnsBeforeEdit > 0 && Number.isFinite(editS) ? editS / d.turnsBeforeEdit : Number.NaN;
			rows.push(
				`| ${id} | ${agent} | ${t.read} | ${t.search} | ${t.shell} | ${d.beforeEdit.length} | ${d.turnsBeforeEdit} | ${Number.isFinite(editS) ? editS.toFixed(1) : "n/d"} | ${Number.isFinite(perRT) ? perRT.toFixed(1) : "n/d"} |`,
			);
			const a = agg[agent];
			a.reads += t.read;
			a.search += t.search;
			a.shell += t.shell;
			a.tools += d.beforeEdit.length;
			a.turns += d.turnsBeforeEdit;
			if (Number.isFinite(editS)) a.edit += editS;
			if (Number.isFinite(perRT)) a.perRT.push(perRT);
		}
	}

	const n = ids.length;
	const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
	console.log(`# Análise tempo-até-código — ${n} cenários\n`);
	console.log(rows.join("\n"));
	console.log("\n## Médias por agente (antes do 1º edit)\n");
	console.log("| agente | reads | search | shell | tools | turnos | 1º-edit (s) | s/round-trip |");
	console.log("|-|-|-|-|-|-|-|-|");
	for (const agent of ["pit", "cc"] as const) {
		const a = agg[agent];
		console.log(
			`| ${agent} | ${(a.reads / n).toFixed(1)} | ${(a.search / n).toFixed(1)} | ${(a.shell / n).toFixed(1)} | ${(a.tools / n).toFixed(1)} | ${(a.turns / n).toFixed(1)} | ${(a.edit / n).toFixed(1)} | ${mean(a.perRT).toFixed(1)} |`,
		);
	}
}

main();
