import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type CheckResult,
	detectLocalTypecheckCommand,
	detectSyntaxFallbackCommand,
	runCheckCommand,
} from "./verification.ts";

export type GoalGateSource = "configured" | "aggregator" | "script" | "typescript" | "syntax";

export interface GoalGateCommand {
	id: string;
	label: string;
	command: string;
	source: GoalGateSource;
	/** Source configuration that produced the command when the command alone is not the full definition. */
	definition?: string;
}

export type GoalGateStatus = "passed" | "failed" | "cancelled" | "inapplicable";

export interface GoalGateResult {
	gate: GoalGateCommand;
	index: number;
	total: number;
	status: GoalGateStatus;
	durationMs: number;
	exitCode?: number;
	timedOut?: boolean;
	output: string;
	fingerprint: string;
}

export interface GoalGateRunResult {
	status: GoalGateStatus;
	results: GoalGateResult[];
	passedGateIds: string[];
	reason?: string;
}

function packageManager(cwd: string): string {
	if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
	if (existsSync(join(cwd, "bun.lock")) || existsSync(join(cwd, "bun.lockb"))) return "bun";
	return "npm";
}

function scriptsAt(cwd: string): Record<string, unknown> {
	try {
		const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
		return pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
	} catch {
		return {};
	}
}

function scriptGate(cwd: string, name: string, definition: string, source: GoalGateSource = "script"): GoalGateCommand {
	return { id: `script:${name}`, label: name, command: `${packageManager(cwd)} run ${name}`, source, definition };
}

function normalizedCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ").toLowerCase();
}

export function goalGateFingerprint(gate: GoalGateCommand): string {
	return createHash("sha256")
		.update(JSON.stringify([gate.id, gate.label, gate.source, gate.command, gate.definition ?? null]))
		.digest("hex");
}

export function detectGoalGateCommands(
	cwd: string,
	configuredCommand?: string,
	changedPaths: readonly string[] = [],
): GoalGateCommand[] {
	const explicit = configuredCommand?.trim();
	if (explicit)
		return [{ id: "configured", label: "configured verification", command: explicit, source: "configured" }];
	const scripts = scriptsAt(cwd);
	const scriptsDefinition = JSON.stringify(scripts);
	const hasScript = (name: string): boolean =>
		typeof scripts[name] === "string" && String(scripts[name]).trim().length > 0;
	if (hasScript("check")) return [scriptGate(cwd, "check", scriptsDefinition, "aggregator")];

	const gates: GoalGateCommand[] = [];
	const typecheck = hasScript("typecheck") ? "typecheck" : hasScript("type-check") ? "type-check" : undefined;
	if (typecheck) gates.push(scriptGate(cwd, typecheck, scriptsDefinition));
	if (hasScript("lint")) gates.push(scriptGate(cwd, "lint", scriptsDefinition));
	if (hasScript("test")) gates.push(scriptGate(cwd, "test", scriptsDefinition));
	if (gates.length > 0) return gates;

	const localTypecheck = detectLocalTypecheckCommand(cwd);
	if (localTypecheck)
		return [{ id: "typescript:typecheck", label: "local TypeScript", command: localTypecheck, source: "typescript" }];
	const syntax = detectSyntaxFallbackCommand(cwd, changedPaths);
	if (syntax) return [{ id: "syntax:changed-files", label: "changed-file syntax", command: syntax, source: "syntax" }];
	return [];
}

function shortFingerprint(gate: GoalGateCommand, result: CheckResult): string {
	const output = result.output
		.replace(/\b\d{4}-\d\d-\d\d[T ][^\s]+/g, "<timestamp>")
		.replace(/\s+/g, " ")
		.trim();
	return `${gate.id}|${normalizedCommand(gate.command)}|${result.exitCode}|${result.timedOut ? "timeout" : "ok"}|${output.slice(-1000)}`;
}

export async function runGoalGates(
	gates: readonly GoalGateCommand[],
	cwd: string,
	opts: { passedGateIds?: readonly string[]; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<GoalGateRunResult> {
	if (gates.length === 0)
		return { status: "inapplicable", results: [], passedGateIds: [], reason: "no applicable local toolchain" };
	const passed = new Set(opts.passedGateIds ?? []);
	const results: GoalGateResult[] = [];
	const passedGateIds = [...passed];
	for (let i = 0; i < gates.length; i += 1) {
		const gate = gates[i];
		if (!gate) continue;
		if (passed.has(gate.id)) continue;
		if (opts.signal?.aborted) return { status: "cancelled", results, passedGateIds };
		const started = Date.now();
		const result = await runCheckCommand(gate.command, cwd, { signal: opts.signal, timeoutMs: opts.timeoutMs });
		const status: GoalGateStatus = opts.signal?.aborted ? "cancelled" : result.ok ? "passed" : "failed";
		const item: GoalGateResult = {
			gate,
			index: i + 1,
			total: gates.length,
			status,
			durationMs: Date.now() - started,
			exitCode: result.exitCode,
			timedOut: result.timedOut,
			output: result.output,
			fingerprint: shortFingerprint(gate, result),
		};
		results.push(item);
		if (status === "cancelled") return { status, results, passedGateIds };
		if (status === "failed") return { status, results, passedGateIds };
		passed.add(gate.id);
		passedGateIds.push(gate.id);
	}
	return { status: "passed", results, passedGateIds };
}
