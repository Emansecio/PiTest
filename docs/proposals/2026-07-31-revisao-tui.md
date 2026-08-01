# Revisão da TUI/CLI — 2026-07-31

Revisão em 5 lentes (densidade do chrome, transcript/markdown, interação/UX,
performance de render, consistência fina), 5 agentes + verificação manual de
cada achado citado. Itens ordenados por lote de implementação (P1 → P2 → P3).

## P1 — defeitos visíveis

- [x] **1. Erro de tool invisível por default.** `activity-line.ts:369` só renderiza corpo `if (expanded)`; `capErrorPreview`/`ERROR_PREVIEW_LINES`/`setResultExpanded` (tool-activity.ts, tool-execution.ts:364) têm zero call sites. Ligar: erro genuíno (`!isAborted`) renderiza corpo capado por `capErrorPreview`.
- [x] **2. H2 com `▎` repetido.** theme.ts:1452 põe glifo visível na style function; `getStylePrefix` (markdown.ts:933) o reanexa após cada segmento inline. Emitir a barra 1× como prefixo de linha no case heading.
- [x] **3. Imagem colada fantasma.** (buffer local no composer, reconciliação por marcador em `pasted-images.ts`) `clearAttachedImages` (agent-session.ts:4097) sem call sites; anexo sobrevive a clear/descarte e viaja no próximo prompt. Reconciliar no submit (marcador sobrevivente = envia) + limpar no clear do editor.
- [x] **4. Strings PT em UI inglesa.** (+ aviso de paste truncado, 4ª ocorrência) interactive-mode.ts:3724, 3731 (`/mouse`), 5080 (`(incompleto — sessão retomada)`). Traduzir.
- [x] **5. Formatadores divergentes.** 6× tokens (footer.ts:79, turn-done-format.ts:13, formatTokenChip 2199, kFmt 8221 imprime `1.0k`, goal-manager.ts:68 com `m` minúsculo, export-html) e 2× elapsed (loader `9m14s` vs goal-manager `9m`; fusion `187s` cru). Canônico criado em `src/utils/format-display.ts`; migrar call sites.

## P2 — fricção e desperdício

- [x] **6. Esc mid-turn 2 passos** (interactive-mode.ts:3363): picker "Interrupt what?" mesmo com 1 tool. Picker só com ≥2; 1 tool = interrupt direto.
- [x] **7. Mouse falha nos seletores principais.** `SelectableRow` sem onMouse (/model, /resume, /tree não clicáveis) + clique não-reclamado dispara `autoSuspendMouse` (tui.ts:1363) e mata cliques seguintes; 1ª seleção de texto sempre falha (dica shift+drag efêmera 1×/sessão).
- [x] **8. Cap de output head-keeping por linhas lógicas** (render-utils.ts:186): unificar no cap visual + tail (idioma do bash-execution.ts:74).
- [x] **9. Thinking visível ilimitado** (assistant-message.ts:716): settled colapsa para N linhas + `moreLinesTrailer`.
- [x] **10. Fences de código em largura total** (markdown.ts:1044): limitar régua a `min(contentWidth, proseMaxColumns)`.
- [x] **11. Startup redundante + chrome morto.** Linha de contexto do hero duplica o footer pristine (startup-screen.ts:280); deletar `welcome-box.ts` + `centered-text.ts` + teste (~350 linhas mortas).
- [x] **12. Gramática densa unificada.** Separador único denso (`HINT_SEPARATOR " · "` vs `LOADER_META_SEP "·"`); 3 grafias do hint de interrupção → `esc interrupt`; retry sem parênteses (turn-view.ts:326); BorderedLoader sem hint em linha própria; fusion-live sem duplo-espaço; hint residente da fila (interactive-mode.ts:6214) vira sufixo dim; joins de status do footer (`" "` → `·`).
- [x] **13. Resize Windows.** Guard de igualdade no reply de cell-size (tui.ts:1493/1524 — invalidate full-tree redundante, 8-22ms/resize medido); resize só-de-altura reimprime transcript inteiro e duplica scrollback (tui.ts:2449) — reimprimir só o viewport.
- [x] **14. Slash de extensão mid-turn** passa por chooser `[Send now][Queue]` com ambos executando já (interactive-mode.ts:3582): bypass do chooser.
- [x] **15. `@` autocomplete substring-only** + `--max-results 100` trunca pré-ranking (tui/autocomplete.ts:724,137): fuzzy real (`fuzzyMatch`) + cap pós-ranking.

## P3 — polimento fino

- [x] Baseline de diff avança em frame falhado → linhas stale (tui.ts:2293; zerar inputCache no catch).
- [x] `extractAnsiCode` CSI terminado só em `[mGKHJ]` (utils.ts:368): generalizar `[@-~]`, corpo zero-width.
- [x] Quick-select numérico 1-9 no ask-picker; hotkey `a` approve no exit-plan (mantendo fail-closed headless).
- [x] `✕`→`✗` (send-now-chooser.ts:60); ICON_* dedup em tool-activity.ts.
- [x] tree-selector trunca por chars (`slice(0,50)`) → `truncateToWidth`; datas US-style.
- [x] Ctrl+L rouba clear-screen (redraw com editor vazio); Ctrl+D busy exige dupla-pressão.
- [x] `---` do modelo = falso divisor de turno (glifo distinto); user message sem Markdown pleno (colar código C vira H1); indent lista aninhada 4→2; escape/image sem cor default.
- [x] Picker de interrupção sobrevive a agent_end (resolver cancelled).
- [x] Enter no autocomplete de slash com argumento obrigatório não submete vazio.
- [x] compositeOverlays O(transcript)/frame → janela do viewport; thinking-preview O(n²) → sanitizar só cauda.
- [x] Hierarquia de hint invertida (tecla dim, descrição muted → trocar); casing lowercase p/ chips; `->` → `→`; pluralização via helper; percent vestigial footer.ts:515; `/stats` custo sem `$`; tempo relativo `5m ago` vs `5m`; tokens de tema semânticos (`command`, `mdHeading3`); dark.json hex duplicado de var.

## Fora de escopo / registrado

- Fallback ASCII geral de glyphs (só gauge tem) — decisão de suporte.
- `REVEAL_SNAP_THROUGH_CHARS` acoplado ao coalescer de 16ms — comentário cruzado apenas.
- Pontos fortes (não mexer): streaming/reveal, diffs, blanks disciplinados, paste, freeze() de memória, synchronized output, bench 0,03-0,10ms/frame @8k linhas.
