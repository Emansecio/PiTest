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

export const PLAN_STEP_STATUSES = ["pending", "active", "done", "blocked"] as const;
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number];

export interface PlanStep {
	id: string;
	intent: string;
	dependsOn: string[];
	producesArtifact?: string;
	verifyCmd?: string;
	status: PlanStepStatus;
}

/** Shape the caller passes to propose/revise (status is optional; defaults to pending). */
export interface PlanStepInput {
	id: string;
	intent: string;
	dependsOn?: string[];
	producesArtifact?: string;
	verifyCmd?: string;
	status?: PlanStepStatus;
}

/** One immutable revision of the plan. */
export interface PlanVersion {
	version: number;
	steps: PlanStep[];
}

export interface PlanState {
	versions: PlanVersion[];
}

const INTENT_MAX = 200;
const ARTIFACT_MAX = 200;
const VERIFY_MAX = 400;

function clamp(s: string, max: number): string {
	const t = s.trim();
	return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
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

	const steps: PlanStep[] = [];
	const ids = new Set<string>();
	for (const raw of rawSteps) {
		const id = typeof raw.id === "string" ? raw.id.trim() : "";
		if (!id) throw new PlanValidationError("Every step needs a non-empty `id`.");
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
	const indegree = new Map<string, number>();
	for (const s of steps) indegree.set(s.id, 0);
	for (const s of steps) {
		for (const _dep of s.dependsOn) indegree.set(s.id, (indegree.get(s.id) ?? 0) + 1);
	}
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

	/** Whether any plan has been proposed yet. */
	isEmpty(): boolean {
		return this.versions.length === 0;
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
	 * `revise` to keep history.
	 */
	propose(steps: PlanStepInput[]): PlanVersion {
		const normalized = validateSteps(steps);
		this.versions = [{ version: 1, steps: normalized }];
		this.dirty = true;
		return cloneVersion(this.versions[0]);
	}

	/**
	 * Append vN+1 with a new step set, preserving all prior versions. If no plan
	 * exists yet this behaves like `propose` (creates v1). Throws on an invalid
	 * DAG, leaving the previous version intact.
	 */
	revise(steps: PlanStepInput[]): PlanVersion {
		const normalized = validateSteps(steps);
		const nextVersion = this.currentVersion() + 1;
		const version: PlanVersion = { version: nextVersion, steps: normalized };
		this.versions.push(version);
		this.dirty = true;
		return cloneVersion(version);
	}

	/**
	 * Mark a step done IN PLACE on the current version (no new version — status
	 * progress is not a re-plan). Returns the updated step or undefined if the id
	 * is unknown / no plan exists.
	 */
	stepDone(id: string): PlanStep | undefined {
		const v = this.versions[this.versions.length - 1];
		if (!v) return undefined;
		const step = v.steps.find((s) => s.id === id);
		if (!step) return undefined;
		step.status = "done";
		this.dirty = true;
		return { ...step };
	}

	/** Set an arbitrary status on a current-version step (used for active/blocked). */
	setStepStatus(id: string, status: PlanStepStatus): PlanStep | undefined {
		const v = this.versions[this.versions.length - 1];
		if (!v) return undefined;
		const step = v.steps.find((s) => s.id === id);
		if (!step) return undefined;
		step.status = status;
		this.dirty = true;
		return { ...step };
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
		for (const step of topoOrder(v.steps)) {
			lines.push(renderStepLine(step));
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
		return { versions: this.versions.map(cloneVersion) };
	}

	restore(data: PlanState | undefined): void {
		if (!data || !Array.isArray(data.versions)) {
			this.versions = [];
			return;
		}
		this.versions = data.versions
			.filter((v) => v && Array.isArray(v.steps))
			.map((v) => ({
				version: typeof v.version === "number" ? v.version : 1,
				steps: v.steps.map((s) => ({
					id: String(s.id),
					intent: String(s.intent),
					dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
					producesArtifact: s.producesArtifact ? String(s.producesArtifact) : undefined,
					verifyCmd: s.verifyCmd ? String(s.verifyCmd) : undefined,
					status: PLAN_STEP_STATUSES.includes(s.status) ? s.status : "pending",
				})),
			}));
	}

	/**
	 * Section injected into the system prompt while a plan exists, so the active
	 * DAG survives history compaction verbatim (mirrors TodoManager). Empty when
	 * no plan has been proposed.
	 */
	systemPromptSection(): string {
		const v = this.versions[this.versions.length - 1];
		if (!v) return "";
		const { done, total } = this.counts();
		const lines = [
			"<plan>",
			`You are executing a structured plan (v${v.version}, ${done}/${total} steps done). Keep it current with the \`plan\` tool:`,
			"- Mark a step done with `plan step_done` the moment it is finished.",
			"- Use `plan revise` to re-shape the DAG (adds a new version, keeps history); do not silently drift.",
			"- Honor `dependsOn`: do not start a step before its dependencies are done.",
			"Current plan (topological order):",
		];
		for (const step of topoOrder(v.steps)) lines.push(renderStepLine(step));
		lines.push("</plan>");
		return lines.join("\n");
	}
}

function renderStepLine(step: PlanStep): string {
	const deps = step.dependsOn.length > 0 ? ` [needs ${step.dependsOn.join(",")}]` : "";
	const artifact = step.producesArtifact ? ` →${step.producesArtifact}` : "";
	const verify = step.verifyCmd ? ` ⟨${step.verifyCmd}⟩` : "";
	return `  ${STATUS_GLYPH[step.status]} ${step.id}  ${step.intent}${deps}${artifact}${verify}`;
}

function cloneVersion(v: PlanVersion): PlanVersion {
	return { version: v.version, steps: v.steps.map((s) => ({ ...s, dependsOn: [...s.dependsOn] })) };
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
