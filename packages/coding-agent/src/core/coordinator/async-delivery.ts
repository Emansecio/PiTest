/**
 * Pure formatter for the message re-injected into the parent chat when an
 * async (op:"spawn") subagent settles. Kept self-contained — the parent agent
 * may have moved on, so the block restates which handle finished and carries the
 * full result/error as the trailing payload (so nothing after it dilutes it).
 */
export function buildAsyncDeliveryBody(handle: string, status: "done" | "error", text: string): string {
	const header =
		status === "error"
			? `[ASYNC DELEGATION FAILED] Subagent '${handle}' errored.`
			: `[ASYNC DELEGATION COMPLETE] Subagent '${handle}' finished.`;
	return `${header}\n\n${text}`;
}
