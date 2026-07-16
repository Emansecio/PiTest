export type SystemMessageKind = "compaction" | "branch" | "skill" | "done" | "overthink" | "ttsr" | "steer" | "queued";

const LABELS: Record<SystemMessageKind, string> = {
	compaction: "⟳ Compaction",
	branch: "⑂ Branch",
	skill: "◆ Skill",
	done: "✓ Done",
	overthink: "◈ Overthink",
	ttsr: "◈ TTSR",
	steer: "▸ Steer",
	queued: "◷ Queued",
};

/** Width-1 glyph + short word for MessageShell.label */
export function systemMessageLabel(kind: SystemMessageKind): string {
	return LABELS[kind];
}
