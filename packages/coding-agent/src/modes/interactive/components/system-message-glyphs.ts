export type SystemMessageKind = "compaction" | "branch" | "skill" | "done" | "overthink" | "ttsr" | "steer" | "queued";

const LABELS: Record<SystemMessageKind, string> = {
	compaction: "⟳ compaction",
	branch: "⑂ branch",
	skill: "◆ skill",
	done: "✓ done",
	overthink: "◈ overthink",
	ttsr: "◈ ttsr",
	steer: "▸ steer",
	queued: "◷ queued",
};

/** Width-1 glyph + short word for MessageShell.label */
export function systemMessageLabel(kind: SystemMessageKind): string {
	return LABELS[kind];
}
