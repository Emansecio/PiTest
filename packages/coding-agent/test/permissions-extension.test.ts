import { describe, expect, it, vi } from "vitest";
import {
	createPermissionsExtension,
	PERMISSION_BLOCKED_CUSTOM_TYPE,
} from "../src/core/built-ins/permissions-extension.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { PermissionChecker } from "../src/core/permissions/checker.ts";

const cwd = process.platform === "win32" ? "C:/proj" : "/proj";

type Handler = (event: any, ctx?: any) => unknown;

function makeFakePi() {
	const handlers = new Map<string, Handler[]>();
	const sent: unknown[] = [];
	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool() {},
		registerCommand() {},
		sendMessage(message: unknown) {
			sent.push(message);
		},
		getOrchestration: () => "solo" as const,
		setOrchestration: vi.fn(),
	} as unknown as ExtensionAPI;
	const fire = (event: string, payload: any, ctx?: any): any => {
		let result: any;
		for (const handler of handlers.get(event) ?? []) {
			const r = handler(payload, ctx);
			if (r !== undefined && result === undefined) result = r;
		}
		return result;
	};
	return { api, fire, sent };
}

describe("permissions-extension tool_call deny", () => {
	it("blocks write in plan mode and sends a permission-blocked custom message", () => {
		const checker = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		const onDecision = vi.fn();
		const { api, fire, sent } = makeFakePi();
		createPermissionsExtension({ cwd, checker, onDecision })(api);

		const block = fire("tool_call", {
			toolName: "write",
			toolCallId: "t1",
			input: { path: "a.ts", content: "x" },
		});

		expect(block).toMatchObject({ block: true });
		expect(typeof block.reason).toBe("string");
		expect(sent[0]).toMatchObject({
			customType: PERMISSION_BLOCKED_CUSTOM_TYPE,
			display: true,
		});
		expect(onDecision).toHaveBeenCalledWith(expect.objectContaining({ toolName: "write", decision: "deny" }));
	});

	it("allows read in plan mode", () => {
		const checker = new PermissionChecker({ cwd, mode: "plan", settings: {} });
		const { api, fire, sent } = makeFakePi();
		createPermissionsExtension({ cwd, checker })(api);

		const block = fire("tool_call", {
			toolName: "read",
			toolCallId: "t1",
			input: { path: "a.ts" },
		});
		expect(block).toBeUndefined();
		expect(sent).toHaveLength(0);
	});
});
