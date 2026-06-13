/**
 * Tests for the declarative-hooks extension wiring of the two informative
 * lifecycle events: SessionStart (session_start) and PreCompact
 * (session_before_compact). Verifies the listeners are installed only when
 * configured, fire the matching hooks with the right payload, surface
 * SessionStart `additionalContext` via the UI, and respect the hook contract
 * (real spawned node command, non-zero exit logged not thrown).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHooksExtension } from "../src/core/built-ins/hooks-extension.js";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/types.js";
import type { HookExecutionResult, HooksSettings } from "../src/core/hooks/index.js";

const tempFiles: string[] = [];

afterEach(() => {
	while (tempFiles.length > 0) {
		const p = tempFiles.pop();
		if (p) {
			try {
				fs.unlinkSync(p);
			} catch {
				/* ignore */
			}
		}
	}
});

/** Writes a throwaway node script that echoes JSON on stdout and returns a `node <path>` command. */
function nodeCmd(stdoutJson: unknown, opts?: { exitCode?: number }): string {
	const exit = opts?.exitCode ?? 0;
	const script = `process.stdout.write(${JSON.stringify(JSON.stringify(stdoutJson))}); process.exit(${exit});`;
	const tempPath = path.join(os.tmpdir(), `pi-hookext-test-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
	fs.writeFileSync(tempPath, script, "utf-8");
	tempFiles.push(tempPath);
	return `node ${JSON.stringify(tempPath)}`;
}

/** A node script that records the JSON payload it received on stdin to `outPath`, then echoes JSON. */
function recordingCmd(outPath: string, stdoutJson: unknown): string {
	const script = `let buf="";process.stdin.on("data",d=>buf+=d);process.stdin.on("end",()=>{require("node:fs").writeFileSync(${JSON.stringify(
		outPath,
	)},buf);process.stdout.write(${JSON.stringify(JSON.stringify(stdoutJson))});process.exit(0);});`;
	const tempPath = path.join(os.tmpdir(), `pi-hookext-rec-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
	fs.writeFileSync(tempPath, script, "utf-8");
	tempFiles.push(tempPath);
	return `node ${JSON.stringify(tempPath)}`;
}

type Handler = (event: any, ctx: any) => unknown;

interface FakePi {
	handlers: Map<string, Handler[]>;
	api: ExtensionAPI;
}

function makeFakePi(): FakePi {
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
	} as unknown as ExtensionAPI;
	return { handlers, api };
}

interface FakeCtx {
	ctx: ExtensionContext;
	notifications: Array<{ message: string; type?: string }>;
}

function makeCtx(opts?: { hasUI?: boolean }): FakeCtx {
	const notifications: Array<{ message: string; type?: string }> = [];
	const ctx = {
		cwd: process.cwd(),
		hasUI: opts?.hasUI ?? false,
		signal: undefined,
		ui: {
			notify(message: string, type?: string) {
				notifications.push({ message, type });
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, notifications };
}

function makePreparation(over?: Record<string, unknown>) {
	return {
		firstKeptEntryId: "e1",
		messagesToSummarize: [{ role: "user" }, { role: "assistant" }, { role: "user" }],
		turnPrefixMessages: [{ role: "user" }],
		isSplitTurn: true,
		tokensBefore: 12_345,
		fileOps: {},
		settings: {},
		cwd: process.cwd(),
		...over,
	};
}

describe("hooks-extension lifecycle events", () => {
	it("installs no session listeners when nothing is configured", () => {
		const { handlers, api } = makeFakePi();
		createHooksExtension({ settings: {}, cwd: process.cwd() })(api);
		expect(handlers.has("session_start")).toBe(false);
		expect(handlers.has("session_before_compact")).toBe(false);
	});

	it("does not install the SessionStart listener when only PreCompact is set", () => {
		const { handlers, api } = makeFakePi();
		const settings: HooksSettings = { PreCompact: [{ command: nodeCmd({}) }] };
		createHooksExtension({ settings, cwd: process.cwd() })(api);
		expect(handlers.has("session_start")).toBe(false);
		expect(handlers.has("session_before_compact")).toBe(true);
	});

	it("fires SessionStart hooks on session_start with the reason payload", async () => {
		const outPath = path.join(os.tmpdir(), `pi-hookext-ss-${Date.now()}.json`);
		tempFiles.push(outPath);
		const executions: HookExecutionResult[] = [];
		const { handlers, api } = makeFakePi();
		const settings: HooksSettings = { SessionStart: [{ command: recordingCmd(outPath, { decision: "allow" }) }] };
		createHooksExtension({
			settings,
			cwd: process.cwd(),
			onExecution: (_e, r) => executions.push(r),
		})(api);

		const handler = handlers.get("session_start")?.[0];
		expect(handler).toBeDefined();
		const { ctx } = makeCtx({ hasUI: false });
		await handler?.({ type: "session_start", reason: "resume" }, ctx);

		expect(executions).toHaveLength(1);
		expect(executions[0].exitCode).toBe(0);
		const sent = JSON.parse(fs.readFileSync(outPath, "utf-8"));
		expect(sent.event).toBe("SessionStart");
		expect(sent.reason).toBe("resume");
		expect(sent.cwd).toBe(process.cwd());
	});

	it("surfaces SessionStart additionalContext via the UI when one is available", async () => {
		const { handlers, api } = makeFakePi();
		const settings: HooksSettings = {
			SessionStart: [{ command: nodeCmd({ additionalContext: "project uses pnpm" }) }],
		};
		createHooksExtension({ settings, cwd: process.cwd() })(api);

		const handler = handlers.get("session_start")?.[0];
		const { ctx, notifications } = makeCtx({ hasUI: true });
		await handler?.({ type: "session_start", reason: "startup" }, ctx);

		expect(notifications).toHaveLength(1);
		expect(notifications[0].message).toContain("project uses pnpm");
		expect(notifications[0].type).toBe("info");
	});

	it("does not notify when no UI is available", async () => {
		const { handlers, api } = makeFakePi();
		const settings: HooksSettings = {
			SessionStart: [{ command: nodeCmd({ additionalContext: "hidden" }) }],
		};
		createHooksExtension({ settings, cwd: process.cwd() })(api);

		const handler = handlers.get("session_start")?.[0];
		const { ctx, notifications } = makeCtx({ hasUI: false });
		await handler?.({ type: "session_start", reason: "startup" }, ctx);
		expect(notifications).toHaveLength(0);
	});

	it("fires PreCompact hooks with only light, derived facts (no heavy arrays)", async () => {
		const outPath = path.join(os.tmpdir(), `pi-hookext-pc-${Date.now()}.json`);
		tempFiles.push(outPath);
		const { handlers, api } = makeFakePi();
		const settings: HooksSettings = { PreCompact: [{ command: recordingCmd(outPath, {}) }] };
		createHooksExtension({ settings, cwd: process.cwd() })(api);

		const handler = handlers.get("session_before_compact")?.[0];
		expect(handler).toBeDefined();
		const { ctx } = makeCtx();
		const result = await handler?.(
			{
				type: "session_before_compact",
				preparation: makePreparation({ previousSummary: "old" }),
				branchEntries: [],
				signal: new AbortController().signal,
			},
			ctx,
		);

		// Informative only — never cancels or customizes compaction.
		expect(result).toBeUndefined();

		const sent = JSON.parse(fs.readFileSync(outPath, "utf-8"));
		expect(sent.event).toBe("PreCompact");
		expect(sent.tokensBefore).toBe(12_345);
		expect(sent.messagesToSummarize).toBe(3); // count, not the array
		expect(sent.turnPrefixMessages).toBe(1);
		expect(sent.isSplitTurn).toBe(true);
		expect(sent.hasPreviousSummary).toBe(true);
		// Heavy fields must NOT leak.
		expect(sent.fileOps).toBeUndefined();
		expect(sent.settings).toBeUndefined();
		expect(Array.isArray(sent.messagesToSummarize)).toBe(false);
	});

	it("respects the hook contract: non-zero PreCompact exit is logged, not thrown", async () => {
		const executions: HookExecutionResult[] = [];
		const { handlers, api } = makeFakePi();
		const settings: HooksSettings = { PreCompact: [{ command: nodeCmd({}, { exitCode: 3 }) }] };
		createHooksExtension({
			settings,
			cwd: process.cwd(),
			onExecution: (_e, r) => executions.push(r),
		})(api);

		const handler = handlers.get("session_before_compact")?.[0];
		const { ctx } = makeCtx();
		// Must not throw despite the non-zero exit; compaction proceeds (returns undefined).
		const result = await handler?.(
			{
				type: "session_before_compact",
				preparation: makePreparation(),
				branchEntries: [],
				signal: new AbortController().signal,
			},
			ctx,
		);
		expect(result).toBeUndefined();
		expect(executions).toHaveLength(1);
		expect(executions[0].exitCode).toBe(3);
	});

	it("respects the PreCompact hook timeout", async () => {
		const tempPath = path.join(os.tmpdir(), `pi-hookext-slow-${Date.now()}.js`);
		fs.writeFileSync(tempPath, "setTimeout(()=>process.exit(0), 5000);", "utf-8");
		tempFiles.push(tempPath);
		const executions: HookExecutionResult[] = [];
		const { handlers, api } = makeFakePi();
		const settings: HooksSettings = {
			PreCompact: [{ command: `node ${JSON.stringify(tempPath)}`, timeoutMs: 100 }],
		};
		createHooksExtension({
			settings,
			cwd: process.cwd(),
			onExecution: (_e, r) => executions.push(r),
		})(api);

		const handler = handlers.get("session_before_compact")?.[0];
		const { ctx } = makeCtx();
		await handler?.(
			{
				type: "session_before_compact",
				preparation: makePreparation(),
				branchEntries: [],
				signal: new AbortController().signal,
			},
			ctx,
		);
		expect(executions).toHaveLength(1);
		expect(executions[0].timedOut).toBe(true);
	});
});
