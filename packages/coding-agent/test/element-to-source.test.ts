import { describe, expect, it } from "vitest";
import {
	type CdpSend,
	decodeDataUri,
	type ElementToSourceDeps,
	extractSourceMappingURL,
	parseSourceMap,
	resolveElementToSource,
} from "../src/core/chrome/element-to-source.js";

// ---------------------------------------------------------------------------
// Test helpers: a real base64-VLQ encoder so the fixtures are honest source maps
// (the module's decoder must agree with a correct encoder, not a hand-faked map).
// ---------------------------------------------------------------------------

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function encodeVlq(value: number): string {
	let vlq = value < 0 ? (-value << 1) | 1 : value << 1;
	let out = "";
	do {
		let digit = vlq & 31;
		vlq >>>= 5;
		if (vlq > 0) digit |= 32;
		out += BASE64[digit];
	} while (vlq > 0);
	return out;
}

function encodeSegment(fields: number[]): string {
	return fields.map(encodeVlq).join("");
}

/**
 * Build a one-line mappings string. Each segment is an ABSOLUTE
 * [genCol, srcIndex, srcLine, srcCol, nameIndex]; we convert to the V3 deltas the
 * format requires. Single generated line (genLine 0) is enough for the test.
 */
function buildMappings(segments: number[][]): string {
	let prev = [0, 0, 0, 0, 0];
	const parts: string[] = [];
	for (const seg of segments) {
		const deltas = seg.map((v, i) => v - prev[i]);
		parts.push(encodeSegment(deltas));
		prev = seg;
	}
	return parts.join(",");
}

function inlineDataUri(map: object): string {
	const json = JSON.stringify(map);
	const b64 = Buffer.from(json, "utf8").toString("base64");
	return `data:application/json;charset=utf-8;base64,${b64}`;
}

// ---------------------------------------------------------------------------
// A fake CDP send() that walks the exact element-to-source flow.
// ---------------------------------------------------------------------------

interface FakeSendOpts {
	/** selector → matched nodeId (0/undefined = no match). */
	querySelectorNodeId?: number;
	objectId?: string;
	listeners?: Array<{ type: string; scriptId?: string; lineNumber?: number; columnNumber?: number }>;
	scriptSource?: string;
	scriptUrl?: string;
}

function makeFakeSend(opts: FakeSendOpts): { send: CdpSend; calls: string[] } {
	const calls: string[] = [];
	const send: CdpSend = async (method) => {
		calls.push(method);
		switch (method) {
			case "DOM.enable":
			case "DOMDebugger.enable":
			case "Debugger.enable":
				return {};
			case "DOM.getDocument":
				return { root: { nodeId: 1 } };
			case "DOM.querySelector":
				return { nodeId: opts.querySelectorNodeId ?? 0 };
			case "DOM.resolveNode":
				return { object: { objectId: opts.objectId ?? "obj-1" } };
			case "DOMDebugger.getEventListeners":
				return { listeners: opts.listeners ?? [] };
			case "Debugger.getScriptSource":
				return { scriptSource: opts.scriptSource ?? "", url: opts.scriptUrl ?? "" };
			default:
				return {};
		}
	};
	return { send, calls };
}

describe("element-to-source — VLQ + source-map primitives", () => {
	it("extracts the LAST sourceMappingURL comment", () => {
		const src = 'const x = "//# sourceMappingURL=decoy.map";\n//# sourceMappingURL=real.js.map\n';
		expect(extractSourceMappingURL(src)).toBe("real.js.map");
	});

	it("returns undefined when no sourceMappingURL is present", () => {
		expect(extractSourceMappingURL("console.log(1)")).toBeUndefined();
	});

	it("decodes a base64 data URI source map", () => {
		const uri = inlineDataUri({ version: 3, sources: ["a.ts"], names: [], mappings: "" });
		const text = decodeDataUri(uri);
		expect(text).toBeDefined();
		expect(JSON.parse(text as string).sources).toEqual(["a.ts"]);
	});

	it("parses a real map and recovers segment positions through the VLQ decoder", () => {
		// generated col 0 → source 0, line 4, col 2, name 0
		// generated col 8 → source 0, line 9, col 0, (no name)
		const mappings = buildMappings([
			[0, 0, 4, 2, 0],
			[8, 0, 9, 0, 0],
		]);
		const parsed = parseSourceMap(
			JSON.stringify({ version: 3, sources: ["src/app.ts"], names: ["onClick"], mappings }),
		);
		expect(parsed).toBeDefined();
		expect(parsed?.sources).toEqual(["src/app.ts"]);
		expect(parsed?.byGenLine[0][0]).toMatchObject({ genCol: 0, srcIndex: 0, srcLine: 4, srcCol: 2, nameIndex: 0 });
		expect(parsed?.byGenLine[0][1]).toMatchObject({ genCol: 8, srcIndex: 0, srcLine: 9, srcCol: 0 });
	});
});

describe("resolveElementToSource", () => {
	it("maps a click listener to its ORIGINAL source position via the source map", async () => {
		// Transpiled handler sits at generated line 0, col 8. The map says that's
		// original src/app.ts line 9 (0-based) col 0, name "onClick".
		const mappings = buildMappings([
			[0, 0, 4, 2, 0],
			[8, 0, 9, 0, 0],
		]);
		const map = { version: 3, sources: ["src/app.ts"], names: ["onClick"], mappings };
		const scriptSource = `function onClick(){}\n//# sourceMappingURL=${inlineDataUri(map)}\n`;

		const { send, calls } = makeFakeSend({
			querySelectorNodeId: 42,
			objectId: "obj-9",
			listeners: [{ type: "click", scriptId: "7", lineNumber: 0, columnNumber: 8 }],
			scriptSource,
			scriptUrl: "http://localhost:3000/app.js",
		});

		const result = await resolveElementToSource({ send }, "#submit");

		expect(result.listeners).toHaveLength(1);
		const l = result.listeners[0];
		expect(l.type).toBe("click");
		expect(l.mapped).toBe(true);
		// 0-based 9/0 in the map → presented 1-based 10/1.
		expect(l.source).toEqual({ file: "src/app.ts", line: 10, column: 1 });
		expect(l.name).toBe("onClick");

		// On-demand domains were enabled and the full flow executed.
		expect(calls).toContain("DOMDebugger.enable");
		expect(calls).toContain("Debugger.enable");
		expect(calls).toContain("DOM.resolveNode");
		expect(calls).toContain("DOMDebugger.getEventListeners");
	});

	it("degrades to the TRANSPILED position with mapped:false when there is no source map", async () => {
		const { send } = makeFakeSend({
			querySelectorNodeId: 42,
			listeners: [{ type: "submit", scriptId: "3", lineNumber: 11, columnNumber: 4 }],
			scriptSource: "function handler(){}\n", // no //# sourceMappingURL
			scriptUrl: "http://localhost:3000/bundle.js",
		});

		const result = await resolveElementToSource({ send }, "form");

		expect(result.listeners).toHaveLength(1);
		const l = result.listeners[0];
		expect(l.mapped).toBe(false);
		// Transpiled position, 1-based: line 11+1, col 4+1, the script URL as file.
		expect(l.source).toEqual({ file: "http://localhost:3000/bundle.js", line: 12, column: 5 });
		expect(l.note).toBe("no sourceMappingURL");
	});

	it("throws when the selector matches no element (hard error, not a degrade)", async () => {
		const { send } = makeFakeSend({ querySelectorNodeId: 0 });
		await expect(resolveElementToSource({ send }, ".nope")).rejects.toThrow(/No element matches selector/);
	});

	it("reports no listeners (not an error) when the element has none bound", async () => {
		const { send } = makeFakeSend({ querySelectorNodeId: 5, listeners: [] });
		const result = await resolveElementToSource({ send }, "#x");
		expect(result.listeners).toHaveLength(0);
		expect(result.note).toMatch(/No event listeners/);
	});

	it("uses the optional lspResolve to refine the resolved position", async () => {
		const mappings = buildMappings([[0, 0, 2, 0, 0]]);
		const map = { version: 3, sources: ["src/widget.ts"], names: ["handle"], mappings };
		const scriptSource = `0;\n//# sourceMappingURL=${inlineDataUri(map)}\n`;
		const { send } = makeFakeSend({
			querySelectorNodeId: 9,
			listeners: [{ type: "click", scriptId: "1", lineNumber: 0, columnNumber: 0 }],
			scriptSource,
			scriptUrl: "http://x/widget.js",
		});

		const deps: ElementToSourceDeps = {
			send,
			lspResolve: async (pos) => ({ file: pos.file, line: 99, column: 7 }),
		};
		const result = await resolveElementToSource(deps, "#w");
		// LSP override wins over the source-map line/col, file preserved.
		expect(result.listeners[0].source).toEqual({ file: "src/widget.ts", line: 99, column: 7 });
		expect(result.listeners[0].mapped).toBe(true);
	});

	it("degrades when an external source map cannot be fetched (no fetchText injected)", async () => {
		const scriptSource = "0;\n//# sourceMappingURL=https://cdn.example.com/app.js.map\n";
		const { send } = makeFakeSend({
			querySelectorNodeId: 1,
			listeners: [{ type: "click", scriptId: "2", lineNumber: 3, columnNumber: 6 }],
			scriptSource,
			scriptUrl: "http://x/app.js",
		});
		const result = await resolveElementToSource({ send }, "#e");
		expect(result.listeners[0].mapped).toBe(false);
		expect(result.listeners[0].source).toEqual({ file: "http://x/app.js", line: 4, column: 7 });
		expect(result.listeners[0].note).toBe("source map not retrievable");
	});
});
