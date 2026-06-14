/**
 * Generic undo stack with clone-on-push semantics.
 *
 * Stores deep clones of state snapshots. Popped snapshots are returned
 * directly (no re-cloning) since they are already detached.
 */
export class UndoStack<S> {
	/**
	 * Defensive cap so a long-lived component (e.g. the chat Input, which never
	 * clears its stack) can't grow the snapshot list without bound. Far above any
	 * realistic undo depth, so it never truncates a real history.
	 */
	private static readonly MAX_ENTRIES = 1000;
	private stack: S[] = [];

	/** Push a clone of the given state onto the stack. */
	push(state: S): void {
		this.stack.push(this.clone(state));
		if (this.stack.length > UndoStack.MAX_ENTRIES) this.stack.shift();
	}

	/**
	 * Shallow-clone a state snapshot. The top-level spread detaches all primitive
	 * fields (strings/numbers are immutable). The only nested mutable field across
	 * callers is the editor's `lines` array, so when present it gets a fresh array
	 * with copied (immutable) string references — fully detached, no aliasing that
	 * could let a later mutation leak into the snapshot. Other state shapes (e.g.
	 * the Input component's `{ value, cursor }`) carry no nested mutable fields and
	 * are detached by the spread alone. Avoids the deep-copy cost of structuredClone
	 * on every keystroke.
	 */
	private clone(state: S): S {
		const s = state as { lines?: string[] };
		const copy = { ...s };
		if (Array.isArray(s.lines)) copy.lines = [...s.lines];
		return copy as S;
	}

	/** Pop and return the most recent snapshot, or undefined if empty. */
	pop(): S | undefined {
		return this.stack.pop();
	}

	/** Remove all snapshots. */
	clear(): void {
		this.stack.length = 0;
	}

	get length(): number {
		return this.stack.length;
	}
}
