import { describe, expect, it } from "vitest";
import { MAX_OUTPUT_BYTES, truncateOutput } from "../../src/core/dap/session.ts";

interface OutBuf {
	output: string;
	outputBytes: number;
	outputTruncated: boolean;
}

function newBuf(): OutBuf {
	return { output: "", outputBytes: 0, outputTruncated: false };
}

// Reference = the ORIGINAL truncateOutput, copied verbatim. The new
// implementation must stay byte-identical to this for output / outputBytes /
// outputTruncated; it only differs by measuring the byte total incrementally.
function truncateOutputReference(session: OutBuf, output: string): void {
	if (!output) return;
	session.output += output;
	session.outputBytes += Buffer.byteLength(output, "utf-8");
	while (Buffer.byteLength(session.output, "utf-8") > MAX_OUTPUT_BYTES) {
		session.output = session.output.slice(Math.min(1024, session.output.length));
		session.outputTruncated = true;
	}
}

function expectIdentical(a: OutBuf, b: OutBuf): void {
	// Compare bytes explicitly so a silent encoding drift can't pass on ===.
	expect(Buffer.from(a.output, "utf-8").equals(Buffer.from(b.output, "utf-8"))).toBe(true);
	expect(a.output).toBe(b.output);
	expect(a.outputBytes).toBe(b.outputBytes);
	expect(a.outputTruncated).toBe(b.outputTruncated);
}

describe("truncateOutput — byte-identity vs reference", () => {
	it("large single-event overflow (5× cap) matches the reference", () => {
		const chunk = "a".repeat(MAX_OUTPUT_BYTES * 5);
		const live = newBuf();
		const ref = newBuf();
		truncateOutput(live, chunk);
		truncateOutputReference(ref, chunk);
		expectIdentical(live, ref);
		expect(live.outputTruncated).toBe(true);
		expect(Buffer.byteLength(live.output, "utf-8")).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
		// outputBytes accumulates the full received total and is NOT decremented.
		expect(live.outputBytes).toBe(MAX_OUTPUT_BYTES * 5);
	});

	it("many small accumulated chunks match the reference", () => {
		const live = newBuf();
		const ref = newBuf();
		// 700 chunks of 333 bytes ≈ 233KB total → crosses the cap mid-stream.
		for (let i = 0; i < 700; i++) {
			const chunk = `line-${i}-${"x".repeat(333)}\n`;
			truncateOutput(live, chunk);
			truncateOutputReference(ref, chunk);
			// Assert identity after every chunk, not just at the end.
			expectIdentical(live, ref);
		}
		expect(live.outputTruncated).toBe(true);
		expect(Buffer.byteLength(live.output, "utf-8")).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
	});

	it("multi-byte UTF-8 single-event overflow (surrogate pairs split at cuts) matches the reference", () => {
		// Pad ASCII to a non-multiple of 1024, then emoji-only, so the 1024-char
		// cut points are guaranteed to land between the surrogate halves of a
		// 4-byte char in a SINGLE truncation event — the exact seam case.
		const big = `${"a".repeat(513)}${"😀".repeat(MAX_OUTPUT_BYTES * 2)}`;
		const live = newBuf();
		const ref = newBuf();
		truncateOutput(live, big);
		truncateOutputReference(ref, big);
		expectIdentical(live, ref);
		expect(live.outputTruncated).toBe(true);
		expect(Buffer.byteLength(live.output, "utf-8")).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
		// NOTE: no UTF-8 round-trip assert here — the original algorithm cuts on
		// 1024-char boundaries and can leave a lone surrogate at the head of the
		// retained buffer. That lossiness is pre-existing behavior the new
		// implementation must REPRODUCE (covered by expectIdentical), not fix.
	});

	it("multi-byte UTF-8 crossing 1024-char slice boundaries matches the reference", () => {
		// Mix 4-byte emoji, 2-byte accents and ASCII so the 1024-char cut points
		// land in the middle of multi-byte runs and char-count ≠ byte-count.
		const unit = "😀é😀ção-ABCDEF😀";
		const big = unit.repeat(Math.ceil((MAX_OUTPUT_BYTES * 6) / Buffer.byteLength(unit, "utf-8")));
		const live = newBuf();
		const ref = newBuf();
		// Feed in irregular slices (by code point) so boundaries vary.
		const cps = Array.from(big);
		let i = 0;
		const sizes = [101, 1024, 1025, 1, 2047, 333];
		let s = 0;
		while (i < cps.length) {
			const take = sizes[s % sizes.length] ?? 512;
			const piece = cps.slice(i, i + take).join("");
			truncateOutput(live, piece);
			truncateOutputReference(ref, piece);
			expectIdentical(live, ref);
			i += take;
			s++;
		}
		expect(live.outputTruncated).toBe(true);
		expect(Buffer.byteLength(live.output, "utf-8")).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
		// (No round-trip assert: a cut may legitimately strand a lone surrogate at
		// the buffer head, exactly like the original algorithm — see case above.)
	});

	it("empty / no-overflow inputs are untouched and identical", () => {
		const live = newBuf();
		const ref = newBuf();
		truncateOutput(live, "");
		truncateOutputReference(ref, "");
		expectIdentical(live, ref);
		expect(live.outputTruncated).toBe(false);

		const small = "hello ✓ world\n";
		truncateOutput(live, small);
		truncateOutputReference(ref, small);
		expectIdentical(live, ref);
		expect(live.outputTruncated).toBe(false);
		expect(live.output).toBe(small);
	});
});
