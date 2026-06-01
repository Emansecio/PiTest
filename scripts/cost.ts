#!/usr/bin/env npx tsx

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Args {
	directory: string;
	days: number;
}

interface UsageCost {
	total?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

interface Usage {
	cost?: UsageCost;
}

interface AssistantMessage {
	role?: string;
	provider?: string;
	usage?: Usage;
}

interface SessionEntry {
	type?: string;
	timestamp?: string;
	message?: AssistantMessage;
}

interface DayCost {
	total: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	requests: number;
}

type ProviderCosts = Record<string, DayCost>;
type CostStats = Record<string, ProviderCosts>;

function printUsage(): void {
	console.log(`Usage: cost.ts -d <path> -n <days>
  -d, --dir <path>   Directory path (required)
  -n, --days <num>   Number of days to track (required)
  -h, --help         Show this help`);
}

function parseArgs(): Args {
	const args = process.argv.slice(2);
	let directory: string | undefined;
	let days: number | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if ((arg === "--dir" || arg === "-d") && args[i + 1]) {
			directory = args[++i];
		} else if ((arg === "--days" || arg === "-n") && args[i + 1]) {
			days = Number.parseInt(args[++i], 10);
		} else if (arg === "--help" || arg === "-h") {
			printUsage();
			process.exit(0);
		}
	}

	if (!directory || days === undefined) {
		console.error("Error: both --dir and --days are required");
		console.error("Run with --help for usage");
		process.exit(1);
	}

	if (!Number.isInteger(days) || days <= 0) {
		console.error("Error: --days must be a positive integer");
		process.exit(1);
	}

	return { directory, days };
}

function encodeSessionDir(dir: string): string {
	const normalized = dir.startsWith("/") ? dir.slice(1) : dir;
	return `--${normalized.replace(/\//g, "-")}--`;
}

function createDayCost(): DayCost {
	return {
		total: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		requests: 0,
	};
}

function addCost(target: DayCost, cost: UsageCost): void {
	target.total += cost.total ?? 0;
	target.input += cost.input ?? 0;
	target.output += cost.output ?? 0;
	target.cacheRead += cost.cacheRead ?? 0;
	target.cacheWrite += cost.cacheWrite ?? 0;
	target.requests += 1;
}

function mergeDayCost(target: DayCost, source: DayCost): void {
	target.total += source.total;
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.requests += source.requests;
}

function parseJsonLine(line: string): SessionEntry | null {
	try {
		return JSON.parse(line) as SessionEntry;
	} catch {
		return null;
	}
}

function sessionFileDate(file: string): Date {
	const timestamp = file.split("_")[0] ?? "";
	const isoTimestamp = timestamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/, "T$1:$2:$3.$4Z");
	return new Date(isoTimestamp);
}

function isoDay(date: Date): string {
	return date.toISOString().split("T")[0]!;
}

function formatCost(cost: DayCost): string {
	const cache = cost.cacheRead + cost.cacheWrite;
	return `$${cost.total.toFixed(4).padStart(8)}  (${cost.requests} reqs, in: $${cost.input.toFixed(4)}, out: $${cost.output.toFixed(4)}, cache: $${cache.toFixed(4)})`;
}

const { directory, days } = parseArgs();
const sessionsBase = join(homedir(), ".pit", "agent", "sessions");
const sessionsDir = join(sessionsBase, encodeSessionDir(directory));

if (!existsSync(sessionsDir)) {
	console.error(`Sessions directory not found: ${sessionsDir}`);
	process.exit(1);
}

const cutoff = new Date();
cutoff.setDate(cutoff.getDate() - days);
cutoff.setHours(0, 0, 0, 0);

const stats: CostStats = {};
const files = readdirSync(sessionsDir).filter((file) => file.endsWith(".jsonl"));

for (const file of files) {
	if (sessionFileDate(file) < cutoff) continue;

	const filepath = join(sessionsDir, file);
	const lines = readFileSync(filepath, "utf8").trim().split("\n");

	for (const line of lines) {
		if (!line) continue;

		const entry = parseJsonLine(line);
		if (entry?.type !== "message" || entry.message?.role !== "assistant" || !entry.message.usage?.cost) {
			continue;
		}

		const entryDate = new Date(entry.timestamp ?? 0);
		if (Number.isNaN(entryDate.getTime())) {
			continue;
		}

		const day = isoDay(entryDate);
		const provider = entry.message.provider ?? "unknown";
		stats[day] ??= {};
		stats[day][provider] ??= createDayCost();
		addCost(stats[day][provider], entry.message.usage.cost);
	}
}

const sortedDays = Object.keys(stats).sort();

if (sortedDays.length === 0) {
	console.log(`No sessions found in the last ${days} days for: ${directory}`);
	process.exit(0);
}

console.log(`\nCost breakdown for: ${directory}`);
console.log(`Period: last ${days} days (since ${isoDay(cutoff)})`);
console.log("=".repeat(80));

let grandTotal = 0;
const providerTotals: ProviderCosts = {};

for (const day of sortedDays) {
	console.log(`\n${day}`);
	console.log("-".repeat(40));

	let dayTotal = 0;
	const dayStats = stats[day] ?? {};
	const providers = Object.keys(dayStats).sort();

	for (const provider of providers) {
		const cost = dayStats[provider]!;
		dayTotal += cost.total;
		providerTotals[provider] ??= createDayCost();
		mergeDayCost(providerTotals[provider], cost);

		console.log(`  ${provider.padEnd(15)} ${formatCost(cost)}`);
	}

	console.log(`  ${"Day total:".padEnd(15)} $${dayTotal.toFixed(4).padStart(8)}`);
	grandTotal += dayTotal;
}

console.log("\n" + "=".repeat(80));
console.log("TOTALS BY PROVIDER");
console.log("-".repeat(40));

for (const provider of Object.keys(providerTotals).sort()) {
	console.log(`  ${provider.padEnd(15)} ${formatCost(providerTotals[provider]!)}`);
}

console.log("-".repeat(40));
console.log(`  ${"GRAND TOTAL:".padEnd(15)} $${grandTotal.toFixed(4).padStart(8)}`);
console.log();
