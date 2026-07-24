/**
 * Tests for SGR mouse report decoding (parseMouse / isMouseSequence).
 *
 * Fixtures are literal byte sequences in the SGR extended form:
 *   ESC [ < b ; x ; y (M|m)
 * where `b` is the button/modifier bitfield, x/y are 1-based cell coords, and
 * the trailing byte is 'M' (press/motion) or 'm' (release).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { isMouseSequence, type MouseEvent, parseMouse } from "../src/keys.js";

/** Build an expected MouseEvent from defaults + overrides (raw is required). */
function ev(raw: string, fields: Partial<MouseEvent>): MouseEvent {
	return {
		type: "press",
		button: "left",
		wheel: undefined,
		x: 0,
		y: 0,
		shift: false,
		ctrl: false,
		alt: false,
		raw,
		...fields,
	};
}

describe("parseMouse", () => {
	describe("press / release per button", () => {
		it("decodes left press (b=0, M)", () => {
			const raw = "\x1b[<0;10;5M";
			assert.deepStrictEqual(parseMouse(raw), ev(raw, { type: "press", button: "left", x: 10, y: 5 }));
		});

		it("decodes left release (b=0, m)", () => {
			const raw = "\x1b[<0;10;5m";
			assert.deepStrictEqual(parseMouse(raw), ev(raw, { type: "release", button: "left", x: 10, y: 5 }));
		});

		it("decodes middle press (b=1, M)", () => {
			const raw = "\x1b[<1;3;7M";
			assert.deepStrictEqual(parseMouse(raw), ev(raw, { type: "press", button: "middle", x: 3, y: 7 }));
		});

		it("decodes middle release (b=1, m)", () => {
			const raw = "\x1b[<1;3;7m";
			assert.deepStrictEqual(parseMouse(raw), ev(raw, { type: "release", button: "middle", x: 3, y: 7 }));
		});

		it("decodes right press (b=2, M)", () => {
			const raw = "\x1b[<2;40;12M";
			assert.deepStrictEqual(parseMouse(raw), ev(raw, { type: "press", button: "right", x: 40, y: 12 }));
		});

		it("decodes right release (b=2, m)", () => {
			const raw = "\x1b[<2;40;12m";
			assert.deepStrictEqual(parseMouse(raw), ev(raw, { type: "release", button: "right", x: 40, y: 12 }));
		});

		it("treats coordinates as 1-based (x=1,y=1)", () => {
			const raw = "\x1b[<0;1;1M";
			assert.deepStrictEqual(parseMouse(raw), ev(raw, { type: "press", button: "left", x: 1, y: 1 }));
		});
	});

	describe("drag (motion with button, b&32)", () => {
		it("decodes left drag (b=32)", () => {
			const raw = "\x1b[<32;15;9M";
			assert.deepStrictEqual(parseMouse(raw), ev(raw, { type: "drag", button: "left", x: 15, y: 9 }));
		});

		it("decodes middle drag (b=33)", () => {
			const raw = "\x1b[<33;15;9M";
			assert.deepStrictEqual(parseMouse(raw), ev(raw, { type: "drag", button: "middle", x: 15, y: 9 }));
		});

		it("decodes right drag (b=34)", () => {
			const raw = "\x1b[<34;15;9M";
			assert.deepStrictEqual(parseMouse(raw), ev(raw, { type: "drag", button: "right", x: 15, y: 9 }));
		});

		it("decodes buttonless drag as button 'none' (b=35, b&3===3)", () => {
			const raw = "\x1b[<35;15;9M";
			assert.deepStrictEqual(parseMouse(raw), ev(raw, { type: "drag", button: "none", x: 15, y: 9 }));
		});
	});

	describe("wheel (b&64)", () => {
		it("decodes wheel up (b=64) with button 'none'", () => {
			const raw = "\x1b[<64;20;20M";
			assert.deepStrictEqual(parseMouse(raw), ev(raw, { type: "wheel", button: "none", wheel: "up", x: 20, y: 20 }));
		});

		it("decodes wheel down (b=65)", () => {
			const raw = "\x1b[<65;20;20M";
			assert.deepStrictEqual(
				parseMouse(raw),
				ev(raw, { type: "wheel", button: "none", wheel: "down", x: 20, y: 20 }),
			);
		});

		it("carries modifiers on a wheel report (ctrl+wheel up, b=80)", () => {
			const raw = "\x1b[<80;20;20M";
			assert.deepStrictEqual(
				parseMouse(raw),
				ev(raw, { type: "wheel", button: "none", wheel: "up", x: 20, y: 20, ctrl: true }),
			);
		});

		// The direction lives in the low 2 bits of the same field the button bits
		// use (64 up, 65 down, 66 left, 67 right). Reading only b&1 made a
		// horizontal trackpad/tilt gesture arrive as a VERTICAL scroll.
		it("decodes wheel left (b=66) as horizontal, not vertical", () => {
			const raw = "\x1b[<66;20;20M";
			assert.deepStrictEqual(
				parseMouse(raw),
				ev(raw, { type: "wheel", button: "none", wheel: "left", x: 20, y: 20 }),
			);
		});

		it("decodes wheel right (b=67) as horizontal, not vertical", () => {
			const raw = "\x1b[<67;20;20M";
			assert.deepStrictEqual(
				parseMouse(raw),
				ev(raw, { type: "wheel", button: "none", wheel: "right", x: 20, y: 20 }),
			);
		});

		it("never reports a horizontal tick as up/down (b=66, b=67)", () => {
			for (const b of [66, 67]) {
				const decoded = parseMouse(`\x1b[<${b};20;20M`);
				assert.ok(decoded, `b=${b} must still decode`);
				assert.notStrictEqual(decoded.wheel, "up", `b=${b} must not decode as wheel up`);
				assert.notStrictEqual(decoded.wheel, "down", `b=${b} must not decode as wheel down`);
			}
		});

		it("carries modifiers on a horizontal wheel report (ctrl+wheel left, b=82)", () => {
			const raw = "\x1b[<82;20;20M";
			assert.deepStrictEqual(
				parseMouse(raw),
				ev(raw, { type: "wheel", button: "none", wheel: "left", x: 20, y: 20, ctrl: true }),
			);
		});
	});

	describe("modifier bits (shift=4, alt=8, ctrl=16)", () => {
		it("decodes shift+left press (b=4)", () => {
			const raw = "\x1b[<4;2;2M";
			assert.deepStrictEqual(parseMouse(raw), ev(raw, { type: "press", button: "left", x: 2, y: 2, shift: true }));
		});

		it("decodes alt+left press (b=8)", () => {
			const raw = "\x1b[<8;2;2M";
			assert.deepStrictEqual(parseMouse(raw), ev(raw, { type: "press", button: "left", x: 2, y: 2, alt: true }));
		});

		it("decodes ctrl+left press (b=16)", () => {
			const raw = "\x1b[<16;2;2M";
			assert.deepStrictEqual(parseMouse(raw), ev(raw, { type: "press", button: "left", x: 2, y: 2, ctrl: true }));
		});

		it("decodes all modifiers on right press (b=2+4+8+16=30)", () => {
			const raw = "\x1b[<30;2;2M";
			assert.deepStrictEqual(
				parseMouse(raw),
				ev(raw, { type: "press", button: "right", x: 2, y: 2, shift: true, alt: true, ctrl: true }),
			);
		});
	});

	describe("large coordinates (SGR advantage, >223)", () => {
		it("decodes coordinates beyond the legacy 223 cap", () => {
			const raw = "\x1b[<0;1000;500M";
			assert.deepStrictEqual(parseMouse(raw), ev(raw, { type: "press", button: "left", x: 1000, y: 500 }));
		});
	});

	describe("malformed / non-mouse input returns undefined", () => {
		it("rejects a sequence missing the '<' marker", () => {
			assert.strictEqual(parseMouse("\x1b[0;10;5M"), undefined);
		});

		it("rejects a sequence with a missing field", () => {
			assert.strictEqual(parseMouse("\x1b[<0;10M"), undefined);
		});

		it("rejects an extra field", () => {
			assert.strictEqual(parseMouse("\x1b[<0;10;5;1M"), undefined);
		});

		it("rejects a non-numeric field", () => {
			assert.strictEqual(parseMouse("\x1b[<0;x;5M"), undefined);
		});

		it("rejects an invalid final byte", () => {
			assert.strictEqual(parseMouse("\x1b[<0;10;5X"), undefined);
		});

		it("rejects trailing bytes after the final byte", () => {
			assert.strictEqual(parseMouse("\x1b[<0;10;5Mtrailing"), undefined);
		});

		it("rejects the legacy X10 ESC[M form (SGR-only by design)", () => {
			// ESC [ M followed by 3 raw coordinate bytes.
			assert.strictEqual(parseMouse("\x1b[M !!"), undefined);
		});

		it("rejects an ordinary key sequence (arrow up)", () => {
			assert.strictEqual(parseMouse("\x1b[A"), undefined);
		});

		it("rejects empty input and plain text", () => {
			assert.strictEqual(parseMouse(""), undefined);
			assert.strictEqual(parseMouse("hello"), undefined);
		});
	});
});

describe("isMouseSequence", () => {
	it("is true for the SGR mouse prefix (ESC [ <)", () => {
		assert.strictEqual(isMouseSequence("\x1b[<0;1;1M"), true);
		// Prefix-only predictor: true even for an incomplete SGR sequence.
		assert.strictEqual(isMouseSequence("\x1b[<0;1"), true);
	});

	it("is false for non-mouse sequences and text", () => {
		assert.strictEqual(isMouseSequence("\x1b[A"), false);
		assert.strictEqual(isMouseSequence("\x1b[M !!"), false); // legacy X10 form
		assert.strictEqual(isMouseSequence("abc"), false);
		assert.strictEqual(isMouseSequence(""), false);
	});
});
