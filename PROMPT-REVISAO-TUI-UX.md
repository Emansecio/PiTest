# Revisão de Interface / UX do Terminal — Pit TUI

## 1. Papel e objetivo
Você é um(a) engenheiro(a) sênior especialista em TUIs de terminal (modelos de largura de célula, ANSI/VT, diff-rendering, animação a 60fps, percepção de latência). Sua tarefa é fazer uma **revisão crítica de interface e experiência de uso** do agente de coding **Pit** (nunca "Pi") — um app TUI em TypeScript. O alvo é a camada de apresentação no terminal: o que o usuário vê, como ele percebe o estado do agente, fluidez, contraste e custo de render. **Você NÃO vai implementar nada.** O entregável é um relatório de achados priorizados e acionáveis (formato na seção 6).

O código já é maduro: há um roadmap de animação concluído (fluidez P1–P7, cadência de spinner unificada ~80ms, smoothing de streaming, ease de cor de estado). **Não proponha reinventar o que já existe — AUDITE o que existe, encontre o que falta, o que regrediu, o que está inconsistente, o que é caro à toa, e o que confunde o usuário.**

## 2. Escopo
**Dentro:**
- Render loop, diff de linhas, composição de overlays, clamp de largura (`@pit/tui`).
- Componentes visuais: spinner/loader, markdown, diff, editor/input, select/settings lists, footer, cheatsheet, imagens.
- Camada de produto interativa em `@pit/coding-agent` modo interativo: agrupamento de atividade de tool calls, estados (thinking/working/done/erro/cancelamento/permissão), verbos de tool, footer, tema/cores, streaming de tokens.
- Cross-platform: comportamento em Windows Terminal, terminais sem truecolor (256-color), fundo claro, tmux, SSH lento, Termux. Plataforma primária de teste é Windows.

**Fora (não tocar / não reportar):**
- Lógica de negócio do agente (loop de tools, providers, prompts, compactação, memória, MCP).
- `@pit/ai` (streaming de rede, providers) exceto onde o *consumo visual* do stream importa.
- Arquivos `dist/`, `node_modules/`, `examples/`, `test/` (são referência, não alvo de achado — veja regra 5).
- Refactor de arquitetura puro sem impacto perceptível em UX ou render-cost.

## 3. Mapa de arquivos-âncora reais
Tudo em `C:\PiTest\packages\`. Use estes como ponto de partida; confirme cada `file:line` antes de citar (linhas são estimativas).

### Núcleo de render — `tui/src/`
- `tui.ts` — coração. `TUI.doRender()` (~1184): caminho diferencial vs full-redraw, cálculo de `firstChanged`/`lastChanged`, scroll, viewport. `applyLineResets()` (~966) + `resetCache` (cache FIFO escalado ao frame, `RESET_CACHE_*`). `compositeOverlays()` (~896) / `compositeLineAt()` (~1047). `clampLineToWidth()` (~1165, última barreira anti-overflow, trunca em produção / throw em `PIT_RENDER_ASSERT=1`). `assertComponentWidth()` (~47). Ticker de animação compartilhado: `addAnimationCallback()` (~639), `tickAnimations()` (~662), `ANIMATION_FRAME_MS=16`; throttle de render `MIN_RENDER_INTERVAL_MS=16` (~318), `scheduleRender()` (~610). `extractCursorPosition()` (~1105), `CURSOR_MARKER` (~154).
- `terminal.ts` — `ProcessTerminal`: raw mode, bracketed paste, Kitty keyboard protocol, debounce de resize `TERMINAL_RESIZE_DEBOUNCE_MS=70` (~18,120), `setProgress()` OSC 9;4 (~401), Windows VT input via koffi (~232).
- `utils.ts` — `visibleWidth()`, `truncateToWidth()`, `wrapTextWithAnsi()`, `sliceByColumn`/`sliceWithWidth`/`extractSegments`, `graphemeWidth()` (~156), `widthCache` (512 entradas, ~37). Largura de grapheme/emoji/east-asian. **Centro de gravidade do crash "Rendered line exceeds terminal width".**
- `terminal-image.ts` — `detectCapabilities()` (~42): deriva `images`/`trueColor`/`hyperlinks` de `TERM`/`COLORTERM`/`WT_SESSION`; `getCapabilities()` cacheado (~88). Protocolos Kitty/iTerm2.
- `components/loader.ts` — `SPINNER_FRAMES` (10 braille, ~18), `SPINNER_FRAME_MS=80` (~29), `PULSE_CYCLE_MS=1600` (~38). `Loader.tick()` (~259) deriva frame+pulso do relógio monotônico compartilhado; `frameAt`/`paletteAt`; contador de elapsed (`setElapsedEnabled`/`setElapsedPaused`).
- `components/markdown.ts` — `Markdown.render()` (~134) + `tokenLineCache` (~104, cache por-token p/ streaming O(n) em vez de O(n²)); `buildTokenLines()` (~213). Lexer: `marked`.
- `components/editor.ts` (2556 linhas — maior componente), `components/input.ts`, `components/select-list.ts`, `components/settings-list.ts`, `components/box.ts`, `components/text.ts`, `components/cheatsheet.ts`, `components/image.ts`.
- `index.ts` — superfície pública exportada.
- Guard-rails de referência: `test/render-perf-guards.test.ts` (gate de scan Kitty + escala do reset cache), `test/render-transcript.bench.ts`, `test/tui-render.test.ts`, `test/regression-regional-indicator-width.test.ts`, `test/truncate-to-width.test.ts`.

### Consumo de produto — `coding-agent/src/modes/interactive/`
- `interactive-mode.ts` (~5589 linhas, orquestrador): cria o `Loader` "working" (~1422) com `workingPulsePalette()` e `setElapsedEnabled(true)`; troca de mensagem por estado (~1501,1605,1755); `agent_start`/`agent_end` (~2571,2733) ligam/desligam `terminal.setProgress()`; `onDebug` (~2203). Loaders de autocompaction/retry/summary.
- `components/activity-line.ts` — uma ação por linha com verbo + ícone de estado (`ICON_SUCCESS="✓"` 1 célula, `ICON_ERROR="✗"`); spinner enquanto pending; `target()` cacheado por `width|state`.
- `components/nav-group.ts` — agrupa rajada de tools de NAVEGAÇÃO numa linha-resumo (`✓ Explored 3 files · 1 search`); `counts()` cacheado.
- `components/tool-activity.ts` — fonte da verdade dos verbos (`ACTION_VERBS`: Edited/Wrote/Ran/Searched…, ~50) e substantivos (`TOOL_NOUNS`, ~6); `verbFor()`, `nounFor()`, `pluralizeNoun()`, `diffStat()`.
- `components/tool-execution.ts` (~635) — `ToolExecutionComponent`: gutter de estado com ease de cor (`GUTTER_EASE_MS=220`), expand (ctrl+o), preview de resultado, fallback de renderer, imagens.
- `components/assistant-message.ts` — streaming smoothing (`REVEAL_*` ~28-33, `revealTick()`, `clampReveal()`), `fadeLineTail()` (~82, wavefront dim→bright), marca de deliverable `●`, breathing de "Thinking…" (~520), zonas OSC 133.
- `theme/theme.ts` (~1267) — schema de tema, `ThemeColor`/`ThemeBg`, conversão truecolor↔256 (`rgbTo256` ~238, `findClosestCubeIndex`, `colorDistance`), thresholds de contexto (`CONTEXT_USAGE_*` ~340). `theme/color-interpolation.ts` (`interpolateFg`, `lerpRgb`), `theme/color-ease.ts`.
- `components/color-ease.ts` (`ColorEase`, smoothstep 220ms, snap sem truecolor), `components/spinner-ticker.ts` (`createSpinnerTicker`), `components/working-palette.ts` (`workingPulsePalette`: gradiente respiratório truecolor de 16 fases, fallback 4-fase em 256-color).
- `components/footer.ts` (~299) — identidade/métricas/extensões; stats cumulativos com scan tail-only O(diff); `sanitizeStatusText()`.
- `components/diff.ts` — diff intra-linha word-level (`renderIntraLineDiff`), inverse em mudanças.
- `display-utils.ts`, `activity-stacker.ts` (agrupa mensagens/atividade por turno).

## 4. Os quatro eixos da revisão

### Eixo A — Experiência geral / fluxo
Pergunte-se, com evidência no código:
- O usuário sempre sabe **o que o agente está fazendo agora** (thinking vs working vs rodando-tool-X vs esperando-input vs erro)? Onde o estado é ambíguo ou silencioso? Veja `interactive-mode.ts` (mensagens de estado), `activity-line.ts`/`nav-group.ts` (verbos), `assistant-message.ts` (breathing de Thinking).
- **Hierarquia visual / sinal vs ruído:** o deliverable final (`●`) se destaca da narração intermediária (dim)? Tool calls agrupadas reduzem ruído sem esconder o que importa? Erros e aborts têm peso visual correto (`activity-line.ts:render`, auto-expand de erro)?
- **Estados de borda:** cancelamento (Ctrl+C / abort → 130), permissão/confirmação, retry, autocompaction, sessão vazia, terminal minúsculo. Algum estado fica órfão, pisca, ou deixa lixo na tela (ver `TUI.stop()` ~558, blank lines órfãs em `assistant-message.ts`)?
- **Descoberta/onboarding:** cheatsheet, hints de keybinding (`keybinding-hints.ts`), footer — o usuário novo descobre comandos e atalhos? Reticência é sempre `…` (um caractere), nunca `...`?
- **Consistência de identidade:** verbos padronizados (Ran/Read/Edited/Searched/Asked/Wrote), ícones de 1 célula, um único spinner em toda a UI. Aponte qualquer divergência.

### Eixo B — Feedback visual (cor, contraste, estados, tema)
- **Truecolor vs 256-color vs sem-cor:** todo efeito que depende de truecolor degrada com elegância? `ColorEase`/`fadeLineTail`/`workingPulsePalette` afirmam fazer *snap*/fallback quando `interpolateFg` retorna `undefined` — verifique que NÃO sobra caso onde 256-color mostra banding feio, cor ilegível, ou texto sumindo. Cheque `theme.ts:rgbTo256` (qualidade da quantização) e `detectCapabilities` (heurística de `WT_SESSION`/`COLORTERM` — falsos positivos/negativos de truecolor?).
- **Fundo claro:** as cores `dim`/`muted`/`thinkingText`/gutters têm contraste suficiente em tema claro? Algum cinza some? (temas em `getThemesDir()`; schema em `theme.ts`).
- **Estados de tool call:** pending (spinner) → success (`✓`) → error (`✗`) — a transição de cor (ease 220ms) é legível e o label não pula de coluna? Diffs (`diff.ts`) e diffstat (`+n -n`) são claros?
- **Footer:** densidade de informação, thresholds de uso de contexto (warn/error/critical), token/cost formatados — informativo sem poluir?
- **Spinner/progress:** OSC 9;4 (`terminal.setProgress`) é ligado/desligado em todos os caminhos (inclusive erro/abort)? Algum loader fica órfão rodando (ver comentários sobre ticker "forever-running" em `assistant-message.ts`)?

### Eixo C — Suavidade / fluidez
- **Cadência de frames:** ticker único a 16ms (`ANIMATION_FRAME_MS`), render throttle 16ms (`MIN_RENDER_INTERVAL_MS`), spinner 80ms — há beating/drift entre animações? Todas derivam do mesmo `performance.now()`? Aponte qualquer timer independente que escape do ticker compartilhado.
- **Flicker / repaint:** o diff de linhas em `doRender` minimiza bytes escritos? Há caminhos que caem em `fullRender(true)` (clear+scrollback) sem necessidade — resize, shrink, append no topo do viewport, mudança de altura? (ver os vários `logRedraw(...)` e a lógica de `firstChanged < prevViewportTop`). Synchronized output (`\x1b[?2026h/l`) cobre todas as escritas multi-linha?
- **Jank no streaming:** o smoothing (`revealTick`, catch-up geométrico, `REVEAL_MAX_STEP=24`) realmente suaviza sem (a) ficar pra trás do texto final ao settle, (b) custar um rebuild O(n) por frame em mensagem longa (`rebuildContent` + `Markdown.render` com `tokenLineCache`). O `fadeLineTail` reaplica segmentação de grapheme por frame — custo aceitável?
- **Scroll/resize:** drag-resize (debounce 70ms) é suave? Conteúdo entra/sai do scrollback corretamente ao alargar/estreitar? Termux (toggle de teclado muda altura) não replica história toda?
- **Transições de estado:** pending→done, thinking→answer, narração→deliverable — alguma é abrupta onde deveria easear, ou easeada onde atrapalha?

### Eixo D — Desempenho de render (HIPÓTESE até medir)
- **Custo por frame no hot path:** o spinner re-renderiza ~12×/s. Quanto trabalho roda por frame? Procure alocações por-frame, recomputação não-cacheada, varreduras O(N-linhas) por frame (ver `applyLineResets`, `collectKittyImageIds`, `extractKittyImageIds` — já gated por capability; confirme que não há outra varredura ingênua).
- **Largura/wrap/markdown:** `visibleWidth`/`truncateToWidth` no caminho quente — o `widthCache` (512) é suficiente ou thrasha? O `tokenLineCache` do markdown sobrevive ao streaming como anunciado, ou alguma invalidação o derruba a cada delta?
- **Throughput de streaming:** emit do modelo vs taxa de reveal vs renders coalescidos — gargalo? `requestRender` coalesce corretamente sob rajada?
- **Complexidade algorítmica:** algum O(n²) latente em listas grandes, transcript longo, ou composição de overlays? (ver notas de "O(n²) per delta" já corrigidas — confirme que não há regressão e procure novas).
- Ancore propostas de perf nos guard-rails existentes (`render-perf-guards.test.ts`, `render-transcript.bench.ts`) e proponha como **medir** antes de afirmar ganho.

## 5. Regras de rigor (obrigatórias)
1. **Todo achado ancorado em `file:line` + símbolo** (função/classe/const). Sem "em algum lugar do render". Linhas são estimativas — cite o símbolo como âncora estável.
2. **Distinga produção de teste/exemplo/dist.** Achados só valem para `src/` de produção. `examples/`, `test/`, `dist/` servem como evidência de contrato/comportamento esperado, nunca como alvo de correção.
3. **Ganho de performance é HIPÓTESE até medir.** Marque cada item de perf como `[hipótese]` e diga *como* validar (bench, contagem de bytes escritos, contagem de renders, profiling). Comportamento deve permanecer **idêntico**: se uma mudança altera o que é renderizado, não é otimização — é mudança de UX e deve ser justificada como tal.
4. **Mudança de UX não pode regredir comportamento existente.** Para cada proposta, declare o risco de regressão e o que poderia quebrar (ex.: largura, caracteres visíveis ao stripar ANSI, identidade de string p/ o diff cache).
5. **Respeite armadilhas conhecidas — violá-las é bug, não estilo:**
   - Toda linha emitida por componente DEVE caber na largura via `visibleWidth()`/`truncateToWidth()`. Largura mal calculada → crash "Rendered line exceeds terminal width" (`clampLineToWidth`/`assertComponentWidth`). Qualquer proposta que monte string de saída precisa provar que respeita largura.
   - Estado interno (reflection, raciocínio, scratch, marcadores como `CURSOR_MARKER`, zonas OSC 133) **nunca** pode vazar como texto visível.
   - Reticência é sempre `…` (U+2026), nunca `...`.
   - Spinner único: `SPINNER_FRAMES`/`SPINNER_FRAME_MS` compartilhados; não introduzir segundo glyph-set ou cadência.
   - Ícones de estado renderizam 1 célula (alinhamento de coluna depende disso).
6. **Restrições de código do projeto** (ao propor "depois"): sem `enum`, sem parameter-properties, sem `namespace`, sem ternário aninhado; indentação por TABS; arrays em linha única. Gate: `npm run check` (tsgo `erasableSyntaxOnly` + biome + browser-smoke).
7. **Não invente achado para preencher.** Se um eixo está saudável, diga "sem achados relevantes" e siga. Validar contra o código real é obrigatório — não confie em suposição sobre como o render "provavelmente" funciona.

## 6. Formato de saída da revisão
Entregue **uma tabela priorizada por impacto** (P0 = quebra/ilegível/crash de UX; P1 = atrito sério ou custo de render alto; P2 = polish perceptível; P3 = nice-to-have), separadores mínimos `|-|-|`, sem box-drawing:

| Prio | Eixo | file:line · símbolo | Problema (observável) | Proposta | Esforço | Risco/Regressão |
|-|-|-|-|-|-|-|

Depois da tabela:
- **Ordem de ataque recomendada** (3–7 itens, sequência que maximiza valor e minimiza retrabalho/conflito entre mudanças).
- **Itens refutados / não-mexer:** o que parece bug mas é intencional (com a evidência no código). Isso evita que a implementação "conserte" algo de propósito.
- Para cada item de perf: a métrica e o método de medição.

## 7. Definition of done da revisão
- Os 4 eixos cobertos; cada um ou tem achados ancorados, ou um "sem achados relevantes" justificado.
- ≥1 caminho de full-redraw evitável (Eixo C) e ≥1 hipótese de perf mensurável (Eixo D) avaliados — confirmados ou descartados com evidência.
- Fallback 256-color / fundo claro auditado em pelo menos: spinner/pulse, ease de estado, fade de streaming, footer (Eixo B).
- Toda armadilha da regra 5 verificada contra as propostas (nenhuma proposta as viola).
- Tabela priorizada + ordem de ataque + lista de refutados entregues.
- Zero achado baseado em `examples/`/`test/`/`dist/` como alvo.

## 8. (Opcional) Paralelização por sub-eixo
Se usar múltiplos agentes, um por eixo, cada um com saída JSON estruturada (`{prio, eixo, file, line, symbol, problema, proposta, esforco, risco, metrica?}`), depois um agente sintetizador funde, deduplica e ordena:
- **Agente A (Fluxo/estados):** `interactive-mode.ts`, `activity-line.ts`, `nav-group.ts`, `tool-activity.ts`, `activity-stacker.ts`, `assistant-message.ts`, `footer.ts`, cheatsheet/hints.
- **Agente B (Cor/contraste/tema):** `theme/theme.ts`, `theme/color-interpolation.ts`, `color-ease.ts`, `working-palette.ts`, `terminal-image.ts:detectCapabilities`, temas em disco; foco truecolor↔256↔sem-cor e fundo claro.
- **Agente C (Fluidez/render):** `tui.ts` (`doRender`, caminhos de full-redraw, ticker, throttle), `terminal.ts` (resize/progress), smoothing em `assistant-message.ts`, `loader.ts`.
- **Agente D (Perf/algorítmica):** `tui.ts` (caches, varreduras por-frame), `utils.ts` (width/wrap), `markdown.ts` (`tokenLineCache`), guard-rails `test/render-perf-guards.test.ts` + `render-transcript.bench.ts`; toda alegação marcada `[hipótese]` + método de medição.

Regra de validação adversarial: o sintetizador **rejeita** qualquer achado de sub-agente que não bata com o código real (sub-agentes alucinam P0/P1) — reconfirme `file:line`+símbolo antes de aceitar.
