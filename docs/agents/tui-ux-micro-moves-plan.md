# Plano de implementação — 9 micro-melhorias de UX TUI

> **Para quem implementa:** este documento é autocontido. Leia a seção
> [Verificação](#verificação-anti-falso-positivo) primeiro, implemente **um lote
> por vez**, rode testes do lote, depois `npm run check`. Não mude constantes de
> motion (`SPINNER_FRAME_MS`, `REVEAL_*`, etc.) — ver Non-goals.
>
> **Contexto:** complementa [`TUI-AESTHETICS.md`](../reports/TUI-AESTHETICS.md) (Moves 0–5
> já shipped) e [`cli-animations.md`](cli-animations.md) (motion subsystem).
> Inventário do que já existe: [`already-built.md`](already-built.md).

---

## Verificação anti falso-positivo

Cada linha abaixo foi revalidada no código em 2026-07-01. Abra o anchor antes de
implementar; se o código já mudou, adapte o plano em vez de duplicar.

| # | Problema | Veredito | Evidência (abrir e confirmar) |
|---|----------|----------|-------------------------------|
| **1** | Loader sem sinal de vazão durante streaming longo | **Real** | [`loader.ts`](../../packages/tui/src/components/loader.ts) L282–287: `composeDisplayText()` = spinner + message + elapsed — **sem** suffix de throughput. [`interactive-mode.ts`](../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) trata `message_update` (L3028) mas **não** alimenta o loader. [`TUI-AESTHETICS.md`](../reports/TUI-AESTHETICS.md) lista explicitamente: "No token-rate / streaming-progress hint". |
| **2** | Fase do loader expõe nomes internos de tool | **Real** | [`interactive-mode.ts`](../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) L3100: ``setWorkingPhase(`Running ${event.toolName}…`)`` → usuário vê `Running edit_v2…`. [`tool-activity.ts`](../../packages/coding-agent/src/modes/interactive/components/tool-activity.ts) já exporta `verbFor()` (L152) — **não usado** no call site. |
| **3** | Hint `(esc to interrupt)` some no turno normal | **Real** | Hint no loader só em [`resetExtensionUI`](../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) L1785 (reset de extensão). `setWorkingPhase` (L1549–1552) chama `setMessage(label)` e **substitui** a mensagem. `createWorkingLoader` (L1555) usa `getWorkingLoaderMessage()` **sem** hint. |
| **4** | Activity line sem elapsed em ações lentas | **Real** | [`activity-line.ts`](../../packages/coding-agent/src/modes/interactive/components/activity-line.ts): **zero** ocorrências de `startedAt`, `Date.now`, `performance.now`. Header pending recomputa todo frame (`cacheable` exclui pending, L262). |
| **5** | NavGroup não mostra alvo da call pendente | **Real** | [`nav-group.ts`](../../packages/coding-agent/src/modes/interactive/components/nav-group.ts) L202–208: `header()` = ícone + verbo + contadores. Teste [`nav-group-component.test.ts`](../../packages/coding-agent/test/nav-group-component.test.ts) L46–50 confirma "Exploring" mas **não** basename pendente. |
| **6** | Números de linha do diff na mesma cor cheia | **Real** | [`diff.ts`](../../packages/coding-agent/src/modes/interactive/components/diff.ts) L127–128: ``theme.fg("toolDiffRemoved", `-${removed.lineNum} ${removedLine}`)`` — prefixo, número e corpo numa única cor. |
| **7** | Todo overlay usa `█░`, footer usa `▰▱` | **Real** | [`todo-overlay.ts`](../../packages/coding-agent/src/modes/interactive/components/todo-overlay.ts) L50–51 vs [`footer.ts`](../../packages/coding-agent/src/modes/interactive/components/footer.ts) L75–76. Move 5 do TUI-AESTHETICS trocou só o footer. |
| **8** | H2/H3 sem hierarquia vs H1 com gradiente | **Real** | [`theme.ts`](../../packages/coding-agent/src/modes/interactive/theme/theme.ts) L1183–1186: só `heading1` especial. [`markdown.ts`](../../packages/tui/src/components/markdown.ts) L623–628: H2+ caem no mesmo `theme.heading(bold)`. |
| **9** | Prosa assistant edge-to-edge por default | **Real, decisão de produto** | [`assistant-message.ts`](../../packages/coding-agent/src/modes/interactive/components/assistant-message.ts) L51: `DEFAULT_ASSISTANT_READING_COLUMNS = 0` (comentário: paridade Claude Code). Setting `assistantReadingColumns` existe. **Lote H é opcional** — só implementar se quiser mudar o default para ~100. |

**Não são problemas (não implementar aqui):** editor card arredondado, placeholder no
editor, sidebar, diff side-by-side, unificar spinners, reduced-motion (já shipped).

---

## Ordem de lotes

```
Lote A (Loader suffix)  →  Lote B (labels humanos)
       ↓
Lotes C + D + E (activity / nav / diff) — podem ser paralelos
       ↓
Lotes F + G (+ H opcional)
       ↓
npm run check + visual gate 60/140 cols
```

---

## Regras obrigatórias (AGENTS.md)

- Erasable TS: sem `enum`, sem parameter properties, sem `namespace`, sem dynamic import.
- Sem nested ternaries.
- Ellipsis sempre `…` (U+2026), nunca `...`.
- Toda linha renderizada: `visibleWidth()` / `truncateToWidth()`.
- Verbos de tool visíveis ao usuário: Ran / Read / Edited / Searched / Asked (via `verbFor`).
- Gate final: `npm run check`.
- Testes `@pit/tui`: `node --test packages/tui/test/<file>.ts` (FORCE_COLOR no import).
- Testes coding-agent: vitest isolado se suite Windows cancelar batch.
- **Visual gate obrigatório** para lotes de layout: tmux 60 + 140 cols — ver
  [`tui-testing.md`](tui-testing.md). `npm run check` verde ≠ layout correto.

---

## Lote A — Loader: hint de interrupt + vazão de streaming (itens 1 + 3)

### Objetivo

Durante um turno, o working loader deve ler:

```
⠏ Editing footer.ts… 14s · esc to interrupt · ↓1.2k
```

- **14s** — já existe (`setElapsedEnabled`).
- **esc to interrupt** — permanente; não some quando `setWorkingPhase` troca a fase.
- **↓1.2k** — chars de texto assistant acumulados no turno, atualizado no máximo 1×/s
  (mesmo gate do elapsed).

### A1 — Estender `@pit/tui` Loader

**Arquivo:** [`packages/tui/src/components/loader.ts`](../../packages/tui/src/components/loader.ts)

1. Campo novo: `private coloredTrailingSuffix = ""`.
2. Método público:

```typescript
setTrailingSuffix(suffix: string): void {
  const next = suffix.length > 0 ? this.messageColorFn(suffix) : "";
  if (next === this.coloredTrailingSuffix) return;
  this.coloredTrailingSuffix = next;
  this.updateDisplay();
}
```

3. Em `composeDisplayText()` (L282), mudar para:

```typescript
return `${indicator}${this.coloredMessage}${this.coloredElapsed}${this.coloredTrailingSuffix}`;
```

4. **Não** embutir suffix em `setMessage` — fase e suffix são independentes.

**Testes:** estender [`packages/tui/test/loader-elapsed.test.ts`](../../packages/tui/test/loader-elapsed.test.ts):

```bash
node --test packages/tui/test/loader-elapsed.test.ts
```

Casos:
- `setTrailingSuffix(" · hint")` → output contém `hint`.
- `setMessage("Thinking…")` depois → suffix **ainda** presente.

### A2 — Wiring em InteractiveMode

**Arquivo:** [`packages/coding-agent/src/modes/interactive/interactive-mode.ts`](../../packages/coding-agent/src/modes/interactive/interactive-mode.ts)

**Campos novos** (perto de `workingMessage`):

```typescript
private streamTextCharCount = 0;
private lastStreamRateSampleMs = 0;
private lastStreamRateCharCount = 0;
```

**Helper privado** (no mesmo arquivo ou em util pequeno):

```typescript
private resetStreamRateCounters(): void {
  this.streamTextCharCount = 0;
  this.lastStreamRateSampleMs = 0;
  this.lastStreamRateCharCount = 0;
}

private countAssistantTextChars(message: AssistantMessage): number {
  let n = 0;
  for (const block of message.content) {
    if (block.type === "text" && typeof block.text === "string") {
      n += block.text.length;
    }
  }
  return n;
}

private formatStreamThroughput(charsPerSec: number): string {
  if (charsPerSec <= 0) return "";
  // Reutilizar escala de footer formatTokens para consistência visual
  if (charsPerSec < 1000) return `↓${charsPerSec}`;
  return `↓${(charsPerSec / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

private refreshLoaderTrailingSuffix(): void {
  if (!this.loadingAnimation) return;
  const interrupt = `${theme.fg("dim", ` · ${keyText("app.interrupt")} to interrupt`)}`;
  let rate = "";
  const now = Date.now();
  if (this.lastStreamRateSampleMs > 0 && now - this.lastStreamRateSampleMs >= 1000) {
    const delta = this.streamTextCharCount - this.lastStreamRateCharCount;
    const secs = (now - this.lastStreamRateSampleMs) / 1000;
    const cps = secs > 0 ? Math.round(delta / secs) : 0;
    if (cps > 0) rate = theme.fg("dim", ` · ${this.formatStreamThroughput(cps)}`);
    this.lastStreamRateSampleMs = now;
    this.lastStreamRateCharCount = this.streamTextCharCount;
  }
  this.loadingAnimation.setTrailingSuffix(`${interrupt}${rate}`);
}
```

**Em `createWorkingLoader()`** — após `setElapsedEnabled(true)`:

```typescript
this.resetStreamRateCounters();
this.lastStreamRateSampleMs = Date.now();
this.lastStreamRateCharCount = 0;
loader.setTrailingSuffix(
  `${theme.fg("dim", ` · ${keyText("app.interrupt")} to interrupt`)}`,
);
```

Importar `keyText` de [`keybinding-hints.ts`](../../packages/coding-agent/src/modes/interactive/components/keybinding-hints.ts).

**Em `case "message_update"`** (bloco assistant, L3028+):

1. `this.streamTextCharCount = this.countAssistantTextChars(this.streamingMessage);`
2. Chamar `this.refreshLoaderTrailingSuffix()` (gate 1s interno).

**Em `stopWorkingLoader()`:** `this.resetStreamRateCounters()`.

**Remover** L1785 que faz `setMessage(... interrupt ...)` dentro de `resetExtensionUI` —
redundante e confunde (suffix permanente substitui).

**Pitfall:** não chamar `refreshLoaderTrailingSuffix` a cada delta sem gate — seguir
padrão de `refreshElapsed` no Loader (1 Hz).

---

## Lote B — Labels humanos no working phase (item 2)

### Objetivo

Substituir `Running edit_v2…` por `Editing src/foo.ts…`.

### B1 — Helper exportado

**Arquivo:** [`packages/coding-agent/src/modes/interactive/components/tool-activity.ts`](../../packages/coding-agent/src/modes/interactive/components/tool-activity.ts)

Adicionar **no final do arquivo** (antes de exports existentes ou após `verbFor`):

```typescript
import { basename } from "node:path";
import { truncateWithEllipsis } from "../../../utils/surrogate.ts";
import { clampBashCommandRow } from "./bash-command-row.ts";

const WORKING_TARGET_MAX = 48;

function workingTargetSnippet(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "bash") {
    const cmd = String(args.command ?? "").trim();
    if (!cmd) return "";
    return truncateWithEllipsis(cmd.replace(/\s+/g, " "), WORKING_TARGET_MAX);
  }
  if (toolName === "web_search") {
    const q = String(args.query ?? "").trim();
    return q ? truncateWithEllipsis(q, WORKING_TARGET_MAX) : "";
  }
  const rawPath =
    typeof args.path === "string"
      ? args.path
      : typeof args.file_path === "string"
        ? args.file_path
        : "";
  if (rawPath) {
    const name = basename(rawPath.replace(/[\\/]+$/, ""));
    return name ? truncateWithEllipsis(name, WORKING_TARGET_MAX) : "";
  }
  return "";
}

/** Label for the working loader while a tool executes. Uses verbFor + short target. */
export function workingPhaseLabel(
  toolName: string,
  args: Record<string, unknown> | undefined,
  pending: boolean,
): string {
  const verb = verbFor(toolName, pending);
  const target = workingTargetSnippet(toolName, args ?? {});
  if (target) return `${verb} ${target}…`;
  if (verbFor("", pending) === verb && toolName !== "bash") {
    return `${toolName}…`;
  }
  return `${verb}…`;
}
```

**Ajuste imports** no topo — mover `basename`/`truncateWithEllipsis`/`clampBashCommandRow`
só se usar clampBashCommandRow (opcional para bash; snippet simples basta).

### B2 — Call site

**Arquivo:** [`interactive-mode.ts`](../../packages/coding-agent/src/modes/interactive/interactive-mode.ts) L3097–3102:

```typescript
case "tool_execution_start": {
  const component = this._ensureToolComponent(event.toolName, event.toolCallId, event.args);
  component.markExecutionStarted();
  this.setWorkingPhase(
    workingPhaseLabel(
      event.toolName,
      event.args as Record<string, unknown>,
      true,
    ),
  );
  this.ui.requestRender();
  break;
}
```

Import: `workingPhaseLabel` de `./components/tool-activity.ts`.

### B3 — Testes

**Criar:** [`packages/coding-agent/test/working-phase-label.test.ts`](../../packages/coding-agent/test/working-phase-label.test.ts)

```typescript
import { describe, expect, it } from "vitest";
import { workingPhaseLabel } from "../src/modes/interactive/components/tool-activity.ts";

describe("workingPhaseLabel", () => {
  it("uses verb + basename for edit", () => {
    const label = workingPhaseLabel("edit", { path: "src/core/footer.ts" }, true);
    expect(label).toContain("Editing");
    expect(label).toContain("footer.ts");
    expect(label.endsWith("…")).toBe(true);
  });
  it("uses command snippet for bash", () => {
    const label = workingPhaseLabel("bash", { command: "npm run check" }, true);
    expect(label).toContain("Running");
    expect(label).toContain("npm");
  });
  it("falls back to tool name for unknown tools", () => {
    expect(workingPhaseLabel("mcp_foo", {}, true)).toContain("mcp_foo");
  });
});
```

Rodar:

```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/working-phase-label.test.ts
```

---

## Lote C — Elapsed na activity line (item 4)

**Arquivo:** [`activity-line.ts`](../../packages/coding-agent/src/modes/interactive/components/activity-line.ts)

1. Constante: `const SLOW_ACTION_ELAPSED_SEC = 4;`
2. Campo: `private execStartedAtMs = 0;`
3. Em `setExec` e `coalesce`: `this.execStartedAtMs = Date.now();`
4. No `render()`, antes de `truncateToWidth(rawHeader, width)` (L298):

```typescript
let headerText = rawHeader;
if (pending) {
  const elapsedSec = Math.floor((Date.now() - this.execStartedAtMs) / 1000);
  if (elapsedSec >= SLOW_ACTION_ELAPSED_SEC) {
    headerText += ` ${theme.fg("muted", `· ${elapsedSec}s`)}`;
  }
}
const header = truncateToWidth(headerText, width);
```

**Teste:** estender [`activity-line-component.test.ts`](../../packages/coding-agent/test/activity-line-component.test.ts) com `vi.spyOn(Date, "now")` ou injetar tempo fixo via stub `execStartedAtMs` se expuser setter de teste — preferir spy:

```typescript
it("shows elapsed suffix on slow pending actions", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  const c = new ActivityLineComponent(fakeTui());
  c.setExec(execStub({ getActivityState: () => "pending", getToolName: () => "bash" }));
  now.mockReturnValue(5000);
  expect(stripAnsi(c.render(120)[0])).toContain("· 5s");
  now.mockRestore();
});
```

---

## Lote D — NavGroup: alvo pendente (item 5)

**Arquivo:** [`nav-group.ts`](../../packages/coding-agent/src/modes/interactive/components/nav-group.ts)

1. Método privado `pendingTargetLabel(): string | null`:

```typescript
private pendingTargetLabel(): string | null {
  for (const e of this.execs) {
    if (e.getActivityState() !== "pending") continue;
    const name = e.getToolName();
    const args = (e.getArgs() ?? {}) as Record<string, unknown>;
    if (name === "read") {
      const raw = typeof args.file_path === "string" ? args.file_path : "";
      const nameOnly = basename(raw.replace(/[\\/]+$/, ""));
      if (nameOnly) return nameOnly;
    }
    if (name === "grep" || name === "find" || name === "ast_grep") {
      const pat = typeof args.pattern === "string" ? args.pattern : "";
      if (pat) return pat.length > 32 ? `${pat.slice(0, 31)}…` : pat;
    }
    return name;
  }
  return null;
}
```

2. Em `header()`, após montar string base, se `state === "pending"`:

```typescript
const pending = this.pendingTargetLabel();
if (pending) {
  const suffix = theme.fg("muted", ` — ${pending}`);
  // Truncar summary se necessário para caber suffix + width
  ...
}
```

Budget de width: o `summary()` já trunca; reserve ~20 cols para ` — basename`.

**Teste:** [`nav-group-component.test.ts`](../../packages/coding-agent/test/nav-group-component.test.ts) — pending read `{ file_path: "src/footer.ts" }` → header contém `footer.ts`.

---

## Lote E — Diff: line numbers em dim (item 6)

**Arquivo:** [`diff.ts`](../../packages/coding-agent/src/modes/interactive/components/diff.ts)

Helper local:

```typescript
function formatDiffLine(
  sign: "+" | "-" | " ",
  lineNum: string,
  body: string,
  lineColor: ThemeColor,
): string {
  const trimmedNum = lineNum.trim();
  const numRendered = trimmedNum.length > 0 ? theme.fg("dim", trimmedNum) : "";
  const gap = numRendered ? " " : "";
  return `${theme.fg(lineColor, sign)}${numRendered}${gap}${body}`;
}
```

Substituir pushes como L127:

```typescript
result.push(formatDiffLine("-", removed.lineNum, removedLine, "toolDiffRemoved"));
result.push(formatDiffLine("+", added.lineNum, addedLine, "toolDiffAdded"));
```

Aplicar em **todos** os branches (multi-line, standalone +, context).

**Teste:** criar [`packages/coding-agent/test/diff-render.test.ts`](../../packages/coding-agent/test/diff-render.test.ts) com input mínimo unified diff; `stripAnsi` e assert estrutura.

---

## Lote F — Gauge glyphs compartilhados (item 7)

1. **Criar** [`gauge-glyphs.ts`](../../packages/coding-agent/src/modes/interactive/components/gauge-glyphs.ts):

```typescript
/** Filled / empty gauge cells (footer + todo). Fallback: ● / ○ if font lacks U+25B0. */
export const GAUGE_FILLED = "▰";
export const GAUGE_EMPTY = "▱";
```

2. **footer.ts:** importar `GAUGE_FILLED`, `GAUGE_EMPTY`; remover `CTX_GAUGE_FILLED`/`CTX_GAUGE_EMPTY` locais (ou alias).

3. **todo-overlay.ts** `renderProgressBar`:

```typescript
const filledPart = theme.fg("success", GAUGE_FILLED.repeat(filled));
const emptyPart = theme.fg("dim", GAUGE_EMPTY.repeat(empty));
```

---

## Lote G — Hierarquia H2 (item 8)

### G1 — Interface

**Arquivo:** [`packages/tui/src/components/markdown.ts`](../../packages/tui/src/components/markdown.ts)

Em `MarkdownTheme`:

```typescript
heading2?: (text: string) => string;
```

### G2 — Render

No `case "heading"`, **antes** do branch H1 (L623):

```typescript
} else if (headingLevel === 2 && this.theme.heading2) {
  headingStyleFn = (text: string) => this.theme.heading2!(text);
```

### G3 — Theme

**Arquivo:** [`theme.ts`](../../packages/coding-agent/src/modes/interactive/theme/theme.ts) `getMarkdownTheme()`:

```typescript
heading2: (text: string) =>
  theme.fg("accent", "▎ ") + theme.fg("mdHeading", theme.bold(text)),
```

**Teste:** adicionar caso em test markdown existente ou criar mínimo em `packages/tui/test/`.

---

## Lote H — Reading column default (item 9, OPCIONAL)

**Só se o product owner aprovar mudança de default.**

1. [`assistant-message.ts`](../../packages/coding-agent/src/modes/interactive/components/assistant-message.ts) L51: `DEFAULT_ASSISTANT_READING_COLUMNS = 100`.
2. [`settings-manager.ts`](../../packages/coding-agent/src/core/settings-manager.ts) comentário L506: default 100; `0` = full width.
3. Atualizar comentário em assistant-message (remover referência Claude Code ou notar mudança).

Setting `assistantReadingColumns: 0` em `.pit/settings.json` restaura edge-to-edge.

---

## Checklist final

- [ ] Lote A: suffix interrupt sobrevive a `setWorkingPhase`; rate aparece após ~1s streaming
- [ ] Lote B: loader nunca mostra `Running edit_v2…` para built-ins mapeados
- [ ] Lote C: action pending ≥4s mostra `· Ns`
- [ ] Lote D: NavGroup exploring mostra basename/query pendente
- [ ] Lote E: diff line numbers em dim
- [ ] Lote F: todo bar usa `▰▱`
- [ ] Lote G: H2 com prefixo `▎`
- [ ] Lote H (opcional): wrap ~100 cols default
- [ ] `npm run check` verde
- [ ] Visual gate tmux 60 + 140 cols nos lotes A, F, G, H

---

## Referência rápida de arquivos

| Lote | Arquivos principais | Testes |
|------|---------------------|--------|
| A | `packages/tui/src/components/loader.ts`, `interactive-mode.ts` | `packages/tui/test/loader-elapsed.test.ts` |
| B | `tool-activity.ts`, `interactive-mode.ts` | `test/working-phase-label.test.ts` (novo) |
| C | `activity-line.ts` | `test/activity-line-component.test.ts` |
| D | `nav-group.ts` | `test/nav-group-component.test.ts` |
| E | `diff.ts` | `test/diff-render.test.ts` (novo) |
| F | `gauge-glyphs.ts`, `footer.ts`, `todo-overlay.ts` | grep `█` em testes todo |
| G | `markdown.ts`, `theme.ts` | `packages/tui/test/` markdown |
| H | `assistant-message.ts`, `settings-manager.ts` | assistant-message tests se existirem |
