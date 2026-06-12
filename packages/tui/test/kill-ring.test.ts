import assert from "node:assert";
import { describe, it } from "node:test";
import { KillRing } from "../src/kill-ring.js";

describe("KillRing", () => {
	it("peek returns the most recently pushed entry", () => {
		const ring = new KillRing();
		ring.push("a", { prepend: false });
		ring.push("b", { prepend: false });
		assert.strictEqual(ring.peek(), "b");
		assert.strictEqual(ring.length, 2);
	});

	it("accumulate merges into the most recent entry without growing", () => {
		const ring = new KillRing();
		ring.push("bar", { prepend: false });
		ring.push("foo", { prepend: true, accumulate: true });
		assert.strictEqual(ring.length, 1);
		assert.strictEqual(ring.peek(), "foobar");
	});

	it("rotate cycles end to front for yank-pop", () => {
		const ring = new KillRing();
		ring.push("a", { prepend: false });
		ring.push("b", { prepend: false });
		ring.push("c", { prepend: false });
		assert.strictEqual(ring.peek(), "c");
		ring.rotate();
		assert.strictEqual(ring.peek(), "b");
		ring.rotate();
		assert.strictEqual(ring.peek(), "a");
		ring.rotate();
		assert.strictEqual(ring.peek(), "c");
	});

	it("normal use (few kills) keeps every entry — behavior unchanged", () => {
		const ring = new KillRing();
		for (let i = 0; i < 60; i++) {
			ring.push(`k${i}`, { prepend: false });
		}
		assert.strictEqual(ring.length, 60);
		assert.strictEqual(ring.peek(), "k59");
	});

	it("caps the ring, dropping the oldest entry once exceeded", () => {
		const ring = new KillRing();
		// Push more than the cap (60) -> 0..69.
		for (let i = 0; i < 70; i++) {
			ring.push(`k${i}`, { prepend: false });
		}
		// Length is capped; newest survives, oldest is gone.
		assert.strictEqual(ring.length, 60);
		assert.strictEqual(ring.peek(), "k69");

		// Walk the entire ring via rotate: it must contain exactly the 60 most
		// recent entries (k10..k69) and none of the dropped ones (k0..k9).
		const seen: string[] = [];
		for (let i = 0; i < 60; i++) {
			seen.push(ring.peek()!);
			ring.rotate();
		}
		assert.ok(seen.includes("k69"), "newest entry must be present");
		assert.ok(seen.includes("k10"), "oldest surviving entry must be present");
		assert.ok(!seen.includes("k9"), "dropped entry must be gone");
		assert.ok(!seen.includes("k0"), "first dropped entry must be gone");
	});

	it("yank-pop still cycles correctly through survivors after capping", () => {
		const ring = new KillRing();
		for (let i = 0; i < 62; i++) {
			ring.push(`k${i}`, { prepend: false });
		}
		// Survivors are k2..k61 (60 entries). Yank-pop order from the top:
		assert.strictEqual(ring.peek(), "k61");
		ring.rotate();
		assert.strictEqual(ring.peek(), "k60");
		ring.rotate();
		assert.strictEqual(ring.peek(), "k59");
		// After exhausting all survivors, it wraps back to the newest.
		// We've rotated twice so far; 58 more completes one full cycle of 60.
		for (let i = 0; i < 58; i++) {
			ring.rotate();
		}
		assert.strictEqual(ring.peek(), "k61");
	});
});
