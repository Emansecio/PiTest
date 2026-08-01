/**
 * Marker bookkeeping for clipboard images pasted into the interactive composer.
 *
 * A paste buffers the image on the interactive-mode side and inserts a visible
 * `[Image #N]` marker into the editor. Nothing reaches the session until the
 * draft is actually dispatched: at that seam the buffer is reconciled against
 * the submitted text and only images whose marker survived are attached. The
 * marker is therefore the user's detach handle — deleting it, clearing the
 * draft (Ctrl+C), or abandoning the message drops the image instead of letting
 * it ghost onto the next unrelated prompt.
 *
 * This deliberately lives outside `AgentSession`: the session's
 * `attachImages()`/drain-on-next-prompt contract stays intact for programmatic
 * (RPC/headless/extension) callers, which attach images without any marker.
 */

/** The visible editor marker for the Nth pasted image (1-based). */
export function imageMarker(index: number): string {
	return `[Image #${index}]`;
}

/**
 * Filter a paste buffer down to the images whose 1-based `[Image #N]` marker
 * still appears in the text being dispatched. Position in the buffer defines
 * the marker number, so callers must pass the buffer in paste order.
 */
export function reconcilePastedImages<T>(text: string, images: readonly T[]): T[] {
	return images.filter((_, i) => text.includes(imageMarker(i + 1)));
}
