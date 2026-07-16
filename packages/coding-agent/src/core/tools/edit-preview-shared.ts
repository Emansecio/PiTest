import { Box, type Component, Spacer, Text } from "@pit/tui";
import { renderDiff, wrapDiffBody } from "../../modes/interactive/components/diff.js";
import { capDiffPreview, EDIT_EXPANDED_MAX_LINES } from "../../modes/interactive/components/tool-activity.ts";
import type { ToolRenderContext } from "../extensions/types.js";
import type { EditDiffError, EditDiffResult } from "./edit-diff.ts";
import { getFilePathArg, invalidArgText, shortenPath } from "./render-utils.ts";

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
	/** Whether the settled (non-preview) tool result was an error. */
	settledError?: boolean;
	/** True once `renderResult` has applied the final diff/error — blocks late async preview updates. */
	previewSettled?: boolean;
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

function diffMemoKey(path: string | undefined, diff: string): string {
	return `${path ?? ""}\0${diff}`;
}

function resolveEditDiffBody(
	component: EditDiffMemoTarget,
	preview: EditPreviewValue,
	path: string | undefined,
): string {
	if ("error" in preview) {
		return "";
	}
	const key = diffMemoKey(path, preview.diff);
	if (component.renderedDiffKey === key && component.renderedDiffBody !== undefined) {
		return component.renderedDiffBody;
	}
	const body = renderDiff(preview.diff, { path });
	component.renderedDiffKey = key;
	component.renderedDiffBody = body;
	return body;
}

/**
 * Diff body child: wraps via {@link wrapDiffBody} (gutter-aware hanging indent on
 * wrapped continuations) instead of the generic Text component, and optionally caps
 * the wrapped line count at render time (legacy expanded).
 */
class EditDiffBodyText implements Component {
	private body: string;
	private maxLines: number | undefined;

	constructor(body: string, maxLines: number | undefined) {
		this.body = body;
		this.maxLines = maxLines;
	}

	invalidate(): void {}

	render(width: number): string[] {
		let lines = wrapDiffBody(this.body, width);
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
	path?: string,
): void {
	if ("error" in preview) {
		parent.addChild(new Spacer(1));
		parent.addChild(new Text(theme.fg("error", preview.error), 0, 0));
		return;
	}
	const body = resolveEditDiffBody(component, preview, path);
	parent.addChild(new Spacer(1));
	parent.addChild(new EditDiffBodyText(body, diffMaxLines));
}

/**
 * Base fields a new edit-family call render component starts with. Shared by
 * `edit` and `edit_v2`; each tool's own `create*Component()` may layer extra
 * fields on top (e.g. `edit`'s `lastArgsComplete`, used to gate its streaming
 * live-preview while args are still arriving — that policy stays local to
 * `edit.ts`, only the base shape is shared here).
 */
export function createEditCallComponentBase(): Box & EditDiffMemoTarget {
	return Object.assign(new Box(1, 1, (text: string) => text), {
		preview: undefined as EditPreviewValue | undefined,
		previewArgsKey: undefined as string | undefined,
		previewPending: false,
		settledError: false,
		previewSettled: false,
		renderedDiffKey: undefined as string | undefined,
		renderedDiffBody: undefined as string | undefined,
	});
}

/**
 * Get-or-create the persisted call render component for an edit-family tool.
 * Reuses `lastComponent` when the TUI already re-mounted it, otherwise reuses
 * (or creates via `create`) the one held in `state`. Identical across `edit`
 * and `edit_v2` — only `create` differs.
 */
export function getOrCreateEditCallComponent<TComponent extends Box>(
	state: { callComponent?: TComponent },
	lastComponent: unknown,
	create: () => TComponent,
): TComponent {
	if (lastComponent instanceof Box) {
		const component = lastComponent as TComponent;
		state.callComponent = component;
		return component;
	}
	if (state.callComponent) {
		return state.callComponent;
	}
	const component = create();
	state.callComponent = component;
	return component;
}

/**
 * Format an edit-family tool's call header: `<label> <path>`. `label` is the
 * only thing that differs between `edit` and `edit_v2` — passing it in (rather
 * than hardcoding "edit") is what keeps `edit_v2`'s header from mislabeling
 * itself as "edit".
 */
export function formatEditToolCallHeader(
	label: string,
	args: { path?: unknown; file_path?: unknown } | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	cwd?: string,
): string {
	const invalidArg = invalidArgText(theme);
	const rawPath = getFilePathArg(args);
	const path = rawPath !== null ? shortenPath(rawPath, cwd) : null;
	const pathDisplay = path === null ? invalidArg : path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
	return `${theme.fg("toolTitle", theme.bold(label))} ${pathDisplay}`;
}

/**
 * Build (mutate + return) an edit-family call render component: header
 * background, header text, and — once a preview exists — the diff/error body.
 * Identical across `edit` and `edit_v2`; callers differ only in header
 * `label` and in when they dispatch the preview compute (edit streams a live
 * preview before args finish; edit_v2 waits for `argsComplete`) — that policy
 * lives in each tool's own `renderCall`, upstream of this helper.
 */
export function buildEditToolCallComponent<
	TComponent extends Box & EditDiffMemoTarget,
	TArgs extends { path?: unknown; file_path?: unknown },
>(
	label: string,
	component: TComponent,
	args: TArgs | undefined,
	theme: typeof import("../../modes/interactive/theme/theme.ts").theme,
	cwd: string | undefined,
	context: Pick<ToolRenderContext, "activityChild" | "expanded">,
): TComponent {
	const activityChild = context.activityChild;
	if (activityChild) {
		component.setBgFn((text: string) => text);
	} else {
		component.setBgFn(getEditHeaderBg(component.preview, component.settledError, theme));
	}
	component.clear();
	if (!activityChild) {
		component.addChild(new Text(formatEditToolCallHeader(label, args, theme, cwd), 0, 0));
	}
	if (!component.preview) {
		return component;
	}
	let diffMaxLines: number | undefined;
	if (!activityChild && context.expanded) {
		diffMaxLines = EDIT_EXPANDED_MAX_LINES;
	}
	const path = getFilePathArg(args) ?? undefined;
	appendEditDiffBody(component, component, component.preview, theme, diffMaxLines, path);
	return component;
}
