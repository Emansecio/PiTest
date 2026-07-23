/**
 * PlanManager — session-scoped STRUCTURED plan, a first-class upgrade over the
 * flat-string `todo` list (see todo/todo-manager.ts, which is explicitly an MVP
 * with "no dependency graph").
 *
 * A plan is a DAG of steps. Every `revise` produces a new immutable VERSION
 * (v1, v2, …) and keeps the full history, so the model can re-shape the plan
 * without losing the previous shape. Each step declares its dependencies
 * (`dependsOn`), the artifact it produces, and an optional verify command.
 *
 * Pure state machine — no UI/theme deps, so it stays usable from headless
 * modes. Mirrors the GoalManager/TodoManager pattern: the AgentSession owns
 * persistence/restore and the module-level "current session" registry below
 * lets the `plan` tool reach the active manager without per-call plumbing.
 *
 * Compaction survival: the active plan does NOT depend on history. Like the
 * todo list it is exposed through `systemPromptSection()` for per-turn
 * re-injection, and the `plan` tool's `show` op reconstructs the full DAG
 * verbatim on demand — so a compaction that drops the original `propose`
 * message never loses the plan.
 */

import { truncateWithEllipsis } from "../../utils/surrogate.ts";

const PLAN_STEP_STATUSES = ["pending", "active", "done", "blocked"] as const;
type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

export interface PlanStep {
	id: string;
	intent: string;
	dependsOn: string[];
	producesArtifact?: string;
	verifyCmd?: string;
	/**
	 * Set true by the (strong) planner when the step is routine, deterministic
	 * mechanical work — the model gearbox (P8b) may downshift to the `smol` role
	 * for a step that is `mechanical` AND carries a `verifyCmd`. The harness NEVER
	 * infers this; absence means "not mechanical".
	 */
	mechanical?: boolean;
	status: PlanStepStatus;
}

/** Shape the caller passes to propose/revise (status is optional; defaults to pending). */
export interface PlanStepInput {
	id: string;
	intent: string;
	dependsOn?: string[];
	producesArtifact?: string;
	verifyCmd?: string;
	mechanical?: boolean;
	status?: PlanStepStatus;
}

/** One immutable revision of the plan. */
export interface PlanVersion {
	version: number;
	steps: PlanStep[];
	/** Markdown context the executor needs (constraints, invariants, decisions). Optional; inherited by revise. */
	brief?: string;
}

export interface PlanState {
	versions: PlanVersion[];
	/**
	 * When true, per-turn `<plan>` injection is suppressed (all steps done).
	 * `plan show` / session entry / `.pit/plans/` artifacts still work for recall.
	 * Cleared by a fresh `propose` / `revise`.
	 */
	archived?: boolean;
}

const INTENT_MAX = 200;
const STEP_ID_MAX = 120;
const ARTIFACT_MAX = 200;
const VERIFY_MAX = 400;
/** Cap for the plan `brief` (markdown context). Larger than per-step fields on purpose. */
const BRIEF_MAX = 4000;
/** Truncation target for the brief inside the per-turn system prompt section (token economy). */
const BRIEF_PROMPT_MAX = 1500;
/** Hard cap for steps accepted into one active plan. */
const MAX_PLAN_STEPS = 64;
/** Maximum characters injected by an active plan on each model turn. */
const PLAN_PROMPT_MAX = 6000;

function clamp(s: string, max: number): string {
	return truncateWithEllipsis(s.trim(), max);
}

/**
 * Validate that `steps` form a legal DAG and normalize them into PlanSteps.
 *
 * Rejects (throwing PlanValidationError) on: empty plan, blank/duplicate ids,
 * a `dependsOn` pointing at a non-existent id, a self-edge, and any cycle.
 * Returns freshly-cloned, status-defaulted steps in the caller's order.
 */
export class PlanValidationError extends Error {}

function validateSteps(rawSteps: PlanStepInput[]): PlanStep[] {
	if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
		throw new PlanValidationError("A plan needs at least one step.");
	}
	if (rawSteps.length > MAX_PLAN_STEPS) {
		throw new PlanValidationError(`A plan supports at most ${MAX_PLAN_STEPS} steps.`);
	}

	const steps: PlanStep[] = [];
	const ids = new Set<string>();
	for (const raw of rawSteps) {
		const id = typeof raw.id === "string" ? raw.id.trim() : "";
		if (!id) throw new PlanValidationError("Every step needs a non-empty `id`.");
		if (id.length > STEP_ID_MAX) throw new PlanValidationError(`Step id exceeds ${STEP_ID_MAX} characters.`);
		if (ids.has(id)) throw new PlanValidationError(`Duplicate step id: ${id}.`);
		ids.add(id);
		const intent = typeof raw.intent === "string" ? raw.intent.trim() : "";
		if (!intent) throw new PlanValidationError(`Step ${id} needs a non-empty \`intent\`.`);

		const dependsOn = Array.isArray(raw.dependsOn) ? raw.dependsOn.map((d) => String(d).trim()).filter(Boolean) : [];
		const status: PlanStepStatus = PLAN_STEP_STATUSES.includes(raw.status as PlanStepStatus)
			? (raw.status as PlanStepStatus)
			: "pending";
		steps.push({
			id,
			intent: clamp(intent, INTENT_MAX),
			dependsOn,
			producesArtifact: raw.producesArtifact?.trim() ? clamp(raw.producesArtifact, ARTIFACT_MAX) : undefined,
			verifyCmd: raw.verifyCmd?.trim() ? clamp(raw.verifyCmd, VERIFY_MAX) : undefined,
			// Normalize to a strict `true | undefined` so the flag never persists as
			// `false`/other truthy junk and equality (sameStep) stays trivial.
			mechanical: raw.mechanical === true ? true : undefined,
			status,
		});
	}

	// Edge integrity: every dependency must reference a known id; no self-edges.
	for (const step of steps) {
		for (const dep of step.dependsOn) {
			if (!ids.has(dep)) {
				throw new PlanValidationError(`Step ${step.id} depends on unknown step id: ${dep}.`);
			}
			if (dep === step.id) {
				throw new PlanValidationError(`Step ${step.id} cannot depend on itself.`);
			}
		}
	}

	const cycle = findCycle(steps);
	if (cycle) {
		throw new PlanValidationError(`Dependency cycle detected: ${cycle.join(" → ")}.`);
	}

	return steps;
}

/**
 * Return one cycle as a node-id path (first→…→first) if the dependency graph
 * has any, else undefined. Iterative DFS with white/gray/black coloring so a
 * deep plan never blows the call stack.
 */
function findCycle(steps: PlanStep[]): string[] | undefined {
	const byId = new Map(steps.map((s) => [s.id, s]));
	const color = new Map<string, 0 | 1 | 2>(); // 0=white 1=gray 2=black
	for (const s of steps) color.set(s.id, 0);

	for (const start of steps) {
		if (color.get(start.id) !== 0) continue;
		const stack: Array<{ id: string; path: string[] }> = [{ id: start.id, path: [start.id] }];
		const open = new Set<string>();
		while (stack.length > 0) {
			const top = stack[stack.length - 1];
			if (color.get(top.id) === 0) {
				color.set(top.id, 1);
				open.add(top.id);
			}
			const node = byId.get(top.id);
			const next = node?.dependsOn.find((d) => color.get(d) !== 2 && !open.has(d));
			if (next) {
				color.set(next, 0);
				stack.push({ id: next, path: [...top.path, next] });
				continue;
			}
			// A dependency still open (gray, on the current path) closes a cycle.
			const back = node?.dependsOn.find((d) => open.has(d));
			if (back) {
				const idx = top.path.indexOf(back);
				return [...top.path.slice(idx), back];
			}
			color.set(top.id, 2);
			open.delete(top.id);
			stack.pop();
		}
	}
	return undefined;
}

/**
 * Topological order of a (validated, acyclic) step list. Kahn's algorithm,
 * preserving the caller's order among ready nodes so the rendered plan reads
 * deterministically. Always succeeds because validateSteps already rejected
 * cycles; defensively appends any stragglers.
 */
export function topoOrder(steps: PlanStep[]): PlanStep[] {
	const order: PlanStep[] = [];
	const placed = new Set<string>();
	// Repeatedly emit every step whose deps are all already placed.
	let progressed = true;
	while (progressed && order.length < steps.length) {
		progressed = false;
		for (const s of steps) {
			if (placed.has(s.id)) continue;
			if (s.dependsOn.every((d) => placed.has(d))) {
				order.push(s);
				placed.add(s.id);
				progressed = true;
			}
		}
	}
	for (const s of steps) {
		if (!placed.has(s.id)) order.push(s);
	}
	return order;
}

const STATUS_GLYPH: Record<PlanStepStatus, string> = {
	done: "✓",
	active: "◐",
	blocked: "✗",
	pending: "○",
};

export class PlanManager {
	private versions: PlanVersion[] = [];
	private dirty = false;
	/** True when all steps are done — suppresses per-turn `<plan>` injection. */
	private archived = false;

	/** Whether any plan has been proposed yet. */
	isEmpty(): boolean {
		return this.versions.length === 0;
	}

	/** Whether the plan is archived (complete; no prompt injection). */
	isArchived(): boolean {
		return this.archived;
	}

	/** Consume the dirty flag — true since the last call if the plan changed (for persistence). */
	takeDirty(): boolean {
		const d = this.dirty;
		this.dirty = false;
		return d;
	}

	/** The current (latest) version, or undefined if no plan exists. */
	current(): PlanVersion | undefined {
		const v = this.versions[this.versions.length - 1];
		return v ? cloneVersion(v) : undefined;
	}

	/** Current version number (0 when empty). */
	currentVersion(): number {
		return this.versions[this.versions.length - 1]?.version ?? 0;
	}

	/**
	 * Create v1. Throws PlanValidationError on an invalid DAG. Calling propose on
	 * an existing plan is treated as a fresh start (history cleared) — use
	 * `revise` to keep history. The optional `brief` carries markdown context the
	 * executor needs (constraints, invariants, key files read, decisions and why).
	 */
	propose(steps: PlanStepInput[], brief?: string): PlanVersion {
		const normalized = validateSteps(steps);
		const clampedBrief = brief?.trim() ? clamp(brief, BRIEF_MAX) : undefined;
		this.versions = [{ version: 1, steps: normalized, brief: clampedBrief }];
		this.archived = false;
		this.dirty = true;
		this.maybeArchiveIfComplete();
		return cloneVersion(this.versions[0]);
	}

	/**
	 * Append vN+1 with a new step set, preserving all prior versions. If no plan
	 * exists yet this behaves like `propose` (creates v1). Throws on an invalid
	 * DAG, leaving the previous version intact. When `brief` is omitted the
	 * previous version's brief is inherited so the model does not lose context by
	 * forgetting to re-pass it. Steps that keep the same `id` and were `done`
	 * inherit that status unless the caller passes an explicit `status`.
	 */
	revise(steps: PlanStepInput[], brief?: string): PlanVersion {
		const normalized = validateSteps(steps);
		const prev = this.versions[this.versions.length - 1];
		if (prev) {
			const prevById = new Map(prev.steps.map((s) => [s.id, s]));
			const explicitStatus = new Set(
				steps.filter((s) => s.status !== undefined).map((s) => (typeof s.id === "string" ? s.id.trim() : "")),
			);
			for (const step of normalized) {
				if (explicitStatus.has(step.id)) continue;
				if (prevById.get(step.id)?.status === "done") {
					step.status = "done";
				}
			}
		}
		const clampedBrief = brief?.trim() ? clamp(brief, BRIEF_MAX) : prev?.brief;
		const nextVersion = this.currentVersion() + 1;
		const version: PlanVersion = { version: nextVersion, steps: normalized, brief: clampedBrief };
		this.versions.push(version);
		this.archived = false;
		this.dirty = true;
		this.maybeArchiveIfComplete();
		return cloneVersion(version);
	}

	/**
	 * Mark a step done IN PLACE on the current version (no new version — status
	 * progress is not a re-plan). Returns the updated step or undefined if the id
	 * is unknown / no plan exists. Throws PlanValidationError when `dependsOn`
	 * are not all done.
	 */
	stepDone(id: string): PlanStep | undefined {
		const v = this.versions[this.versions.length - 1];
		if (!v) return undefined;
		const step = v.steps.find((s) => s.id === id);
		if (!step) return undefined;
		const statusById = new Map(v.steps.map((s) => [s.id, s.status]));
		const unmet = step.dependsOn.filter((d) => statusById.get(d) !== "done");
		if (unmet.length > 0) {
			throw new PlanValidationError(`Cannot mark step ${id} done: unmet dependsOn: ${unmet.join(", ")}.`);
		}
		step.status = "done";
		this.dirty = true;
		this.maybeArchiveIfComplete();
		return { ...step };
	}

	/** Archive when every step on the current version is done (total > 0). */
	private maybeArchiveIfComplete(): void {
		const { done, total } = this.counts();
		if (total > 0 && done === total) {
			this.archived = true;
		}
	}

	/**
	 * Steps the model may start right now: `pending` with every dependency `done`.
	 * Mirrors the `Ready now:` derivation in {@link systemPromptSection} but returns
	 * full (cloned) steps so callers like the model gearbox (P8b) can read
	 * `mechanical`/`verifyCmd`. Empty when no plan exists, it is archived, or every
	 * step is done/blocked. Declaration order is preserved.
	 */
	readySteps(): PlanStep[] {
		const v = this.versions[this.versions.length - 1];
		if (!v) return [];
		const statusById = new Map(v.steps.map((s) => [s.id, s.status]));
		return v.steps
			.filter((s) => s.status === "pending" && s.dependsOn.every((d) => statusById.get(d) === "done"))
			.map((s) => ({ ...s, dependsOn: [...s.dependsOn] }));
	}

	/** {done,total} for the current version. */
	counts(): { done: number; total: number } {
		const v = this.versions[this.versions.length - 1];
		if (!v) return { done: 0, total: 0 };
		return { done: v.steps.filter((s) => s.status === "done").length, total: v.steps.length };
	}

	/**
	 * Multi-line render of the current version in topological order, one line per
	 * step: `<glyph> id  intent [deps] →artifact ⟨verify⟩`. No raw giant lines —
	 * the caller (tool renderer) is responsible for width-fitting via the TUI
	 * helpers; this returns plain text consumed by getTextOutput.
	 */
	render(): string {
		const v = this.versions[this.versions.length - 1];
		if (!v) return "(no plan)";
		const { done, total } = this.counts();
		const lines = [`plan v${v.version} (${done}/${total} done)`];
		if (v.brief) {
			lines.push("brief:", v.brief);
		}
		const statusById = new Map(v.steps.map((s) => [s.id, s.status]));
		for (const step of topoOrder(v.steps)) {
			lines.push(renderStepLine(step, statusById));
		}
		return lines.join("\n");
	}

	/** Compact diff between the previous and current version, for the revise reply. */
	diffFromPrevious(): string {
		if (this.versions.length < 2) return "";
		const prev = this.versions[this.versions.length - 2];
		const cur = this.versions[this.versions.length - 1];
		return diffVersions(prev, cur);
	}

	serialize(): PlanState {
		return { versions: this.versions.map(cloneVersion), archived: this.archived || undefined };
	}

	restore(data: PlanState | undefined): void {
		if (!data || !Array.isArray(data.versions)) {
			this.versions = [];
			this.archived = false;
			return;
		}
		const restored: PlanVersion[] = [];
		for (const version of data.versions) {
			if (!version || !Array.isArray(version.steps)) continue;
			try {
				restored.push({
					version: typeof version.version === "number" ? version.version : 1,
					steps: validateSteps(version.steps),
					brief: typeof version.brief === "string" ? clamp(version.brief, BRIEF_MAX) : undefined,
				});
			} catch {
				// A corrupt persisted revision must not create an unbounded prompt.
			}
		}
		this.versions = restored;
		if (typeof data.archived === "boolean") {
			this.archived = data.archived;
		} else {
			this.archived = false;
			this.maybeArchiveIfComplete();
		}
	}

	/**
	 * Per-turn system-prompt injection. Empty when no plan OR when archived
	 * (all steps done) — stops paying tokens for a finished DAG. Use `plan show`
	 * / session entry / `.pit/plans/` for recall. Compaction survival still holds
	 * while the plan is active (mirrors TodoManager).
	 *
	 * When `permissionMode` is `"plan"`, wording is planning/read-only so it does
	 * not conflict with the `<plan_mode>` READ-ONLY section.
	 */
	systemPromptSection(opts?: { permissionMode?: "plan" | "auto" }): string {
		if (this.archived) return "";
		const v = this.versions[this.versions.length - 1];
		if (!v) return "";
		const { done, total } = this.counts();
		const planning = opts?.permissionMode === "plan";
		const lines = planning
			? [
					"<plan>",
					`You are refining a structured plan (v${v.version}, ${done}/${total} steps). The session is READ-ONLY — do not execute edits. Keep the DAG current with the \`plan\` tool:`,
					"- Use `plan revise` to re-shape the DAG as understanding improves; do not silently drift.",
					"- Honor `dependsOn` when ordering steps.",
					"- When ready, present for approval with `exit_plan`.",
				]
			: [
					"<plan>",
					`You are executing a structured plan (v${v.version}, ${done}/${total} steps done). Keep it current with the \`plan\` tool:`,
					"- Mark a step done with `plan step_done` the moment it is finished.",
					"- Use `plan revise` to re-shape the DAG (adds a new version, keeps history); do not silently drift.",
					"- Honor `dependsOn`: do not start a step before its dependencies are done.",
				];
		if (v.brief) {
			const truncated = truncateWithEllipsis(v.brief, BRIEF_PROMPT_MAX);
			lines.push("brief:", truncated);
			if (truncated.length < v.brief.length) {
				lines.push("(full brief: plan show)");
			}
		}
		lines.push("Current plan (topological order):");
		const statusById = new Map(v.steps.map((s) => [s.id, s.status]));
		let omittedSteps = 0;
		for (const step of topoOrder(v.steps)) {
			const line = renderStepLine(step, statusById);
			if (lines.join("\n").length + line.length + 1 > PLAN_PROMPT_MAX) {
				omittedSteps++;
				continue;
			}
			lines.push(line);
		}
		if (omittedSteps > 0) lines.push(`(${omittedSteps} steps omitted; use plan show)`);
		const readyNow = v.steps
			.filter((s) => s.status === "pending" && s.dependsOn.every((d) => statusById.get(d) === "done"))
			.map((s) => s.id);
		if (readyNow.length > 0) {
			const readyLine = `Ready now: ${readyNow.join(", ")}`;
			if (lines.join("\n").length + readyLine.length + "\n</plan>".length <= PLAN_PROMPT_MAX) {
				lines.push(readyLine);
			}
		}
		lines.push("</plan>");
		const section = lines.join("\n");
		return section.length <= PLAN_PROMPT_MAX
			? section
			: `${truncateWithEllipsis(section, PLAN_PROMPT_MAX - "\n</plan>".length)}\n</plan>`;
	}
}

function renderStepLine(step: PlanStep, statusById?: Map<string, PlanStepStatus>): string {
	const deps = step.dependsOn.length > 0 ? ` [needs ${step.dependsOn.join(",")}]` : "";
	const artifact = step.producesArtifact ? ` →${step.producesArtifact}` : "";
	const verify = step.verifyCmd ? ` ⟨${step.verifyCmd}⟩` : "";
	// Dense marker echoing the planner's `mechanical` flag back so the executor (and
	// a reviewer) can see which steps the gearbox is allowed to downshift.
	const mech = step.mechanical ? " ⚙" : "";
	const ready =
		statusById && step.status === "pending" && step.dependsOn.every((d) => statusById.get(d) === "done")
			? " ← ready"
			: "";
	return `  ${STATUS_GLYPH[step.status]} ${step.id}  ${step.intent}${deps}${artifact}${verify}${mech}${ready}`;
}

function cloneVersion(v: PlanVersion): PlanVersion {
	return {
		version: v.version,
		steps: v.steps.map((s) => ({ ...s, dependsOn: [...s.dependsOn] })),
		brief: v.brief,
	};
}

function diffVersions(prev: PlanVersion, cur: PlanVersion): string {
	const prevById = new Map(prev.steps.map((s) => [s.id, s]));
	const curById = new Map(cur.steps.map((s) => [s.id, s]));
	const lines: string[] = [];
	for (const s of cur.steps) {
		const before = prevById.get(s.id);
		if (!before) {
			lines.push(`+ ${s.id}  ${s.intent}`);
		} else if (!sameStep(before, s)) {
			lines.push(`~ ${s.id}  ${s.intent}`);
		}
	}
	for (const s of prev.steps) {
		if (!curById.has(s.id)) lines.push(`- ${s.id}  ${s.intent}`);
	}
	return lines.length > 0 ? lines.join("\n") : "(no structural change)";
}

function sameStep(a: PlanStep, b: PlanStep): boolean {
	return (
		a.intent === b.intent &&
		a.producesArtifact === b.producesArtifact &&
		a.verifyCmd === b.verifyCmd &&
		a.mechanical === b.mechanical &&
		a.dependsOn.length === b.dependsOn.length &&
		a.dependsOn.every((d, i) => d === b.dependsOn[i])
	);
}

// ---------------------------------------------------------------------------
// Module-level "current session" registry, mirroring todo-manager / goal-manager.
// The `plan` tool reaches the active manager through this without per-call plumbing.
// ---------------------------------------------------------------------------

let currentPlanManager: PlanManager | undefined;

export function setCurrentPlanManager(mgr: PlanManager | undefined): void {
	currentPlanManager = mgr;
}

export function getCurrentPlanManager(): PlanManager | undefined {
	return currentPlanManager;
}
