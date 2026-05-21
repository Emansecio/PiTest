#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as undici from "undici";
import { APP_NAME } from "./config.ts";
import { main } from "./main.ts";

process.title = APP_NAME;
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// TEMP DIAGNOSTIC — write env state to a file so user can verify which agent dir was used.
try {
	const piEnv = Object.keys(process.env)
		.filter((k) => k.startsWith("PI_") || k === "USERPROFILE")
		.map((k) => `  ${k}=${process.env[k]}`)
		.join("\n");
	const diag = [
		`pid=${process.pid}`,
		`argv0=${process.argv0}`,
		`PI_CODING_AGENT_DIR=${process.env.PI_CODING_AGENT_DIR ?? "<unset>"}`,
		`APP_NAME=${APP_NAME}`,
		`cwd=${process.cwd()}`,
		`time=${new Date().toISOString()}`,
		`all PI_*/USERPROFILE env:`,
		piEnv,
		"",
	].join("\n");
	appendFileSync(join(homedir(), "pit-diag.log"), `--- start ---\n${diag}`);
} catch {}

// bodyTimeout/headersTimeout default to 300s in undici; long local-LLM stalls
// (e.g. vLLM buffering a large tool call) exceed that and abort the SSE stream
// with UND_ERR_BODY_TIMEOUT. Disable both — provider SDKs enforce their own
// AbortController-based deadlines via retry.provider.timeoutMs.
undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent({ allowH2: false, bodyTimeout: 0, headersTimeout: 0 }));

// Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
// bundled fetch can otherwise consume compressed responses through npm undici's
// dispatcher without decompressing them, causing response.json() failures.
undici.install?.();

main(process.argv.slice(2));
