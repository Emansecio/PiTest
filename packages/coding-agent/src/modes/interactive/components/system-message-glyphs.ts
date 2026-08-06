import { isAsciiGlyphMode } from "./glyph-resolver.ts";

export type SystemMessageKind = "compaction" | "branch" | "skill" | "done" | "overthink" | "ttsr" | "steer" | "queued";

const LABELS_UNICODE: Record<SystemMessageKind, string> = {
	compaction: "⟳ Compaction",
	branch: "⑂ Branch",
	skill: "◆ Skill",
	done: "✓ Done",
	overthink: "◈ Overthink",
	ttsr: "◈ TTSR",
	steer: "▸ Steer",
	queued: "◷ Queued",
};

const LABELS_ASCII: Record<SystemMessageKind, string> = {
	compaction: "* Compaction",
	branch: "Y Branch",
	skill: "* Skill",
	done: "v Done",
	overthink: "o Overthink",
	ttsr: "o TTSR",
	steer: "> Steer",
	queued: "o Queued",
};

/** Width-1 glyph + short word for MessageShell.label (ASCII-safe under PIT_ASCII). */
export function systemMessageLabel(kind: SystemMessageKind): string {
	return isAsciiGlyphMode() ? LABELS_ASCII[kind] : LABELS_UNICODE[kind];
}
