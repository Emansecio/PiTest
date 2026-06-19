import type { EditDiffError, EditDiffResult } from "./edit-diff.ts";

/** Union of the two render-preview shapes shared by `edit` and `edit_v2`. */
export type EditPreviewValue = EditDiffResult | EditDiffError;

/**
 * Minimal structural view of an edit call render component touched by
 * `setEditPreview`. Both `edit.ts` (EditCallRenderComponent) and
 * `edit-hashline.ts` (CallComponent) satisfy this shape.
 */
export interface EditPreviewTarget {
	preview?: EditPreviewValue;
	previewArgsKey?: string;
	previewPending?: boolean;
}

/**
 * Update a render component's staged preview. Returns true when the visible
 * diff/error changed (so the caller knows to re-render). Behavior is identical
 * across the `edit` and `edit_v2` tools.
 */
export function setEditPreview(
	component: EditPreviewTarget,
	preview: EditPreviewValue,
	argsKey: string | undefined,
): boolean {
	const current = component.preview;
	const changed =
		current === undefined ||
		("error" in current && "error" in preview
			? current.error !== preview.error
			: "error" in current !== "error" in preview) ||
		(!("error" in current) &&
			!("error" in preview) &&
			(current.diff !== preview.diff || current.firstChangedLine !== preview.firstChangedLine));
	component.preview = preview;
	component.previewArgsKey = argsKey;
	component.previewPending = false;
	return changed;
}

/**
 * Resolve the header background painter for an edit call component, keyed by
 * the current preview/settled state. Identical for `edit` and `edit_v2`.
 */
export function getEditHeaderBg(
	preview: EditPreviewValue | undefined,
	settledError: boolean | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
): (text: string) => string {
	if (preview) {
		if ("error" in preview) {
			return (text: string) => theme.bg("toolErrorBg", text);
		}
		return (text: string) => theme.bg("toolSuccessBg", text);
	}
	if (settledError) {
		return (text: string) => theme.bg("toolErrorBg", text);
	}
	return (text: string) => theme.bg("toolPendingBg", text);
}
