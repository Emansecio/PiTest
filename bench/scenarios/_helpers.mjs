/**
 * Helpers compartilhados pelos oráculos. O oráculo roda com cwd = sandbox do
 * agente e env BENCH_SANDBOX / BENCH_PRISTINE. Exit 0 = passou.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SANDBOX = process.env.BENCH_SANDBOX || process.cwd();
export const PRISTINE = process.env.BENCH_PRISTINE || "";

export function sandboxPath(rel) {
	return join(SANDBOX, rel);
}

export function readSandbox(rel) {
	return readFileSync(join(SANDBOX, rel), "utf8");
}

export function readPristine(rel) {
	return readFileSync(join(PRISTINE, rel), "utf8");
}

/** Dynamic-imports a module from the agent's sandbox (cache-busted). */
export async function importSandbox(rel) {
	const url = `${pathToFileURL(join(SANDBOX, rel)).href}?t=${Date.now()}-${Math.random()}`;
	return import(url);
}

/** Runs `node <rel>` inside the sandbox; returns {code,out}. */
export function runNode(rel, args = []) {
	const r = spawnSync(process.execPath, [join(SANDBOX, rel), ...args], {
		cwd: SANDBOX,
		encoding: "utf8",
		timeout: 60000,
	});
	return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

/** True if `rel` is byte-identical to the pristine seed copy. */
export function unchanged(rel) {
	try {
		return readFileSync(join(SANDBOX, rel), "utf8") === readFileSync(join(PRISTINE, rel), "utf8");
	} catch {
		return false;
	}
}

export function pass(msg) {
	console.log(`PASS: ${msg}`);
	process.exit(0);
}

export function fail(msg) {
	console.log(`FAIL: ${msg}`);
	process.exit(1);
}

/** assert that throws into fail() */
export function check(cond, msg) {
	if (!cond) fail(msg);
}
