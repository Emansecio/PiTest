// Post-tsc step: bundle the CLI entry (dist/cli.js) into a single self-contained
// ESM file with esbuild. Boot no longer resolves/stats ~1000 modules (notably
// the typebox barrel pulled transitively by @pit/ai / @pit/tui / @pit/agent-core);
// they are internalized into one file, cutting ~200 ms off startup.
//
// The individual dist/*.js files are left in place — they remain the package's
// library exports (index.js, extension-api.js, core/hooks, core/sdk) and are
// what `check:dist-exports` and `import "@pit/coding-agent"` consume. Only
// dist/cli.js (the bin entry) is replaced by the bundle.
//
// Not committed as part of any long-lived artifact; runs on every package build.

import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageDir = join(__dirname, "..");
const distDir = join(packageDir, "dist");
// Bundle FROM the untouched tsc entry output TO a separate file. Overwriting the
// tsc output in place would defeat tsc's incremental build (it sees cli.js as
// up-to-date and stops re-emitting it, so the next build re-bundles the bundle).
const entry = join(distDir, "cli.js");
const outfile = join(distDir, "cli.bundle.mjs");

// esbuild is present in the repo root node_modules (transitive dev dep). Resolve
// it from there so this works regardless of hoisting.
const { build } = require("esbuild");

const SHEBANG = "#!/usr/bin/env node";

// Modules that ship native addons (.node) or a wasm sidecar and must stay
// external — esbuild cannot inline a native binary, and these are loaded lazily
// via createRequire at runtime anyway. Extra entries are harmless: nothing here
// is statically value-imported, so most are never pulled regardless.
const EXTERNAL = [
	"@silvia-odwyer/photon-node",
	"ffi-rs",
	"@ast-grep/napi",
	"@ff-labs/fff-node",
	"@pituned/clipboard",
	"typescript-language-server",
];

async function main() {
	if (!existsSync(entry)) {
		throw new Error(`bundle-cli: entry not found (run tsc first): ${entry}`);
	}

	const result = await build({
		entryPoints: [entry],
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		external: EXTERNAL,
		write: false,
		metafile: true,
		legalComments: "none",
		// Provide a CJS-style `require` for any bundled dependency that calls the
		// bare global `require` (createRequire-based lazy loads keep their own
		// binding). `import.meta.url` resolves to dist/cli.js at runtime, so
		// relative requires (e.g. @pit/ai's "./models.generated.js") anchor on
		// dist/ — see the generated-catalog copy below.
		banner: {
			js: `import { createRequire as __pitCreateRequire } from "node:module";\nconst require = __pitCreateRequire(import.meta.url);`,
		},
	});

	const output = result.outputFiles.find((f) => f.path.endsWith(".js")) ?? result.outputFiles[0];
	let code = output.text;

	// esbuild preserves the entry shebang, but guarantee it leads the file.
	if (!code.startsWith("#!")) {
		code = `${SHEBANG}\n${code}`;
	}

	writeFileSync(outfile, code);
	chmodSync(outfile, 0o755);

	// @pit/ai's models.ts / image-models.ts load their generated catalogs via
	// `createRequire(import.meta.url)("./models.generated.js")`. Inside the bundle
	// import.meta.url is dist/cli.js, so those relative requires resolve against
	// dist/. Copy the catalogs next to the bundle so they resolve. They are pure
	// data (no singletons), so a per-copy instance is harmless.
	// @pit/ai's package.json exposes only an ESM "exports" map (no CJS main), so
	// require.resolve("@pit/ai") throws. This step only ever runs inside the
	// monorepo build, where @pit/ai is the sibling packages/ai — resolve its dist
	// directly, with a node_modules symlink fallback.
	const aiDistCandidates = [
		join(packageDir, "..", "ai", "dist"),
		join(packageDir, "..", "..", "node_modules", "@pit", "ai", "dist"),
	];
	const aiDist = aiDistCandidates.find((d) => existsSync(join(d, "models.generated.js")));
	if (!aiDist) {
		throw new Error(`bundle-cli: could not locate @pit/ai dist (looked in: ${aiDistCandidates.join(", ")})`);
	}
	for (const name of ["models.generated.js", "image-models.generated.js"]) {
		const src = join(aiDist, name);
		if (existsSync(src)) {
			copyFileSync(src, join(distDir, name));
		} else {
			console.warn(`bundle-cli: warning — expected generated catalog missing: ${src}`);
		}
	}

	// Report and sanity-check the bundle composition.
	const bytes = Buffer.byteLength(code);
	const inputs = Object.keys(result.metafile.inputs);
	const bundledTypebox = inputs.some((p) => /node_modules[\\/]typebox[\\/]/.test(p));
	const leakedNative = inputs.some((p) =>
		EXTERNAL.some((ext) => p.includes(`node_modules/${ext}`) || p.includes(`node_modules\\${ext.replace(/\//g, "\\")}`)),
	);
	console.log(
		`bundle-cli: wrote dist/cli.bundle.mjs (${(bytes / 1024 / 1024).toFixed(2)} MB, ${inputs.length} inputs, ` +
			`typebox ${bundledTypebox ? "internalized" : "NOT bundled!"}, native externals ${leakedNative ? "LEAKED!" : "excluded"})`,
	);
	if (!bundledTypebox) {
		throw new Error("bundle-cli: typebox was not internalized — bundle would not improve boot");
	}
	if (leakedNative) {
		throw new Error("bundle-cli: a native external leaked into the bundle");
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exit(1);
});
