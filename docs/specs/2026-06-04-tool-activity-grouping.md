# Tool Activity Grouping — Design

Data: 2026-06-04 · Status: design aprovado; plano de implementação em [docs/plans/2026-06-04-tool-activity-grouping.md](../plans/2026-06-04-tool-activity-grouping.md). Correções pós-recon aplicadas (testes sob **vitest**, não `node --test`; formato de diff é **custom**, não unified; assert de gutter direto no `render()`; o exec é **envolvido** por componentes-linha em vez de refatorado). **Não implementar** fora do plano.

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
