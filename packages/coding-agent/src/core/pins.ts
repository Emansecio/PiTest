/**
 * PinManager — session-scoped "context immune to forgetting" (proposal P5).
 *
 * Two pin kinds with distinct mechanics:
 *
 * - **fact** — a short piece of text the user (or model) marks as load-bearing.
 *   Its survival is GUARANTEED: it is re-emitted every turn through
 *   {@link PinManager.systemPromptSection} alongside goal/todo/plan, so it never
 *   depends on the message window and outlives any compaction.
 * - **file** — a repo path whose read/edit/write/grep/find tool-results are made
 *   immune to live-prune / supersede / mutation-arg elision. The immunity is
 *   applied in the compaction prune pipeline (see `pinnedCanonicalPaths` and the
 *   `pinnedIndices` derivation in compaction.ts). File pins protect the window
 *   evidence, NOT against a full compaction — that is what the fact pins and the
 *   {@link PinManager.summaryFooter} carry across.
 *
 * Pure state machine — no UI/theme deps, so it stays usable from headless modes.
 * The AgentSession owns persistence/restore and the module-level "current
 * session" registry below lets the `pin` tool reach the active manager without
 * per-call plumbing. Mirrors the GoalManager/TodoManager/PlanManager pattern.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { truncateWithEllipsis } from "../utils/surrogate.ts";
import { canonicalPathKey } from "./tools/path-utils.ts";

export type PinKind = "fact" | "file";

export interface PinItem {
	/** Short, stable id ("p1", "p2", …) — a monotonic counter, never reused. */
	id: string;
	kind: PinKind;
	/** kind "fact": the fact text (capped, truncated on create). */
	text?: string;
	/** kind "file": canonicalPathKey of the absolute path — the prune-pipeline key. */
	canonicalPath?: string;
	/** kind "file": repo-relative path for display. */
	displayPath?: string;
	createdBy: "user" | "model";
}

export interface PinStateSnapshot {
	items: PinItem[];
	nextId: number;
}

/** Max pins (facts + files) held at once. Keeps the per-turn cost bounded/visible. */
export const PIN_CAP = 16;
/** Max chars of a fact pin — truncated on create. */
export const PIN_FACT_MAX = 300;

function relativeDisplayPath(absPath: string, cwd: string): string {
	const rel = relative(resolve(cwd), resolve(absPath)).split("\\").join("/");
	// Outside the cwd (leading "..") or empty (path === cwd): fall back to the
	// absolute path so the display never lies about where the file is.
	if (rel === "" || rel.startsWith("../")) return absPath.split("\\").join("/");
	return rel;
}

export class PinManager {
	private items: PinItem[] = [];
	private nextId = 1;
	private dirty = false;
	private changeListener?: () => void;

	/** Returns whether state changed since the last call, then resets the flag. */
	takeDirty(): boolean {
		const was = this.dirty;
		this.dirty = false;
		return was;
	}

	/**
	 * Register a single listener fired synchronously after every mutation. The
	 * AgentSession wires this to persistence (and forwards to a UI repaint hook);
	 * pass `undefined` to clear.
	 */
	setChangeListener(listener: (() => void) | undefined): void {
		this.changeListener = listener;
	}

	private markChanged(): void {
		this.dirty = true;
		this.changeListener?.();
	}

	list(): readonly PinItem[] {
		return this.items.map((p) => ({ ...p }));
	}

	isEmpty(): boolean {
		return this.items.length === 0;
	}

	private assertCapacity(): void {
		if (this.items.length >= PIN_CAP) {
			throw new Error(`Pin limit reached (${PIN_CAP}). Unpin something first before adding another.`);
		}
	}

	/** Pin a short fact. Throws a legible Error when the cap is exceeded. */
	pinFact(text: string, createdBy: "user" | "model"): PinItem {
		const clean = truncateWithEllipsis(text.trim(), PIN_FACT_MAX);
		if (clean === "") throw new Error("Cannot pin an empty fact.");
		this.assertCapacity();
		const item: PinItem = { id: `p${this.nextId++}`, kind: "fact", text: clean, createdBy };
		this.items.push(item);
		this.markChanged();
		return { ...item };
	}

	/**
	 * Pin a file by ABSOLUTE path. Canonicalizes to the same key the rest of the
	 * project uses; a path already pinned returns the EXISTING item (dedupe, no
	 * error, no new id). A genuinely new pin throws when the cap is exceeded.
	 */
	pinFile(absPath: string, cwd: string, createdBy: "user" | "model"): PinItem {
		const canonicalPath = canonicalPathKey(absPath);
		const existing = this.items.find((p) => p.kind === "file" && p.canonicalPath === canonicalPath);
		if (existing) return { ...existing };
		this.assertCapacity();
		const item: PinItem = {
			id: `p${this.nextId++}`,
			kind: "file",
			canonicalPath,
			displayPath: relativeDisplayPath(absPath, cwd),
			createdBy,
		};
		this.items.push(item);
		this.markChanged();
		return { ...item };
	}

	/**
	 * Remove a pin by id. The user owns the list: a `model` request can never
	 * remove a pin a human created (returns false). Returns false for an unknown id.
	 */
	unpin(id: string, requestedBy: "user" | "model"): boolean {
		const idx = this.items.findIndex((p) => p.id === id);
		if (idx < 0) return false;
		if (requestedBy === "model" && this.items[idx].createdBy === "user") return false;
		this.items.splice(idx, 1);
		this.markChanged();
		return true;
	}

	/** Snapshot for persistence; `undefined` when empty (nothing to persist). */
	serialize(): PinStateSnapshot | undefined {
		if (this.items.length === 0) return undefined;
		return { items: this.items.map((p) => ({ ...p })), nextId: this.nextId };
	}

	/** Restore from a persisted snapshot. Tolerant of malformed/legacy entries. */
	restore(snapshot: PinStateSnapshot | undefined): void {
		if (!snapshot || !Array.isArray(snapshot.items)) {
			this.items = [];
			this.nextId = 1;
			return;
		}
		this.items = snapshot.items
			.filter((p): p is PinItem => {
				if (!p || typeof p.id !== "string") return false;
				if (p.kind === "fact") return typeof p.text === "string" && p.text.length > 0;
				if (p.kind === "file") return typeof p.canonicalPath === "string" && p.canonicalPath.length > 0;
				return false;
			})
			.slice(0, PIN_CAP)
			.map((p) => ({
				...p,
				createdBy: p.createdBy === "user" || p.createdBy === "model" ? p.createdBy : "user",
			}));
		// nextId must clear every existing id so a restored pin never collides with
		// a freshly-created one (ids are "p<N>"; a non-numeric id contributes 0).
		const maxId = this.items.reduce((m, p) => Math.max(m, Number(p.id.slice(1)) || 0), 0);
		const rawNext = typeof snapshot.nextId === "number" && Number.isFinite(snapshot.nextId) ? snapshot.nextId : 1;
		this.nextId = Math.max(rawNext, maxId + 1);
	}

	/** Canonical path keys of the file pins — consumed by the prune pipeline. */
	pinnedCanonicalPaths(): ReadonlySet<string> {
		const set = new Set<string>();
		for (const p of this.items) {
			if (p.kind === "file" && p.canonicalPath) set.add(p.canonicalPath);
		}
		return set;
	}

	/**
	 * Dense `<pinned>` block re-injected into the system prompt every turn (after
	 * the dynamic marker, so it never invalidates the cached prefix). This is what
	 * makes fact pins immune to forgetting — they never depend on the window.
	 * `undefined` when there is nothing pinned.
	 */
	systemPromptSection(): string | undefined {
		if (this.items.length === 0) return undefined;
		const facts = this.items.filter((p) => p.kind === "fact");
		const files = this.items.filter((p) => p.kind === "file");
		const lines = [
			"<pinned>",
			"User-pinned context — treat as load-bearing; do not let it drift out of the working set.",
		];
		for (const f of facts) lines.push(`- #${f.id} ${f.text}`);
		if (files.length > 0) {
			const list = files.map((f) => `#${f.id} ${f.displayPath}`).join(" · ");
			lines.push(`Files kept verbatim in context (re-read before editing if unsure): ${list}`);
		}
		lines.push("</pinned>");
		return lines.join("\n");
	}

	/**
	 * Compact one-line-ish block appended to a compaction summary, so pinned facts
	 * and files stay visible even for the span the summary folds away. `undefined`
	 * when empty.
	 */
	summaryFooter(): string | undefined {
		if (this.items.length === 0) return undefined;
		const facts = this.items.filter((p) => p.kind === "fact");
		const files = this.items.filter((p) => p.kind === "file");
		const parts: string[] = [];
		if (facts.length > 0) parts.push(`facts — ${facts.map((f) => f.text).join("; ")}`);
		if (files.length > 0) parts.push(`files — ${files.map((f) => f.displayPath).join(", ")}`);
		return `Pinned (user-marked, still active): ${parts.join(". ")}.`;
	}
}

// ---------------------------------------------------------------------------
// Module-level "current session" registry, mirroring goal/todo/plan managers.
// The `pin` tool reaches the active manager through this without per-call plumbing.
// ---------------------------------------------------------------------------

let currentPinManager: PinManager | undefined;

export function setCurrentPinManager(mgr: PinManager | undefined): void {
	currentPinManager = mgr;
}

export function getCurrentPinManager(): PinManager | undefined {
	return currentPinManager;
}

/**
 * Resolve a verbatim path argument (as a model passes it to read/edit/…) to the
 * canonical key used for pin matching — the SAME `canonicalPathKey` the pin set
 * stores, so both sides agree regardless of spelling/symlinks. Relative paths
 * resolve against `process.cwd()`, matching the supersede scan's own resolution.
 */
export function canonicalPinKeyForToolPath(pathArg: string): string {
	return canonicalPathKey(isAbsolute(pathArg) ? pathArg : resolve(pathArg));
}
