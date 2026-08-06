/**
 * Tests for the fourth Permission facet: `confirm` (confirm-writes).
 *
 * Three layers, in order:
 *  1. the pure checker terminal (`checkConfirm`) — what defers, what is
 *     pre-approved by the allowlists, and who wins when rules collide;
 *  2. every consumer of a `PermissionDecision` (no silent fall-through to allow);
 *  3. the resolution layer — interactive once/session/deny, and headless deny.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createPermissionsExtension } from "../src/core/built-ins/permissions-extension.ts";
import { evaluateSubagentToolPermission } from "../src/core/coordinator/spawn.ts";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import { describeToolAction, PermissionChecker } from "../src/core/permissions/checker.ts";
import {
	CONFIRM_ALLOW_ONCE_LABEL,
	CONFIRM_ALLOW_SESSION_LABEL,
	CONFIRM_DENY_LABEL,
	commandPrefixPattern,
	resolveConfirmDecision,
	sessionRuleForAction,
} from "../src/core/permissions/confirm-gate.ts";
import { buildConfirmModeSection } from "../src/core/permissions/confirm-mode-prompt.ts";
import { formatPermissionBlockedContent, humanModeNotifyLabel } from "../src/core/permissions/mode-labels.ts";
import { buildPermissionModeSection } from "../src/core/permissions/mode-prompt.ts";
import type { PermissionSettings } from "../src/core/permissions/types.ts";
import { createUserInputBus, setCurrentUserInputBus } from "../src/core/user-input-bus.ts";

const cwd = process.platform === "win32" ? "C:/proj" : "/proj";
const abs = (p: string) => `${cwd}/${p}`;

const confirm = (settings: PermissionSettings = {}) => new PermissionChecker({ cwd, mode: "confirm", settings });

// ---------------------------------------------------------------------------
// 1. Checker terminal
// ---------------------------------------------------------------------------

describe("PermissionChecker — confirm terminal", () => {
	it("lets reads run free (no prompt)", () => {
		expect(confirm().check(describeToolAction("read", { path: "src/a.ts" })).decision).toBe("allow");
		expect(confirm().check(describeToolAction("grep", { pattern: "x" })).decision).toBe("allow");
	});

	it("defers a write, naming the target in the reason", () => {
		const d = confirm().check(describeToolAction("write", { path: "src/x.ts", content: "y" }));
		expect(d.decision).toBe("confirm");
		expect(d.decision === "confirm" && d.reason).toContain("src/x.ts");
	});

	it("defers an exec with the (truncated) command in the reason", () => {
		const d = confirm().check(describeToolAction("bash", { command: "git push origin main" }));
		expect(d.decision).toBe("confirm");
		expect(d.decision === "confirm" && d.reason).toContain("git push origin main");
	});

	it("truncates a huge command line to keep the prompt one line", () => {
		const d = confirm().check(describeToolAction("bash", { command: `echo ${"x".repeat(300)}` }));
		expect(d.decision === "confirm" && d.reason.length).toBeLessThan(120);
	});

	it("allows side-effect-free tools and defers every other side effect", () => {
		const c = confirm();
		expect(c.check(describeToolAction("todo", { action: "list" })).decision).toBe("allow");
		expect(c.check(describeToolAction("plan", { action: "propose" })).decision).toBe("allow");
		// workspace / agent / exec / opaque
		expect(c.check(describeToolAction("memory_append", { entry: "x" })).decision).toBe("confirm");
		expect(c.check(describeToolAction("retain", { content: "x" })).decision).toBe("confirm");
		expect(c.check(describeToolAction("eval", { code: "1+1" })).decision).toBe("confirm");
		expect(c.check({ type: "tool", toolName: "totally_unknown_ext", args: {} }).decision).toBe("confirm");
	});

	it("defers every mcp__* tool", () => {
		expect(confirm().check(describeToolAction("mcp__github__create_issue", { title: "x" })).decision).toBe("confirm");
	});

	it("denies spawn outright — a headless subagent cannot raise a prompt", () => {
		const c = confirm();
		for (const tool of ["task", "parallel", "fanout"]) {
			const d = c.check(describeToolAction(tool, { prompt: "x" }));
			expect(d.decision, tool).toBe("deny");
			expect(d.decision === "deny" && d.reason).toContain("cannot prompt for approval");
		}
	});

	it("lets allowTools pre-approve a spawn (the documented way in)", () => {
		expect(confirm({ allowTools: ["task"] }).check(describeToolAction("task", { prompt: "x" })).decision).toBe(
			"allow",
		);
	});

	// --- allowlists are the "don't ask me again" surface ---------------------

	it("skips the prompt when every write path matches allowPaths", () => {
		const c = confirm({ allowPaths: [{ glob: "**/src/**" }] });
		expect(c.check(describeToolAction("write", { path: "src/x.ts", content: "y" })).decision).toBe("allow");
	});

	it("still prompts when ONE path of a multi-file edit is uncovered", () => {
		const c = confirm({ allowPaths: [{ glob: "**/src/**" }] });
		const action = describeToolAction("edit", {
			path: "src/a.ts",
			edits: [{ path: "docs/b.md", oldText: "a", newText: "b" }],
		});
		expect(c.check(action).decision).toBe("confirm");
	});

	it("prompts for a mutating tool that exposes no path at all", () => {
		expect(confirm().check(describeToolAction("chrome_devtools_click", { uid: "x" })).decision).toBe("confirm");
	});

	it("skips the prompt when the command matches allowCommands", () => {
		const c = confirm({ allowCommands: [{ pattern: "^npm test" }] });
		expect(c.check(describeToolAction("bash", { command: "npm test -- --run" })).decision).toBe("allow");
		expect(c.check(describeToolAction("bash", { command: "npm publish" })).decision).toBe("confirm");
	});

	// --- precedence ----------------------------------------------------------

	it("deny rules win over the prompt (built-in floor)", () => {
		const c = confirm();
		expect(c.check(describeToolAction("write", { path: ".env", content: "x" })).decision).toBe("deny");
		expect(c.check(describeToolAction("bash", { command: "rm -rf /" })).decision).toBe("deny");
		expect(c.check(describeToolAction("read", { path: ".ssh/id_rsa" })).decision).toBe("deny");
	});

	it("denyTools wins over everything, including the allowTools bypass", () => {
		const c = confirm({ denyTools: ["write"], allowTools: ["write"] });
		expect(c.check(describeToolAction("write", { path: "src/a.ts", content: "y" })).decision).toBe("deny");
	});

	it("user deny rules win even when allowPaths would have pre-approved the write", () => {
		const c = confirm({
			allowPaths: [{ glob: "**/src/**" }],
			denyPaths: [{ glob: "**/src/secret.ts" }],
		});
		expect(c.check(describeToolAction("write", { path: "src/secret.ts", content: "y" })).decision).toBe("deny");
	});

	it("allowlistOnly wins over confirm — CI must never park on a prompt", () => {
		const c = new PermissionChecker({
			cwd,
			mode: "confirm",
			settings: { allowlistOnly: true, allowPaths: [{ glob: "**/src/**" }] },
		});
		// Uncovered → deny (fail-closed), NOT confirm.
		const denied = c.check(describeToolAction("write", { path: "docs/a.md", content: "y" }));
		expect(denied.decision).toBe("deny");
		expect(denied.decision === "deny" && denied.reason).toContain("Fail-closed");
		// Covered → allow, still without a prompt.
		expect(c.check(describeToolAction("write", { path: "src/a.ts", content: "y" })).decision).toBe("allow");
		// And nothing anywhere defers.
		expect(c.check(describeToolAction("bash", { command: "npm test" })).decision).toBe("deny");
	});

	it("never emits confirm in the other three modes (auto/plan/ask are unchanged)", () => {
		const actions = [
			describeToolAction("write", { path: "src/a.ts", content: "y" }),
			describeToolAction("bash", { command: "npm test" }),
			describeToolAction("read", { path: "src/a.ts" }),
			describeToolAction("task", { prompt: "x" }),
			describeToolAction("mcp__x__y", {}),
		];
		for (const mode of ["auto", "plan", "ask"] as const) {
			const c = new PermissionChecker({ cwd, mode, settings: {} });
			for (const action of actions) {
				expect(c.check(action).decision, `${mode}/${action.toolName}`).not.toBe("confirm");
			}
		}
	});
});

// ---------------------------------------------------------------------------
// 2. Consumers of PermissionDecision
// ---------------------------------------------------------------------------

describe("confirm is handled explicitly by every decision consumer", () => {
	it("subagent gating blocks a deferral (headless — nobody to approve)", () => {
		// A `write` reaches the confirm terminal; the subagent gate must not read
		// "not a deny" as "allow".
		const checker = confirm();
		const blocked = evaluateSubagentToolPermission(checker, "write", { path: "src/a.ts", content: "y" });
		expect(blocked).toMatchObject({ block: true });
		expect(blocked?.reason).toContain("cannot prompt for approval");
	});

	it("subagent gating still allows a pre-approved write", () => {
		const checker = confirm({ allowPaths: [{ glob: "**/src/**" }] });
		expect(evaluateSubagentToolPermission(checker, "write", { path: "src/a.ts", content: "y" })).toBeUndefined();
	});

	it("exhaustiveness: the decision union has exactly the three known variants", () => {
		// A new variant added without updating the consumers below would fail here.
		const seen = new Set<string>();
		const c = confirm({ denyTools: ["forbidden"] });
		seen.add(c.check(describeToolAction("read", { path: "a.ts" })).decision);
		seen.add(c.check(describeToolAction("write", { path: "a.ts", content: "" })).decision);
		seen.add(c.check({ type: "tool", toolName: "forbidden", args: {} }).decision);
		expect([...seen].sort()).toEqual(["allow", "confirm", "deny"]);
	});
});

// ---------------------------------------------------------------------------
// 3. Resolution
// ---------------------------------------------------------------------------

/** Bind a bus whose listener answers with `picked`, and return it. */
function bindBus(picked: string[] | "cancel") {
	const bus = createUserInputBus();
	const requests: any[] = [];
	bus.onRequest((req) => {
		requests.push(req);
		if (picked === "cancel") {
			bus.resolve(req.requestId, { picked: [], cancelled: true });
			return;
		}
		bus.resolve(req.requestId, { picked, cancelled: false });
	});
	setCurrentUserInputBus(bus);
	return { bus, requests };
}

describe("resolveConfirmDecision — interactive", () => {
	// The input bus is a module-level singleton — never leak it between tests.
	afterEach(() => setCurrentUserInputBus(undefined));

	it("Allow once runs the call and remembers nothing", async () => {
		const { requests } = bindBus([CONFIRM_ALLOW_ONCE_LABEL]);
		const checker = confirm();
		const action = describeToolAction("write", { path: "src/x.ts", content: "y" });
		const res = await resolveConfirmDecision(checker, action, "write → src/x.ts");
		expect(res).toEqual({ decision: "allow" });
		expect(checker.settings.allowPaths ?? []).toHaveLength(0);
		// Deny is listed FIRST so any auto-answer path lands on the safe choice.
		expect(requests[0].options[0].label).toBe(CONFIRM_DENY_LABEL);
		expect(requests[0].options.map((o: any) => o.label)).toEqual([
			CONFIRM_DENY_LABEL,
			CONFIRM_ALLOW_ONCE_LABEL,
			CONFIRM_ALLOW_SESSION_LABEL,
		]);
	});

	it("Allow for session records an allowPaths rule and stops asking", async () => {
		bindBus([CONFIRM_ALLOW_SESSION_LABEL]);
		const checker = confirm();
		const action = describeToolAction("write", { path: "src/x.ts", content: "y" });
		const res = await resolveConfirmDecision(checker, action, "write → src/x.ts");
		expect(res).toMatchObject({ decision: "allow", remembered: true });
		expect(checker.settings.allowPaths?.map((r) => r.glob)).toEqual([abs("src/x.ts")]);
		// The very next identical write no longer defers.
		expect(checker.check(action).decision).toBe("allow");
	});

	it("Allow for session on a command records a prefix regex, not the whole line", async () => {
		bindBus([CONFIRM_ALLOW_SESSION_LABEL]);
		const checker = confirm();
		const action = describeToolAction("bash", { command: "git push origin main --force-with-lease" });
		await resolveConfirmDecision(checker, action, "run `git push …`");
		expect(checker.settings.allowCommands?.map((r) => r.pattern)).toEqual(["^git\\s+push\\b"]);
		expect(checker.check(describeToolAction("bash", { command: "git push upstream dev" })).decision).toBe("allow");
		// A different git subcommand is NOT covered by the grant.
		expect(checker.check(describeToolAction("bash", { command: "git reset --hard" })).decision).toBe("confirm");
	});

	it("Allow for session on a tool records the tool name in allowTools", async () => {
		bindBus([CONFIRM_ALLOW_SESSION_LABEL]);
		const checker = confirm();
		const action = describeToolAction("mcp__github__create_issue", { title: "x" });
		await resolveConfirmDecision(checker, action, 'run tool "mcp__github__create_issue"');
		expect(checker.settings.allowTools).toEqual(["mcp__github__create_issue"]);
		expect(checker.check(action).decision).toBe("allow");
	});

	it("the prompt shows what a session grant would record", async () => {
		const { requests } = bindBus([CONFIRM_DENY_LABEL]);
		await resolveConfirmDecision(confirm(), describeToolAction("bash", { command: "npm test" }), "run `npm test`");
		const sessionOption = requests[0].options.find((o: any) => o.label === CONFIRM_ALLOW_SESSION_LABEL);
		expect(sessionOption.description).toContain("^npm\\s+test\\b");
	});

	it("omits the session option when there is nothing matchable to remember", async () => {
		const { requests } = bindBus([CONFIRM_DENY_LABEL]);
		await resolveConfirmDecision(
			confirm(),
			describeToolAction("chrome_devtools_click", { uid: "x" }),
			"chrome_devtools_click",
		);
		expect(requests[0].options.map((o: any) => o.label)).toEqual([CONFIRM_DENY_LABEL, CONFIRM_ALLOW_ONCE_LABEL]);
	});

	it("Deny blocks the call and remembers nothing", async () => {
		bindBus([CONFIRM_DENY_LABEL]);
		const checker = confirm();
		const res = await resolveConfirmDecision(
			checker,
			describeToolAction("write", { path: "src/x.ts", content: "y" }),
			"write → src/x.ts",
		);
		expect(res.decision).toBe("deny");
		expect(res.reason).toContain("User denied");
		expect(checker.settings.allowPaths ?? []).toHaveLength(0);
	});

	it("cancel (Esc / timeout) denies — fail-closed", async () => {
		bindBus("cancel");
		const res = await resolveConfirmDecision(
			confirm(),
			describeToolAction("write", { path: "src/x.ts", content: "y" }),
			"write → src/x.ts",
		);
		expect(res.decision).toBe("deny");
	});
});

describe("resolveConfirmDecision — headless channels", () => {
	// The input bus is a module-level singleton — never leak it between tests.
	afterEach(() => setCurrentUserInputBus(undefined));

	it("denies with actionable copy when no interactive listener is bound", async () => {
		setCurrentUserInputBus(undefined);
		const res = await resolveConfirmDecision(
			confirm(),
			describeToolAction("write", { path: "src/x.ts", content: "y" }),
			'write to "src/x.ts"',
		);
		expect(res.decision).toBe("deny");
		expect(res.reason).toBe(
			'confirm mode requires an interactive session to approve "write to "src/x.ts"" — run interactively, or use auto (or allowlistOnly for CI).',
		);
	});

	it("denies when a bus exists but nothing is listening (print/RPC)", async () => {
		setCurrentUserInputBus(createUserInputBus());
		const res = await resolveConfirmDecision(
			confirm(),
			describeToolAction("bash", { command: "npm test" }),
			"run `npm test`",
		);
		expect(res.decision).toBe("deny");
		expect(res.reason).toContain("requires an interactive session");
	});
});

describe("session-rule derivation", () => {
	it("derives a prefix pattern from the executable and its subcommand", () => {
		expect(commandPrefixPattern("git push origin main")).toBe("^git\\s+push\\b");
		expect(commandPrefixPattern("npm  test -- --run")).toBe("^npm\\s+test\\b");
		expect(commandPrefixPattern("ls")).toBe("^ls\\b");
		// Flags and paths are not subcommands.
		expect(commandPrefixPattern("rg -n pattern")).toBe("^rg\\b");
		expect(commandPrefixPattern("./build.sh --clean")).toBe("^\\./build\\.sh\\b");
		expect(commandPrefixPattern("   ")).toBe("");
	});

	it("normalizes write paths to absolute globs so the checker can match them", () => {
		const rule = sessionRuleForAction(cwd, describeToolAction("write", { path: "src/x.ts", content: "" }));
		expect(rule).toEqual({ kind: "paths", globs: [abs("src/x.ts")] });
	});

	it("has nothing to remember for a pathless mutation", () => {
		expect(sessionRuleForAction(cwd, describeToolAction("chrome_devtools_click", { uid: "x" }))).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Wiring: extension, labels, prompt
// ---------------------------------------------------------------------------

function makeFakePi() {
	const handlers = new Map<string, ((event: any, ctx?: any) => unknown)[]>();
	const sent: any[] = [];
	const tools: ToolDefinition[] = [];
	const commands = new Map<string, { handler: (args: string, ctx: any) => unknown }>();
	const api = {
		on(event: string, handler: (event: any, ctx?: any) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		registerCommand: (name: string, def: any) => commands.set(name, def),
		sendMessage: (m: unknown) => sent.push(m),
		getOrchestration: () => "solo" as const,
		setOrchestration: vi.fn(),
	} as unknown as ExtensionAPI;
	const fire = async (event: string, payload: any, ctx?: any) => {
		let result: any;
		for (const handler of handlers.get(event) ?? []) {
			const r = await handler(payload, ctx);
			if (r !== undefined && result === undefined) result = r;
		}
		return result;
	};
	return { api, fire, sent, tools, commands };
}

describe("permissions-extension in confirm mode", () => {
	// The input bus is a module-level singleton — never leak it between tests.
	afterEach(() => setCurrentUserInputBus(undefined));

	it("blocks a tool call the user denied and posts the transcript notice", async () => {
		bindBus([CONFIRM_DENY_LABEL]);
		const checker = confirm();
		const onDecision = vi.fn();
		const { api, fire, sent } = makeFakePi();
		createPermissionsExtension({ cwd, checker, onDecision })(api);

		const block = await fire("tool_call", {
			toolName: "write",
			toolCallId: "t1",
			input: { path: "a.ts", content: "" },
		});
		expect(block).toMatchObject({ block: true });
		expect(sent).toHaveLength(1);
		// The audit callback only ever sees a resolved verdict, never "confirm".
		expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ toolName: "write", decision: "deny" }));
	});

	it("lets an approved tool call through and audits it as allow", async () => {
		bindBus([CONFIRM_ALLOW_ONCE_LABEL]);
		const checker = confirm();
		const onDecision = vi.fn();
		const { api, fire, sent } = makeFakePi();
		createPermissionsExtension({ cwd, checker, onDecision })(api);

		const block = await fire("tool_call", {
			toolName: "write",
			toolCallId: "t1",
			input: { path: "a.ts", content: "" },
		});
		expect(block).toBeUndefined();
		expect(sent).toHaveLength(0);
		expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ decision: "allow" }));
	});

	it("blocks without any prompt in a headless channel", async () => {
		setCurrentUserInputBus(undefined);
		const { api, fire } = makeFakePi();
		createPermissionsExtension({ cwd, checker: confirm() })(api);
		const block = await fire("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "npm test" } });
		expect(block).toMatchObject({ block: true });
		expect(block.reason).toContain("requires an interactive session");
	});

	it("resolves the <confirm_mode> section from the mode, and no longer appends it per-turn", async () => {
		const { api, fire } = makeFakePi();
		createPermissionsExtension({ cwd, checker: confirm() })(api);
		// The section is now a cacheable-prefix input the host renders
		// (BuildSystemPromptOptions.permissionModeSection), not a per-turn append —
		// re-billing it on every request of every turn is the cost this avoids.
		expect(buildPermissionModeSection("confirm")).toContain("<confirm_mode>");
		expect(await fire("before_agent_start", { systemPrompt: "BASE" })).toBeUndefined();
	});

	it("accepts `/permission-mode confirm`", async () => {
		const checker = new PermissionChecker({ cwd, mode: "auto", settings: {} });
		const { api, commands } = makeFakePi();
		const onModeChange = vi.fn();
		createPermissionsExtension({ cwd, checker, onModeChange })(api);
		const ctx = { ui: { notify: vi.fn(), setStatus: vi.fn() } };
		await commands.get("permission-mode")!.handler("confirm", ctx);
		expect(checker.mode).toBe("confirm");
		expect(onModeChange).toHaveBeenCalledWith("confirm");
	});
});

describe("<confirm_mode> prompt section", () => {
	const s = buildConfirmModeSection();

	it("is wrapped in its own tag", () => {
		expect(s.startsWith("<confirm_mode>")).toBe(true);
		expect(s.trimEnd().endsWith("</confirm_mode>")).toBe(true);
	});

	it("states that mutations pause for approval and that reads are free", () => {
		expect(s).toContain("MUTATION");
		expect(s.toLowerCase()).toContain("approve");
		expect(s.toLowerCase()).toContain("reads run freely");
	});

	it("asks the model to batch mutations", () => {
		expect(s.toLowerCase()).toContain("batch");
	});

	it("bans the plan ritual explicitly", () => {
		expect(s).toContain("NO plan ritual");
		expect(s).toContain("exit_plan");
	});
});

describe("confirm labels", () => {
	it("has its own notify copy", () => {
		expect(humanModeNotifyLabel("solo", "confirm")).toContain("Confirm");
		expect(humanModeNotifyLabel("solo", "confirm")).not.toBe(humanModeNotifyLabel("solo", "auto"));
	});

	it("has its own blocked-content hint (no read-only claim)", () => {
		const line = formatPermissionBlockedContent("write", undefined, "confirm");
		expect(line).toContain("confirm mode");
		expect(line).not.toContain("read-only");
	});
});
