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

	it("leaving plan mode restores 'default' when no pre-plan role was snapshotted", () => {
		expect(decideRoleForPermissionMode("auto", "plan", planConfig)).toBe("default");
	});

	it("leaving plan mode restores the pre-plan role when snapshotted", () => {
		expect(decideRoleForPermissionMode("auto", "plan", planConfig, "smol")).toBe("smol");
		expect(decideRoleForPermissionMode("auto", "plan", planConfig, "slow")).toBe("slow");
	});

	it("leaving plan mode does not clobber a role the user picked manually", () => {
		expect(decideRoleForPermissionMode("auto", "smol", planConfig, "default")).toBeUndefined();
		expect(decideRoleForPermissionMode("auto", "slow", planConfig)).toBeUndefined();
	});

	it("staying in auto with the default role is a no-op", () => {
		expect(decideRoleForPermissionMode("auto", "default", planConfig)).toBeUndefined();
	});

	// Ask is read-only like plan but has NO dedicated role in v1 — it behaves
	// exactly like auto for the role swap (leaving plan restores the pre-plan role).
	it("entering ask from plan restores the pre-plan role (or 'default')", () => {
		expect(decideRoleForPermissionMode("ask", "plan", planConfig)).toBe("default");
		expect(decideRoleForPermissionMode("ask", "plan", planConfig, "smol")).toBe("smol");
	});

	it("entering ask never adopts the plan role", () => {
		expect(decideRoleForPermissionMode("ask", "default", planConfig)).toBeUndefined();
		expect(decideRoleForPermissionMode("ask", "default", undefined)).toBeUndefined();
	});

	it("entering ask does not clobber a role the user picked manually", () => {
		expect(decideRoleForPermissionMode("ask", "smol", planConfig, "default")).toBeUndefined();
	});

	// Confirm is an execution stance with no dedicated role either — identical
	// treatment to auto/ask (the `mode !== "plan"` generalization must cover it).
	it("entering confirm from plan restores the pre-plan role (or 'default')", () => {
		expect(decideRoleForPermissionMode("confirm", "plan", planConfig)).toBe("default");
		expect(decideRoleForPermissionMode("confirm", "plan", planConfig, "smol")).toBe("smol");
	});

	it("entering confirm never adopts the plan role", () => {
		expect(decideRoleForPermissionMode("confirm", "default", planConfig)).toBeUndefined();
		expect(decideRoleForPermissionMode("confirm", "default", undefined)).toBeUndefined();
	});

	it("entering confirm does not clobber a role the user picked manually", () => {
		expect(decideRoleForPermissionMode("confirm", "smol", planConfig, "default")).toBeUndefined();
	});
});
