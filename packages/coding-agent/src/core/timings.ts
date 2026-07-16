/**
 * Central timing instrumentation for startup profiling.
 * Enable with PIT_TIMING=1 environment variable.
 */

const ENABLED = process.env.PIT_TIMING === "1";
const timings: Array<{ label: string; ms: number }> = [];
/**
 * Absolute milestones measured with performance.now(), whose origin is process
 * start — so a milestone recorded at the top of cli.ts captures the otherwise
 * invisible pre-main() cost (node + tsx bootstrap + eager import eval). Kept in
 * a separate list that resetTimings() does NOT clear, since main() resets the
 * delta timings after the milestones were recorded.
 */
const milestones: Array<{ label: string; ms: number }> = [];
let lastTime = Date.now();

export function resetTimings(): void {
	if (!ENABLED) return;
	timings.length = 0;
	lastTime = Date.now();
}

export function time(label: string): void {
	if (!ENABLED) return;
	const now = Date.now();
	timings.push({ label, ms: now - lastTime });
	lastTime = now;
}

/** Record an absolute milestone: milliseconds elapsed since process start. */
export function markMilestone(label: string): void {
	if (!ENABLED) return;
	milestones.push({ label, ms: Math.round(performance.now()) });
}

export function printTimings(): void {
	if (!ENABLED || (timings.length === 0 && milestones.length === 0)) return;
	console.error("\n--- Startup Timings ---");
	for (const m of milestones) {
		console.error(`  ${m.label}: ${m.ms}ms since process start`);
	}
	for (const t of timings) {
		console.error(`  ${t.label}: ${t.ms}ms`);
	}
	console.error(`  TOTAL: ${timings.reduce((a, b) => a + b.ms, 0)}ms`);
	console.error("------------------------\n");
}
