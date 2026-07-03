/**
 * Session Contract — Band P / Pillar P5 (conventions contract). See
 * docs/agents/conditioning-band-study.md §4-P5, §5, §8 decision 7.
 *
 * When the verification gate reprove for a STRUCTURED reason (a biome lint rule,
 * a recurring TypeScript error code), the violated *rule* is distilled into a
 * small, session-scoped list of active constraints and injected into the system
 * prompt's dynamic suffix (see system-prompt.ts). The effect: the model stops
 * repeating the same convention violation it was just corrected on — the
 * pre-generation complement of the learned-error store, which memorizes failed
 * *calls* rather than violated *conventions*.
 *
 * Design invariants (from the study):
 *  - Session-scoped ONLY. No persistence, no cross-session state (§8 decision 7:
 *    cross-session promotion is future work, guided by measurement).
 *  - Cap of {@link MAX_CONSTRAINTS} active constraints; when full, the weakest
 *    (fewest hits, then oldest) is evicted only if the newcomer is at least as
 *    established — so a first-seen one-off never displaces a repeatedly-fired
 *    convention ("prefer higher-hit constraints when full").
 *  - Universal + cheap: P5 is ON at every thermostat level (§5 dosing table), so
 *    this module does not read the supervision thermostat at all.
 *  - v1 extraction is pure parsing of known toolchain formats — NO LLM (§4-P5).
 *
 * Expiry design (the honest choice — reported in the handoff):
 *  1. PRIMARY (always active, needs no wiring): cap-based LRU with hit-preference.
 *     The list is bounded at 5 and self-cleans: a stale, low-hit constraint is
 *     evicted the moment a fresher/stronger one needs its slot. This is the only
 *     expiry mechanism that works today, because...
 *  2. DESIGNED (needs one line of integration): expiry after
 *     {@link EXPIRY_PASSES} = 3 CONSECUTIVE verification PASSES during which the
 *     constraint never re-fired — via {@link SessionContract.noteVerificationPass}.
 *     Three consecutive greens with no recurrence is strong evidence the model
 *     internalized the convention: one green can be a check that never exercised
 *     the rule, two can be coincidence, three consecutive is a reliable "learned"
 *     signal. It is deliberately smaller than SessionRecoveryController's 5-clean
 *     loosen constant because a full verification PASS is a much stronger signal
 *     than a single clean tool call. This mirrors the session-recovery clean-streak
 *     histeresis the study cites for P5's expiry.
 *
 *     Why it is not wired here: the ONLY place a verification PASS is observed is
 *     agent-session.ts (`result.ok` in the gate loop), which another agent owns
 *     right now. `runCheckCommand` in verification/verification.ts is a shared,
 *     pure runner also used by the goal_complete probe and by each fix-loop
 *     re-run, so noting a pass there would double-count and fire on non-gate
 *     probes. `noteVerificationPass()` is therefore exported ready-to-call: the
 *     integration is a single line on the green branch of the gate loop.
 *     TODO(band-p integration): call getCurrentSessionContract()?.noteVerificationPass()
 *     on the verification "passed" branch in agent-session.ts once that file is free.
 *
 * Kill-switch `PIT_NO_SESSION_CONTRACT=1` is fail-open (ingest no-ops, block empty).
 */

import { recordDiagnostic } from "@pit/ai";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import { truncateWithEllipsis } from "../utils/surrogate.ts";

/** Maximum number of active constraints held at once (§4-P5: "cap ~5 itens"). */
export const MAX_CONSTRAINTS = 5;

/** Consecutive verification PASSES without a re-fire before a constraint expires. */
export const EXPIRY_PASSES = 3;

/** Cap on an injected constraint's gist/message so one line stays one line. */
const MAX_TEXT_CHARS = 140;

/** The provenance of a constraint — the toolchain whose output produced it. */
export type ConstraintSource = "biome" | "typescript";

/** A parsed-but-not-yet-tracked constraint (output of the pure extractors). */
export interface ExtractedConstraint {
	/** Stable dedupe key (e.g. `biome:lint/style/noEnum`, `ts:TS2322`). */
	id: string;
	/** The imperative, English, one-line instruction injected into the prompt. */
	text: string;
	source: ConstraintSource;
}

/** A tracked, session-active constraint. */
export interface SessionConstraint extends ExtractedConstraint {
	/** How many times this rule has fired this session (repeat violations bump it). */
	hits: number;
	/** Monotonic session-scoped insertion counter — deterministic LRU tie-break. */
	addedAt: number;
	/** Consecutive verification PASSES since this constraint last fired (expiry). */
	passesSinceLastFire: number;
}

export function isSessionContractDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(env.PIT_NO_SESSION_CONTRACT);
}

// ---------------------------------------------------------------------------
// Pure extraction — v1 parsers over known toolchain output formats. No LLM, no
// I/O, no state: identical input → identical output. State that must persist
// across cycles (the TS recurrence counter) is threaded in/out, never hidden.
// ---------------------------------------------------------------------------

/** Matches a biome rule id anywhere on a line: `lint/<category>/<ruleName>`. */
const BIOME_RULE_RE = /lint\/[a-z][a-z0-9]*\/[A-Za-z][A-Za-z0-9]+/;
/** A biome diagnostic MESSAGE line: a marker glyph then human text (not a code frame). */
const BIOME_MSG_RE = /^\s*[×✖!⚠>]\s*(.+?)\s*$/;
/** A `tsc`/`tsgo` diagnostic: `... error TS####: <message>` (one per line). */
const TS_ERROR_RE = /error (TS\d+):[ \t]*([^\r\n]*)/g;
/** `erasableSyntaxOnly` violation — no enums / namespaces / parameter-properties. */
const ERASABLE_TS_CODE = "TS1294";

function leafOf(rule: string): string {
	const i = rule.lastIndexOf("/");
	return i < 0 ? rule : rule.slice(i + 1);
}

function trimText(msg: string): string {
	const one = msg.replace(/\s+/g, " ").trim();
	return one.length > MAX_TEXT_CHARS ? truncateWithEllipsis(one, MAX_TEXT_CHARS) : one;
}

/**
 * Parse biome lint violations into `{rule, gist}` pairs, deduped by rule (first
 * gist wins). Handles both the `path:line:col lint/style/noEnum …` header form
 * and the `rule-name (lint/style/noEnum)` inline form — both carry the same
 * `lint/…/…` token. The gist is the nearby human message line (`× Use === …`);
 * when none is found within a small window it falls back to the rule leaf name.
 */
export function parseBiomeRules(output: string): Array<{ rule: string; gist: string }> {
	const lines = output.split(/\r?\n/);
	const seen = new Map<string, string>();
	for (let i = 0; i < lines.length; i++) {
		const m = BIOME_RULE_RE.exec(lines[i]!);
		if (!m) continue;
		const rule = m[0];
		if (seen.has(rule)) continue;
		let gist = leafOf(rule);
		for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
			const line = lines[j]!;
			if (line.includes("│")) continue; // code frame, not a message
			const mm = BIOME_MSG_RE.exec(line);
			if (mm) {
				gist = trimText(mm[1]!);
				break;
			}
		}
		seen.set(rule, gist);
	}
	return [...seen].map(([rule, gist]) => ({ rule, gist }));
}

/** Parse every `error TS####: <message>` occurrence (order preserved, with repeats). */
export function parseTypeScriptErrors(output: string): Array<{ code: string; message: string }> {
	const out: Array<{ code: string; message: string }> = [];
	for (const m of output.matchAll(TS_ERROR_RE)) {
		out.push({ code: m[1]!, message: m[2] ?? "" });
	}
	return out;
}

/** The fixed constraint for an `erasableSyntaxOnly` (TS1294) project rule. */
export function erasableConstraint(): ExtractedConstraint {
	return {
		id: "ts:erasable-syntax",
		text: "Do not use enums, namespaces, or parameter properties — this project enforces erasableSyntaxOnly (TS1294).",
		source: "typescript",
	};
}

/**
 * Extract constraints from ONE failed check's output. Pure: the cross-cycle TS
 * recurrence counter is passed in (`priorTsCounts`) and a fresh merged map is
 * returned — the manager owns the running instance.
 *
 * Rules (§4-P5):
 *  - biome: every distinct lint rule → a constraint (the rule id is high-signal
 *    on its own; biome output is always structured).
 *  - TypeScript: a code becomes a constraint only when it RECURS — the same code
 *    ≥2 times in THIS output OR ≥2 times cumulatively across cycles — to avoid
 *    pinning one-off type errors as session conventions.
 *  - TS1294 is a special case: emitted on FIRST sight (it names a project-wide
 *    syntax ban, not a one-off), as the fixed erasable-syntax constraint; the
 *    generic `ts:TS1294` constraint is intentionally NOT also emitted.
 */
export function extractConstraints(
	output: string,
	priorTsCounts?: ReadonlyMap<string, number>,
): { constraints: ExtractedConstraint[]; tsCounts: Map<string, number> } {
	const constraints: ExtractedConstraint[] = [];

	for (const { rule, gist } of parseBiomeRules(output)) {
		constraints.push({ id: `biome:${rule}`, text: `biome: ${rule} — ${gist}`, source: "biome" });
	}

	const tsCounts = new Map(priorTsCounts ?? []);
	const errors = parseTypeScriptErrors(output);
	const inThisOutput = new Map<string, number>();
	for (const { code } of errors) inThisOutput.set(code, (inThisOutput.get(code) ?? 0) + 1);
	for (const [code, n] of inThisOutput) tsCounts.set(code, (tsCounts.get(code) ?? 0) + n);

	let erasableEmitted = false;
	const emitted = new Set<string>();
	for (const { code, message } of errors) {
		if (code === ERASABLE_TS_CODE) {
			if (!erasableEmitted) {
				constraints.push(erasableConstraint());
				erasableEmitted = true;
			}
			continue;
		}
		if (emitted.has(code)) continue;
		const recurringInOutput = (inThisOutput.get(code) ?? 0) >= 2;
		const recurringAcrossCycles = (tsCounts.get(code) ?? 0) >= 2;
		if (!recurringInOutput && !recurringAcrossCycles) continue;
		emitted.add(code);
		constraints.push({ id: `ts:${code}`, text: `${code}: ${trimText(message)}`, source: "typescript" });
	}

	return { constraints, tsCounts };
}

// ---------------------------------------------------------------------------
// Prompt rendering — pure, so the dynamic-suffix block can be unit-tested apart
// from the manager. Mirrors formatHotFileOutlines in system-prompt.ts.
// ---------------------------------------------------------------------------

/**
 * Render the `<session_contract>` dynamic-suffix block, highest-hit constraint
 * first (salience), tie-broken by insertion order. Returns "" when there is
 * nothing to inject — the caller then emits no block at all.
 */
export function formatSessionContractBlock(constraints: readonly SessionConstraint[]): string {
	if (constraints.length === 0) return "";
	const ordered = [...constraints].sort((a, b) => b.hits - a.hits || a.addedAt - b.addedAt);
	const body = ordered.map((c) => `  - ${c.text}`).join("\n");
	return `<session_contract>\n  (project conventions you already violated this session — do NOT repeat them)\n${body}\n</session_contract>`;
}

/** Cheap 32-bit FNV-1a hash — dedupes re-ingest of an identical check output. */
function hash32(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

// ---------------------------------------------------------------------------
// The manager: holds the active constraints, the cross-cycle TS counter, and the
// insertion sequence. All session-scoped; nothing survives the instance.
// ---------------------------------------------------------------------------

export class SessionContract {
	private constraints: SessionConstraint[] = [];
	private tsCodeCounts = new Map<string, number>();
	private seq = 0;
	private lastIngestHash: number | undefined;

	/**
	 * Parse a failed check's output and fold any structured rule violations into
	 * the active constraint list. Called from summarizeCheckFailure — the single
	 * choke-point every check failure flows through. Fail-open + idempotent on an
	 * identical output (the gate re-summarizes the same result on the exhausted
	 * path, and the fix loop re-runs the check each attempt).
	 */
	ingestCheckFailure(output: string): void {
		if (isSessionContractDisabled()) return;
		if (typeof output !== "string" || output.length === 0) return;
		const h = hash32(output);
		if (h === this.lastIngestHash) return;
		this.lastIngestHash = h;
		const { constraints, tsCounts } = extractConstraints(output, this.tsCodeCounts);
		this.tsCodeCounts = tsCounts;
		for (const ec of constraints) this.add(ec);
	}

	/**
	 * Add or refresh one constraint. Dedupe by id: a repeat violation bumps `hits`
	 * and resets the pass-expiry counter (the model just re-broke it). A genuinely
	 * new constraint takes a free slot; when full it evicts the weakest incumbent
	 * (fewest hits, then oldest) only if the newcomer is at least as established —
	 * so recurring conventions are never displaced by a first-seen one-off.
	 */
	add(ec: ExtractedConstraint): void {
		const existing = this.constraints.find((c) => c.id === ec.id);
		if (existing) {
			existing.hits += 1;
			existing.passesSinceLastFire = 0;
			existing.text = ec.text; // refresh to the latest gist/message
			this.emit(existing.id, `refreshed hits=${existing.hits}`);
			return;
		}
		const fresh: SessionConstraint = {
			...ec,
			hits: 1,
			addedAt: this.seq++,
			passesSinceLastFire: 0,
		};
		if (this.constraints.length < MAX_CONSTRAINTS) {
			this.constraints.push(fresh);
			this.emit(fresh.id, "added");
			return;
		}
		let victimIdx = 0;
		for (let i = 1; i < this.constraints.length; i++) {
			const v = this.constraints[victimIdx]!;
			const c = this.constraints[i]!;
			if (c.hits < v.hits || (c.hits === v.hits && c.addedAt < v.addedAt)) victimIdx = i;
		}
		const victim = this.constraints[victimIdx]!;
		if (victim.hits <= fresh.hits) {
			this.constraints[victimIdx] = fresh;
			this.emit(fresh.id, "added");
		}
		// else: every incumbent is more established — drop the newcomer.
	}

	/**
	 * Record ONE clean verification PASS. Ages every constraint by one pass and
	 * expires those that have now gone {@link EXPIRY_PASSES} consecutive passes
	 * without re-firing. See the module header for why this is exported rather
	 * than wired here.
	 */
	noteVerificationPass(): void {
		if (this.constraints.length === 0) return;
		for (const c of this.constraints) c.passesSinceLastFire += 1;
		this.constraints = this.constraints.filter((c) => c.passesSinceLastFire < EXPIRY_PASSES);
	}

	/** The active constraints (defensive copy). */
	list(): SessionConstraint[] {
		return this.constraints.map((c) => ({ ...c }));
	}

	size(): number {
		return this.constraints.length;
	}

	/** Render the `<session_contract>` dynamic-suffix block, or "" when empty/off. */
	renderPromptBlock(): string {
		if (isSessionContractDisabled()) return "";
		return formatSessionContractBlock(this.constraints);
	}

	private emit(ruleId: string, note: string): void {
		recordDiagnostic({
			category: "quality.contract",
			level: "info",
			source: "session-contract",
			context: { ruleId, note },
		});
	}
}

// ---------------------------------------------------------------------------
// Module-level "current session" registry, mirroring plan-manager, verification
// (setCurrentVerificationProbe, verification/verification.ts) and the supervision
// thermostat. The injection site (system-prompt.ts) reaches the active contract
// through this without threading it through the session — the established pattern.
// ---------------------------------------------------------------------------

let currentSessionContract: SessionContract | undefined;

export function setCurrentSessionContract(contract: SessionContract | undefined): void {
	currentSessionContract = contract;
}

export function getCurrentSessionContract(): SessionContract | undefined {
	return currentSessionContract;
}
