/**
 * Microbench: native dynamic import vs jiti.import for a precompiled .js extension.
 */
import { createJiti } from "jiti/static";
import { performance } from "node:perf_hooks";

import { pathToFileURL } from "node:url";
const rawTarget = process.argv[2] ?? "C:/Users/User/.pit/agent/npm/node_modules/pi-autoresearch/extensions/pi-autoresearch/index.js";
const target = pathToFileURL(rawTarget).href;

console.log(`target: ${target}\n`);

// 1) Native import (Node ESM)
{
	const t0 = performance.now();
	const mod = await import(target);
	const ms = performance.now() - t0;
	console.log(`native import:     ${ms.toFixed(0)}ms  (default = ${typeof mod.default})`);
}

// 2) Jiti import (same module)
{
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	const t0 = performance.now();
	const mod = await jiti.import(rawTarget, { default: true });
	const ms = performance.now() - t0;
	console.log(`jiti import:       ${ms.toFixed(0)}ms  (typeof = ${typeof mod})`);
}

// 3) Jiti import again (warm)
{
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	const t0 = performance.now();
	const mod = await jiti.import(rawTarget, { default: true });
	const ms = performance.now() - t0;
	console.log(`jiti import warm:  ${ms.toFixed(0)}ms`);
}
