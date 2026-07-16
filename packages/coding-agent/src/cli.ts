#!/usr/bin/env node
/**
 * CLI entry point for the refactored coding agent.
 * Uses main.ts with AgentSession and new mode modules.
 *
 * Test with: npx tsx src/cli-new.ts [args...]
 */
import { APP_NAME } from "./config.ts";
import { markMilestone, printTimings } from "./core/timings.ts";
import { resolveKeepAliveOptions } from "./utils/env-flags.ts";

// performance.now()'s origin is process start, so this absolute milestone
// captures everything PIT_TIMING was previously blind to: node boot, the tsx
// loader bootstrap, and the eager import eval of this entry module's graph.
markMilestone("module-eval");

process.title = APP_NAME;
process.env.PIT_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

/**
 * Install the tuned undici global dispatcher. Loaded lazily (undici costs
 * ~140-160ms of module eval) so the --version early-exit below doesn't pay for
 * it; every non-version path awaits this BEFORE importing main.ts, and no fetch
 * happens before main() runs, so the dispatcher is always in place ahead of any
 * network code.
 */
async function installGlobalDispatcher(): Promise<void> {
	const undici = await import("undici");
	// bodyTimeout/headersTimeout default to 300s in undici; long local-LLM stalls
	// (e.g. vLLM buffering a large tool call) exceed that and abort the SSE stream
	// with UND_ERR_BODY_TIMEOUT. Disable both — provider SDKs enforce their own
	// AbortController-based deadlines via retry.provider.timeoutMs.
	// keepAliveTimeout defaults to 4s in undici, shorter than the typical gap
	// between turns, so every turn re-paid DNS+TCP+TLS. Hold idle sockets for 60s
	// (PIT_KEEPALIVE_MS overrides; PIT_NO_KEEPALIVE_TUNING=1 restores defaults).
	undici.setGlobalDispatcher(
		new undici.EnvHttpProxyAgent({
			allowH2: false,
			bodyTimeout: 0,
			headersTimeout: 0,
			...resolveKeepAliveOptions(),
		}),
	);

	// Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
	// bundled fetch can otherwise consume compressed responses through npm undici's
	// dispatcher without decompressing them, causing response.json() failures.
	undici.install?.();
}

const cliArgs = process.argv.slice(2);

async function runCli(): Promise<void> {
	if (cliArgs.includes("--version") || cliArgs.includes("-V")) {
		const { VERSION } = await import("./config.ts");
		console.log(VERSION);
		printTimings();
		return;
	}

	await installGlobalDispatcher();
	const { main } = await import("./main.ts");
	await main(cliArgs);
}

void runCli();
