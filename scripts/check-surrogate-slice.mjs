// Guard against surrogate-unsafe truncation.
//
// `str.slice(0, n)` (or any `.slice(...)`) immediately decorated with the
// ellipsis glyph U+2026 cuts on UTF-16 code units, so a boundary landing
// between a high and low surrogate splits an astral char (emoji / CJK ext)
// into a lone surrogate that renders as U+FFFD. Use `sliceSafe()` /
// `truncateWithEllipsis()` from packages/coding-agent/src/utils/surrogate.ts
// (or the equivalent inline guard) instead.
//
// Heuristic: a `.slice(...)` whose result is within a few characters of an
// ellipsis on the same line (the `${x.slice(0, n)}…` idiom). Array slices
// (followed by `.join`/`.map`) and the helper itself don't match. Runs as a
// fast static check in check-parallel.mjs.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["packages/agent/src", "packages/ai/src", "packages/coding-agent/src", "packages/tui/src"];
const SKIP = /(\.test\.ts|\.d\.ts|\.generated\.ts|[\\/]surrogate\.ts)$/;
// `.slice(...)` followed within a few chars (`)`, `}`, space) by U+2026.
const PATTERN = /\.slice\([^)]*\)[^\n]{0,6}…/;

function walk(dir, out) {
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === "dist" || e.name === "node_modules") continue;
			walk(p, out);
		} else if (e.name.endsWith(".ts") && !SKIP.test(p)) {
			out.push(p);
		}
	}
	return out;
}

const offenders = [];
for (const root of ROOTS) {
	for (const file of walk(root, [])) {
		const lines = readFileSync(file, "utf-8").split("\n");
		lines.forEach((line, i) => {
			if (PATTERN.test(line)) {
				offenders.push(`${file.replace(/\\/g, "/")}:${i + 1}: ${line.trim()}`);
			}
		});
	}
}

if (offenders.length > 0) {
	console.error("surrogate-unsafe truncation — use sliceSafe()/truncateWithEllipsis() from utils/surrogate.ts:");
	for (const o of offenders) console.error(`  ${o}`);
	process.exit(1);
}
console.log(`surrogate-slice: clean (${ROOTS.length} source roots)`);
