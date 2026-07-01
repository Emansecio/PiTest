/**
 * Unit tests for `decideRoleForPermissionMode` — the pure decision function
 * that maps a permission-mode change to a model role swap. No TUI, no session.
 */

import { describe, expect, it } from "vitest";
import { decideRoleForPermissionMode } from "../src/core/model-resolver.ts";

const planConfig = { model: "anthropic/claude-opus-4-8" };

describe("decideRoleForPermissionMode", () => {
	it("entering plan mode returns 'plan' when a plan role is configured", () => {
		expect(decideRoleForPermissionMode("plan", "default", planConfig)).toBe("plan");
	});

	it("entering plan mode is a no-op when no plan role is configured", () => {
		expect(decideRoleForPermissionMode("plan", "default", undefined)).toBeUndefined();
	});

	it("leaving plan mode restores 'default' only when still on the plan role", () => {
		expect(decideRoleForPermissionMode("auto", "plan", planConfig)).toBe("default");
	});

	it("leaving plan mode does not clobber a role the user picked manually", () => {
		expect(decideRoleForPermissionMode("auto", "smol", planConfig)).toBeUndefined();
		expect(decideRoleForPermissionMode("auto", "slow", planConfig)).toBeUndefined();
	});

	it("staying in auto with the default role is a no-op", () => {
		expect(decideRoleForPermissionMode("auto", "default", planConfig)).toBeUndefined();
	});
});
