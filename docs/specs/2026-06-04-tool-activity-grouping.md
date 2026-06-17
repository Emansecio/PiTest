> **Status:** Shipped — commits fd22db32, 390a6897, 9152ed2c. Historical record of a delivered feature. This file consolidates the original design spec, implementation plan, and Amp-style rendering refinement (previously three separate files).

# Tool Activity Grouping — Consolidated (Design + Plan + Amp Rendering)

---

## Part 1 — Design Spec

# Tool Activity Grouping — Design

Data: 2026-06-04 · Status: design aprovado; plano de implementação em **Part 2 — Implementation Plan** (abaixo, neste mesmo arquivo). Correções pós-recon aplicadas (testes sob **vitest**, não `node --test`; formato de diff é **custom**, não unified; assert de gutter direto no `render()`; o exec é **envolvido** por componentes-linha em vez de refatorado). **Não implementar** fora do plano.

## Contexto e problema

Hoje a TUI interativa do Pit renderiza **1 bloco empilhado por tool call** ([interactive-mode.ts:2752](packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2752)): cada `ToolExecutionComponent` ganha gutter `│`, cabeçalho e preview. Numa sessão real o agente faz dezenas de calls, e esse log de bastidor **afoga a narração do agente** — que é justamente o que o humano lê. O sinal (a fala do agente, os diffs) fica enterrado no ruído (cada read/grep/ls como bloco próprio).

**Objetivo:** elevar a qualidade de UI/UX agrupando a atividade de bastidor em linhas-resumo e deixando a fala do agente em primeiro plano — o padrão para o qual Claude Code / Cursor / Amp convergiram, por ser a resposta certa ao problema de signal/noise.

## Decisões (fixadas no brainstorming)

- **Substitui** o empilhamento atual (novo padrão; não é opt-in). Mantém-se um *escape hatch* de reversão (setting), por precaução de UX — não como modo paralelo de primeira classe.
- **Duas famílias de linha:** navegação passiva colapsa num resumo agregado; ação com efeito ganha linha própria com seu identificador.
- **Estilo limpo:** o marcador de estado é um ícone (`✓`/`✗`/spinner), **sem** o gutter `│`. O gutter permanece **apenas** na mensagem do usuário e nos eventos de sistema (compactação, branch, diagnostics) — "temporariamente", podendo migrar depois.
- **Erros sempre visíveis:** sucesso colapsa; uma tool que falha auto-expande seu detalhe inline e marca a linha com `✗`. Diffs de sucesso ficam atrás do `ctrl+o`.

## Modelo

### Famílias de tool

O `TOOL_REGISTRY` ([core/tools/index.ts:298](packages/coding-agent/src/core/tools/index.ts#L298)) tem **35 tools** built-in + as de extensão/MCP. Categorizar por **metadado na definição da tool** (campo novo `activity: "navigation" | "action"`, default `"action"`), **não** por lista hardcoded — assim extensões/MCP se autodeclaram e o default seguro (ação = linha própria) cobre o desconhecido. Confirmar no plano se já existe um flag read-only reusável antes de criar o campo.

|família|tools built-in|render|
|-|-|-|
|navegação|read, grep, find, ls, symbol, ast_grep, search_tool_bm25, recall, reflect, recipe, calc, inspect_image, recall_tool_output, chrome_devtools_{screenshot,read_console,read_network,list_pages}|colapsa num **NavGroup** agregado|
|ação|edit, edit_v2, write, bash, web_search, ast_edit, eval, render_mermaid, goal_complete, todo, ask, resolve, retain, forget, preview, chrome_devtools_{select_page,navigate,evaluate}|**linha própria** com identificador|

Eixo: *navegação* = read-only, ruído de orientação (agrega); *ação* = efeito observável (destaque individual). Só `edit`/`edit_v2` usam `renderShell:"self"` hoje (desenham o próprio diff).

### Divisão da rajada

- Navegação **contígua** acumula no NavGroup aberto.
- Uma **ação** fecha o NavGroup aberto e emite sua própria linha.
- **Texto de resposta do agente** (`AssistantMessageComponent` com conteúdo visível) fecha tudo e divide as rajadas.
- **Thinking não divide** (senão fragmenta demais e mata o ganho de signal/noise).
- **Abort/interrupção** fecha a rajada no estado atual.

### Formato de linha

```
✓ Explored 3 files · 1 search · 1 list                     ▸     NavGroup (agregado por categoria)
✓ Edited  server/.../+page.svx  +1 -1                       ▸     edit  → arquivo clicável + diffstat
✓ Wrote   server/src/lib/new.ts                             ▸     write → arquivo (novo ou sobrescrito)
✓ Ran  $ npm test  ✓                                        ▸     bash  → comando + status
✓ Fetched example.com                                       ▸     web   → host
✓ research  topic: "…"                                      ▸     Task/MCP → nome + args ≤80c

  I'll update the manual's embedded video…                        texto do agente divide a rajada

⋮ Exploring 2 files · 1 search                              ▸     em andamento: spinner no lugar do ✓
✗ Ran  $ npm run build  exit 1                              ▾     erro: auto-expande o output do item
    <stderr inline…>
```

- **Estados:** spinner (`SPINNER_FRAME_MS=80`) enquanto roda → `✓` verde (ok) / `✗` vermelho (erro). Fade de cor reusa o `GUTTER_EASE_MS=220ms`.
- **Affordance:** `▸` colapsado / `▾` expandido.
- **NavGroup** usa verbo fixo `Exploring`/`Explored` (só agrega navegação) e atualiza o agregado **ao vivo** conforme as calls chegam (`Exploring 1 file` → `Exploring 2 files · 1 search`). As linhas de ação usam o verbo da própria categoria (`Edited`, `Wrote`, `Ran`, `Fetched`).

### Visibilidade e expansão

- Sucesso → colapsado (navegação no contador agregado; ação na sua linha-resumo).
- Erro → auto-expande o `ToolExecutionComponent` daquele item inline; a linha de ação **ou** o NavGroup fica `✗`. Numa tool de **navegação que falha**, o NavGroup marca `✗` e auto-expande **só o filho que falhou**; os demais seguem colapsados no contador.
- `ctrl+o` (`toggleToolOutputExpansion`, estado global) expande/colapsa: para o NavGroup, mostra todos os filhos (os blocos de hoje); para uma ação, mostra seu detalhe (o diff completo, o output do bash).

## Arquitetura

Reaproveita o máximo do que existe — não é rewrite dos renderizadores por-tool.

- **`NavGroupComponent`** (novo): acumula tool calls de navegação; header agregado por categoria; mantém os `ToolExecutionComponent` como filhos (renderizados só ao expandir). Sem gutter — usa o ícone de estado. Métodos: `addCall(exec)`, `markClosed()`, `updateHeader()`.
- **`ToolExecutionComponent`** (existente, ajustado): para as ações; header novo no estilo-linha (ícone + identificador + diffstat/status), sem gutter. O `renderCall`/`renderResult` por-tool e o `ctrl+o` são reaproveitados.
- **`MessageShell`** (existente, intacto): segue servindo `UserMessageComponent` (gutter azul) e os eventos de sistema (gutter custom/diagnostics).
- **interactive-mode** ([:2752](packages/coding-agent/src/modes/interactive/interactive-mode.ts#L2752)): ganha o estado `currentNavGroup` e a regra de empilhamento:
  - call de navegação → adiciona ao `currentNavGroup` (cria se não houver);
  - call de ação → `currentNavGroup = null` (fecha) + emite linha de ação;
  - `AssistantMessage` com texto → fecha o NavGroup + adiciona o texto;
  - thinking → não mexe no NavGroup.

O **diffstat** (`+N/-M`) deriva de `result.details.diff` (tipo `EditToolDetails`, [edit.ts:481](packages/coding-agent/src/core/tools/edit.ts#L481)). **Atenção (recon):** o diff **não** é unified padrão — é formato custom (`generateDiffString`/`computeEditsDiff` em `edit-diff.ts`): cada linha tem prefixo `+`/`-`/espaço no **primeiro caractere**, seguido do número de linha (com `padStart`); sem header `@@`/`---`/`+++`. Contagem robusta por `line[0]`: `'+'` → adicionada, `'-'` → removida, `' '` → contexto. `write` retorna `details: undefined` → id = só o caminho (sem diffstat); `bash` retorna `BashToolDetails` (sem diff, sem exit code estruturado) → status comunicado pelo ícone `✓`/`✗`.

## Edge cases

- **NavGroup de 1 item:** usa o formato agregado mesmo assim (`Explored 1 file`), por consistência (espelha a imagem-alvo).
- **Edits repetidos no mesmo arquivo:** consolidam num diffstat acumulado numa só linha.
- **`renderShell:"self"`** (edit-hashline, extensões com UI própria): contam como ação (linha própria); a UI própria aparece ao expandir, ou imediatamente se a tool falhar.
- **Abort:** fecha a rajada no estado atual, sem promover a erro.
- **Tool calls concorrentes (resolvido):** o dispatch **é paralelo** ([agent-loop.ts:716](packages/agent/src/agent-loop.ts#L716) `executeToolCallsParallel`), então `tool_execution_start`/`end` chegam **fora de ordem**. Solução: o agrupamento é decidido na **primeira aparição da toolCall no stream** (`message_update` :2502, que reflete a ordem determinística do assistant message) — `tool_execution_start`/`end` é idempotente e só atualiza o spinner/estado do componente já posicionado, casando pelo `toolCallId`. Assim a ordem visual é determinística independente da ordem de execução. Um batch misto (nav+ação na ordem do message) fragmenta em NavGroups separados — previsível e aceitável.

## Não-objetivos (YAGNI)

- Migrar a mensagem do usuário e os eventos de sistema para o estilo limpo (futuro — o "temporariamente" do gutter).
- Taxonomia tool→família configurável pelo usuário.
- Agrupar atividade entre turnos diferentes (cada turno do agente reinicia o estado de rajada).

## Mapa do código (recon 2026-06-04)

Levantado por 3 agentes de recon + validado nos 3 pilares (concorrência paralela, `shellDisabled`, `details.diff`).

**Empilhamento / ciclo de vida** — [interactive-mode.ts](packages/coding-agent/src/modes/interactive/interactive-mode.ts):
- `_ensureToolComponent()` :2752–2771 — **único ponto** de criação de tool ao vivo (`addChild` :2769); chamado por `message_update` (:2502) e `tool_execution_start` (:2549). É aqui que a bifurcação nav/ação decide entre `NavGroup.addCall` e `addChild` direto.
- `AssistantMessageComponent`: live em `message_start` :2480–2489; histórico em `addMessageToChat()` :2908–2915.
- **Rebuild de histórico**: `renderSessionContext()` :2953–2966 cria tools fora do `_ensureToolComponent` — precisa do **mesmo** agrupamento (não esquecer este caminho).
- Ciclo: `message_update`(toolCall)→ensure/updateArgs · `tool_execution_start`→markExecutionStarted (spinner) · `tool_execution_update`→updateResult(partial) · `tool_execution_end`→updateResult(final)+`pendingTools.delete`.
- Inserção do `currentNavGroup`: reset em `agent_start` (:2440) e no início de `renderSessionContext`; fecha em texto visível (`message_update` :2496 / `message_end` :2514) e em abort.

**Texto vs thinking** — [assistant-message.ts:127–263](packages/coding-agent/src/modes/interactive/components/assistant-message.ts#L127): `updateContent()` discrimina `content.type "text"` vs `"thinking"`. **Não há** `hasVisibleText()` público — adicionar (ou inspecionar `message.content.some(c => c.type==="text" && c.text.trim())`) pra decidir o fechamento da rajada.

**Shell / gutter / spinner / expand**:
- Gutter desenhado em [message-shell.ts:150–166](packages/coding-agent/src/modes/interactive/components/message-shell.ts#L150); **`shellDisabled`** (:62, :130–135) já faz passthrough sem gutter → estilo limpo = construir com `shellDisabled:true`. Hooks prontos: `setGutterColor`/`setGutterSpinner`/`setLabel`/`setShellDisabled`.
- Spinner+fade em [tool-execution.ts](packages/coding-agent/src/modes/interactive/components/tool-execution.ts): `runningSpinnerTick` :549–554 e `gutterEaseTick` (`GUTTER_EASE_MS=220`) :514–526 escrevem no gutter via `setGutterSpinner`/`setGutterColor`. **Decisão (recon):** em vez de refatorar esse spinner para um destino parametrizável (que arriscaria o modo legacy), o exec é **envolvido** — no modo agrupado roda com `setShellDisabled(true)` (sem gutter; animação de gutter desligada via flag `setActivityChild`) e expõe `getActivityState(): "pending"|"success"|"error"`. Quem pinta o ícone é o componente-linha (`NavGroupComponent`/`ActivityLineComponent`), com um ticker próprio extraído para helper compartilhado (`spinner-ticker.ts`). O código de gutter/spinner do exec fica **intacto** para o modo legacy.
- **Expand é GLOBAL** — [interactive-mode.ts:3329](packages/coding-agent/src/modes/interactive/interactive-mode.ts#L3329) `toggleToolOutputExpansion` itera todos os `chatContainer.children` chamando `setExpanded`. NavGroup só implementa `setExpanded(boolean)` (duck-type `Expandable`) e repassa aos filhos — cai no loop automaticamente.

**Concorrência** — [agent-loop.ts:716–786](packages/agent/src/agent-loop.ts#L716): `executeToolCallsParallel` (Promise.all em start :727 e exec :748; só o result fan-out :778 é serial).

## Testes

**Correção (recon):** os componentes interativos vivem em `packages/coding-agent/` e seus testes rodam sob **vitest** (`cd packages/coding-agent && npx vitest --run test/<arquivo>.test.ts`), **não** `node --test` — o `_render-assert-setup.ts`/`render-width assert` é exclusivo do package `@pit/tui`. Padrão do repo ([test/tool-execution-component.test.ts](packages/coding-agent/test/tool-execution-component.test.ts)): `initTheme("dark")` no `beforeAll`, `createFakeTui()` (stub com `requestRender`/`addAnimationCallback`), instanciar, `render(width): string[]`, `stripAnsi(...)`, `expect().toContain`/`.not.toContain`.

- **Empilhamento:** navegação agrupa; ação quebra o NavGroup; texto divide; thinking não; abort fecha (testado via `ActivityStacker` isolado).
- **NavGroup:** contadores por categoria, atualização ao vivo, transições spinner→✓/✗, auto-expand do filho que falha.
- **Linhas de ação:** edit com diffstat correto (contagem por `line[0]`), write `Wrote`, bash com status, erro auto-expandido.
- **Gutter ausente:** assert direto no render — `for (const l of comp.render(120)) expect(stripAnsi(l)).not.toContain("│")`. (`PIT_TUI_WRITE_LOG` é só p/ sessão real via `ProcessTerminal`; não serve a teste unitário de componente.)

## Rollout

Default = modo agrupado. Setting de reversão `tui.toolActivity: "grouped" | "legacy"` mantém o caminho antigo vivo por precaução (regressões de UX só aparecem no uso real), sem ser um opt-in de primeira classe. Caminho legacy pode ser removido depois de estabilizar.


---

## Part 2 — Implementation Plan

# Tool Activity Grouping — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir o empilhamento "1 bloco por tool call" da TUI interativa por linhas de atividade agrupadas — navegação colapsa num resumo agregado (`✓ Explored 3 files · 1 search`), ações ganham linha própria com identificador e diffstat (`✓ Edited path +1 -1`), e a fala do agente divide as rajadas. Estilo limpo (ícone de estado, sem gutter `│`).

**Architecture:** Em vez de refatorar o spinner/gutter do `ToolExecutionComponent` (risco no modo legacy), o exec é **envolvido**. No modo agrupado ele roda com `setShellDisabled(true)` (sem gutter) e expõe `getActivityState()`/`getActivityFamily()`; quem pinta o ícone agregado é um componente-linha novo (`NavGroupComponent` para navegação, `ActivityLineComponent` para ação), cada um com um ticker de spinner próprio (`spinner-ticker.ts`). A decisão de empilhamento é isolada num `ActivityStacker` testável. Um setting `toolActivity: "grouped" | "legacy"` mantém o caminho atual vivo como escape hatch. Spec: [docs/specs/2026-06-04-tool-activity-grouping.md](../specs/2026-06-04-tool-activity-grouping.md).

**Tech Stack:** TypeScript ESM (Node ≥22), `@pit/tui` (Container/Text/theme), erasableSyntaxOnly (sem enum / parameter properties / namespaces runtime), tsgo para typecheck, biome para lint, **vitest** para os testes dos componentes interativos (vivem em `packages/coding-agent/`, NÃO sob `node --test`).

---

## Restrições do projeto (ler antes de codar)

- **erasableSyntaxOnly:** nada de `enum`, parameter properties (`constructor(private x)` é proibido — declare o campo e atribua no corpo), nem `namespace` com runtime. Use `type`/`interface` e uniões de string literais.
- **Tabs** para indentação (o repo inteiro usa tab, não espaços). Os blocos de código abaixo usam tab.
- **Verify:** `npm run check` na raiz = biome + `tsgo --noEmit` + browser-smoke + generated. `tsgo` é silencioso em sucesso → confie no exit code. Para lint/format de um arquivo: `npm run check:fix`.
- **Teste de um arquivo:** `cd packages/coding-agent && npx vitest --run test/<arquivo>.test.ts`.
- **Não commitar em branch:** Thiago commita direto no `main`. Cada task termina com um commit no `main`.
- **Box-drawing:** o `│` (gutter) é justamente o que removemos das linhas de tool; só os ícones `✓`/`✗`/`⋮`/spinner e o separador `·` (U+00B7) são permitidos nas linhas novas.

## File Structure

**Novos arquivos** (todos em `packages/coding-agent/`):

| Arquivo | Responsabilidade |
|-|-|
| `src/modes/interactive/components/arg-summary.ts` | `summarizeArgsOneLine` extraído de `tool-execution.ts` (quebra dependência circular tool-execution ↔ tool-activity). |
| `src/modes/interactive/components/tool-activity.ts` | Lógica pura sem UI: `ToolActivity` type, `toolActivityFamily`, `computeDiffStat`, `navNounFor`, `formatActionSummary`. |
| `src/modes/interactive/components/spinner-ticker.ts` | `createSpinnerTicker` — registra 1 animation callback que anima um glyph enquanto um predicado é verdadeiro. Compartilhado por NavGroup e ActivityLine. |
| `src/modes/interactive/components/nav-group.ts` | `NavGroupComponent` — agrega calls de navegação num header com contadores; render sem gutter; auto-expande filho que falha. |
| `src/modes/interactive/components/activity-line.ts` | `ActivityLineComponent` — envolve 1 exec de ação; header com verbo+identificador+diffstat; render sem gutter. |
| `src/modes/interactive/activity-stacker.ts` | `ActivityStacker` — decide append-nav / new-nav / action / divide / reset. Único ponto da regra de empilhamento; testável isolado. |

**Arquivos modificados:**

| Arquivo | Mudança |
|-|-|
| `src/core/extensions/types.ts` | Campo `activity?: "navigation" \| "action"` na interface `ToolDefinition`. |
| 16 tool factories (lista na Task 2) | `activity: "navigation",` no objeto de definição. |
| `src/modes/interactive/components/tool-execution.ts` | Importa `summarizeArgsOneLine` de `arg-summary.ts`; getters `getToolName`/`getArgs`/`getResultDetails`/`getActivityState`/`getActivityFamily`; `setActivityChild`; guard `gutterAnimationsEnabled`. |
| `src/modes/interactive/components/assistant-message.ts` | Export `messageHasVisibleText(message)`. |
| `src/core/settings-manager.ts` | Campo `toolActivity?` + getter `getToolActivity()`. |
| `src/modes/interactive/interactive-mode.ts` | Campo `activityStacker`; wiring em `_ensureToolComponent`, `agent_start`, `message_update`, `renderSessionContext`; bypass legacy. |

**Testes novos:** `test/tool-activity.test.ts`, `test/spinner-ticker.test.ts`, `test/nav-group-component.test.ts`, `test/activity-line-component.test.ts`, `test/activity-stacker.test.ts`, `test/tool-activity-family.test.ts`, `test/assistant-message-visible-text.test.ts`.

---

## Task 1: Campo `activity` na ToolDefinition + helper `toolActivityFamily`

**Files:**
- Modify: `packages/coding-agent/src/core/extensions/types.ts:452` (após `executionMode?`)
- Create: `packages/coding-agent/src/modes/interactive/components/tool-activity.ts`
- Test: `packages/coding-agent/test/tool-activity.test.ts`

- [ ] **Step 1: Escrever o teste do helper**

Criar `packages/coding-agent/test/tool-activity.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { toolActivityFamily } from "../src/modes/interactive/components/tool-activity.js";

describe("toolActivityFamily", () => {
	test("returns the explicit family when set", () => {
		expect(toolActivityFamily({ activity: "navigation" } as any)).toBe("navigation");
		expect(toolActivityFamily({ activity: "action" } as any)).toBe("action");
	});

	test("defaults to action when undefined or no definition", () => {
		expect(toolActivityFamily({} as any)).toBe("action");
		expect(toolActivityFamily(undefined)).toBe("action");
	});
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `cd packages/coding-agent && npx vitest --run test/tool-activity.test.ts`
Expected: FAIL — `Cannot find module '.../tool-activity.js'`.

- [ ] **Step 3: Adicionar o campo na interface**

Em `packages/coding-agent/src/core/extensions/types.ts`, logo após a linha `executionMode?: ToolExecutionMode;` (≈452), inserir:

```ts
	/**
	 * UI activity family for the interactive TUI's grouped tool rendering.
	 * - "navigation": passive read-only orientation (read/grep/ls/…); collapses
	 *   into an aggregated NavGroup line.
	 * - "action": has an observable effect (edit/write/bash/…); gets its own line.
	 * Defaults to "action" when omitted, so unknown/extension/MCP tools are
	 * surfaced individually (the safe default).
	 */
	activity?: "navigation" | "action";
```

- [ ] **Step 4: Criar o módulo `tool-activity.ts` com o helper**

Criar `packages/coding-agent/src/modes/interactive/components/tool-activity.ts`:

```ts
import type { ToolDefinition } from "../../../core/extensions/types.ts";

export type ToolActivity = "navigation" | "action";

/** Resolve a tool's activity family. Defaults to "action" (safe: own line). */
export function toolActivityFamily(def: ToolDefinition<any, any> | undefined): ToolActivity {
	return def?.activity ?? "action";
}
```

- [ ] **Step 5: Rodar o teste e confirmar que passa**

Run: `cd packages/coding-agent && npx vitest --run test/tool-activity.test.ts`
Expected: PASS (2 testes).

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/src/core/extensions/types.ts packages/coding-agent/src/modes/interactive/components/tool-activity.ts packages/coding-agent/test/tool-activity.test.ts
git commit -m "feat(tui): add activity family metadata to ToolDefinition"
```

---

## Task 2: Marcar as 16 tools de navegação

**Files (cada um, no objeto `return { name: ... }` da definitionFactory):**
- Modify: `packages/coding-agent/src/core/tools/read.ts:316`
- Modify: `packages/coding-agent/src/core/tools/grep.ts:133`
- Modify: `packages/coding-agent/src/core/tools/find.ts:124`
- Modify: `packages/coding-agent/src/core/tools/ls.ts:117`
- Modify: `packages/coding-agent/src/core/tools/symbol.ts:266`
- Modify: `packages/coding-agent/src/core/tools/ast-grep.ts:160`
- Modify: `packages/coding-agent/src/core/tools/search-tool-bm25.ts:68`
- Modify: `packages/coding-agent/src/core/tools/recall.ts:75`
- Modify: `packages/coding-agent/src/core/tools/reflect.ts:91`
- Modify: `packages/coding-agent/src/core/tools/recipe.ts:227`
- Modify: `packages/coding-agent/src/core/tools/calc.ts:347`
- Modify: `packages/coding-agent/src/core/tools/inspect-image.ts:65`
- Modify: `packages/coding-agent/src/core/tools/chrome-devtools.ts:119,182,199,214`
- Test: `packages/coding-agent/test/tool-activity-family.test.ts`

- [ ] **Step 1: Escrever o teste (resolve via createToolDefinition)**

Criar `packages/coding-agent/test/tool-activity-family.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { createToolDefinition } from "../src/core/tools/index.js";

const NAVIGATION = [
	"read", "grep", "find", "ls", "symbol", "ast_grep", "search_tool_bm25",
	"recall", "reflect", "recipe", "calc", "inspect_image",
	"chrome_devtools_list_pages", "chrome_devtools_screenshot",
	"chrome_devtools_read_console", "chrome_devtools_read_network",
] as const;

const ACTION = ["edit", "write", "bash", "ast_edit", "web_search", "todo"] as const;

describe("tool activity family on built-in definitions", () => {
	test.each(NAVIGATION)("%s is navigation", (name) => {
		expect(createToolDefinition(name as any, process.cwd()).activity).toBe("navigation");
	});

	test.each(ACTION)("%s defaults to action (undefined)", (name) => {
		expect(createToolDefinition(name as any, process.cwd()).activity).toBeUndefined();
	});
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd packages/coding-agent && npx vitest --run test/tool-activity-family.test.ts`
Expected: FAIL — os 16 navigation retornam `undefined` (campo ainda não setado).

- [ ] **Step 3: Adicionar `activity: "navigation",` em cada definitionFactory**

Em cada arquivo acima, localizar o objeto `return {` que contém o `name:` na linha indicada e inserir `activity: "navigation",` logo após a linha `name: "...",`. Exemplo em `read.ts` (após a linha 316 `name: "read",`):

```ts
	return {
		name: "read",
		activity: "navigation",
		label: "read",
```

Em `chrome-devtools.ts` há **4** factories (linhas 119/182/199/214) — adicionar o campo nas quatro (`chrome_devtools_list_pages`, `chrome_devtools_screenshot`, `chrome_devtools_read_console`, `chrome_devtools_read_network`). Os outros `chrome_devtools_*` (select_page/navigate/evaluate) **não** recebem o campo (ficam action por default).

Para localizar com precisão em caso de drift de linha: `grep -n 'name: "<tool>"' packages/coding-agent/src/core/tools/<arquivo>.ts`.

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `cd packages/coding-agent && npx vitest --run test/tool-activity-family.test.ts`
Expected: PASS (16 navigation + 6 action).

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/core/tools/ packages/coding-agent/test/tool-activity-family.test.ts
git commit -m "feat(tui): tag navigation tools with activity metadata"
```

---

## Task 3: Extrair `summarizeArgsOneLine` para `arg-summary.ts`

Quebra a futura dependência circular `tool-execution.ts` ↔ `tool-activity.ts` (ambos precisarão do summary).

**Files:**
- Create: `packages/coding-agent/src/modes/interactive/components/arg-summary.ts`
- Modify: `packages/coding-agent/src/modes/interactive/components/tool-execution.ts:36-70`
- Test: `packages/coding-agent/test/arg-summary.test.ts`

- [ ] **Step 1: Escrever o teste**

Criar `packages/coding-agent/test/arg-summary.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { summarizeArgsOneLine } from "../src/modes/interactive/components/arg-summary.js";

describe("summarizeArgsOneLine", () => {
	test("formats scalar object entries as key: value", () => {
		expect(summarizeArgsOneLine({ path: "a.ts", count: 3 })).toBe("path: a.ts  count: 3");
	});

	test("collapses arrays and objects", () => {
		expect(summarizeArgsOneLine({ items: [1, 2], nested: { a: 1 } })).toBe("items: [2]  nested: {…}");
	});

	test("clamps long strings with an ellipsis", () => {
		const out = summarizeArgsOneLine("x".repeat(200));
		expect(out.length).toBe(80);
		expect(out.endsWith("…")).toBe(true);
	});
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd packages/coding-agent && npx vitest --run test/arg-summary.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Criar `arg-summary.ts` movendo a função**

Criar `packages/coding-agent/src/modes/interactive/components/arg-summary.ts` com o corpo atual de `summarizeArgsOneLine` (tool-execution.ts:36-70), agora exportado:

```ts
// Max width of the one-line arg summary shown next to a tool name for tools
// without a custom renderCall.
export const FALLBACK_CALL_SUMMARY_MAX = 80;

/**
 * Compact, single-line preview of a tool call's args for a collapsed row.
 * Scalars render as `key: value`; arrays/objects collapse to `[n]` / `{…}` so
 * a large payload (typical of MCP tools) never expands the row. The whole line
 * is clamped to maxLen.
 */
export function summarizeArgsOneLine(args: unknown, maxLen = FALLBACK_CALL_SUMMARY_MAX): string {
	const clamp = (s: string): string => (s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s);
	if (typeof args === "string") {
		return clamp(args.replace(/\s+/g, " ").trim());
	}
	if (args === null || typeof args !== "object") {
		return "";
	}
	const parts: string[] = [];
	for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
		if (v === null || v === undefined) continue;
		let val: string;
		if (typeof v === "string") val = v;
		else if (typeof v === "number" || typeof v === "boolean") val = String(v);
		else if (Array.isArray(v)) val = `[${v.length}]`;
		else val = "{…}";
		parts.push(`${k}: ${val.replace(/\s+/g, " ").trim()}`);
		// Stop once we already overflow — no point formatting the tail.
		if (parts.join("  ").length >= maxLen) break;
	}
	return clamp(parts.join("  "));
}
```

- [ ] **Step 4: Atualizar `tool-execution.ts` para importar**

Em `tool-execution.ts`: remover o `const FALLBACK_CALL_SUMMARY_MAX = 80;` (linha 36) e a função `summarizeArgsOneLine` inteira (linhas 43-70). Adicionar ao bloco de imports (após a linha 20 `import { MessageShell } from "./message-shell.ts";`):

```ts
import { summarizeArgsOneLine } from "./arg-summary.ts";
```

(O `FALLBACK_RESULT_PREVIEW_LINES`, `SINGLE_LINE_PREVIEW_TOOLS` etc. ficam onde estão — só `summarizeArgsOneLine` e seu `FALLBACK_CALL_SUMMARY_MAX` saem.)

- [ ] **Step 5: Rodar testes (novo + não-regressão do exec)**

Run: `cd packages/coding-agent && npx vitest --run test/arg-summary.test.ts test/tool-execution-component.test.ts`
Expected: PASS em ambos (o exec continua usando `summarizeArgsOneLine`, agora importado).

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/src/modes/interactive/components/arg-summary.ts packages/coding-agent/src/modes/interactive/components/tool-execution.ts packages/coding-agent/test/arg-summary.test.ts
git commit -m "refactor(tui): extract summarizeArgsOneLine to arg-summary module"
```

---

## Task 4: `computeDiffStat`, `navNounFor` e `formatActionSummary`

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/components/tool-activity.ts`
- Test: `packages/coding-agent/test/tool-activity.test.ts` (estender)

- [ ] **Step 1: Estender o teste**

Adicionar a `packages/coding-agent/test/tool-activity.test.ts`:

```ts
import { computeDiffStat, formatActionSummary, navNounFor } from "../src/modes/interactive/components/tool-activity.js";

describe("computeDiffStat", () => {
	test("counts added/removed by the first char of each line", () => {
		// edit-diff.ts custom format: prefix +/-/space at char[0], then line number.
		const diff = ["+  5 added line", "-  4 removed line", "   3 context", "+  6 another add"].join("\n");
		expect(computeDiffStat(diff)).toEqual({ added: 2, removed: 1 });
	});

	test("does not mistake content starting with +/- (prefix is always char[0])", () => {
		const diff = ["   3 -not removed", "+  4 +really added"].join("\n");
		expect(computeDiffStat(diff)).toEqual({ added: 1, removed: 0 });
	});

	test("empty diff is zero", () => {
		expect(computeDiffStat("")).toEqual({ added: 0, removed: 0 });
	});
});

describe("navNounFor", () => {
	test("maps known tools, falls back to step", () => {
		expect(navNounFor("read")).toBe("file");
		expect(navNounFor("grep")).toBe("search");
		expect(navNounFor("unknown_tool")).toBe("step");
	});
});

describe("formatActionSummary", () => {
	test("edit yields verb Edited + path + diffstat", () => {
		const r = formatActionSummary("edit", { path: "a/b.ts" }, { diff: "+  1 x\n-  2 y" });
		expect(r.verb).toBe("Edited");
		expect(r.identifier).toBe("a/b.ts");
		expect(r.diffstat).toEqual({ added: 1, removed: 1 });
	});

	test("write yields Wrote + path, no diffstat", () => {
		const r = formatActionSummary("write", { file_path: "n.ts" }, undefined);
		expect(r).toEqual({ verb: "Wrote", identifier: "n.ts", diffstat: undefined });
	});

	test("bash yields Ran + $ command", () => {
		const r = formatActionSummary("bash", { command: "npm test" }, undefined);
		expect(r.verb).toBe("Ran");
		expect(r.identifier).toBe("$ npm test");
	});

	test("unknown tool capitalizes the name and summarizes args", () => {
		const r = formatActionSummary("render_mermaid", { code: "graph" }, undefined);
		expect(r.verb).toBe("Render_mermaid");
		expect(r.identifier).toContain("code: graph");
	});
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd packages/coding-agent && npx vitest --run test/tool-activity.test.ts`
Expected: FAIL — `computeDiffStat`/`navNounFor`/`formatActionSummary` não exportados.

- [ ] **Step 3: Implementar no `tool-activity.ts`**

Adicionar ao final de `tool-activity.ts` (e o import do summary no topo):

```ts
import { summarizeArgsOneLine } from "./arg-summary.ts";
```

```ts
/** Count added/removed lines in the custom edit diff. The prefix (+/-/space) is
 * always char[0]; the line number follows. Context lines start with a space, so
 * content that itself begins with +/- never miscounts. */
export function computeDiffStat(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		const c = line.charCodeAt(0);
		if (c === 43) added++; // '+'
		else if (c === 45) removed++; // '-'
	}
	return { added, removed };
}

const NAV_NOUNS: Record<string, string> = {
	read: "file",
	grep: "search",
	ast_grep: "search",
	search_tool_bm25: "search",
	find: "match",
	ls: "list",
	symbol: "symbol",
	recall: "recall",
	reflect: "reflection",
	recipe: "recipe",
	calc: "calc",
	inspect_image: "image",
	chrome_devtools_list_pages: "page",
	chrome_devtools_screenshot: "screenshot",
	chrome_devtools_read_console: "console read",
	chrome_devtools_read_network: "network read",
};

/** Singular noun for a navigation tool's aggregated counter. */
export function navNounFor(toolName: string): string {
	return NAV_NOUNS[toolName] ?? "step";
}

export function pluralizeNoun(noun: string, n: number): string {
	if (n === 1) return noun;
	if (noun.endsWith("h") || noun.endsWith("s")) return `${noun}es`;
	return `${noun}s`;
}

const ACTION_VERBS: Record<string, string> = {
	edit: "Edited",
	edit_v2: "Edited",
	ast_edit: "Edited",
	write: "Wrote",
	bash: "Ran",
	web_search: "Searched",
};

const EDIT_TOOLS = new Set(["edit", "edit_v2", "ast_edit"]);

function capitalize(s: string): string {
	return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function truncate(s: string, max: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function pickPath(args: any): string {
	return String(args?.path ?? args?.file_path ?? args?.filename ?? "");
}

export interface ActionSummary {
	verb: string;
	identifier: string;
	diffstat?: { added: number; removed: number };
}

/** Verb + identifier (+ diffstat for edits) for an action line header. */
export function formatActionSummary(toolName: string, args: any, details: any): ActionSummary {
	const verb = ACTION_VERBS[toolName] ?? capitalize(toolName);
	if (EDIT_TOOLS.has(toolName)) {
		const diff = details?.diff;
		return { verb, identifier: pickPath(args), diffstat: typeof diff === "string" ? computeDiffStat(diff) : undefined };
	}
	if (toolName === "write") {
		return { verb, identifier: pickPath(args), diffstat: undefined };
	}
	if (toolName === "bash") {
		return { verb, identifier: `$ ${truncate(String(args?.command ?? args?.cmd ?? ""), 80)}`, diffstat: undefined };
	}
	if (toolName === "web_search") {
		return { verb, identifier: truncate(String(args?.query ?? args?.q ?? ""), 80), diffstat: undefined };
	}
	return { verb, identifier: summarizeArgsOneLine(args), diffstat: undefined };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd packages/coding-agent && npx vitest --run test/tool-activity.test.ts`
Expected: PASS (todos os describes).

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/modes/interactive/components/tool-activity.ts packages/coding-agent/test/tool-activity.test.ts
git commit -m "feat(tui): add diffstat + action/nav formatting helpers"
```

---

## Task 5: `messageHasVisibleText` em assistant-message

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/components/assistant-message.ts` (adicionar export no fim)
- Test: `packages/coding-agent/test/assistant-message-visible-text.test.ts`

- [ ] **Step 1: Escrever o teste**

Criar `packages/coding-agent/test/assistant-message-visible-text.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { messageHasVisibleText } from "../src/modes/interactive/components/assistant-message.js";

describe("messageHasVisibleText", () => {
	test("true when a non-empty text block exists", () => {
		expect(messageHasVisibleText({ content: [{ type: "text", text: "hello" }] } as any)).toBe(true);
	});

	test("false for thinking-only or whitespace text", () => {
		expect(messageHasVisibleText({ content: [{ type: "thinking", thinking: "x" }] } as any)).toBe(false);
		expect(messageHasVisibleText({ content: [{ type: "text", text: "   " }] } as any)).toBe(false);
	});

	test("false when only tool calls are present", () => {
		expect(messageHasVisibleText({ content: [{ type: "toolCall", id: "1", name: "read" }] } as any)).toBe(false);
	});
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd packages/coding-agent && npx vitest --run test/assistant-message-visible-text.test.ts`
Expected: FAIL — export inexistente.

- [ ] **Step 3: Adicionar o export**

No fim de `assistant-message.ts` (fora da classe), adicionar:

```ts
/** True when the assistant message carries at least one non-empty text block.
 * Thinking-only / tool-call-only messages return false — used by the activity
 * stacker to decide when agent speech should divide a tool-activity burst. */
export function messageHasVisibleText(message: AssistantMessage): boolean {
	return message.content.some((c) => c.type === "text" && typeof c.text === "string" && c.text.trim().length > 0);
}
```

(`AssistantMessage` já está importado de `@pit/ai` no topo do arquivo — linha 1.)

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd packages/coding-agent && npx vitest --run test/assistant-message-visible-text.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/modes/interactive/components/assistant-message.ts packages/coding-agent/test/assistant-message-visible-text.test.ts
git commit -m "feat(tui): export messageHasVisibleText for burst division"
```

---

## Task 6: `createSpinnerTicker`

**Files:**
- Create: `packages/coding-agent/src/modes/interactive/components/spinner-ticker.ts`
- Test: `packages/coding-agent/test/spinner-ticker.test.ts`

- [ ] **Step 1: Escrever o teste**

Criar `packages/coding-agent/test/spinner-ticker.test.ts`:

```ts
import { SPINNER_FRAMES, type TUI } from "@pit/tui";
import { describe, expect, test } from "vitest";
import { createSpinnerTicker } from "../src/modes/interactive/components/spinner-ticker.js";

function fakeTui(): { ui: TUI; tick: (now: number) => void; unsubbed: () => boolean } {
	let cb: ((now: number) => boolean) | null = null;
	let unsubbed = false;
	const ui = {
		addAnimationCallback: (fn: (now: number) => boolean) => {
			cb = fn;
			return () => {
				unsubbed = true;
			};
		},
	} as unknown as TUI;
	return { ui, tick: (now) => cb?.(now), unsubbed: () => unsubbed };
}

describe("createSpinnerTicker", () => {
	test("emits spinner glyphs while shouldSpin is true", () => {
		const { ui, tick } = fakeTui();
		const glyphs: Array<string | null> = [];
		createSpinnerTicker(ui, () => true, (g) => glyphs.push(g));
		tick(0);
		tick(1000);
		expect(glyphs.length).toBeGreaterThan(0);
		expect(SPINNER_FRAMES).toContain(glyphs[0]);
	});

	test("emits null once when shouldSpin flips to false", () => {
		let spin = true;
		const { ui, tick } = fakeTui();
		const glyphs: Array<string | null> = [];
		createSpinnerTicker(ui, () => spin, (g) => glyphs.push(g));
		tick(0);
		spin = false;
		tick(1000);
		tick(2000);
		expect(glyphs[glyphs.length - 1]).toBeNull();
		// only one null even after multiple idle ticks
		expect(glyphs.filter((g) => g === null).length).toBe(1);
	});

	test("stop() unsubscribes the animation callback", () => {
		const { ui, unsubbed } = fakeTui();
		const t = createSpinnerTicker(ui, () => true, () => {});
		t.stop();
		expect(unsubbed()).toBe(true);
	});
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd packages/coding-agent && npx vitest --run test/spinner-ticker.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar**

Criar `packages/coding-agent/src/modes/interactive/components/spinner-ticker.ts`:

```ts
import { SPINNER_FRAME_MS, SPINNER_FRAMES, type TUI } from "@pit/tui";

export interface SpinnerTicker {
	/** Detach the animation callback. */
	stop(): void;
}

/**
 * Drive a single animation callback that calls `onFrame(glyph)` with the next
 * spinner frame while `shouldSpin()` is true, and `onFrame(null)` exactly once
 * when it flips to false. Idle (not spinning) ticks are cheap no-ops. Mirrors
 * ToolExecutionComponent's running spinner, but writes to a caller-owned sink
 * instead of the message-shell gutter.
 */
export function createSpinnerTicker(
	ui: TUI,
	shouldSpin: () => boolean,
	onFrame: (glyph: string | null) => void,
): SpinnerTicker {
	let frame = -1;
	let cleared = true;
	const unsub = ui.addAnimationCallback((now: number) => {
		if (shouldSpin()) {
			cleared = false;
			const f = Math.floor(now / SPINNER_FRAME_MS) % SPINNER_FRAMES.length;
			if (f === frame) return false;
			frame = f;
			onFrame(SPINNER_FRAMES[f]);
			return true;
		}
		if (!cleared) {
			cleared = true;
			frame = -1;
			onFrame(null);
			return true;
		}
		return false;
	});
	return { stop: unsub };
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd packages/coding-agent && npx vitest --run test/spinner-ticker.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/modes/interactive/components/spinner-ticker.ts packages/coding-agent/test/spinner-ticker.test.ts
git commit -m "feat(tui): add shared spinner ticker helper"
```

---

## Task 7: Getters + `setActivityChild` no ToolExecutionComponent

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`
- Test: `packages/coding-agent/test/tool-execution-activity.test.ts`

- [ ] **Step 1: Escrever o teste**

Criar `packages/coding-agent/test/tool-execution-activity.test.ts`:

```ts
import { type TUI } from "@pit/tui";
import { beforeAll, describe, expect, test } from "vitest";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

function fakeTui(): TUI {
	return { requestRender: () => {}, addAnimationCallback: () => () => {} } as unknown as TUI;
}

describe("ToolExecutionComponent activity API", () => {
	beforeAll(() => initTheme("dark"));

	test("getActivityFamily reads built-in metadata", () => {
		const read = new ToolExecutionComponent("read", "t1", { file_path: "a" }, {}, undefined, fakeTui(), process.cwd());
		expect(read.getActivityFamily()).toBe("navigation");
		const bash = new ToolExecutionComponent("bash", "t2", { command: "ls" }, {}, undefined, fakeTui(), process.cwd());
		expect(bash.getActivityFamily()).toBe("action");
	});

	test("getActivityState tracks partial → success/error", () => {
		const c = new ToolExecutionComponent("read", "t3", { file_path: "a" }, {}, undefined, fakeTui(), process.cwd());
		expect(c.getActivityState()).toBe("pending");
		c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
		expect(c.getActivityState()).toBe("success");
		const e = new ToolExecutionComponent("read", "t4", { file_path: "a" }, {}, undefined, fakeTui(), process.cwd());
		e.updateResult({ content: [{ type: "text", text: "boom" }], isError: true });
		expect(e.getActivityState()).toBe("error");
	});

	test("getToolName / getArgs / getResultDetails expose inputs", () => {
		const c = new ToolExecutionComponent("edit", "t5", { path: "x.ts" }, {}, undefined, fakeTui(), process.cwd());
		c.updateResult({ content: [], isError: false, details: { diff: "+  1 a" } });
		expect(c.getToolName()).toBe("edit");
		expect(c.getArgs()).toEqual({ path: "x.ts" });
		expect(c.getResultDetails()).toEqual({ diff: "+  1 a" });
	});

	test("setActivityChild removes the gutter from rendered lines", () => {
		const c = new ToolExecutionComponent("read", "t6", { file_path: "a.ts" }, {}, undefined, fakeTui(), process.cwd());
		c.updateResult({ content: [{ type: "text", text: "data" }], isError: false });
		c.setActivityChild(true);
		for (const line of c.render(120)) {
			expect(stripAnsi(line)).not.toContain("│");
		}
	});
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd packages/coding-agent && npx vitest --run test/tool-execution-activity.test.ts`
Expected: FAIL — métodos inexistentes.

- [ ] **Step 3: Adicionar o campo guard + os métodos**

Em `tool-execution.ts`:

(a) Adicionar o import do tipo no topo (junto aos imports de tipo, após a linha 13):

```ts
import type { ToolActivity } from "./tool-activity.ts";
```

(b) Adicionar o campo após `private runningSpinnerFrame = -1;` (≈114):

```ts
	// When true (component is a child of a NavGroup/ActivityLine), the gutter is
	// hidden and its animations are owned by the parent line — skip the local
	// gutter spinner/ease entirely.
	private gutterAnimationsEnabled = true;
```

(c) Adicionar os métodos públicos (ex.: logo após `setExpanded`, ≈320):

```ts
	getToolName(): string {
		return this.toolName;
	}

	getArgs(): any {
		return this.args;
	}

	getResultDetails(): any {
		return this.result?.details;
	}

	getActivityState(): "pending" | "success" | "error" {
		if (this.isPartial) return "pending";
		return this.result?.isError ? "error" : "success";
	}

	getActivityFamily(): ToolActivity {
		return this.toolDefinition?.activity ?? this.builtInToolDefinition?.activity ?? "action";
	}

	/** Run as a child of an activity line/group: drop the gutter and let the
	 * parent own the state icon + spinner. Idempotent. */
	setActivityChild(on: boolean): void {
		this.gutterAnimationsEnabled = !on;
		this.setShellDisabled(on);
		if (on) {
			this.stopRunningSpinner();
			this.stopGutterEase();
		}
		this.updateDisplay();
	}
```

(d) Guardar os dois animadores de gutter. No início de `refreshGutterState` (≈480):

```ts
	private refreshGutterState(): void {
		if (!this.gutterAnimationsEnabled) return;
```

E no início de `syncRunningSpinner` (≈537):

```ts
	private syncRunningSpinner(): void {
		if (!this.gutterAnimationsEnabled) {
			this.stopRunningSpinner();
			return;
		}
```

- [ ] **Step 4: Rodar testes (novo + não-regressão)**

Run: `cd packages/coding-agent && npx vitest --run test/tool-execution-activity.test.ts test/tool-execution-component.test.ts`
Expected: PASS em ambos.

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/modes/interactive/components/tool-execution.ts packages/coding-agent/test/tool-execution-activity.test.ts
git commit -m "feat(tui): expose activity state/family + child mode on tool exec"
```

---

## Task 8: `NavGroupComponent` — agregação e header

**Files:**
- Create: `packages/coding-agent/src/modes/interactive/components/nav-group.ts`
- Test: `packages/coding-agent/test/nav-group-component.test.ts`

- [ ] **Step 1: Escrever o teste (header + sem gutter)**

Criar `packages/coding-agent/test/nav-group-component.test.ts`:

```ts
import { type TUI } from "@pit/tui";
import { beforeAll, describe, expect, test } from "vitest";
import { NavGroupComponent } from "../src/modes/interactive/components/nav-group.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

function fakeTui(): TUI {
	return { requestRender: () => {}, addAnimationCallback: () => () => {} } as unknown as TUI;
}

function navExec(name: string, id: string, args: any): ToolExecutionComponent {
	return new ToolExecutionComponent(name, id, args, {}, undefined, fakeTui(), process.cwd());
}

function resolved(c: ToolExecutionComponent): ToolExecutionComponent {
	c.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
	return c;
}

describe("NavGroupComponent", () => {
	beforeAll(() => initTheme("dark"));

	test("aggregates counters per noun once all resolve", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(resolved(navExec("read", "1", { file_path: "a" })));
		g.addCall(resolved(navExec("read", "2", { file_path: "b" })));
		g.addCall(resolved(navExec("read", "3", { file_path: "c" })));
		g.addCall(resolved(navExec("grep", "4", { pattern: "x" })));
		g.addCall(resolved(navExec("ls", "5", { path: "." })));
		const header = stripAnsi(g.render(120)[0]);
		expect(header).toContain("Explored");
		expect(header).toContain("3 files");
		expect(header).toContain("1 search");
		expect(header).toContain("1 list");
		expect(header).toContain("·");
	});

	test("uses Exploring while a call is still pending", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(resolved(navExec("read", "1", { file_path: "a" })));
		g.addCall(navExec("read", "2", { file_path: "b" })); // still partial
		expect(stripAnsi(g.render(120)[0])).toContain("Exploring");
	});

	test("collapsed render is a single line with no gutter", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(resolved(navExec("read", "1", { file_path: "a" })));
		const lines = g.render(120);
		expect(lines.length).toBe(1);
		expect(stripAnsi(lines[0])).not.toContain("│");
	});

	test("empty group renders nothing", () => {
		expect(new NavGroupComponent(fakeTui()).render(120)).toEqual([]);
	});
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd packages/coding-agent && npx vitest --run test/nav-group-component.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `nav-group.ts`**

Criar `packages/coding-agent/src/modes/interactive/components/nav-group.ts`:

```ts
import { Container, SPINNER_FRAMES, type TUI } from "@pit/tui";
import { theme } from "../theme/theme.ts";
import { createSpinnerTicker, type SpinnerTicker } from "./spinner-ticker.ts";
import { navNounFor, pluralizeNoun } from "./tool-activity.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

type GroupState = "pending" | "success" | "error";

const ICON_SUCCESS = "✓";
const ICON_ERROR = "✗";

/** Aggregates a contiguous burst of navigation tool calls into one summary line
 * (`✓ Explored 3 files · 1 search`). Children render only when expanded; a child
 * that errors auto-expands. No gutter — the state icon carries the framing. */
export class NavGroupComponent extends Container {
	private ui: TUI;
	private execs: ToolExecutionComponent[] = [];
	private expanded = false;
	private spinnerGlyph: string | null = null;
	private ticker: SpinnerTicker;

	constructor(ui: TUI) {
		super();
		this.ui = ui;
		this.ticker = createSpinnerTicker(
			ui,
			() => this.aggregateState() === "pending",
			(g) => {
				this.spinnerGlyph = g;
				this.ui.requestRender();
			},
		);
	}

	addCall(exec: ToolExecutionComponent): void {
		exec.setActivityChild(true);
		this.execs.push(exec);
		this.ui.requestRender();
	}

	/** Duck-typed Expandable (interactive-mode's ctrl+o loop). */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		for (const e of this.execs) e.setExpanded(expanded);
	}

	private aggregateState(): GroupState {
		let anyPending = false;
		let anyError = false;
		for (const e of this.execs) {
			const s = e.getActivityState();
			if (s === "pending") anyPending = true;
			else if (s === "error") anyError = true;
		}
		return anyPending ? "pending" : anyError ? "error" : "success";
	}

	private icon(state: GroupState): string {
		if (state === "pending") return theme.fg("gutterToolPending", this.spinnerGlyph ?? SPINNER_FRAMES[0]);
		if (state === "error") return theme.fg("gutterToolError", ICON_ERROR);
		return theme.fg("gutterToolSuccess", ICON_SUCCESS);
	}

	private counts(): string {
		const byNoun = new Map<string, number>();
		for (const e of this.execs) {
			const noun = navNounFor(e.getToolName());
			byNoun.set(noun, (byNoun.get(noun) ?? 0) + 1);
		}
		const parts: string[] = [];
		for (const [noun, n] of byNoun) parts.push(`${n} ${pluralizeNoun(noun, n)}`);
		return parts.join(" · ");
	}

	private header(state: GroupState): string {
		const verb = state === "pending" ? "Exploring" : "Explored";
		return `${this.icon(state)} ${theme.bold(verb)} ${theme.fg("toolOutput", this.counts())}`;
	}

	override render(width: number): string[] {
		if (this.execs.length === 0) return [];
		const state = this.aggregateState();
		const lines = [this.header(state)];
		if (this.expanded) {
			for (const e of this.execs) {
				for (const l of e.render(width - 2)) lines.push(`  ${l}`);
			}
		} else if (state === "error") {
			// Auto-expand only the failed child(ren); others stay in the counter.
			for (const e of this.execs) {
				if (e.getActivityState() !== "error") continue;
				e.setExpanded(true);
				for (const l of e.render(width - 2)) lines.push(`  ${l}`);
			}
		}
		return lines;
	}
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd packages/coding-agent && npx vitest --run test/nav-group-component.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/modes/interactive/components/nav-group.ts packages/coding-agent/test/nav-group-component.test.ts
git commit -m "feat(tui): add NavGroupComponent for navigation aggregation"
```

---

## Task 9: NavGroup — expand global e auto-expand de erro

**Files:**
- Test: `packages/coding-agent/test/nav-group-component.test.ts` (estender)

(A implementação da Task 8 já cobre expand/erro; esta task adiciona os testes que travam o comportamento.)

- [ ] **Step 1: Estender o teste**

Adicionar ao describe em `nav-group-component.test.ts`:

```ts
	test("setExpanded(true) renders all children indented under the header", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(resolved(navExec("read", "1", { file_path: "a.ts" })));
		g.addCall(resolved(navExec("read", "2", { file_path: "b.ts" })));
		g.setExpanded(true);
		const lines = g.render(120);
		expect(lines.length).toBeGreaterThan(1);
		for (const l of lines) expect(stripAnsi(l)).not.toContain("│");
	});

	test("a failed child marks the group ✗ and auto-expands only that child", () => {
		const g = new NavGroupComponent(fakeTui());
		g.addCall(resolved(navExec("read", "1", { file_path: "a.ts" })));
		const bad = navExec("read", "2", { file_path: "missing.ts" });
		bad.updateResult({ content: [{ type: "text", text: "ENOENT" }], isError: true });
		g.addCall(bad);
		const lines = g.render(120);
		expect(stripAnsi(lines[0])).toContain("✗");
		expect(lines.length).toBeGreaterThan(1);
		expect(stripAnsi(lines.join("\n"))).toContain("ENOENT");
	});
```

- [ ] **Step 2: Rodar e confirmar que passa (verde direto — lógica já existe)**

Run: `cd packages/coding-agent && npx vitest --run test/nav-group-component.test.ts`
Expected: PASS. Se algum falhar, ajustar `render()` na Task 8 — não relaxar o teste.

- [ ] **Step 3: Commit**

```bash
git add packages/coding-agent/test/nav-group-component.test.ts
git commit -m "test(tui): lock NavGroup expand + error auto-expand behavior"
```

---

## Task 10: `ActivityLineComponent` — linha de ação

**Files:**
- Create: `packages/coding-agent/src/modes/interactive/components/activity-line.ts`
- Test: `packages/coding-agent/test/activity-line-component.test.ts`

- [ ] **Step 1: Escrever o teste**

Criar `packages/coding-agent/test/activity-line-component.test.ts`:

```ts
import { type TUI } from "@pit/tui";
import { beforeAll, describe, expect, test } from "vitest";
import { ActivityLineComponent } from "../src/modes/interactive/components/activity-line.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

function fakeTui(): TUI {
	return { requestRender: () => {}, addAnimationCallback: () => () => {} } as unknown as TUI;
}

function exec(name: string, args: any): ToolExecutionComponent {
	return new ToolExecutionComponent(name, "x", args, {}, undefined, fakeTui(), process.cwd());
}

describe("ActivityLineComponent", () => {
	beforeAll(() => initTheme("dark"));

	test("edit shows Edited + path + diffstat, no gutter", () => {
		const e = exec("edit", { path: "server/+page.svx" });
		e.updateResult({ content: [], isError: false, details: { diff: "+  1 a\n-  2 b" } });
		const line = new ActivityLineComponent(e, fakeTui());
		const text = stripAnsi(line.render(120)[0]);
		expect(text).toContain("Edited");
		expect(text).toContain("server/+page.svx");
		expect(text).toContain("+1");
		expect(text).toContain("-1");
		expect(text).not.toContain("│");
	});

	test("write shows Wrote + path with no diffstat", () => {
		const e = exec("write", { file_path: "src/new.ts" });
		e.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
		const text = stripAnsi(new ActivityLineComponent(e, fakeTui()).render(120)[0]);
		expect(text).toContain("Wrote");
		expect(text).toContain("src/new.ts");
	});

	test("bash shows Ran $ command", () => {
		const e = exec("bash", { command: "npm test" });
		e.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		expect(stripAnsi(new ActivityLineComponent(e, fakeTui()).render(120)[0])).toContain("Ran $ npm test");
	});

	test("an errored action marks ✗ and auto-expands its detail", () => {
		const e = exec("bash", { command: "npm run build" });
		e.updateResult({ content: [{ type: "text", text: "compile error xyz" }], isError: true });
		const lines = new ActivityLineComponent(e, fakeTui()).render(120);
		expect(stripAnsi(lines[0])).toContain("✗");
		expect(stripAnsi(lines.join("\n"))).toContain("compile error xyz");
	});

	test("pending action shows neither ✓ nor ✗ in the header", () => {
		const text = stripAnsi(new ActivityLineComponent(exec("bash", { command: "x" }), fakeTui()).render(120)[0]);
		expect(text).not.toContain("✓");
		expect(text).not.toContain("✗");
	});
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd packages/coding-agent && npx vitest --run test/activity-line-component.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `activity-line.ts`**

Criar `packages/coding-agent/src/modes/interactive/components/activity-line.ts`:

```ts
import { Container, SPINNER_FRAMES, type TUI } from "@pit/tui";
import { theme } from "../theme/theme.ts";
import { createSpinnerTicker, type SpinnerTicker } from "./spinner-ticker.ts";
import { formatActionSummary } from "./tool-activity.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

const ICON_SUCCESS = "✓";
const ICON_ERROR = "✗";

/** Wraps a single action tool call as a clean summary line
 * (`✓ Edited path +1 -1`). The wrapped exec is the expandable detail (its own
 * renderCall/renderResult), rendered gutter-less. Errors auto-expand. */
export class ActivityLineComponent extends Container {
	private ui: TUI;
	private exec: ToolExecutionComponent;
	private expanded = false;
	private errorAutoExpanded = false;
	private spinnerGlyph: string | null = null;
	private ticker: SpinnerTicker;

	constructor(exec: ToolExecutionComponent, ui: TUI) {
		super();
		this.exec = exec;
		this.ui = ui;
		exec.setActivityChild(true);
		this.ticker = createSpinnerTicker(
			ui,
			() => this.exec.getActivityState() === "pending",
			(g) => {
				this.spinnerGlyph = g;
				this.ui.requestRender();
			},
		);
	}

	/** Duck-typed Expandable (interactive-mode's ctrl+o loop). */
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.exec.setExpanded(expanded);
	}

	private icon(): string {
		const state = this.exec.getActivityState();
		if (state === "pending") return theme.fg("gutterToolPending", this.spinnerGlyph ?? SPINNER_FRAMES[0]);
		if (state === "error") return theme.fg("gutterToolError", ICON_ERROR);
		return theme.fg("gutterToolSuccess", ICON_SUCCESS);
	}

	private header(): string {
		const { verb, identifier, diffstat } = formatActionSummary(
			this.exec.getToolName(),
			this.exec.getArgs(),
			this.exec.getResultDetails(),
		);
		let line = `${this.icon()} ${theme.bold(verb)}`;
		if (identifier) line += ` ${theme.fg("toolOutput", identifier)}`;
		if (diffstat) {
			line += ` ${theme.fg("gutterToolSuccess", `+${diffstat.added}`)} ${theme.fg("gutterToolError", `-${diffstat.removed}`)}`;
		}
		return line;
	}

	override render(width: number): string[] {
		const state = this.exec.getActivityState();
		if (state === "error" && !this.errorAutoExpanded) {
			this.exec.setExpanded(true);
			this.errorAutoExpanded = true;
		}
		const lines = [this.header()];
		if (this.expanded || state === "error") {
			for (const l of this.exec.render(width - 2)) lines.push(`  ${l}`);
		}
		return lines;
	}
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd packages/coding-agent && npx vitest --run test/activity-line-component.test.ts`
Expected: PASS (5 testes).

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/modes/interactive/components/activity-line.ts packages/coding-agent/test/activity-line-component.test.ts
git commit -m "feat(tui): add ActivityLineComponent for action lines"
```

---

## Task 11: Setting `toolActivity`

**Files:**
- Modify: `packages/coding-agent/src/core/settings-manager.ts` (interface `Settings` ≈327 + getter ≈1360)
- Test: `packages/coding-agent/test/settings-tool-activity.test.ts`

- [ ] **Step 1: Escrever o teste**

Criar `packages/coding-agent/test/settings-tool-activity.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("getToolActivity", () => {
	test("defaults to grouped", () => {
		const sm = new SettingsManager({} as any);
		expect(sm.getToolActivity()).toBe("grouped");
	});

	test("honors an explicit legacy override", () => {
		const sm = new SettingsManager({ toolActivity: "legacy" } as any);
		expect(sm.getToolActivity()).toBe("legacy");
	});
});
```

> Nota de execução: confirmar a forma de construir um `SettingsManager` em teste lendo o topo de `settings-manager.ts` e um teste existente de settings; ajustar o `new SettingsManager(...)` ao construtor real (alguns recebem um path, outros um objeto). O ponto fixo do teste é só `getToolActivity()`.

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd packages/coding-agent && npx vitest --run test/settings-tool-activity.test.ts`
Expected: FAIL — `getToolActivity` inexistente.

- [ ] **Step 3: Adicionar campo + getter**

Na interface `Settings` (após o campo `chromeDevtools` ou próximo dos demais de UI, ≈327):

```ts
	/** Interactive TUI tool rendering: "grouped" (default) groups consecutive
	 * tool calls into activity lines; "legacy" keeps one stacked block per call. */
	toolActivity?: "grouped" | "legacy";
```

Na classe `SettingsManager`, junto aos demais getters (ex.: após `getDoubleEscapeAction`, ≈1362):

```ts
	getToolActivity(): "grouped" | "legacy" {
		return this.settings.toolActivity ?? "grouped";
	}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd packages/coding-agent && npx vitest --run test/settings-tool-activity.test.ts`
Expected: PASS (2 testes).

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/core/settings-manager.ts packages/coding-agent/test/settings-tool-activity.test.ts
git commit -m "feat(settings): add toolActivity grouped/legacy setting"
```

---

## Task 12: `ActivityStacker` — regra de empilhamento isolada

**Files:**
- Create: `packages/coding-agent/src/modes/interactive/activity-stacker.ts`
- Test: `packages/coding-agent/test/activity-stacker.test.ts`

- [ ] **Step 1: Escrever o teste**

Criar `packages/coding-agent/test/activity-stacker.test.ts`:

```ts
import { type Component, type TUI } from "@pit/tui";
import { beforeAll, describe, expect, test } from "vitest";
import { ActivityStacker } from "../src/modes/interactive/activity-stacker.js";
import { ActivityLineComponent } from "../src/modes/interactive/components/activity-line.js";
import { NavGroupComponent } from "../src/modes/interactive/components/nav-group.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function fakeTui(): TUI {
	return { requestRender: () => {}, addAnimationCallback: () => () => {} } as unknown as TUI;
}

function exec(name: string): ToolExecutionComponent {
	return new ToolExecutionComponent(name, name, {}, {}, undefined, fakeTui(), process.cwd());
}

describe("ActivityStacker", () => {
	beforeAll(() => initTheme("dark"));

	test("contiguous navigation calls land in one NavGroup", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeNavigation(exec("read"));
		s.placeNavigation(exec("grep"));
		expect(added.length).toBe(1);
		expect(added[0]).toBeInstanceOf(NavGroupComponent);
	});

	test("an action closes the open NavGroup and starts its own line", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeNavigation(exec("read"));
		s.placeAction(exec("edit"));
		s.placeNavigation(exec("ls"));
		expect(added.length).toBe(3); // nav-group, action-line, NEW nav-group
		expect(added[0]).toBeInstanceOf(NavGroupComponent);
		expect(added[1]).toBeInstanceOf(ActivityLineComponent);
		expect(added[2]).toBeInstanceOf(NavGroupComponent);
		expect(added[2]).not.toBe(added[0]);
	});

	test("divide() closes the burst so the next nav opens a fresh group", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeNavigation(exec("read"));
		s.divide();
		s.placeNavigation(exec("grep"));
		expect(added.length).toBe(2);
		expect(added[0]).not.toBe(added[1]);
	});

	test("reset() also closes the burst", () => {
		const added: Component[] = [];
		const s = new ActivityStacker(fakeTui(), (c) => added.push(c));
		s.placeNavigation(exec("read"));
		s.reset();
		s.placeNavigation(exec("grep"));
		expect(added.length).toBe(2);
	});
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd packages/coding-agent && npx vitest --run test/activity-stacker.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `activity-stacker.ts`**

Criar `packages/coding-agent/src/modes/interactive/activity-stacker.ts`:

```ts
import type { Component, TUI } from "@pit/tui";
import { ActivityLineComponent } from "./components/activity-line.ts";
import { NavGroupComponent } from "./components/nav-group.ts";
import type { ToolExecutionComponent } from "./components/tool-execution.ts";

/**
 * Owns the single rule that turns a stream of tool components into grouped
 * activity: contiguous navigation accumulates in one NavGroup; an action closes
 * it and gets its own line; agent text / abort / a new turn divide the burst.
 * Pure placement logic so it can be unit-tested without the interactive mode.
 */
export class ActivityStacker {
	private ui: TUI;
	private addToChat: (component: Component) => void;
	private current: NavGroupComponent | null = null;

	constructor(ui: TUI, addToChat: (component: Component) => void) {
		this.ui = ui;
		this.addToChat = addToChat;
	}

	placeNavigation(exec: ToolExecutionComponent): void {
		if (!this.current) {
			this.current = new NavGroupComponent(this.ui);
			this.addToChat(this.current);
		}
		this.current.addCall(exec);
	}

	placeAction(exec: ToolExecutionComponent): void {
		this.current = null;
		this.addToChat(new ActivityLineComponent(exec, this.ui));
	}

	/** Agent text or abort splits the burst without promoting state. */
	divide(): void {
		this.current = null;
	}

	/** New turn / history rebuild: forget the open group. */
	reset(): void {
		this.current = null;
	}
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `cd packages/coding-agent && npx vitest --run test/activity-stacker.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/modes/interactive/activity-stacker.ts packages/coding-agent/test/activity-stacker.test.ts
git commit -m "feat(tui): add ActivityStacker placement rule"
```

---

## Task 13: Wiring no caminho ao vivo (interactive-mode)

Integra o stacker ao streaming. Este é wiring sobre uma classe grande — a lógica de empilhamento já está testada (Task 12) e a categorização (Task 2/7); aqui só conectamos. Verificação por suíte + smoke.

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

- [ ] **Step 1: Imports + campos**

No bloco de imports, adicionar:

```ts
import { ActivityStacker } from "./activity-stacker.ts";
import { messageHasVisibleText } from "./components/assistant-message.ts";
```

Adicionar campos de instância (junto a `private chatContainer: Container;` ≈270):

```ts
	private activityStacker!: ActivityStacker;
	private lastDividedMessage: unknown = null;
```

(Se `erasableSyntaxOnly`/strict reclamar de `!`, declarar `private activityStacker: ActivityStacker;` e garantir a atribuição no construtor antes de qualquer uso — ela ocorre logo após `this.chatContainer = new Container();`.)

- [ ] **Step 2: Inicializar o stacker junto ao chatContainer**

Após `this.chatContainer = new Container();` (≈440):

```ts
		this.activityStacker = new ActivityStacker(this.ui, (component) => this.chatContainer.addChild(component));
```

- [ ] **Step 3: Bifurcar `_ensureToolComponent`**

Em `_ensureToolComponent` (≈2752), substituir o trecho final:

```ts
		component.setExpanded(this.toolOutputExpanded);
		this.chatContainer.addChild(component);
		this.pendingTools.set(toolCallId, component);
		return component;
```

por:

```ts
		component.setExpanded(this.toolOutputExpanded);
		if (this.settingsManager.getToolActivity() === "grouped") {
			if (component.getActivityFamily() === "navigation") {
				this.activityStacker.placeNavigation(component);
			} else {
				this.activityStacker.placeAction(component);
			}
		} else {
			this.chatContainer.addChild(component);
		}
		this.pendingTools.set(toolCallId, component);
		return component;
```

- [ ] **Step 4: Resetar em `agent_start`**

No case `"agent_start"` (≈2440), logo após `this.pendingTools.clear();`:

```ts
				this.activityStacker.reset();
				this.lastDividedMessage = null;
```

- [ ] **Step 5: Dividir a rajada quando o assistant emite texto**

No case `"message_update"` (≈2496), dentro do `if (this.streamingComponent && event.message.role === "assistant")`, após `this.streamingComponent.updateContent(this.streamingMessage);` e antes do `for (const content ...)`:

```ts
					if (
						this.settingsManager.getToolActivity() === "grouped" &&
						this.lastDividedMessage !== this.streamingMessage &&
						messageHasVisibleText(this.streamingMessage)
					) {
						this.activityStacker.divide();
						this.lastDividedMessage = this.streamingMessage;
					}
```

(O texto da mensagem assistant já renderiza antes das tools dela — o `streamingComponent` é adicionado ao `chatContainer` antes dos tool components — então dividir ao detectar texto visível encerra a rajada anterior e faz as tools desta mensagem abrirem uma nova. Thinking não conta: `messageHasVisibleText` ignora blocos `thinking`.)

- [ ] **Step 6: Verificar build + suíte do package**

Run: `cd packages/coding-agent && npx vitest --run` (suíte inteira do package)
Expected: PASS. Em seguida, da raiz: `npm run check` → EXIT 0.

- [ ] **Step 7: Smoke manual**

Rodar a TUI (`npm run --workspace packages/coding-agent dev` ou o script `/run` do projeto), fazer o agente ler alguns arquivos e editar um. Confirmar visualmente: navegação colapsa em `Explored N files …`; um edit vira `Edited path +N -M`; a fala do agente separa as rajadas; `ctrl+o` expande. Trocar para legacy (`toolActivity: "legacy"` no settings) e confirmar o comportamento antigo.

- [ ] **Step 8: Commit**

```bash
git add packages/coding-agent/src/modes/interactive/interactive-mode.ts
git commit -m "feat(tui): wire grouped tool activity into the live stream"
```

---

## Task 14: Wiring no rebuild de histórico (`renderSessionContext`)

Sem isso, sessões retomadas (`--resume`) e o redraw inicial mostram o estilo legacy enquanto o streaming ao vivo mostra o agrupado — inconsistente.

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/interactive-mode.ts` (`renderSessionContext` ≈2946)

- [ ] **Step 1: Resetar o stacker no início do rebuild**

No começo de `renderSessionContext()` (antes do `for (const message of sessionContext.messages)`):

```ts
		const grouped = this.settingsManager.getToolActivity() === "grouped";
		if (grouped) this.activityStacker.reset();
```

- [ ] **Step 2: Dividir em mensagens com texto + colocar tools via stacker**

No loop, no ramo `if (message.role === "assistant")`, **antes** do `for (const content of message.content)`:

```ts
				if (grouped && messageHasVisibleText(message)) {
					this.activityStacker.divide();
				}
```

E dentro desse `for`, no ramo `if (content.type === "toolCall")`, substituir o trecho:

```ts
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
```

por:

```ts
						component.setExpanded(this.toolOutputExpanded);
						if (grouped) {
							if (component.getActivityFamily() === "navigation") {
								this.activityStacker.placeNavigation(component);
							} else {
								this.activityStacker.placeAction(component);
							}
						} else {
							this.chatContainer.addChild(component);
						}
```

(O restante — `renderedPendingTools.set(...)`, o tratamento de `aborted`/`error`, e o casamento de `toolResult` — fica intacto: o exec continua sendo o mesmo objeto, só o destino visual muda.)

- [ ] **Step 3: Verificar**

Run: `cd packages/coding-agent && npx vitest --run` → PASS. Depois `npm run check` na raiz → EXIT 0.

- [ ] **Step 4: Smoke de histórico**

Abrir uma sessão existente com `--resume` (ou reabrir o projeto) e confirmar que o histórico reconstruído mostra o mesmo agrupamento do streaming ao vivo (navegação colapsada, ações em linha, erros expandidos).

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/modes/interactive/interactive-mode.ts
git commit -m "feat(tui): apply grouped activity to history rebuild"
```

---

## Task 15: Verificação final end-to-end

**Files:** nenhum (gate).

- [ ] **Step 1: Suíte completa dos 4 packages**

Run (raiz): `npm test` (ou, por package: `npm run --workspace packages/coding-agent test`, idem tui/ai/agent).
Expected: verde. Os únicos vermelhos toleráveis são os 3 e2e de provider que falham por credencial ausente (não-regressão conhecida — confirmar com `git stash` se aparecerem).

- [ ] **Step 2: Gate global**

Run (raiz): `npm run check`
Expected: EXIT 0 (biome + `tsgo --noEmit` + browser-smoke + generated). `tsgo` é silencioso em sucesso.

- [ ] **Step 3: Atualizar a memória do projeto**

Atualizar `C:\Users\User\.claude\projects\C--PiTest\memory\` com uma entrada `project` registrando: feature tool-activity-grouping implementada (grouped default + escape hatch legacy), arquivos-chave (`activity-stacker.ts`, `nav-group.ts`, `activity-line.ts`, `tool-activity.ts`, `spinner-ticker.ts`), e o link `[[tui-animation-roadmap]]`. Acrescentar a linha no `MEMORY.md`.

- [ ] **Step 4: Commit final**

```bash
git add -A
git commit -m "chore(tui): finalize tool activity grouping"
git push origin main
```

---

## Self-Review

**Cobertura do spec (seção → task):**
- Famílias de tool (metadado `activity`, default action) → Tasks 1, 2, 7.
- Divisão da rajada (nav agrupa, ação fecha, texto divide, thinking não, abort/reset fecham) → Tasks 5, 12, 13.
- Formato de linha (ícone, verbo, identificador, diffstat, contadores agregados, spinner) → Tasks 4, 6, 8, 10.
- Visibilidade/expansão (sucesso colapsa, erro auto-expande, `ctrl+o` global via duck-type `Expandable`) → Tasks 8, 9, 10 (`setExpanded` em ambos os componentes cai no loop `setToolsExpanded`).
- Arquitetura (envolver exec com shellDisabled, ticker próprio, reusar renderCall/renderResult) → Tasks 7, 8, 10.
- diffstat de `details.diff` (formato custom, contagem por `line[0]`) → Task 4.
- Concorrência (decisão na 1ª aparição via `_ensureToolComponent`, idempotente por `toolCallId`) → Task 13 (a bifurcação vive no único ponto de criação; `pendingTools` continua a chave por `toolCallId`).
- Histórico (`renderSessionContext` com o mesmo agrupamento) → Task 14.
- Rollout (default grouped + setting legacy) → Tasks 11, 13, 14.
- Testes (vitest, assert de gutter por `not.toContain("│")`) → todas as tasks de componente.

**Consistência de tipos/nomes:** `ToolActivity` (tool-activity.ts) usado por tool-execution (`getActivityFamily`) e tool-activity (`toolActivityFamily`). `getActivityState(): "pending"|"success"|"error"` idêntico em exec, NavGroup (`aggregateState`) e ActivityLine. `formatActionSummary` retorna `{ verb, identifier, diffstat? }` — consumido só pela ActivityLine. `createSpinnerTicker(ui, shouldSpin, onFrame)` idêntico nos dois componentes. `ActivityStacker` métodos `placeNavigation/placeAction/divide/reset` — chamados em interactive-mode (live + history).

**Riscos conhecidos / decisões registradas:**
- `messageHasVisibleText` assume que o texto da mensagem renderiza antes das tools dela (verdade hoje: o `streamingComponent` entra no `chatContainer` antes dos tool components). Se isso mudar, a divisão texto-no-meio precisa de tratamento por índice de conteúdo — fora do escopo (spec: "batch misto fragmenta — previsível e aceitável").
- Abort: a divisão por abort (Task 12 expõe `divide()`) só é chamada ao vivo se houver um handler de abort; o `reset()` em `agent_start` já fecha a rajada no próximo turno. Se quiser fechar imediatamente no abort, localizar o handler de interrupção em interactive-mode e chamar `this.activityStacker.divide()` — opcional, não bloqueia o MVP.
- `getToolActivity()` é lido a cada tool call/rebuild; é um campo simples de objeto (sem I/O), custo desprezível.

## Execução

**Plano detalhado em Part 2 — Implementation Plan (abaixo). Duas opções de execução:**

1. **Subagent-Driven (recomendado)** — um subagente fresco por task, revisão entre tasks, iteração rápida. SUB-SKILL: `superpowers:subagent-driven-development`.
2. **Inline** — executar as tasks nesta sessão com checkpoints. SUB-SKILL: `superpowers:executing-plans`.


---

## Part 3 — Amp-Style Rendering Refinement

# TUI Amp-Style Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the two-family activity model (navigation folds, action gets its own verb-led line), mark the agent's final deliverable, tighten vertical density, and polish the footer/glyph/code-block/bash rendering — converging on the Amp reference.

**Architecture:** All grouping flows through the single `ActivityStacker.placeCall` branch point (used by both live streaming at `interactive-mode.ts:2804` and history rebuild at `:3018`), so the core change is local. Navigation keeps folding into `NavGroupComponent`; actions get a new sibling `ActivityLineComponent` (mirrors NavGroup, one exec). The deliverable marker is set at `agent_end`. Footer/glyph/markdown/bash are independent small edits. Decision record: `docs/adr/0005-two-family-activity-rendering.md`. Domain terms: `docs/CONTEXT.md` (Activity Group, Tool Family, Action Line, Narration vs Deliverable).

**Tech Stack:** TypeScript (tsgo + erasableSyntaxOnly — no enums/parameter-properties), `@pit/tui` components, **vitest** for `packages/coding-agent` component tests (`cd packages/coding-agent && npx vitest --run test/<file>.test.ts`), biome for lint. Theme via `theme.fg(key, text)` / `theme.bold` / `theme.italic`.

---

## File Structure

- `packages/coding-agent/src/modes/interactive/components/tool-activity.ts` — **modify**: add `verbFor()` and `diffStat()`; keep `nounFor`/`pluralizeNoun`.
- `packages/coding-agent/src/modes/interactive/components/activity-line.ts` — **create**: `ActivityLineComponent`, one action call, verb-led header + state icon, child exec shown on expand/error. Mirrors `nav-group.ts`.
- `packages/coding-agent/src/modes/interactive/activity-stacker.ts` — **modify**: branch `placeCall` on `exec.getActivityFamily()`; route `ask`/`resolve` to neither family.
- `packages/coding-agent/src/modes/interactive/components/nav-group.ts` — **modify**: navigation-only verbs (`Exploring`/`Explored`), drop `Did`/`Working`; swap success glyph to `✔` (heavy, text-VS).
- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts` — **modify**: `markAsDeliverable()` → pulsing `●` on the last text block; Amp spacing.
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts` — **modify**: track last assistant component; call `markAsDeliverable()` at `agent_end`.
- `packages/coding-agent/src/modes/interactive/components/footer.ts` — **modify**: 2-line layout; `auto`(perm) + `⟳`(compact) on metrics right; drop near-empty status line.
- `packages/coding-agent/src/core/built-ins/permissions-extension.ts` — **modify**: stop pushing `permissions:` into the generic status channel (footer renders mode inline).
- `packages/coding-agent/src/modes/interactive/theme/theme.ts` — **modify**: dim `mdCodeBlockBorder`.
- `packages/coding-agent/src/modes/interactive/components/bash-command-row.ts` — already clamps to one row; **no change** (reveal is via existing `ctrl+o` on the exec child).

---

## Task 1: Action verb + diffstat helpers

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/components/tool-activity.ts`
- Test: `packages/coding-agent/test/tool-activity.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { diffStat, verbFor } from "../src/modes/interactive/components/tool-activity.ts";

describe("verbFor", () => {
  it("maps edit family to Edited/Editing", () => {
    expect(verbFor("edit", false)).toBe("Edited");
    expect(verbFor("edit_v2", false)).toBe("Edited");
    expect(verbFor("ast_edit", true)).toBe("Editing");
  });
  it("maps write/bash/web/eval", () => {
    expect(verbFor("write", false)).toBe("Wrote");
    expect(verbFor("write", true)).toBe("Writing");
    expect(verbFor("bash", false)).toBe("Ran");
    expect(verbFor("bash", true)).toBe("Running");
    expect(verbFor("web_search", false)).toBe("Searched");
    expect(verbFor("eval", false)).toBe("Evaluated");
  });
  it("falls back to a neutral verb for unknown action tools", () => {
    expect(verbFor("some_mcp_tool", false)).toBe("Ran");
    expect(verbFor("some_mcp_tool", true)).toBe("Running");
  });
});

describe("diffStat", () => {
  it("counts added/removed by first char, ignoring context and headers", () => {
    const diff = ["+  1 added line", "-  2 removed line", "   3 context", "+  4 another add"].join("\n");
    expect(diffStat(diff)).toEqual({ added: 2, removed: 1 });
  });
  it("returns zeros for empty/undefined", () => {
    expect(diffStat("")).toEqual({ added: 0, removed: 0 });
    expect(diffStat(undefined)).toEqual({ added: 0, removed: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/coding-agent && npx vitest --run test/tool-activity.test.ts`
Expected: FAIL — `verbFor`/`diffStat` are not exported.

- [ ] **Step 3: Add the implementation**

Append to `tool-activity.ts`:

```ts
/** Past/present verb for an action line. `pending` selects the present
 * participle shown while the call runs (spinner state). Unknown action tools
 * fall back to the neutral Ran/Running pair. */
const ACTION_VERBS: Record<string, { done: string; pending: string }> = {
  edit: { done: "Edited", pending: "Editing" },
  edit_v2: { done: "Edited", pending: "Editing" },
  ast_edit: { done: "Edited", pending: "Editing" },
  write: { done: "Wrote", pending: "Writing" },
  bash: { done: "Ran", pending: "Running" },
  web_search: { done: "Searched", pending: "Searching" },
  eval: { done: "Evaluated", pending: "Evaluating" },
  render_mermaid: { done: "Rendered", pending: "Rendering" },
  preview: { done: "Previewed", pending: "Previewing" },
  todo: { done: "Updated todos", pending: "Updating todos" },
};

export function verbFor(toolName: string, pending: boolean): string {
  const v = ACTION_VERBS[toolName] ?? { done: "Ran", pending: "Running" };
  return pending ? v.pending : v.done;
}

export function diffStat(diff: string | undefined): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  if (!diff) return { added, removed };
  for (const line of diff.split("\n")) {
    if (line[0] === "+") added++;
    else if (line[0] === "-") removed++;
  }
  return { added, removed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/coding-agent && npx vitest --run test/tool-activity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/modes/interactive/components/tool-activity.ts packages/coding-agent/test/tool-activity.test.ts
git commit -m "feat(tui): add action verb + diffstat helpers for activity lines"
```

---

## Task 2: ActivityLineComponent (single action, verb-led)

**Files:**
- Create: `packages/coding-agent/src/modes/interactive/components/activity-line.ts`
- Test: `packages/coding-agent/test/activity-line-component.test.ts` (create)

Mirrors `nav-group.ts` (spinner ticker, icon, expand, error auto-expand) but renders ONE exec with a category verb + target instead of an aggregated counter.

- [ ] **Step 1: Write the failing test**

```ts
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { beforeAll, describe, expect, it } from "vitest";
import { stripAnsi } from "../src/utils/ansi.ts";
import { ActivityLineComponent } from "../src/modes/interactive/components/activity-line.ts";

beforeAll(() => initTheme("dark"));

function fakeTui() {
  return { requestRender() {}, addAnimationCallback() { return () => {}; } } as any;
}

// Minimal exec stub matching the ToolExecutionComponent surface ActivityLine reads.
function execStub(over: Partial<any>) {
  return {
    setActivityChild() {},
    setExpanded() {},
    getActivityState: () => "success",
    isAborted: () => false,
    getToolName: () => "edit",
    getArgs: () => ({ path: "server/foo.ts" }),
    getResultDetails: () => ({ diff: "+  1 a\n-  2 b" }),
    render: () => ["<exec body>"],
    ...over,
  };
}

describe("ActivityLineComponent", () => {
  it("renders a verb-led header with target and diffstat, no gutter", () => {
    const c = new ActivityLineComponent(fakeTui());
    c.setExec(execStub({}));
    const out = c.render(120).map(stripAnsi);
    expect(out[0]).toContain("Edited");
    expect(out[0]).toContain("server/foo.ts");
    expect(out[0]).toContain("+1");
    expect(out[0]).toContain("-2");
    for (const l of out) expect(l).not.toContain("│");
  });

  it("renders bash as Ran $ command", () => {
    const c = new ActivityLineComponent(fakeTui());
    c.setExec(execStub({ getToolName: () => "bash", getArgs: () => ({ command: "npm test" }), getResultDetails: () => undefined }));
    const out = c.render(120).map(stripAnsi);
    expect(out[0]).toContain("Ran");
    expect(out[0]).toContain("$ npm test");
  });

  it("auto-expands the exec body on a genuine error", () => {
    const c = new ActivityLineComponent(fakeTui());
    c.setExec(execStub({ getActivityState: () => "error", isAborted: () => false }));
    const out = c.render(120).map(stripAnsi);
    expect(out.some((l) => l.includes("<exec body>"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/coding-agent && npx vitest --run test/activity-line-component.test.ts`
Expected: FAIL — module `activity-line.ts` does not exist.

- [ ] **Step 3: Implement ActivityLineComponent**

Create `packages/coding-agent/src/modes/interactive/components/activity-line.ts`:

```ts
import { Container, SPINNER_FRAMES, type TUI } from "@pit/tui";
import { theme } from "../theme/theme.ts";
import { clampBashCommandRow } from "./bash-command-row.ts";
import { createSpinnerTicker, type SpinnerTicker } from "./spinner-ticker.ts";
import { diffStat, verbFor } from "./tool-activity.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

type LineState = "pending" | "success" | "error";

const ICON_SUCCESS = "✔︎";
const ICON_ERROR = "✗";

/** One action call rendered on its own verb-led line (`✔ Edited foo.ts +1 -2`,
 * `✔ Ran $ npm test`). No gutter — the state icon frames it. The wrapped exec
 * renders only when expanded or on a genuine error. Sibling of NavGroupComponent;
 * actions are signal and never fold into the navigation counter. */
export class ActivityLineComponent extends Container {
  private ui: TUI;
  private exec!: ToolExecutionComponent;
  private expanded = false;
  private spinnerGlyph: string | null = null;
  private ticker: SpinnerTicker | null = null;

  constructor(ui: TUI) {
    super();
    this.ui = ui;
  }

  setExec(exec: ToolExecutionComponent): void {
    this.exec = exec;
    exec.setActivityChild(true);
    if (exec.getActivityState() === "pending") this.ensureTicker();
    this.ui.requestRender();
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.exec?.setExpanded(expanded);
  }

  private ensureTicker(): void {
    if (this.ticker) return;
    this.ticker = createSpinnerTicker(
      this.ui,
      () => this.exec.getActivityState() === "pending",
      (g) => {
        this.spinnerGlyph = g;
        if (g === null) {
          this.ticker?.stop();
          this.ticker = null;
        }
        this.ui.requestRender();
      },
    );
  }

  private state(): LineState {
    const s = this.exec.getActivityState();
    if (s === "pending") return "pending";
    if (s === "error" && !this.exec.isAborted()) return "error";
    return "success";
  }

  private icon(state: LineState): string {
    if (state === "pending") return theme.fg("gutterToolPending", this.spinnerGlyph ?? SPINNER_FRAMES[0]);
    if (state === "error") return theme.fg("gutterToolError", ICON_ERROR);
    return theme.fg("gutterToolSuccess", ICON_SUCCESS);
  }

  private target(width: number): string {
    const name = this.exec.getToolName();
    const args = this.exec.getArgs() ?? {};
    if (name === "bash") {
      return clampBashCommandRow({ command: String(args.command ?? ""), width: Math.max(0, width - 12), colorKey: "toolTitle" });
    }
    if (name === "web_search") {
      return theme.fg("toolTitle", String(args.query ?? ""));
    }
    const path = String(args.path ?? args.file_path ?? "");
    let line = theme.fg("toolTitle", path);
    const { added, removed } = diffStat(this.exec.getResultDetails()?.diff);
    if (added || removed) {
      line += ` ${theme.fg("gutterToolSuccess", `+${added}`)} ${theme.fg("gutterToolError", `-${removed}`)}`;
    }
    return line;
  }

  override render(width: number): string[] {
    if (!this.exec) return [];
    const state = this.state();
    const pending = state === "pending";
    const verb = verbFor(this.exec.getToolName(), pending);
    const header = `${this.icon(state)} ${theme.bold(verb)} ${this.target(width)}`;
    const lines = [header];
    const showBody = this.expanded || (state === "error" && !this.exec.isAborted());
    if (showBody) {
      if (state === "error") this.exec.setExpanded(true);
      for (const l of this.exec.render(width - 2)) lines.push(`  ${l}`);
    }
    return lines;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/coding-agent && npx vitest --run test/activity-line-component.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/modes/interactive/components/activity-line.ts packages/coding-agent/test/activity-line-component.test.ts
git commit -m "feat(tui): add ActivityLineComponent for single action calls"
```

---

## Task 3: Branch ActivityStacker on tool family (+ exclude ask/resolve)

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/activity-stacker.ts`
- Test: `packages/coding-agent/test/activity-stacker.test.ts` (extend existing)

- [ ] **Step 1: Write the failing test**

Add to `packages/coding-agent/test/activity-stacker.test.ts`:

```ts
it("navigation folds into one group; an action breaks it into its own line", () => {
  const added: string[] = [];
  const ui = { requestRender() {}, addAnimationCallback() { return () => {}; } } as any;
  const stacker = new ActivityStacker(ui, (c) => added.push(c.constructor.name));

  stacker.placeCall(navExec()); // navigation
  stacker.placeCall(navExec()); // navigation → same group
  stacker.placeCall(actionExec()); // action → breaks, own line
  stacker.placeCall(navExec()); // navigation → new group

  expect(added).toEqual(["NavGroupComponent", "ActivityLineComponent", "NavGroupComponent"]);
});

it("ask/resolve are not placed in the activity stream", () => {
  const added: string[] = [];
  const ui = { requestRender() {}, addAnimationCallback() { return () => {}; } } as any;
  const stacker = new ActivityStacker(ui, (c) => added.push(c.constructor.name));
  expect(stacker.placeCall(askExec())).toBe(false);
  expect(added).toEqual([]);
});
```

Add these stub builders near the top of the test file (reuse the existing fake-exec pattern in this file; the three differ only in `getActivityFamily`/`getToolName`):

```ts
function navExec() { return makeExec({ getActivityFamily: () => "navigation", getToolName: () => "read" }); }
function actionExec() { return makeExec({ getActivityFamily: () => "action", getToolName: () => "edit" }); }
function askExec() { return makeExec({ getActivityFamily: () => "action", getToolName: () => "ask" }); }
```

If `makeExec` does not already exist in the file, add it: a factory returning an object with `setActivityChild(){}, setExpanded(){}, getActivityState:()=>"success", isAborted:()=>false, getResultDetails:()=>undefined, getArgs:()=>({}), render:()=>[]` merged with the override.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/coding-agent && npx vitest --run test/activity-stacker.test.ts`
Expected: FAIL — current `placeCall` returns void and always builds a NavGroup.

- [ ] **Step 3: Rewrite ActivityStacker.placeCall**

Replace the body of `activity-stacker.ts` `placeCall` and add the action/skip branches:

```ts
import type { Component, TUI } from "@pit/tui";
import { ActivityLineComponent } from "./components/activity-line.ts";
import { NavGroupComponent } from "./components/nav-group.ts";
import type { ToolExecutionComponent } from "./components/tool-execution.ts";

/** Tools that are a turn exchange with the user, not background activity:
 * rendered as their own turn block elsewhere, never in the activity stream. */
const TURN_EXCHANGE_TOOLS = new Set(["ask", "resolve"]);

export class ActivityStacker {
  private ui: TUI;
  private addToChat: (component: Component) => void;
  private current: NavGroupComponent | null = null;

  constructor(ui: TUI, addToChat: (component: Component) => void) {
    this.ui = ui;
    this.addToChat = addToChat;
  }

  /** Place a tool call. Navigation folds into the open group; an action closes
   * the group and gets its own ActivityLine. Returns false when the tool is a
   * turn exchange (ask/resolve) the caller should render itself. */
  placeCall(exec: ToolExecutionComponent): boolean {
    if (TURN_EXCHANGE_TOOLS.has(exec.getToolName())) {
      this.current = null;
      return false;
    }
    if (exec.getActivityFamily() === "action") {
      this.current = null;
      const line = new ActivityLineComponent(this.ui);
      this.addToChat(line);
      line.setExec(exec);
      return true;
    }
    if (!this.current) {
      this.current = new NavGroupComponent(this.ui);
      this.addToChat(this.current);
    }
    this.current.addCall(exec);
    return true;
  }

  divide(): void {
    this.current = null;
  }

  reset(): void {
    this.current = null;
  }
}
```

- [ ] **Step 4: Update the two call sites to honor the skip return**

In `interactive-mode.ts`, the live path at `:2803-2807` and the history path at `:3017-3021` currently do `if (grouped) { placeCall } else { addChild }`. Change both so that when `placeCall` returns `false` (ask/resolve), the component is NOT added to the chat container by the stacker AND not double-added. The exec for ask/resolve still lives in `pendingTools`; its interactive UI is rendered by the existing ask/resolve flow. Concretely, replace the live block:

```ts
if (this.settingsManager.getToolActivity() === "grouped") {
  this.activityStacker.placeCall(component);
} else {
  this.chatContainer.addChild(component);
}
```

with:

```ts
if (this.settingsManager.getToolActivity() === "grouped") {
  const placed = this.activityStacker.placeCall(component);
  if (!placed) this.chatContainer.addChild(component); // ask/resolve render their own block
} else {
  this.chatContainer.addChild(component);
}
```

Apply the identical change at the history-rebuild site (`:3017`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/coding-agent && npx vitest --run test/activity-stacker.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/src/modes/interactive/activity-stacker.ts packages/coding-agent/src/modes/interactive/interactive-mode.ts packages/coding-agent/test/activity-stacker.test.ts
git commit -m "feat(tui): two-family activity — actions break out, ask/resolve leave the stream"
```

---

## Task 4: NavGroup is navigation-only (drop Did/Working, heavy check)

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/components/nav-group.ts`
- Test: `packages/coding-agent/test/nav-group-component.test.ts` (extend existing)

With actions routed away (Task 3), a NavGroup only ever holds navigation, so the verb is always `Exploring`/`Explored`.

- [ ] **Step 1: Write the failing test**

Add to `packages/coding-agent/test/nav-group-component.test.ts`:

```ts
it("always uses Explored/Exploring (never Did/Working)", () => {
  const g = new NavGroupComponent(fakeTui());
  g.addCall(navExec("read"));
  g.addCall(navExec("grep"));
  const out = g.render(120).map(stripAnsi);
  expect(out[0]).toContain("Explored");
  expect(out[0]).not.toContain("Did");
});

it("uses a heavy check glyph", () => {
  const g = new NavGroupComponent(fakeTui());
  g.addCall(navExec("read"));
  expect(g.render(120)[0]).toContain("✔");
});
```

(`navExec(name)` = exec stub with `getActivityFamily:()=>"navigation"`, `getToolName:()=>name`, `getActivityState:()=>"success"`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/coding-agent && npx vitest --run test/nav-group-component.test.ts`
Expected: FAIL — header uses `Did`/`✓` for the success-mixed case.

- [ ] **Step 3: Edit nav-group.ts**

In `nav-group.ts`, change the success glyph constant:

```ts
const ICON_SUCCESS = "✔︎";
```

Replace the `header()` verb logic (currently branches on `allNav` and emits `Did`/`Working`) with navigation-only verbs:

```ts
private header(state: GroupState): string {
  const verb = state === "pending" ? "Exploring" : "Explored";
  return `${this.icon(state)} ${theme.bold(verb)} ${theme.fg("toolOutput", this.counts())}`;
}
```

Delete the now-unused `getActivityFamily` scan inside `header` (the `allNav` const).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/coding-agent && npx vitest --run test/nav-group-component.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/src/modes/interactive/components/nav-group.ts packages/coding-agent/test/nav-group-component.test.ts
git commit -m "feat(tui): NavGroup is navigation-only; heavy check glyph"
```

---

## Task 5: Deliverable marker (pulsing ● on the last text block)

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`
- Modify: `packages/coding-agent/src/modes/interactive/interactive-mode.ts`
- Test: `packages/coding-agent/test/assistant-message-deliverable.test.ts` (create)

Detection heuristic: the LAST text block of the LAST assistant component in a turn is the deliverable. Mark it at `agent_end`.

- [ ] **Step 1: Write the failing test**

```ts
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { beforeAll, describe, expect, it } from "vitest";
import { stripAnsi } from "../src/utils/ansi.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";

beforeAll(() => initTheme("dark"));
const fakeTui = () => ({ requestRender() {}, addAnimationCallback() { return () => {}; } }) as any;

describe("deliverable marker", () => {
  it("prepends ● to the last text block once marked", () => {
    const c = new AssistantMessageComponent(fakeTui());
    c.updateContent({ role: "assistant", content: [{ type: "text", text: "Pronto — corrigido." }] } as any);
    const before = c.render(80).map(stripAnsi).join("\n");
    expect(before).not.toContain("●");
    c.markAsDeliverable();
    const after = c.render(80).map(stripAnsi).join("\n");
    expect(after).toContain("●");
  });

  it("does nothing when the message has no visible text", () => {
    const c = new AssistantMessageComponent(fakeTui());
    c.updateContent({ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } as any);
    c.markAsDeliverable();
    expect(c.render(80).map(stripAnsi).join("\n")).not.toContain("●");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/coding-agent && npx vitest --run test/assistant-message-deliverable.test.ts`
Expected: FAIL — `markAsDeliverable` is not a method.

- [ ] **Step 3: Implement markAsDeliverable**

In `assistant-message.ts` add a field `private isDeliverable = false;` and the method:

```ts
/** Mark this message as the turn's final deliverable: a pulsing accent ● is
 * drawn before the first line of its last text block. Idempotent. */
markAsDeliverable(): void {
  if (this.isDeliverable) return;
  this.isDeliverable = true;
  this.startDeliverablePulse();
  this.rebuildContent();
  this.ui.requestRender();
}
```

In `rebuildContent()`, when adding the LAST text block (the block at `lastVisibleIndex` whose kind is `"text"`), and `this.isDeliverable` is true, wrap its ReadingColumn so the first rendered line is prefixed with the pulsing glyph. The simplest in-pattern approach: pass a `marker` to the `Markdown`/`ReadingColumn` is overkill — instead post-process in `render()`. Add to the component's `render()` (after `super.render(width)` produces `lines`), before the OSC133 wrapping:

```ts
if (this.isDeliverable && lines.length > 0) {
  const glyph = theme.fg("accent", this.pulseBright ? "◉" : "●");
  // Prefix the first non-empty content line (skip the leading Spacer blank).
  for (let i = 0; i < lines.length; i++) {
    if (stripAnsiLen(lines[i]) > 0) {
      lines[i] = `${glyph} ${lines[i]}`;
      break;
    }
  }
}
```

Add the pulse ticker (single bright→settle, reusing the animation callback):

```ts
private pulseBright = false;
private startDeliverablePulse(): void {
  this.pulseBright = true;
  let frames = 0;
  const stop = this.ui.addAnimationCallback(() => {
    frames++;
    if (frames >= 6) { // ~0.5s at the shared cadence; settle to ●
      this.pulseBright = false;
      stop();
      this.ui.requestRender();
      return;
    }
    this.pulseBright = frames % 2 === 0;
    this.ui.requestRender();
  });
}
```

If `theme` has no `accent` key, add one in `theme.ts` (a distinct foreground, e.g. cyan/violet) — verify the key set in `theme/theme.ts` and reuse an existing accent-like key if present rather than inventing a duplicate. Use `visibleWidth` (already imported in sibling components) for `stripAnsiLen`, or import `stripAnsi` and measure.

- [ ] **Step 4: Wire markAsDeliverable at agent_end**

In `interactive-mode.ts`, track the last attached assistant component. Where assistant components are attached (`maybeAttachStreamingComponent` at `:2776` and `addMessageToChat`), record `this.lastAssistantComponent = component`. Add the field `private lastAssistantComponent: AssistantMessageComponent | null = null;`. Reset it to `null` in `agent_start` (near `:2448` where `activityStacker.reset()` is called). In the `agent_end` handler (`:2597`), after the existing cleanup, add:

```ts
if (this.settingsManager.getToolActivity() === "grouped") {
  this.lastAssistantComponent?.markAsDeliverable();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/coding-agent && npx vitest --run test/assistant-message-deliverable.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/src/modes/interactive/components/assistant-message.ts packages/coding-agent/src/modes/interactive/interactive-mode.ts packages/coding-agent/src/modes/interactive/theme/theme.ts packages/coding-agent/test/assistant-message-deliverable.test.ts
git commit -m "feat(tui): mark the turn's final deliverable with a pulsing accent glyph"
```

---

## Task 6: Amp density (prose separated from activity; tool lines flush)

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`
- Test: `packages/coding-agent/test/assistant-message-spacing.test.ts` (create)

Target: one blank line between a prose block and adjacent activity; consecutive tool lines flush; one blank between turns. Activity components (`NavGroupComponent`/`ActivityLineComponent`) emit NO leading/trailing blank of their own. Prose blocks (`AssistantMessageComponent`) keep ONE leading blank.

- [ ] **Step 1: Write the failing test**

```ts
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { beforeAll, describe, expect, it } from "vitest";
import { stripAnsi } from "../src/utils/ansi.ts";
import { NavGroupComponent } from "../src/modes/interactive/components/nav-group.ts";

beforeAll(() => initTheme("dark"));
const fakeTui = () => ({ requestRender() {}, addAnimationCallback() { return () => {}; } }) as any;
const navExec = (name: string) => ({ setActivityChild(){}, setExpanded(){}, getActivityState:()=>"success", isAborted:()=>false, getToolName:()=>name, getActivityFamily:()=>"navigation", getArgs:()=>({}), getResultDetails:()=>undefined, render:()=>[] } as any);

describe("activity spacing", () => {
  it("NavGroup emits no leading or trailing blank line", () => {
    const g = new NavGroupComponent(fakeTui());
    g.addCall(navExec("read"));
    const lines = g.render(120).map(stripAnsi);
    expect(lines[0].trim()).not.toBe("");
    expect(lines[lines.length - 1].trim()).not.toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or passes — confirm baseline)**

Run: `cd packages/coding-agent && npx vitest --run test/assistant-message-spacing.test.ts`
Expected: PASS already for NavGroup (it emits no blank). This locks the invariant against regression. If it FAILS, a stray Spacer exists — remove it.

- [ ] **Step 3: Confirm prose keeps exactly one leading blank, activity none**

Audit `assistant-message.ts:162` (`this.contentContainer.addChild(new Spacer(1))` — the single leading blank before prose; KEEP it). Confirm `nav-group.ts` and `activity-line.ts` `render()` push no `""` first/last line (they don't). The Amp model emerges from: prose has 1 leading blank, activity has 0 → prose↔activity boundary = 1 blank; activity↔activity = 0 blank; turn↔turn = the user message's own leading blank. No code change beyond Task 2/4 if the audit holds; otherwise delete the offending Spacer.

- [ ] **Step 4: Run the broader interactive snapshot test (Task 9) after it exists**

(Deferred to Task 9's full-turn snapshot.)

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/test/assistant-message-spacing.test.ts
git commit -m "test(tui): lock Amp density invariant (activity emits no own blank lines)"
```

---

## Task 7: Footer — 2 lines, dedupe auto, drop near-empty status line

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/components/footer.ts`
- Modify: `packages/coding-agent/src/core/built-ins/permissions-extension.ts`
- Test: `packages/coding-agent/test/footer.test.ts` (create or extend)

The permission mode must move OUT of the generic extension-status channel and INTO the footer metrics line, next to a compact-glyph for auto-compact. Then the 3rd line only renders when OTHER extension statuses exist.

- [ ] **Step 1: Make the footer aware of permission mode**

`FooterComponent` needs the current permission mode. The provider (`ReadonlyFooterDataProvider`) already exposes extension statuses; rather than thread a new dependency, the cleanest path is: keep `permissions-extension` setting the status under key `permissions`, but have the footer SPECIAL-CASE that key — pull it out of the generic status line and render it inline on the metrics line. Add a helper to read it:

```ts
private getPermissionMode(): string | null {
  const statuses = this.footerData.getExtensionStatuses();
  const raw = statuses.get("permissions"); // e.g. "permissions: auto"
  if (!raw) return null;
  const m = /permissions:\s*(\S+)/.exec(raw);
  return m ? m[1] : null;
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
// Build a FooterComponent with stub session + provider exposing
// getExtensionStatuses() => new Map([["permissions", "permissions: auto"]]),
// autoCompactEnabled = true. (Reuse the stub pattern from existing footer/usage tests.)

it("shows permission mode + compact glyph on the metrics line, not a 3rd line", () => {
  initTheme("dark");
  const footer = makeFooter({ permissions: "auto", autoCompact: true });
  const lines = footer.render(80).map(stripAnsi);
  expect(lines.length).toBe(2);
  expect(lines[1]).toContain("auto");
  expect(lines[1]).toContain("⟳");
  expect(lines.some((l) => l.startsWith("permissions:"))).toBe(false);
});

it("keeps a 3rd line when another extension status exists", () => {
  initTheme("dark");
  const footer = makeFooter({ permissions: "plan", autoCompact: false, extra: ["whatsapp: 3"] });
  const lines = footer.render(80).map(stripAnsi);
  expect(lines.length).toBe(3);
  expect(lines[1]).toContain("plan");
  expect(lines[1]).not.toContain("⟳"); // compact off
  expect(lines[2]).toContain("whatsapp: 3");
});
```

(`makeFooter` constructs the component with stubbed `AgentSession` + `ReadonlyFooterDataProvider`; mirror the existing footer test stubs in the repo.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/coding-agent && npx vitest --run test/footer.test.ts`
Expected: FAIL — current footer puts `auto` (compact) as the word `auto` and `permissions: auto` on a separate line.

- [ ] **Step 4: Edit footer.ts**

In `render()` metrics line (`:198-217`): replace the auto-compact `rightParts.push("auto")` at `:211` with the consolidated mode segment:

```ts
const mode = this.getPermissionMode(); // "auto" | "plan" | null
const modeBits: string[] = [];
if (mode) modeBits.push(mode);
if (this.autoCompactEnabled) modeBits.push("⟳");
if (modeBits.length) rightParts.push(modeBits.join(" "));
```

In the extension-status block (`:222-233`): exclude the `permissions` key so it never renders as its own line:

```ts
const extensionStatuses = this.footerData.getExtensionStatuses();
const otherStatuses = Array.from(extensionStatuses.entries()).filter(([k]) => k !== "permissions");
if (otherStatuses.length > 0) {
  // build cachedStatusLine from otherStatuses (same sort/sanitize/join as before)
  ...
  lines.push(truncateToWidth(this.cachedStatusLine!, width, theme.fg("dim", "…")));
}
```

(Adjust the version-cache to key off `otherStatuses` content; simplest is to drop the version cache short-circuit and rebuild from `otherStatuses` each render — the list is tiny.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/coding-agent && npx vitest --run test/footer.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/coding-agent/src/modes/interactive/components/footer.ts packages/coding-agent/test/footer.test.ts
git commit -m "feat(tui): footer 2-line — merge permission mode + compact glyph, drop near-empty status row"
```

---

## Task 8: Dim the code-block fence so backticks read as chrome

**Files:**
- Modify: `packages/coding-agent/src/modes/interactive/theme/theme.ts`
- Test: manual (theme color change; no behavioral assertion worth a unit test)

- [ ] **Step 1: Locate the color key**

`theme.ts:1210` — `codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text)`. Find the `mdCodeBlockBorder` entry in the dark (and light) palette.

- [ ] **Step 2: Dim it**

Change `mdCodeBlockBorder` to the dimmest neutral the palette already defines for chrome (reuse the value used by `dim`/`muted` rather than a new literal, so themes stay consistent). The fence ` ``` ` then recedes visually.

- [ ] **Step 3: Eyeball in a real session**

Run: `node packages/coding-agent/dist/main.js` (or the dev entry), ask the agent to emit a fenced block, confirm the ` ``` ` reads as faint chrome, not literal content.

- [ ] **Step 4: Commit**

```bash
git add packages/coding-agent/src/modes/interactive/theme/theme.ts
git commit -m "fix(tui): dim mdCodeBlockBorder so code fences read as chrome"
```

> Note: this keeps the literal ` ``` ` markers by design (chosen over dropping them). If, after this, code content ever renders OUTSIDE a block with bare backticks leaking, that is a separate streaming re-lex bug in `packages/tui/src/components/markdown.ts:168` (`tokenLineCache` re-tokenizes only the trailing token) — file it with the exact agent message that triggered it.

---

## Task 9: Full-turn snapshot regression test

**Files:**
- Test: `packages/coding-agent/test/activity-turn-snapshot.test.ts` (create)

Locks the end-to-end Amp layout: user → nav group → action line → narration → nav group → deliverable.

- [ ] **Step 1: Write the snapshot test**

Drive an `ActivityStacker` + components through a representative turn and assert the stripped-ANSI line sequence: a `✔ Explored …` line, then a `✔ Edited …` line directly under it (no blank between), a blank line before the narration prose, and the final prose carrying `●`. Assert NO line contains `│` for activity components, and NO `Did`/`Did 1 question` appears.

```ts
// Build: NavGroup(read, grep) → ActivityLine(edit) → AssistantMessage("narração")
//        → NavGroup(read) → AssistantMessage("Pronto."), then markAsDeliverable() on the last.
// Concatenate renders in chat order, strip ANSI, assert:
expect(joined).toContain("Explored");
expect(joined).toContain("Edited");
expect(joined).not.toContain("Did");
expect(joined).toContain("●");
expect(joined).not.toContain("│");
```

- [ ] **Step 2: Run it**

Run: `cd packages/coding-agent && npx vitest --run test/activity-turn-snapshot.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the full interactive suite for regressions**

Run: `cd packages/coding-agent && npx vitest --run test/activity-stacker.test.ts test/nav-group-component.test.ts test/activity-line-component.test.ts test/footer.test.ts test/tool-activity.test.ts test/assistant-message-deliverable.test.ts test/assistant-message-spacing.test.ts test/activity-turn-snapshot.test.ts`
Expected: ALL PASS.

- [ ] **Step 4: Lint + typecheck**

Run: `cd packages/coding-agent && npx @biomejs/biome check src/modes/interactive && npx tsgo --noEmit -p .`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/coding-agent/test/activity-turn-snapshot.test.ts
git commit -m "test(tui): full-turn Amp-layout snapshot regression"
```

---

## Self-Review

**Spec coverage** (the 7 feedback points + footer):
1. Narração vs entrega → Task 5 (●, heuristic at agent_end). ✓
2. Verbos por categoria → Tasks 1–4 (verbFor, ActivityLine, family branch). ✓
3. Densidade → Task 6 (Amp spacing invariant). ✓
4. Footer "auto" duplicado → Task 7. ✓
5. Glyph ✓→✔ → Tasks 2 & 4 (ICON_SUCCESS heavy + text-VS). ✓
6. Code fence → Task 8 (dim border; backticks kept by decision). ✓
7. Bash gigante → no new code: `bash-command-row.ts` already clamps to one row; full command behind the existing `ctrl+o` reveal on the exec child (documented in File Structure). ✓
8. "Did 1 question" → Task 3 (ask/resolve leave the stream) + Task 4 (no more `Did`). ✓

**Placeholder scan:** action verbs, diffstat, ActivityLine, stacker branch, footer edits all carry complete code. Two honest verification points flagged (not placeholders): `theme.accent` key existence (Task 5 Step 3) and the footer test stub pattern (Task 7 Step 2) — both say "reuse the existing pattern in the repo" with the exact shape given.

**Type consistency:** `getActivityFamily(): ToolActivity`, `getActivityState(): "pending"|"success"|"error"`, `getToolName()`, `getResultDetails()`, `getArgs()`, `setActivityChild()`, `setExpanded()`, `isAborted()` all match `tool-execution.ts:301-360`. `createSpinnerTicker(ui, predicate, onFrame)` and `SpinnerTicker` match `nav-group.ts` usage. `placeCall` now returns `boolean` — both call sites updated (Task 3 Step 4).

**Dependency order:** 1 (helpers) → 2 (ActivityLine uses helpers) → 3 (stacker uses ActivityLine) → 4 (NavGroup cleanup, safe once actions routed away) → 5 (deliverable, independent) → 6 (density, depends on 2/4 emitting no blanks) → 7 (footer, independent) → 8 (theme, independent) → 9 (snapshot, depends on all).
