/**
 * Hermetic smoke: native ESM import vs jiti.import on a repo-local precompiled
 * extension fixture. No API keys, no ~/.pit deps. Mirrors scripts/bench-extension-load.mjs.
 */
import { createJiti } from "jiti/static";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures", "extension-load-smoke", "index.js");

if (!existsSync(fixturePath)) {
	console.error(`extension-load smoke: missing fixture at ${fixturePath}`);
	process.exit(1);
}

const target = pathToFileURL(fixturePath).href;

async function smokeNativeImport() {
	const t0 = performance.now();
	const mod = await import(target);
	const ms = performance.now() - t0;
	if (typeof mod?.default !== "function") {
		throw new Error(`native import: expected default export function, got ${typeof mod?.default}`);
	}
	return ms;
}

async function smokeJitiImport(label, jiti) {
	const t0 = performance.now();
	const mod = await jiti.import(fixturePath, { default: true });
	const ms = performance.now() - t0;
	if (typeof mod !== "function") {
		throw new Error(`${label}: expected default export function, got ${typeof mod}`);
	}
	return ms;
}

try {
	const nativeMs = await smokeNativeImport();
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	const jitiMs = await smokeJitiImport("jiti import", jiti);
	const jitiWarmMs = await smokeJitiImport("jiti import warm", jiti);

	console.log(
		`extension-load smoke ok (native=${nativeMs.toFixed(0)}ms jiti=${jitiMs.toFixed(0)}ms warm=${jitiWarmMs.toFixed(0)}ms)`,
	);
	console.log(`METRIC extension_load_native_ms=${Math.round(nativeMs)}`);
	console.log(`METRIC extension_load_jiti_ms=${Math.round(jitiMs)}`);
} catch (err) {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
}
