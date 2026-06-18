// =============================================================================
// Frame chunk coalescing
// =============================================================================
//
// Stdio-based JSON-RPC readers (LSP / DAP / MCP) accumulate incoming `data`
// chunks before parsing length-prefixed frames out of them. Concatenating the
// whole accumulated buffer on every chunk is O(B²) for a B-byte message split
// across N chunks. Instead each handler pushes the raw chunk into a pending
// list (O(1)) and the drain loop coalesces them ~once per drain cycle via this
// helper, turning N concats into ~1.
//
// The returned buffer is byte-identical to repeatedly concatenating `buffer`
// with each pending chunk in order; only the scheduling of the copies changes.

/**
 * Merge any pending chunks onto `buffer`, preserving byte order. Callers must
 * clear the pending list (`pending.length = 0`) after invoking this. Returns
 * `buffer` unchanged when there is nothing pending.
 */
export function coalesceChunks(buffer: Buffer, pending: Buffer[]): Buffer {
	if (pending.length === 0) return buffer;
	if (buffer.length === 0 && pending.length === 1) return pending[0];
	return Buffer.concat([buffer, ...pending]);
}
