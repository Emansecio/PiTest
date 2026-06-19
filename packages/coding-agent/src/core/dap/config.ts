/**
 * DAP adapter resolution and auto-selection. Reuses the LSP module's root-marker
 * and binary-resolution helpers so the two subsystems agree on what "available"
 * means for a project.
 */

import * as path from "node:path";
import { hasRootMarkers, resolveCommand } from "../lsp/config.ts";
import { isRecord } from "../lsp/internal.ts";
import DEFAULTS from "./defaults.ts";
import type { DapAdapterConfig, DapResolvedAdapter } from "./types.ts";

const EXTENSIONLESS_DEBUGGER_ORDER = ["gdb", "lldb-dap"] as const;

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function normalizeObject(value: unknown): Record<string, unknown> {
	return isRecord(value) ? { ...value } : {};
}

function normalizeAdapterConfig(config: unknown): DapAdapterConfig | null {
	if (!isRecord(config)) return null;
	if (typeof config.command !== "string" || config.command.length === 0) return null;
	const connectMode = config.connectMode === "socket" ? ("socket" as const) : undefined;
	return {
		command: config.command,
		args: normalizeStringArray(config.args),
		languages: normalizeStringArray(config.languages),
		fileTypes: normalizeStringArray(config.fileTypes).map((entry) => entry.toLowerCase()),
		rootMarkers: normalizeStringArray(config.rootMarkers),
		launchDefaults: normalizeObject(config.launchDefaults),
		attachDefaults: normalizeObject(config.attachDefaults),
		...(connectMode ? { connectMode } : {}),
	};
}

function getDefaults(): Record<string, DapAdapterConfig> {
	const adapters: Record<string, DapAdapterConfig> = {};
	for (const [name, config] of Object.entries(DEFAULTS as Record<string, unknown>)) {
		const normalized = normalizeAdapterConfig(config);
		if (normalized) adapters[name] = normalized;
	}
	return adapters;
}

const DEFAULT_ADAPTERS = getDefaults();

export function resolveAdapter(adapterName: string, cwd: string): DapResolvedAdapter | null {
	const config = DEFAULT_ADAPTERS[adapterName];
	if (!config) return null;
	const resolvedCommand = resolveCommand(config.command, cwd);
	if (!resolvedCommand) return null;
	return {
		name: adapterName,
		command: config.command,
		args: config.args ?? [],
		resolvedCommand,
		languages: config.languages ?? [],
		fileTypes: config.fileTypes ?? [],
		rootMarkers: config.rootMarkers ?? [],
		launchDefaults: config.launchDefaults ?? {},
		attachDefaults: config.attachDefaults ?? {},
		connectMode: config.connectMode ?? "stdio",
	};
}

export function getAvailableAdapters(cwd: string): DapResolvedAdapter[] {
	return Object.keys(DEFAULT_ADAPTERS)
		.map((name) => resolveAdapter(name, cwd))
		.filter((adapter): adapter is DapResolvedAdapter => adapter !== null);
}

function getMatchingAdapters(program: string, cwd: string): DapResolvedAdapter[] {
	const extension = path.extname(program).toLowerCase();
	const available = getAvailableAdapters(cwd);
	if (!extension) {
		// Extensionless binaries: only native debuggers (gdb/lldb-dap) or adapters
		// matched by root markers. Don't fall back to e.g. debugpy for a C binary.
		const nativeDebuggers: ReadonlySet<string> = new Set(EXTENSIONLESS_DEBUGGER_ORDER);
		return available.filter(
			(adapter) =>
				nativeDebuggers.has(adapter.name) ||
				(adapter.rootMarkers.length > 0 && hasRootMarkers(cwd, adapter.rootMarkers)),
		);
	}
	const exactMatches = available.filter((adapter) => adapter.fileTypes.includes(extension));
	return exactMatches.length > 0 ? exactMatches : available;
}

function sortAdaptersForLaunch(program: string, cwd: string, adapters: DapResolvedAdapter[]): DapResolvedAdapter[] {
	const extension = path.extname(program).toLowerCase();
	const rootAware = adapters.map((adapter) => ({
		adapter,
		hasExtensionMatch: extension.length > 0 && adapter.fileTypes.includes(extension),
		hasRootMatch: adapter.rootMarkers.length > 0 && hasRootMarkers(cwd, adapter.rootMarkers),
	}));
	rootAware.sort((left, right) => {
		if (left.hasExtensionMatch !== right.hasExtensionMatch) return left.hasExtensionMatch ? -1 : 1;
		if (left.hasRootMatch !== right.hasRootMatch) return left.hasRootMatch ? -1 : 1;
		const leftRank = EXTENSIONLESS_DEBUGGER_ORDER.indexOf(
			left.adapter.name as (typeof EXTENSIONLESS_DEBUGGER_ORDER)[number],
		);
		const rightRank = EXTENSIONLESS_DEBUGGER_ORDER.indexOf(
			right.adapter.name as (typeof EXTENSIONLESS_DEBUGGER_ORDER)[number],
		);
		const normalizedLeft = leftRank === -1 ? Number.MAX_SAFE_INTEGER : leftRank;
		const normalizedRight = rightRank === -1 ? Number.MAX_SAFE_INTEGER : rightRank;
		if (normalizedLeft !== normalizedRight) return normalizedLeft - normalizedRight;
		return left.adapter.name.localeCompare(right.adapter.name);
	});
	return rootAware.map((entry) => entry.adapter);
}

export function selectLaunchAdapter(program: string, cwd: string, adapterName?: string): DapResolvedAdapter | null {
	if (adapterName) return resolveAdapter(adapterName, cwd);
	const matches = getMatchingAdapters(program, cwd);
	const sorted = sortAdaptersForLaunch(program, cwd, matches);
	return sorted[0] ?? null;
}

export function selectAttachAdapter(cwd: string, adapterName?: string, port?: number): DapResolvedAdapter | null {
	if (adapterName) return resolveAdapter(adapterName, cwd);
	const available = getAvailableAdapters(cwd);
	if (port !== undefined) {
		const debugpy = available.find((adapter) => adapter.name === "debugpy");
		if (debugpy) return debugpy;
	}
	for (const preferred of EXTENSIONLESS_DEBUGGER_ORDER) {
		const match = available.find((adapter) => adapter.name === preferred);
		if (match) return match;
	}
	return available[0] ?? null;
}
