import { type Component, Spacer, Text } from "@pit/tui";
import { renderDiff } from "../../modes/interactive/components/diff.js";
import { capDiffPreview } from "../../modes/interactive/components/tool-activity.ts";
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

/** Memo fields shared by edit call render components. */
export interface EditDiffMemoTarget extends EditPreviewTarget {
	renderedDiffKey?: string;
	renderedDiffBody?: string;
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

function resolveEditDiffBody(component: EditDiffMemoTarget, preview: EditPreviewValue): string {
	if ("error" in preview) {
		return "";
	}
	if (component.renderedDiffKey === preview.diff && component.renderedDiffBody !== undefined) {
		return component.renderedDiffBody;
	}
	const body = renderDiff(preview.diff);
	component.renderedDiffKey = preview.diff;
	component.renderedDiffBody = body;
	return body;
}

/** Text child that caps wrapped diff lines at render time (legacy expanded). */
class EditDiffBodyText implements Component {
	private body: string;
	private maxLines: number | undefined;

	constructor(body: string, maxLines: number | undefined) {
		this.body = body;
		this.maxLines = maxLines;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const inner = new Text(this.body, 0, 0);
		let lines = inner.render(width);
		if (this.maxLines !== undefined) {
			lines = capDiffPreview(lines, width, this.maxLines);
		}
		return lines;
	}
}

/**
 * Mount preview/error body under an edit call header. When `activityChild`,
 * callers skip the header and background before invoking this.
 */
export function appendEditDiffBody(
	parent: { addChild: (child: Component) => void },
	component: EditDiffMemoTarget,
	preview: EditPreviewValue,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	diffMaxLines: number | undefined,
): void {
	if ("error" in preview) {
		parent.addChild(new Spacer(1));
		parent.addChild(new Text(theme.fg("error", preview.error), 0, 0));
		return;
	}
	const body = resolveEditDiffBody(component, preview);
	parent.addChild(new Spacer(1));
	if (diffMaxLines !== undefined) {
		parent.addChild(new EditDiffBodyText(body, diffMaxLines));
	} else {
		parent.addChild(new Text(body, 0, 0));
	}
}
