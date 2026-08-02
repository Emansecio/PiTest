/**
 * Tests for the dry-run report builder. We use a hand-built fake `services`
 * object so we never go through the real auth/extension loaders.
 */

import { describe, expect, it } from "vitest";
import { buildDryRunReport, formatReportJson, formatReportText } from "../src/cli/dry-run/index.js";
import { PermissionChecker } from "../src/core/permissions/checker.ts";

function makeFakeServices(overrides?: Partial<Record<string, unknown>>) {
	const settings = {
		drainErrors: () => [],
		getPermissionSettings: () => ({ mode: "auto" }),
		getHooksSettings: () => ({}),
		getMcpSettings: () => ({}),
		getMemorySettings: () => ({}),
	};
	const modelRegistry = {
		hasConfiguredAuth: () => true,
	};
	const resourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [] }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getSkillByName: () => undefined,
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getMemoryFiles: () => [],
	};
	return {
		cwd: process.cwd(),
		agentDir: process.cwd(),
		settingsManager: settings,
		modelRegistry,
		resourceLoader,
		authStorage: {},
		diagnostics: [],
		// Live checker: the report reads `failClosed` from it so the
		// `--allowlist-only` CLI override (which never reaches settings.json) shows up.
		permissionChecker: new PermissionChecker({ cwd: process.cwd(), mode: "auto", settings: {} }),
		...overrides,
	} as unknown as import("../src/core/agent-session-services.ts").AgentSessionServices;
}

describe("dry-run builder", () => {
	it("returns 'ready' when everything is configured", () => {
		const services = makeFakeServices();
		const model = { provider: "openai", id: "gpt-x" } as unknown as import("@pit/ai").Model<any>;
		const report = buildDryRunReport({
			services,
			resolvedModel: model,
			resolvedToolNames: ["read", "bash"],
		});
		expect(report.overallStatus).toBe("ready");
		expect(report.checks.find((c) => c.name === "Model & auth")?.status).toBe("ready");
		expect(report.checks.find((c) => c.name === "Tools")?.detail).toContain("read, bash");
	});

	it("reports 'blocked' when no model resolves", () => {
		const services = makeFakeServices();
		const report = buildDryRunReport({
			services,
			resolvedModel: undefined,
			resolvedToolNames: ["read"],
		});
		expect(report.overallStatus).toBe("blocked");
		expect(report.checks.find((c) => c.name === "Model & auth")?.status).toBe("blocked");
	});

	it("reports 'blocked' when model exists but auth is missing", () => {
		const services = makeFakeServices({
			modelRegistry: { hasConfiguredAuth: () => false },
		});
		const model = { provider: "openai", id: "gpt-x" } as unknown as import("@pit/ai").Model<any>;
		const report = buildDryRunReport({
			services,
			resolvedModel: model,
			resolvedToolNames: ["read"],
		});
		expect(report.overallStatus).toBe("blocked");
	});

	it("flags the fail-closed preset from the live checker (CLI --allowlist-only)", () => {
		const plain = buildDryRunReport({ services: makeFakeServices(), resolvedToolNames: [] });
		expect(plain.checks.find((c) => c.name === "Permissions")?.detail).not.toContain("fail-closed");

		const services = makeFakeServices({
			permissionChecker: new PermissionChecker({
				cwd: process.cwd(),
				mode: "auto",
				settings: { allowlistOnly: true },
			}),
		});
		const report = buildDryRunReport({ services, resolvedToolNames: [] });
		expect(report.checks.find((c) => c.name === "Permissions")?.detail).toContain("fail-closed");
	});

	it("text format includes overall status header", () => {
		const services = makeFakeServices();
		const model = { provider: "openai", id: "gpt-x" } as unknown as import("@pit/ai").Model<any>;
		const report = buildDryRunReport({
			services,
			resolvedModel: model,
			resolvedToolNames: ["read"],
		});
		const text = formatReportText(report);
		expect(text).toContain("pit dry-run");
		expect(text).toContain("READY");
	});

	it("json format round-trips structure", () => {
		const services = makeFakeServices();
		const model = { provider: "openai", id: "gpt-x" } as unknown as import("@pit/ai").Model<any>;
		const report = buildDryRunReport({
			services,
			resolvedModel: model,
			resolvedToolNames: ["read"],
		});
		const json = JSON.parse(formatReportJson(report));
		expect(json.overallStatus).toBe(report.overallStatus);
		expect(json.checks.length).toBe(report.checks.length);
	});
});
