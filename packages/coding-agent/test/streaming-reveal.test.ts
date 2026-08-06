/**
 * End-to-end streaming reveal through the REAL InteractiveMode (headless
 * harness): provider bursts → message_update → AssistantMessageComponent
 * reveal → rendered transcript.
 *
 * The coarse-cadence case replays a live-measured Anthropic OAuth stream
 * (~70-char SSE events every ~470ms, near-constant): the reveal must bridge
 * those gaps instead of draining each burst in ~130ms and freezing the
 * wavefront for the remainder — the "response arrives in blocks" regression.
 * The gap-aware spread lives in assistant-message.ts (spreadFrames).
 */

import { afterEach, describe, expect, test } from "vitest";
import { createInteractiveHarness, type InteractiveHarness } from "./interactive-harness.ts";

let harness: InteractiveHarness | undefined;

afterEach(() => {
	harness?.dispose();
	harness = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function assistantMessage(text: string, stopReason?: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		...(stopReason ? { stopReason } : {}),
	};
}

function visibleChars(h: InteractiveHarness): number {
	return h.chatText().replace(/[^a-z0-9]/gi, "").length;
}

/** Feed a growing text in `chunks` bursts; sample visible chars after each. */
async function driveStream(h: InteractiveHarness, chunks: string[]): Promise<number[]> {
	let text = "";
	const visible: number[] = [];
	await h.emit({ type: "agent_start" } as never);
	await h.emit({ type: "message_start", message: assistantMessage("") } as never);
	for (const chunk of chunks) {
		text += chunk;
		await h.emit({
			type: "message_update",
			message: assistantMessage(text),
			assistantMessageEvent: { type: "text_delta", delta: chunk },
		} as never);
		// Give the animation ticker frames to advance the reveal (smoothing path).
		await sleep(60);
		visible.push(visibleChars(h));
	}
	return visible;
}

const CHUNKS = Array.from({ length: 12 }, (_, i) => `word${i} lorem ipsum dolor sit amet consectetur `);

describe("streaming reveal (headless InteractiveMode)", () => {
	test("smoothing OFF: each provider burst is visible after its update", async () => {
		harness = createInteractiveHarness({ streamingSmoothing: false });
		const visible = await driveStream(harness, CHUNKS);
		for (let i = 1; i < visible.length; i++) {
			expect(visible[i], `sample ${i}: ${JSON.stringify(visible)}`).toBeGreaterThan(visible[i - 1]);
		}
		expect(visible[0]).toBeGreaterThan(0);
	});

	test("smoothing ON (production default): text flows between bursts", async () => {
		harness = createInteractiveHarness({ streamingSmoothing: true });
		const visible = await driveStream(harness, CHUNKS);
		const midpoint = visible[Math.floor(visible.length / 2)];
		expect(midpoint, `progression: ${JSON.stringify(visible)}`).toBeGreaterThan(0);
		for (let i = 1; i < visible.length; i++) {
			expect(visible[i], `sample ${i}: ${JSON.stringify(visible)}`).toBeGreaterThanOrEqual(visible[i - 1]);
		}
		const growth = visible.filter((v, i) => i > 0 && v > visible[i - 1]).length;
		expect(growth, `progression: ${JSON.stringify(visible)}`).toBeGreaterThanOrEqual(Math.floor(CHUNKS.length / 2));
	});

	test("coarse provider cadence (live-measured: ~70 chars / ~470ms): reveal bridges the gaps", async () => {
		harness = createInteractiveHarness({ streamingSmoothing: true });
		const h = harness;
		await h.emit({ type: "agent_start" } as never);
		await h.emit({ type: "message_start", message: assistantMessage("") } as never);

		const burst = "the quick brown fox jumps over the lazy dog and keeps running on ";
		let text = "";
		const samples: Array<{ t: number; chars: number }> = [];
		const t0 = performance.now();
		for (let i = 0; i < 8; i++) {
			text += burst;
			await h.emit({
				type: "message_update",
				message: assistantMessage(text),
				assistantMessageEvent: { type: "text_delta", delta: burst },
			} as never);
			const gapEnd = performance.now() + 470;
			while (performance.now() < gapEnd) {
				await sleep(30);
				samples.push({ t: performance.now() - t0, chars: visibleChars(h) });
			}
		}
		let frozenMs = 0;
		let worstFrozenMs = 0;
		for (let i = 1; i < samples.length; i++) {
			if (samples[i].chars > samples[i - 1].chars) {
				frozenMs = 0;
			} else {
				frozenMs += samples[i].t - samples[i - 1].t;
				worstFrozenMs = Math.max(worstFrozenMs, frozenMs);
			}
		}
		// The user-visible symptom: motion stopping for most of an inter-burst gap.
		expect(worstFrozenMs, "longest mid-stream freeze").toBeLessThan(250);
	}, 30000);

	test("long markdown answer: per-update event cost and full render stay bounded", async () => {
		harness = createInteractiveHarness({ streamingSmoothing: true });
		const h = harness;
		await h.emit({ type: "agent_start" } as never);
		await h.emit({ type: "message_start", message: assistantMessage("") } as never);

		const piece = (i: number) =>
			i % 20 === 10
				? `\n\`\`\`ts\nconst x${i} = compute(${i});\n\`\`\`\n`
				: `Paragraph ${i} with some **bold** and \`inline\` code. `;
		let text = "";
		const emitMs: number[] = [];
		let lastRenderMs = 0;
		for (let i = 0; i < 250; i++) {
			text += piece(i);
			const t0 = performance.now();
			await h.emit({
				type: "message_update",
				message: assistantMessage(text),
				assistantMessageEvent: { type: "text_delta", delta: piece(i) },
			} as never);
			emitMs.push(performance.now() - t0);
			if (i % 10 === 9) {
				const r0 = performance.now();
				h.chatText();
				lastRenderMs = performance.now() - r0;
			}
		}
		const tail = emitMs.slice(-25);
		const tailAvg = tail.reduce((a, b) => a + b, 0) / tail.length;
		// Costs above the 16ms coalescer cadence would queue updates and land the
		// paint in blocks — the exact symptom the coarse-cadence case guards.
		expect(tailAvg, "tail per-update event cost").toBeLessThan(16);
		expect(lastRenderMs, `full container render at ${text.length} chars`).toBeLessThan(16);
	}, 60000);
});
