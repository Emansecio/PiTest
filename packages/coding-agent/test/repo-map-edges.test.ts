import { describe, expect, it } from "vitest";
import { extractFileDeps, extractPythonDeps, extractRustDeps, extractTsJsDeps } from "../src/core/repo-map/edges.js";

/** In-memory `fileExists` from a fixed set of repo-relative paths. */
function fsFrom(paths: string[]): (p: string) => boolean {
	const set = new Set(paths);
	return (p) => set.has(p);
}

describe("extractTsJsDeps — TS/JS relative resolution", () => {
	it("resolves a relative import with an explicit extension", () => {
		const content = `import { foo } from "./sibling.ts";`;
		const deps = extractTsJsDeps(content, "src/a.ts", { fileExists: fsFrom(["src/sibling.ts"]) });
		expect(deps).toEqual(["src/sibling.ts"]);
	});

	it("resolves a relative import with NO extension by trying candidates", () => {
		const content = `import { foo } from "./sibling";`;
		const deps = extractTsJsDeps(content, "src/a.ts", { fileExists: fsFrom(["src/sibling.tsx"]) });
		expect(deps).toEqual(["src/sibling.tsx"]);
	});

	it("resolves a directory import to its index file", () => {
		const content = `import { foo } from "./dir";`;
		const deps = extractTsJsDeps(content, "src/a.ts", { fileExists: fsFrom(["src/dir/index.ts"]) });
		expect(deps).toEqual(["src/dir/index.ts"]);
	});

	it("resolves a .js specifier to its .ts sibling on disk (NodeNext/ESM convention)", () => {
		const content = `import { foo } from "./sibling.js";`;
		const deps = extractTsJsDeps(content, "src/a.ts", { fileExists: fsFrom(["src/sibling.ts"]) });
		expect(deps).toEqual(["src/sibling.ts"]);
	});

	it("prefers the literal .js file over the .ts swap when both could match", () => {
		const content = `import { foo } from "./sibling.js";`;
		const deps = extractTsJsDeps(content, "src/a.ts", { fileExists: fsFrom(["src/sibling.js", "src/sibling.ts"]) });
		expect(deps).toEqual(["src/sibling.js"]);
	});

	it("handles export-from re-exports", () => {
		const content = `export { foo } from "./sibling.ts";\nexport * from "./other.ts";`;
		const deps = extractTsJsDeps(content, "src/a.ts", {
			fileExists: fsFrom(["src/sibling.ts", "src/other.ts"]),
		});
		// extractTsJsDeps is the raw per-language extractor (extraction order);
		// dedup+sort is applied by the top-level extractFileDeps dispatcher.
		expect(deps).toEqual(["src/sibling.ts", "src/other.ts"]);
	});

	it("handles require()", () => {
		const content = `const foo = require("./sibling.ts");`;
		const deps = extractTsJsDeps(content, "src/a.ts", { fileExists: fsFrom(["src/sibling.ts"]) });
		expect(deps).toEqual(["src/sibling.ts"]);
	});

	it("handles dynamic import()", () => {
		const content = `const mod = await import("./sibling.ts");`;
		const deps = extractTsJsDeps(content, "src/a.ts", { fileExists: fsFrom(["src/sibling.ts"]) });
		expect(deps).toEqual(["src/sibling.ts"]);
	});

	it("handles a side-effect import with no bindings", () => {
		const content = `import "./init.ts";`;
		const deps = extractTsJsDeps(content, "src/a.ts", { fileExists: fsFrom(["src/init.ts"]) });
		expect(deps).toEqual(["src/init.ts"]);
	});

	it("discards a bare npm package specifier", () => {
		const content = `import { z } from "zod";\nimport React from "react";`;
		const deps = extractTsJsDeps(content, "src/a.ts", { fileExists: () => true });
		expect(deps).toEqual([]);
	});

	it("discards a relative import that does not resolve to any file", () => {
		const content = `import { foo } from "./ghost";`;
		const deps = extractTsJsDeps(content, "src/a.ts", { fileExists: () => false });
		expect(deps).toEqual([]);
	});

	it("resolves ../ climbing out of the current directory", () => {
		const content = `import { foo } from "../shared/util.ts";`;
		const deps = extractTsJsDeps(content, "src/nested/a.ts", { fileExists: fsFrom(["src/shared/util.ts"]) });
		expect(deps).toEqual(["src/shared/util.ts"]);
	});

	it("resolves a multi-line named import", () => {
		const content = `import {\n  foo,\n  bar,\n} from "./sibling.ts";`;
		const deps = extractTsJsDeps(content, "src/a.ts", { fileExists: fsFrom(["src/sibling.ts"]) });
		expect(deps).toEqual(["src/sibling.ts"]);
	});

	it("resolves the trivial @pit/<name> workspace mapping", () => {
		const content = `import { something } from "@pit/ai";`;
		const deps = extractTsJsDeps(content, "packages/coding-agent/src/x.ts", {
			fileExists: fsFrom(["packages/ai/src/index.ts"]),
		});
		expect(deps).toEqual(["packages/ai/src/index.ts"]);
	});

	it("drops @pit/agent-core when NO resolveBare is injected (dir mismatch: packages/agent) — fallback-only behavior", () => {
		const content = `import { something } from "@pit/agent-core";`;
		const deps = extractTsJsDeps(content, "packages/coding-agent/src/x.ts", {
			fileExists: fsFrom(["packages/agent/src/index.ts"]),
		});
		expect(deps).toEqual([]);
	});

	it("dedupes and sorts the result via extractFileDeps", () => {
		const content = `import { a } from "./sibling.ts";\nimport { b } from "./sibling.ts";\nimport { c } from "./other.ts";`;
		const deps = extractFileDeps(content, "src/a.ts", { fileExists: fsFrom(["src/sibling.ts", "src/other.ts"]) });
		expect(deps).toEqual(["src/other.ts", "src/sibling.ts"]);
	});

	it("never throws on malformed content (fail-open)", () => {
		expect(() => extractFileDeps("import from ;;; ((( {{{", "src/a.ts", { fileExists: () => true })).not.toThrow();
	});
});

describe("extractTsJsDeps — bare specifiers via the injected resolveBare", () => {
	it("resolves @pit/agent-core through resolveBare (the dir-mismatch case the fallback can't)", () => {
		const content = `import { something } from "@pit/agent-core";`;
		const deps = extractTsJsDeps(content, "packages/coding-agent/src/x.ts", {
			fileExists: fsFrom(["packages/agent/src/index.ts"]),
			resolveBare: (spec) => (spec === "@pit/agent-core" ? "packages/agent/src/index" : null),
		});
		expect(deps).toEqual(["packages/agent/src/index.ts"]);
	});

	it("resolves a subpath specifier @scope/pkg/sub via resolveBare", () => {
		const content = `import { x } from "@pit/agent-core/utils/retry";`;
		const deps = extractTsJsDeps(content, "packages/coding-agent/src/x.ts", {
			fileExists: fsFrom(["packages/agent/utils/retry.ts"]),
			resolveBare: (spec) => (spec === "@pit/agent-core/utils/retry" ? "packages/agent/utils/retry" : null),
		});
		expect(deps).toEqual(["packages/agent/utils/retry.ts"]);
	});

	it("resolves a tsconfig alias @/x via resolveBare (wiring itself is living-index's concern)", () => {
		const content = `import { util } from "@/utils/helpers";`;
		const deps = extractTsJsDeps(content, "packages/coding-agent/src/x.ts", {
			fileExists: fsFrom(["packages/coding-agent/src/utils/helpers.ts"]),
			resolveBare: (spec) => (spec === "@/utils/helpers" ? "packages/coding-agent/src/utils/helpers" : null),
		});
		expect(deps).toEqual(["packages/coding-agent/src/utils/helpers.ts"]);
	});

	it("passes the IMPORTING file's repo-relative path to resolveBare", () => {
		const seen: string[] = [];
		extractTsJsDeps(`import { x } from "@pit/ai";`, "packages/coding-agent/src/deep/y.ts", {
			fileExists: () => false,
			resolveBare: (_spec, fromRepoRelPath) => {
				seen.push(fromRepoRelPath);
				return null;
			},
		});
		expect(seen).toEqual(["packages/coding-agent/src/deep/y.ts"]);
	});

	it("falls back to the trivial @pit/<name> mapping when resolveBare returns null", () => {
		const content = `import { something } from "@pit/ai";`;
		const deps = extractTsJsDeps(content, "packages/coding-agent/src/x.ts", {
			fileExists: fsFrom(["packages/ai/src/index.ts"]),
			resolveBare: () => null,
		});
		expect(deps).toEqual(["packages/ai/src/index.ts"]);
	});

	it("falls back when resolveBare's mapped path does not exist on disk", () => {
		const content = `import { something } from "@pit/ai";`;
		const deps = extractTsJsDeps(content, "packages/coding-agent/src/x.ts", {
			fileExists: fsFrom(["packages/ai/src/index.ts"]),
			resolveBare: () => "totally/wrong/mapping", // no file there -> fallback still lands the edge
		});
		expect(deps).toEqual(["packages/ai/src/index.ts"]);
	});

	it("a throwing resolveBare fails open to the fallback", () => {
		const content = `import { something } from "@pit/ai";`;
		const deps = extractTsJsDeps(content, "packages/coding-agent/src/x.ts", {
			fileExists: fsFrom(["packages/ai/src/index.ts"]),
			resolveBare: () => {
				throw new Error("resolver bug");
			},
		});
		expect(deps).toEqual(["packages/ai/src/index.ts"]);
	});

	it("still discards a bare npm package when resolveBare returns null for it", () => {
		const content = `import { z } from "zod";`;
		const deps = extractTsJsDeps(content, "src/a.ts", {
			fileExists: () => true,
			resolveBare: () => null,
		});
		expect(deps).toEqual([]);
	});

	it("relative specifiers NEVER consult resolveBare", () => {
		let called = 0;
		const deps = extractTsJsDeps(`import { foo } from "./sibling.ts";`, "src/a.ts", {
			fileExists: fsFrom(["src/sibling.ts"]),
			resolveBare: () => {
				called++;
				return null;
			},
		});
		expect(deps).toEqual(["src/sibling.ts"]);
		expect(called).toBe(0);
	});
});

describe("extractPythonDeps — absolute + relative module resolution", () => {
	it("resolves an absolute dotted import to a package __init__", () => {
		const content = `import a.b.c`;
		const deps = extractPythonDeps(content, "pkg/mod.py", { fileExists: fsFrom(["a/b/c/__init__.py"]) });
		expect(deps).toEqual(["a/b/c/__init__.py"]);
	});

	it("resolves an absolute dotted import to a plain module file", () => {
		const content = `import a.b.c`;
		const deps = extractPythonDeps(content, "pkg/mod.py", { fileExists: fsFrom(["a/b/c.py"]) });
		expect(deps).toEqual(["a/b/c.py"]);
	});

	it("resolves a comma-separated import list with aliases", () => {
		const content = `import os, a.b as ab`;
		const deps = extractPythonDeps(content, "pkg/mod.py", { fileExists: fsFrom(["a/b.py"]) });
		expect(deps).toEqual(["a/b.py"]);
	});

	it("resolves `from a.b import d` to the MODULE (a.b), not the imported name", () => {
		const content = `from a.b import d`;
		const deps = extractPythonDeps(content, "pkg/mod.py", { fileExists: fsFrom(["a/b.py"]) });
		expect(deps).toEqual(["a/b.py"]);
	});

	it("resolves `from . import x` to the current package's __init__", () => {
		const content = `from . import x`;
		const deps = extractPythonDeps(content, "pkg/sub/mod.py", { fileExists: fsFrom(["pkg/sub/__init__.py"]) });
		expect(deps).toEqual(["pkg/sub/__init__.py"]);
	});

	it("resolves `from .. import x` to the PARENT package's __init__", () => {
		const content = `from .. import x`;
		const deps = extractPythonDeps(content, "pkg/sub/mod.py", { fileExists: fsFrom(["pkg/__init__.py"]) });
		expect(deps).toEqual(["pkg/__init__.py"]);
	});

	it("resolves `from ..pkg.sub import y` walking up then back down", () => {
		const content = `from ..sibling.leaf import y`;
		const deps = extractPythonDeps(content, "pkg/sub/mod.py", {
			fileExists: fsFrom(["pkg/sibling/leaf.py"]),
		});
		expect(deps).toEqual(["pkg/sibling/leaf.py"]);
	});

	it("discards an import with no resolvable file", () => {
		const content = `import totally.missing.module`;
		const deps = extractPythonDeps(content, "pkg/mod.py", { fileExists: () => false });
		expect(deps).toEqual([]);
	});

	it("strips a trailing inline comment on a plain import line", () => {
		const content = `import a.b  # noqa`;
		const deps = extractPythonDeps(content, "pkg/mod.py", { fileExists: fsFrom(["a/b.py"]) });
		expect(deps).toEqual(["a/b.py"]);
	});
});

describe("extractRustDeps — mod/use resolution", () => {
	it("resolves `mod name;` to a same-dir file", () => {
		const content = `mod helpers;`;
		const deps = extractRustDeps(content, "src/lib.rs", { fileExists: fsFrom(["src/helpers.rs"]) });
		expect(deps).toEqual(["src/helpers.rs"]);
	});

	it("resolves `mod name;` to a same-dir mod.rs directory form", () => {
		const content = `pub mod helpers;`;
		const deps = extractRustDeps(content, "src/lib.rs", { fileExists: fsFrom(["src/helpers/mod.rs"]) });
		expect(deps).toEqual(["src/helpers/mod.rs"]);
	});

	it("does NOT emit an edge for an inline `mod name { ... }` body", () => {
		const content = `mod helpers {\n    pub fn f() {}\n}`;
		const deps = extractRustDeps(content, "src/lib.rs", { fileExists: () => true });
		expect(deps).toEqual([]);
	});

	it("resolves `use crate::a::b;` against the nearest ancestor src/ root", () => {
		const content = `use crate::a::b;`;
		const deps = extractRustDeps(content, "myapp/src/main.rs", {
			fileExists: fsFrom(["myapp/src/a/b.rs"]),
		});
		expect(deps).toEqual(["myapp/src/a/b.rs"]);
	});

	it("falls back to the module prefix when the last `use` segment is an item, not a module", () => {
		const content = `use crate::a::Foo;`;
		const deps = extractRustDeps(content, "myapp/src/main.rs", {
			fileExists: fsFrom(["myapp/src/a.rs"]),
		});
		expect(deps).toEqual(["myapp/src/a.rs"]);
	});

	it("resolves `use crate::a::{b, c};` to the module prefix a", () => {
		const content = `use crate::a::{b, c};`;
		const deps = extractRustDeps(content, "myapp/src/main.rs", {
			fileExists: fsFrom(["myapp/src/a.rs"]),
		});
		expect(deps).toEqual(["myapp/src/a.rs"]);
	});

	it("resolves `use self::y;` relative to the current file's own module dir", () => {
		const content = `use self::y;`;
		const deps = extractRustDeps(content, "myapp/src/a.rs", {
			fileExists: fsFrom(["myapp/src/a/y.rs"]),
		});
		expect(deps).toEqual(["myapp/src/a/y.rs"]);
	});

	it("resolves `use super::x;` to the parent module directory", () => {
		const content = `use super::x;`;
		const deps = extractRustDeps(content, "myapp/src/a/b.rs", {
			fileExists: fsFrom(["myapp/src/a/x.rs"]),
		});
		expect(deps).toEqual(["myapp/src/a/x.rs"]);
	});

	it("discards an external crate use path", () => {
		const content = `use serde::{Deserialize, Serialize};`;
		const deps = extractRustDeps(content, "myapp/src/main.rs", { fileExists: () => true });
		expect(deps).toEqual([]);
	});

	it("no ancestor src/ dir -> crate:: path is dropped, not guessed", () => {
		const content = `use crate::a::b;`;
		const deps = extractRustDeps(content, "loose/main.rs", { fileExists: () => true });
		expect(deps).toEqual([]);
	});
});

describe("extractFileDeps — dispatch + fail-open", () => {
	it("returns [] for an unknown extension", () => {
		expect(extractFileDeps("import x from './y'", "notes.md", { fileExists: () => true })).toEqual([]);
	});
});
