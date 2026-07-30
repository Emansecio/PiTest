import { describe, expect, it } from "vitest";
import { AskLineBlock, renderAskCallLines, renderAskResultLines } from "../src/core/tools/ask-render.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

initTheme();

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const plain = (lines: string[]): string[] => lines.map(strip);

const LONG_QUESTION =
	"Análise passiva concluída. O IDOR candidato está confirmado no cliente: o SPA monta a URL com o id do usuário e o backend não revalida o dono do recurso. Posso seguir com o teste ativo?";

describe("renderAskCallLines", () => {
	it("lays the question out against the real width instead of a fixed 80 columns", () => {
		const wide = plain(renderAskCallLines({ question: LONG_QUESTION }, theme, 200));
		expect(wide).toHaveLength(1);
		// Whole question fits on a wide terminal — the old hard 80-char clip did not.
		expect(wide[0]).toContain("Posso seguir com o teste ativo?");
		expect(wide[0]).not.toContain("…");
		expect(wide[0].length).toBeLessThanOrEqual(200);
	});

	it("keeps the question to a single clipped line", () => {
		// The picker card below already carries the full text while the ask is
		// pending, and afterwards this row is context nobody re-reads.
		const lines = plain(renderAskCallLines({ question: LONG_QUESTION }, theme, 60));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(/…$/);
		expect(lines[0].length).toBeLessThanOrEqual(60);
	});

	it("opens with the label instead of a background chip", () => {
		const lines = plain(renderAskCallLines({ question: LONG_QUESTION }, theme, 70));
		expect(lines[0].startsWith("Question: ")).toBe(true);
	});

	it("prefixes the scope tight against the question, matching the UI separator", () => {
		const lines = plain(renderAskCallLines({ question: "Seguir?", header: "autorização" }, theme, 80));
		expect(lines[0]).toBe("Question: autorização·Seguir?");
	});

	it("demotes an answered question but keeps the same layout", () => {
		const pending = renderAskCallLines({ question: "Seguir?", header: "escopo" }, theme, 80, false);
		const answered = renderAskCallLines({ question: "Seguir?", header: "escopo" }, theme, 80, true);
		expect(plain(answered)).toEqual(plain(pending));
		// Same text, quieter paint — the answer below it carries the block now.
		expect(answered[0]).not.toBe(pending[0]);
	});

	it("dims a trailing aside and drops it before touching the question", () => {
		const q = "Qual é o link alvo? (client_id ou URL de signup)";
		const wide = plain(renderAskCallLines({ question: q }, theme, 80));
		expect(wide[0]).toBe("Question: Qual é o link alvo? (client_id ou URL de signup)");
		// Too narrow for both: the aside goes, the question survives intact.
		const tight = plain(renderAskCallLines({ question: q }, theme, 34));
		expect(tight[0]).toContain("Qual é o link alvo?");
		expect(tight[0]).not.toContain("client_id");
	});

	it("never overflows a narrow terminal", () => {
		// A row wider than the viewport makes TUI.doRender throw, so this is a
		// crash guard, not a cosmetic one.
		for (let width = 4; width <= 40; width++) {
			for (const line of renderAskCallLines({ question: LONG_QUESTION, header: "escopo" }, theme, width)) {
				expect(strip(line).length).toBeLessThanOrEqual(width);
			}
			const result = renderAskResultLines(
				{
					response: { kind: "selection", selections: [LONG_QUESTION], comment: "uma nota razoavelmente longa" },
					cancelled: false,
				},
				"",
				theme,
				width,
			);
			for (const line of result) expect(strip(line).length).toBeLessThanOrEqual(width);
		}
	});

	it("keeps the ellipsis inside the paint instead of a bare reset", () => {
		// truncateToWidth emits `\x1b[0m…\x1b[0m`, which drops the `…` back to the
		// terminal default — the brightest thing on an otherwise muted row — and
		// kills the color of everything after it.
		const line = renderAskCallLines({ question: LONG_QUESTION, header: "escopo" }, theme, 60)[0];
		expect(line).toContain("…");
		expect(line).not.toContain("\x1b[0m");
	});

	it("drops the scope before it can crowd out the question", () => {
		const lines = plain(renderAskCallLines({ question: LONG_QUESTION, header: "escopo-bem-longo" }, theme, 26));
		expect(lines[0]).not.toContain("escopo-bem-longo");
		expect(lines[0]).toContain("Análise");
	});
});

describe("renderAskResultLines", () => {
	const answer =
		"Sem conta agora, mas autorize testes NÃO autenticados adicionais no fluxo de login com identificadores sintéticos";

	it("hangs the wrapped answer under its own glyph", () => {
		const lines = plain(
			renderAskResultLines(
				{ response: { kind: "selection", selections: [answer] }, cancelled: false },
				"",
				theme,
				60,
			),
		);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines[0].startsWith("❯ ")).toBe(true);
		for (const line of lines.slice(1)) {
			expect(line.startsWith("  ")).toBe(true);
			expect(line[2]).not.toBe(" ");
		}
	});

	it("gives each pick its own row and nests an attached comment", () => {
		const lines = plain(
			renderAskResultLines(
				{
					response: { kind: "selection", selections: ["Primeira", "Segunda"], comment: "só após o release" },
					cancelled: false,
				},
				"",
				theme,
				80,
			),
		);
		expect(lines).toEqual(["❯ Primeira", "❯ Segunda", "  ↳ só após o release"]);
	});

	it("renders a freeform answer as typed", () => {
		const lines = plain(
			renderAskResultLines(
				{ response: { kind: "freeform", text: "  faz do seu jeito  " }, cancelled: false },
				"",
				theme,
				80,
			),
		);
		expect(lines).toEqual(["❯ faz do seu jeito"]);
	});

	it("hard-breaks a long token without eating characters", () => {
		// The break used to slice by the truncated string's length, which counts
		// the four code units of the trailing reset as text — four characters of
		// the URL vanished at every wrap point.
		const url = `https://appai.example.com/eligibility/${"segmento-".repeat(12)}fim`;
		const lines = plain(
			renderAskResultLines({ response: { kind: "freeform", text: url }, cancelled: false }, "", theme, 30),
		);
		expect(lines.length).toBeGreaterThan(3);
		const rebuilt = lines.map((l, i) => (i === 0 ? l.slice(2) : l.slice(2))).join("");
		expect(rebuilt).toBe(url);
	});

	it("marks a cancelled prompt", () => {
		expect(plain(renderAskResultLines({ response: null, cancelled: true }, "", theme, 80))).toEqual(["✗ cancelled"]);
	});

	it("falls back to the raw payload with a neutral marker for auto-answers", () => {
		const lines = plain(
			renderAskResultLines(undefined, "Selected: Sim (auto, no interactive input bound)", theme, 80),
		);
		expect(lines).toEqual(["· Selected: Sim (auto, no interactive input bound)"]);
	});

	it("renders nothing when there is neither a response nor output", () => {
		expect(renderAskResultLines(undefined, "   ", theme, 80)).toEqual([]);
	});
});

describe("AskLineBlock", () => {
	it("reuses the same array instance until width or state changes", () => {
		let builds = 0;
		const block = new AskLineBlock("a", () => {
			builds++;
			return ["one"];
		});
		const first = block.render(80);
		expect(block.render(80)).toBe(first);
		expect(builds).toBe(1);

		// Same key: no rebuild, even though the builder closure is new.
		block.setState("a", () => ["two"]);
		expect(block.render(80)).toBe(first);

		block.setState("b", () => ["two"]);
		expect(block.render(80)).toEqual(["two"]);
		// A width change rebuilds too.
		expect(block.render(40)).not.toBe(block.render(80));
	});
});
