# Auditoria de performance do Pit TUI — RAM, CPU e riscos de travamento — 2026-07-03

> Produzida sobre o commit `1115921b2`. Irmã da auditoria de experiência
> [`tui-experience-audit-2026-07.md`](tui-experience-audit-2026-07.md) (estética/UX);
> esta cobre exclusivamente **performance de runtime da interface**: consumo de RAM,
> CPU e riscos de freeze/lentidão. Metodologia: 4 lanes paralelas com ownership
> disjunto (núcleo de render @pit/tui / editor+input / orquestração do
> interactive-mode / componentes+tema), com **toda evidência `file:line` abaixo
> re-verificada manualmente no código em 2026-07-03**. Análise estática — nenhum
> profiling de runtime foi executado; ver [Como medir](#como-medir) para quantificar
> antes/depois.
>
> Restrição de projeto: **nenhuma proposta remove funcionalidade** — apenas
> memoização, incrementalização, poda de retenção e coalescing.

## Onde a fronteira está agora

O motor já é maduro: render diferencial com fast path de última linha, caches por
identidade de referência (`applyLineResets`, `Container.render`, `Text`/`Markdown`),
lexing incremental de markdown em appends, ticker de animação único e coalescido,
virtualização do transcript (`VirtualizedContainer`), `dispose()` em todos os
componentes animados. O trabalho quadrático por chunk foi eliminado em `1115921b2`.

**A fronteira mudou para quatro lugares:**

1. **Custo por frame ainda é O(transcript inteiro)** em 4–6 passes no núcleo
   (flatten, resets, diff scan, kitty scan) — o streaming fica progressivamente
   mais pesado conforme a sessão cresce.
2. **Texto não-ASCII (português!) não tem fast path de largura** — toda linha com
   acento paga `Intl.Segmenter`, com cache global de só 512 entradas.
3. **Freeze hazards pontuais**: full redraw do transcript inteiro no resize,
   rebuild total do chat em toggles, busca do `/tree` O(n) por tecla sem memo,
   ausência de backpressure no stdout.
4. **RAM cresce monotonicamente** com a sessão: componentes de histórico retêm
   payloads (outputs de tool, base64 de imagem ~2×), caches com teto alto.

---

## Tabela priorizada (alavancagem = impacto ÷ esforço, ponderada por confiança)

| # | Achado | Classe | Impacto | Esforço | Risco | Confiança |
|---|--------|--------|---------|---------|-------|-----------|
| P1 | `visibleWidth` sem fast path Latin-1; cache 512 | CPU | Alto (PT-BR) | S | Baixo | Alta |
| P2 | 4 passes O(N-linhas) por frame no núcleo | CPU+GC | Alto (sessão longa) | M | Médio | Alta |
| P3 | `fullRender` reescreve transcript inteiro no resize | FREEZE+RAM | Alto (sessão longa) | M | Médio | Alta |
| P4 | Sem backpressure no `stdout.write` | RAM+lag | Médio-alto (SSH/term lento) | M | Médio | Alta |
| P5 | `theme` global é Proxy (2 traps por operação de cor) | CPU | Médio (espalhado) | S | Baixo | Alta |
| P6 | Editor: `getText()` join por tecla; layout memo invalidado por cursor; visual-line map sem memo | CPU | Médio-alto (prompt grande) | S/M | Baixo | Alta |
| P7 | Toggle de thinking → dispose+rebuild do chat inteiro | FREEZE | Médio (sessão longa) | M | Médio | Alta |
| P8 | Busca do tree-selector O(n) por tecla sem memo/debounce | FREEZE | Médio-alto (/tree grande) | S | Baixo | Alta |
| P9 | Retenção de payloads pesados no histórico (RAM monotônica) | RAM | Alto (sessão longa) | M/L | Médio | Média |
| P10 | `Loader.render` e `TruncatedText` quebram memo do pai por frame | CPU+GC | Médio | S | Baixo | Alta |
| P11 | Cor: `parseTrueColorFg` regex por chamada; shimmer aloca por grafema/frame | CPU+GC | Médio (durante working) | S | Baixo | Alta |
| P12 | Footer: chave de cache de ~25 campos + sort por frame | CPU | Médio (streaming) | S/M | Baixo | Alta |
| P13 | `refreshLoaderTrailingSuffix` remontado por chunk | CPU | Médio (streaming) | S | Baixo | Alta |
| P14 | Git poll fixo 5s para sempre + `spawnSync` no 1º render | CPU+FREEZE | Médio (repo grande) | S | Baixo | Alta |
| P15 | Paste inline O(n²) (`pasteBuffer.indexOf` do zero) | FREEZE | Médio (edge) | S | Baixo | Alta |
| P16 | Imagens: header decode do base64 inteiro; retenção 2× | CPU+RAM | Médio (imagens grandes) | S | Baixo | Alta |
| P17 | Ticker de animação fixo em 16ms (~60 wakeups/s) | CPU | Baixo-médio (contínuo) | S | Baixo | Média |
| P18 | `Box.render` materializa childLines antes do cache-check | CPU+GC | Baixo-médio | S | Baixo | Média |
| P19 | `resetCache` até 65.536 linhas retidas; undo do `Input` até 1000 snapshots | RAM | Baixo (bounded) | S | Baixo | Alta |
| P20 | `stdin-buffer` O(L²) em sequência ESC não terminada | FREEZE | Baixo (patológico) | M | Médio | Média |
| P21 | `resetExtensionUI` não resolve Promises nem libera `userInputPauseDepth` | RAM+UI travada | Baixo (edge) | S | Baixo | Média |
| P22 | Fan-outs O(histórico) em setters (`setToolsExpanded` etc.) + loop redundante em `onHideThinkingBlockChange` | CPU | Baixo | S | Baixo | Alta |

---

## Tier 1 — maior alavancagem

### P1 — Fast path de largura para texto latino acentuado + cache maior
**Evidência:** `packages/tui/src/utils.ts:37` (`WIDTH_CACHE_SIZE = 512`),
`utils.ts:45-53` (`isPrintableAscii` como único fast path), `utils.ts:206-263`
(`visibleWidth` → `Intl.Segmenter` para qualquer não-ASCII).

**Mecanismo:** `isPrintableAscii` rejeita qualquer char fora de `0x20-0x7E`. Uma
sessão em português ("é", "ã", "ç"…) faz praticamente toda linha de prosa cair no
caminho caro: strip de ANSI char-a-char + segmentação de grafemas + `graphemeWidth`
por cluster. O cache global tem só 512 entradas com evicção FIFO — um frame com
mais de 512 linhas não-ASCII distintas (full redraw, tabela grande) evicta a si
mesmo. `visibleWidth` é a função mais chamada do sistema (wrap, truncate, clamp,
composite, editor).

**Otimização (sem mudança de comportamento):**
1. Fast path "Latin-1/Latin Extended": loop de `charCodeAt`; se todos os chars
   estão em `[0x20-0x7E] ∪ [0xA0-0x2FF]` **excluindo** `0xAD` (soft hyphen),
   `width = length` — cobre ~99% das linhas PT-BR sem segmenter (todos esses
   codepoints são narrow/width-1 em EAW e nunca formam clusters com o vizinho
   seguinte quando não há combining marks ≥ `0x300`).
2. Subir `WIDTH_CACHE_SIZE` para ~4096 (chaves já limitadas a 4096 chars).
3. Nos loops de `wrapSingleLine`/`truncateToWidth` que chamam `graphemeWidth` por
   segmento, o mesmo fast path por segmento evita o teste de emoji/regex.

**Ganho estimado:** grande em sessões PT-BR (cada render/wrap/clamp de linha
acentuada passa de µs de segmenter para ns de loop); reduz também o custo do P3.

### P2 — Eliminar os passes O(N-linhas-totais) por frame no núcleo
**Evidência:**
- Flatten: `packages/tui/src/virtualized-container.ts:135-145` (`flattenCaches`
  re-empurra TODAS as linhas quando qualquer filho da hot-zone muda — todo frame
  de streaming/spinner) **+** `packages/tui/src/tui.ts:373-383` (`Container.render`
  do root faz uma SEGUNDA cópia O(N) das mesmas linhas no mesmo frame).
- Resets: `tui.ts:1126-1166` (`applyLineResets` aloca 2 arrays de N e percorre N
  índices sempre que ≥1 linha mudou; o fast path "all stable" de `tui.ts:1113-1121`
  falha em qualquer frame de streaming).
- Diff: `tui.ts:1553-1579` (fast path de "só a última linha" ainda varre N-1
  referências; o caso geral varre `maxLines` inteiro).
- Kitty: `tui.ts:1185-1193` + chamadas em `tui.ts:1496,1640,1760`
  (`collectKittyImageIds` percorre todas as linhas + aloca um `Set` **todo frame**,
  mesmo em terminal não-Kitty — o guard O(1) está *dentro* de
  `extractKittyImageIds`, mas o loop externo + call por linha + Set permanecem).

**Mecanismo:** com transcript de N linhas, cada frame de streaming custa ~4-6
passes O(N) + 3-4 alocações de arrays de N elementos, a até 60fps. O custo por
frame cresce linearmente com a idade da sessão — é a razão estrutural de
"sessão longa fica pesada".

**Otimizações:**
1. **Kitty (trivial, fazer primeiro):** em `collectKittyImageIds`, se
   `getCapabilities().images !== "kitty"`, retornar um `Set` vazio compartilhado
   sem tocar nas linhas. Elimina 1 passe O(N) + alocação por frame para 100% dos
   terminais Windows/VSCode/iTerm2.
2. **Flatten incremental:** `VirtualizedContainer` conhece o índice do primeiro
   filho alterado (hot start / staleIndices). Manter offsets por filho e
   reconstruir só o sufixo (`prefixo.slice(0, off)` é memcpy engine-otimizado;
   melhor ainda: manter um array persistente e retornar cópia-on-write do sufixo).
   Contrato do Component (nova referência quando muda) é preservado.
3. **Dupla cópia:** o root `Container` re-flatten quando qualquer filho muda de
   referência. Com o P10 corrigido (Loader/TruncatedText memoizados), frames em
   que só o footer/status muda deixam de re-copiar as N linhas do chat. Avaliar
   também transformar o root flatten no mesmo esquema de offsets.
4. **Resets:** double-buffer persistente (`swap` entre dois pares input/output)
   em vez de `new Array(N)` ×2 por frame; a semântica de "não mutar o array
   retornado no frame anterior" se mantém porque os buffers alternam.
5. **Diff scan:** quando o flatten incremental existir, propagar "primeiro índice
   possivelmente sujo" para `_doRenderCore` e iniciar a varredura ali; varrer
   `lastChanged` de trás para frente com early-exit.

**Ganho estimado:** streaming em sessão de 10k+ linhas cai de ~5 passes O(10k)
por frame para O(tail). GC churn por frame cai na mesma proporção.

### P3 — Full redraw do resize: chunking e poda do custo por linha
**Evidência:** `tui.ts:1468-1499` (`fullRender` monta UMA string com todas as
linhas e faz um `terminal.write` síncrono), `tui.ts:1480` (`clampLineToWidth` →
`visibleWidth` por linha — colide com P1 em transcript acentuado),
`tui.ts:626-634` (resize força `previousWidth = -1` → `fullRender("all")`),
`terminal.ts:18` (debounce de 70ms limita a frequência, não o custo).

**Mecanismo:** numa sessão com 20k linhas, um resize de largura constrói uma
string de vários MB (pico de RAM), mede a largura de cada linha (P1) e bloqueia o
event loop na escrita; o emulador ainda precisa consumir tudo. Freeze visível e
proporcional à idade da sessão.

**Otimizações (preservando o comportamento de scrollback):**
1. Cache de largura por linha: `previousLines` pode carregar um array paralelo de
   larguras (ou o `resetCache` guardar `{text, width}`), zerando o custo de
   `clampLineToWidth` em linhas já conhecidas.
2. Escrever em chunks (ex.: 2k linhas por `write`, com `setImmediate` entre
   chunks dentro do mesmo "frame lógico" protegido por `\x1b[?2026h/l` por chunk)
   para ceder o event loop e evitar a string única de vários MB.
3. Registrar no log de debug (`PIT_DEBUG_REDRAW`) o tamanho do redraw para
   monitorar regressões.

### P4 — Backpressure no stdout (terminal lento / SSH)
**Evidência:** `packages/tui/src/terminal.ts:362-371` (`write()` ignora o retorno
de `process.stdout.write`).

**Mecanismo:** quando o consumidor (SSH, emulador ocupado) não drena, Node
enfileira os frames em memória sem limite. Com streaming a 60fps, a fila cresce,
a latência visual acumula (o usuário vê a UI "atrasada" — percebido como
lentidão/travamento) e a RAM sobe.

**Otimização:** rastrear o retorno de `write()`; quando `false`, marcar
`backpressured` e fazer o TUI **pular frames** (coalescer: o próximo render após
`'drain'` pinta o estado mais novo — "latest wins", nenhum conteúdo é perdido
porque o render é derivado do estado, não da fila). Um teto de segurança (ex.:
não agendar novos writes com >2 frames pendentes) limita a fila a O(1) frames.

### P5 — Tirar o Proxy do caminho quente do tema
**Evidência:** `packages/coding-agent/src/modes/interactive/theme/theme.ts:776-782`
(`export const theme = new Proxy(...)` com lookup em `globalThis` por acesso).

**Mecanismo:** cada `theme.fg("accent", s)` custa 1 trap para `.fg` + 1 trap
interno (o `this` dentro de `fg` é o Proxy) — e há milhares de chamadas
`fg/bg/bold/italic` por árvore renderizada (markdown estiliza por span). Traps de
Proxy custam ~5-10× uma leitura de propriedade e inibem inlining do V8.

**Otimização:** manter a exportação `theme` (compatibilidade), mas fazer os
módulos quentes resolverem a instância concreta uma vez (`getTheme()`
module-local atualizado por `onThemeChange`), ou fazer o Proxy trap cachear o
`Theme` resolvido num campo e invalidar no swap de tema. Hot-swap de tema
continua funcionando.

### P6 — Editor: custo por tecla independente do tamanho do buffer
**Evidência:**
- `packages/tui/src/components/editor.ts:1362-1364` (`getText()` = `join("\n")` do
  buffer inteiro) chamado em toda mutação via `onChange(this.getText())`
  (`editor.ts:1501-1504`, backspace/newline/insertText idem) + 2× extra no fluxo
  de autocomplete.
- `editor.ts:510-527` (`getLayoutLines` memo inclui `cursorLine`/`cursorCol` →
  **qualquer seta** invalida e reroda `layoutText` O(todas as linhas)).
- `editor.ts:2104-2129` (`buildVisualLineMap` reconstruído O(linhas) a cada ↑/↓/
  PageUp/PageDown, sem memo — `wrapLineCached` amortiza o wrap, mas o array e o
  loop são refeitos).

**Mecanismo:** com prompt de 5-50KB (o cenário real: texto ditado/gerado longo —
pastes grandes viram marcador de 1 linha), cada tecla paga O(buffer) em join +
O(linhas) em layout; navegação paga O(linhas) por movimento.

**Otimizações:** memoizar `getText()` por `bufferRevision`; separar o layout
estrutural (chave: `bufferRevision`+width) da sobreposição de cursor (barata);
memoizar `buildVisualLineMap` pela mesma chave.

### P7 — Toggles que reconstroem o chat inteiro
**Evidência:** `interactive-mode.ts:4442-4457` (`toggleThinkingBlockVisibility` →
`rebuildChatFromMessages()`: dispose + re-parse de markdown de TODA a sessão,
síncrono); `interactive-mode.ts:4948-4958` (`onHideThinkingBlockChange` faz um
loop `setHideThinkingBlock` em todos os filhos **e depois** joga esse trabalho
fora chamando `rebuildChatFromMessages()`).

**Otimização:** os componentes já expõem `setHideThinkingBlock` — atualizar
in-place + `markChildStale`, como `setHiddenThinkingLabel` já faz (o rebuild só é
necessário para casos estruturais; manter como fallback). Remover o loop
redundante de 4951-4955 é uma linha.

### P8 — Busca do tree-selector sem memo nem debounce
**Evidência:** `components/tree-selector.ts:983-987` (`searchQuery += key;
applyFilter()` síncrono por caractere), `tree-selector.ts:327-330`
(`getSearchableText(node)` + `.toLowerCase()` recomputados para TODOS os nós a
cada tecla), contraste com `session-selector-search.ts` (WeakMap + debounce 75ms
+ budget de regex).

**Otimização:** memoizar texto pesquisável por nó (`WeakMap<node, string>`) e
aplicar o mesmo debounce do session-selector. Em `/tree` de sessões grandes a
digitação deixa de travar.

### P9 — RAM monotônica: liberar payloads pesados do histórico fora da viewport
**Evidência:** `interactive-mode.ts:600` (chatContainer vive a sessão inteira),
`_addToolBlock`/`_ensureToolComponent` (`interactive-mode.ts:3606-3615`) — cada
tool/mensagem vira um Component vivo para sempre; `ToolExecutionComponent` retém
`result` completo (outputs grandes, imagens base64); `packages/tui/src/components/image.ts:25,124` +
`terminal-image.ts:126-170` — cada `Image` retém o base64 original **e** a
sequência de render com o mesmo base64 embutido (~2× o tamanho por imagem).

**Otimizações:** (a) nas `Image`, não reter as duas formas — regenerar a
sequência sob demanda ou soltar `base64Data` após o encode; (b) para blocos muito
acima da viewport, reter apenas as linhas já renderizadas (strings) e soltar os
payloads brutos (`result`, buffers), re-hidratando sob demanda no expand — o
scrollback visível não muda; (c) medir com heap snapshot antes de calibrar
limiares.

---

## Tier 2 — ganhos médios, esforço pequeno

### P10 — Componentes que quebram a memoização do pai
- `packages/tui/src/components/loader.ts:125-127`:
  `render() { return ["", ...super.render(width)] }` — array novo por chamada;
  o pai vê referência nova → re-flatten do root a cada frame com o loader visível
  (que é exatamente o período de streaming). Cachear o wrapper e invalidá-lo só
  quando a referência de `super.render()` mudar.
- `packages/tui/src/components/truncated-text.ts:18-57`: sem cache algum; array
  novo + `truncateToWidth` por frame. Usada em `pending-user-message`,
  `oauth-selector`, `tree-selector`, `pendingMessagesContainer`
  (`interactive-mode.ts:4635`). Memoizar por `(text, width)` como `Text`.
- `packages/tui/src/components/box.ts:81-108`: materializa `childLines`
  (concat `leftPad + line` por linha) ANTES do cache check; com `paddingX>0` são
  N strings novas por frame. Checar primeiro width/bgSample/identidade dos arrays
  dos filhos.

### P11 — Pipeline de cor: parse e alocação repetidos
- `theme/color-interpolation.ts:126-130` (`parseTrueColorFg` roda regex sobre
  strings ANSI **constantes por tema** a cada chamada); `interpolateFg`
  (`:153-164`) paga 2 parses por chamada — e `fadeLineTail`
  (`assistant-message.ts:126-146`) chama `interpolateFg` **por grafema da borda,
  por frame** durante o reveal.
- `shimmerColorAt` (`color-interpolation.ts:184-216`): por frame do loader, 3
  parses de tema + `lerpRgb` (objeto) + `rgbFg` (closure + string) **por
  grafema** do label.

**Otimização:** cache `Map<ThemeColor, Rgb>` por instância de tema (invalidado no
swap); LUT quantizada de cores do shimmer por bucket de intensidade (a função já
é quantizável); reutilizar prefixos `\x1b[38;2;…m` em vez de closure por grafema.

### P12 — Footer: dirty-tracking por versão em vez de chave serializada
**Evidência:** `components/footer.ts:353-407` (`buildRenderCacheKey` monta ~25
campos com `Array.from(...).sort().map().join()` + `buildWorkspaceCwdLabels` a
CADA render — 60fps durante streaming — quase sempre para descobrir que nada
mudou); `footer.ts:419,429` recomputam `cwdLabels`/`contextUsage` de novo no corpo.

**Otimização:** comparar contadores de versão (session state version,
`getStatusVersion()`, `getGitDiffVersion()`, width) e só então montar a chave
cara; reusar `cwdLabels`/`contextUsage` entre a chave e o corpo.

### P13 — Suffix do loader por chunk
**Evidência:** `interactive-mode.ts:1698-1714` chamado por `message_update`
(`:3252`) — remonta `keyText + theme.fg` do " to interrupt" (constante no turno)
e o chip de tokens a cada delta.

**Otimização:** memoizar o prefixo por turno; comparar `(outputTokens, rate)` com
o último aplicado e pular `setTrailingSuffix` quando idêntico.

### P14 — Git: poll adaptativo e primeiro render sem spawnSync
**Evidência:** `core/footer-data-provider.ts:129` (`DIFF_POLL_MS = 5000`) +
`:461-471` — 2 processos `git` a cada 5s, para sempre, mesmo com o app idle;
`:370-390` (`resolveGitDiffStatsSync` com 2 `spawnSync`) alcançável pelo primeiro
`footer.render` via `getGitDiffStats()` (`:198-204`) se o async do constructor
ainda não terminou → bloqueio do event loop no startup (repo grande = centenas de ms).

**Otimização:** (a) no caminho sync, retornar `null` (footer sem chip até o
async chegar ~100ms depois) ou disparar o async e não bloquear; (b) backoff
adaptativo do poll (5s → 15s → 30s após N ciclos sem mudança; reset em evento de
tool mutante/watcher) — os watchers de HEAD/index já cobrem a maioria dos casos.

### P15 — Paste inline O(n²)
**Evidência:** `packages/tui/src/components/editor.ts:969-972` e
`packages/tui/src/components/input.ts:86-89` — `pasteBuffer += data;
pasteBuffer.indexOf("\x1b[201~")` re-escaneia do zero a cada chunk. O caminho
principal (`stdin-buffer.ts:373-378`) já usa janela `searchFrom`.

**Otimização:** buscar a partir de `prevLen - 5` (comprimento do marcador − 1),
como o stdin-buffer. ~3 linhas em cada arquivo.

### P16 — Imagens: sondagem de header e retenção dupla
**Evidência:** `packages/tui/src/terminal-image.ts:252-271` (PNG),
`:318-338` (GIF), `:340-377` (WEBP) — `Buffer.from(base64Data, "base64")`
decodifica a imagem INTEIRA para ler ≤30 bytes de header (JPEG já trunca em
131072 chars — `:273-277`); `image.ts:25,124` — retenção do base64 + sequência
(~2×, ver P9a).

**Otimização:** `Buffer.from(base64Data.slice(0, 64), "base64")` por formato.

### P17 — Cadência do ticker de animação
**Evidência:** `tui.ts:404,413` (`MIN_RENDER_INTERVAL_MS = 16`,
`ANIMATION_FRAME_MS = 16`); spinner avança a cada 80ms (`SPINNER_FRAME_MS`), os
callbacks fazem gating por bucket e retornam `false` — mas o processo acorda
~60×/s enquanto qualquer animação existir.

**Otimização:** derivar o intervalo do menor cadence ativo (spinner 80ms, shimmer
~33ms, breath ~bucket de 8) ou simplesmente 33ms — metade dos wakeups, sem perda
visual perceptível em terminal. Opcional: frame-budget adaptativo (se
`doRender` > 8ms, dobrar `MIN_RENDER_INTERVAL_MS` temporariamente) — protege
terminais lentos e sessões gigantes.

---

## Tier 3 — bounded / edge cases (registrar, fazer quando tocar no arquivo)

- **P19a** `tui.ts:1100` — `resetCache` até 65.536 entradas (linha inteira como
  chave + versão normalizada como valor ≈ 2× bytes por linha cacheada). Trocar
  teto por contagem para teto por bytes acumulados.
- **P19b** `undo-stack.ts:13` + `input.ts:379-381` — `Input` acumula até 1000
  snapshots completos e nunca limpa. Reduzir teto do Input e/ou snapshots por
  delta. `kill-ring.ts:26-28` — acumulação por concat; usar array de partes.
- **P20** `stdin-buffer.ts:218-297` — sequência ESC longa não terminada gera
  re-parse O(L²) por chunk até `MAX_BUFFER_BYTES` (10MB). Lembrar o offset já
  verificado entre chunks.
- **P21** `interactive-mode.ts:1956-1982` — `resetExtensionUI` esconde
  seletor/input de extensão sem resolver as Promises de
  `showExtensionSelector/Input` nem liberar `beginUserInputWait` →
  closures retidas + relógio do loader pausado para sempre (mitigado quando a
  extensão passa `signal`). Resolver como cancel + `releaseWait` no hide.
- **P22** `interactive-mode.ts:4427-4440,1886-1897,4895-4907` — fan-outs
  O(histórico) em toggles; manter índice dos filhos relevantes. Remover o loop
  100% redundante de `onHideThinkingBlockChange` (`:4951-4955`, ver P7).
- **P18** `box.ts` (ver P10). `settings-list.ts:121` — `maxLabelWidth`
  recalculado por render com `Math.max(...spread)`. `activity-line.ts:295` —
  `stripAnsi(target).trim()` por frame de spinner. `visual-truncate.ts:46` —
  chave de cache embute o texto inteiro; chavear por `outputVersion`.
  `editor.ts:645-674` — `paintPrefixVisible` re-segmenta O(n²) o prefixo do
  slash-command. `tree-selector.ts:878` — `JSON.stringify(args)` por nó ao montar
  (não por frame; ok). `interactive-mode.ts:3015-3032` — goal spinner repinta
  ~12,5fps em idle com goal ativo; reduzir cadência quando não streaming.
- **Micro**: `keys.ts:572-679` roda regexes Kitty mesmo para chars simples —
  early-out por `charCodeAt(0) !== 27`; `getToolActivity()` aloca array por
  chamada (`settings-manager.ts:1648`).

---

## O que JÁ está bem otimizado (não re-auditar)

- Render diferencial + fast path última linha + sync-output `?2026` (`tui.ts`).
- `applyLineResets` com fast path por identidade de referência + cache FIFO
  escalado pelo frame (`tui.ts:1094-1170`).
- `Container.render`/`Text`/`Spacer`/`Card`/`MessageShell`/`DynamicBorder` —
  memo por identidade correto; `Card` checa cache ANTES de renderizar filhos.
- Markdown streaming: lex incremental em appends, `tokenLineCache`,
  `tokenKeyCache`, caches por célula de tabela, fence scan incremental
  (commit `1115921b2`).
- `AssistantMessageComponent`: patch in-place por structure key, decorated memo
  por identidade, reveal/breath com unsubscribe + `dispose()`.
- Ticker de animação único, coalescido, com buffer reutilizado e `unref()`.
- Editor: `wrapLineCached` por linha, paste→marcador atômico (cap 10MiB),
  segmentação lazy nos hot paths, cursor blink desassinado quando idle.
- StdinBuffer: janela `searchFrom` no paste, caps de buffer.
- Autocomplete: debounce, TTL+LRU de readdir, abort de requests obsoletos.
- `bash-execution`: cap rolante + truncação por `outputVersion`.
- `footer.getCumulativeTotals` tail-incremental; `session-selector-search` com
  WeakMap + budget de regex; selectors filtram só em keystroke.
- Sem `setInterval` em idle além do git poll (P14) e keepalive de progresso
  OSC 9;4 (1s, barato); watcher de tema é event-driven.
- Resize com debounce de 70ms (`terminal.ts:18`); dimensões sync sem I/O.
- Listeners de sessão/agent: sem dupla inscrição; `stop()` limpa tudo.

## O que NÃO foi auditado

Fora do escopo "interface": `core/agent-session.ts`, compaction, tools (exceto
superfícies de UI), `@pit/ai`, `@pit/agent`, modo RPC, extensões de exemplo.
Nenhum profiling de runtime foi executado (análise estática); as magnitudes são
estimativas de mecanismo, não medições.

## Como medir

- `npm run profile:tui` (`scripts/profile-coding-agent-node.mjs --mode tui`) para
  CPU antes/depois; heap snapshot (Chrome DevTools / `--inspect`) para P9/P16.
- Sinais já existentes: `TUI.fullRedraws`, `getDiffScanCountForTest`,
  `getResetCacheSizeForTest`, `PIT_DEBUG_REDRAW=1`, `PIT_TUI_WRITE_LOG` (volume
  de bytes escritos por frame).
- Gates de verificação (ver memória do projeto): `tsgo` na raiz limpo; suites
  `@pit/tui` (713 testes) e coding-agent; benches de markdown existentes.
- Cenários de regressão manual: sessão longa sintética (10k+ linhas) com
  streaming ativo; resize durante streaming; prompt de 50KB digitado; `/tree` com
  milhares de entradas; sessão SSH com latência.
