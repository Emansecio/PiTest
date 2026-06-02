// Microbenchmark for the extreme-perf-optimizer sweep.
// Each case asserts OLD === NEW over the inputs (isomorphism) before timing.
// Run: node scripts/bench-perf-sweep.mjs

function median(xs) {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

// time `fn` doing `iters` calls, repeated `samples` times → median ns/op
function bench(fn, iters, samples = 7) {
	for (let w = 0; w < 3; w++) for (let i = 0; i < iters; i++) fn(i); // warmup
	const perOp = [];
	for (let s = 0; s < samples; s++) {
		const t0 = performance.now();
		for (let i = 0; i < iters; i++) fn(i);
		const t1 = performance.now();
		perOp.push(((t1 - t0) * 1e6) / iters); // ns/op
	}
	return median(perOp);
}

// ---------------------------------------------------------------------------
// Case 1 — isDenseText (compaction.ts): per-char regex+includes → charCodeAt
// ---------------------------------------------------------------------------
function isDenseTextOld(text) {
	if (text.length === 0) return false;
	let nonAlphaNum = 0, structural = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") {
			if (!/[a-zA-Z0-9]/.test(c)) nonAlphaNum++;
		}
		if ('{}[]()<>;:,="'.includes(c)) structural++;
	}
	return nonAlphaNum / text.length > 0.2 || structural / text.length > 0.05;
}
const STRUCTURAL_CODES = new Set('{}[]()<>;:,="'.split("").map((c) => c.charCodeAt(0)));
function isDenseTextNew(text) {
	if (text.length === 0) return false;
	let nonAlphaNum = 0, structural = 0;
	for (let i = 0; i < text.length; i++) {
		const cc = text.charCodeAt(i);
		if (cc !== 32 && cc !== 9 && cc !== 10 && cc !== 13) {
			const isAlnum = (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122);
			if (!isAlnum) nonAlphaNum++;
		}
		if (STRUCTURAL_CODES.has(cc)) structural++;
	}
	return nonAlphaNum / text.length > 0.2 || structural / text.length > 0.05;
}

const prose = ("The agent should first read the file and then decide what to do next. " +
	"This is a fairly long reasoning trace that a model might emit while thinking. ").repeat(60); // ~8 KB prose
const code = ("const x = foo(bar[i], {a: 1, b: [2,3]}); if (x > 0 && y < 10) { return x; } // note\n").repeat(95); // ~8 KB dense

for (const [name, t] of [["prose", prose], ["code", code]]) {
	if (isDenseTextOld(t) !== isDenseTextNew(t)) throw new Error(`isDenseText mismatch on ${name}`);
}
// also fuzz isomorphism over varied unicode/whitespace
for (let k = 0; k < 500; k++) {
	const r = String.fromCharCode(...Array.from({ length: 40 }, (_, j) => ((k * 7 + j * 13) % 220) + 9));
	if (isDenseTextOld(r) !== isDenseTextNew(r)) throw new Error("isDenseText fuzz mismatch");
}

const proseOld = bench(() => isDenseTextOld(prose), 2000);
const proseNew = bench(() => isDenseTextNew(prose), 2000);
const codeOld = bench(() => isDenseTextOld(code), 2000);
const codeNew = bench(() => isDenseTextNew(code), 2000);

// ---------------------------------------------------------------------------
// Case 2 — content-block visibility (assistant-message.ts): slice+some O(n²) → index O(n)
// ---------------------------------------------------------------------------
const isVis = (b) => (b.type === "text" && b.text.trim() !== "") || (b.type === "thinking" && b.thinking !== "") || b.type === "toolCall" || b.type === "image";
function visOld(content) { // per-block slice().some() → O(n^2)
	let count = 0;
	for (let i = 0; i < content.length; i++) if (content.slice(i + 1).some(isVis)) count++;
	return count;
}
function visNew(content) { // precompute last visible index → O(n)
	let last = -1;
	for (let i = 0; i < content.length; i++) if (isVis(content[i])) last = i;
	let count = 0;
	for (let i = 0; i < content.length; i++) if (i < last) count++;
	return count;
}
const blocks = Array.from({ length: 40 }, (_, i) =>
	i % 3 === 0 ? { type: "text", text: "hello world" } : i % 3 === 1 ? { type: "thinking", thinking: "hmm" } : { type: "toolCall" });
if (visOld(blocks) !== visNew(blocks)) throw new Error("visibility mismatch");
const visOldNs = bench(() => visOld(blocks), 5000);
const visNewNs = bench(() => visNew(blocks), 5000);

// ---------------------------------------------------------------------------
const fmt = (n) => n.toFixed(1).padStart(8);
const x = (o, n) => `${(o / n).toFixed(2)}x`;
console.log("case                         old(ns)   new(ns)  speedup");
console.log(`isDenseText prose 8KB       ${fmt(proseOld)} ${fmt(proseNew)}   ${x(proseOld, proseNew)}`);
console.log(`isDenseText code  8KB       ${fmt(codeOld)} ${fmt(codeNew)}   ${x(codeOld, codeNew)}`);
console.log(`content-blocks vis n=40     ${fmt(visOldNs)} ${fmt(visNewNs)}   ${x(visOldNs, visNewNs)}`);
