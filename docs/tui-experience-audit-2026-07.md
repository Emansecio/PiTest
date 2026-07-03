# Auditoria de experiência e design do Pit TUI — 2026-07-03

> Sucessora de [`TUI-AESTHETICS.md`](../TUI-AESTHETICS.md) (Moves 0–5 shipped) e
> [`tui-ux-micro-moves-plan.md`](agents/tui-ux-micro-moves-plan.md) (itens 1–9,
> quase todos shipped). Produzida por 4 lanes paralelas com ownership disjunto
> (chrome / conversa / tools / overlays+tema); toda evidência `file:line` abaixo
> foi verificada no código em 2026-07-03.

## Onde a fronteira está agora

A coluna de chat está polida: hero com ignição, cards arredondados nos tool
blocks, gradientes, footer calmo, medida de leitura de 100 colunas, labels
humanizados no loader, H2 com barra `▎`. **A fronteira mudou de lugar** — os
maiores buracos hoje são:

1. **Overlays e seletores não acompanharam o Move 1** — `/model`, `/theme`,
   `/login` etc. ainda usam réguas planas `─` soltas (`DynamicBorder`) enquanto
   o resto do app virou card arredondado. É o maior furo de coerência.
2. **Code blocks do markdown são recessivos** — o elemento mais importante da
   resposta de um coding agent tem só uma barrinha `│` em `borderMuted`
   (`#2a3633`, quase invisível sobre `#0c1110`), sem topo/base/fundo.
3. **Erro de tool não grita** — num card framed, falha vs sucesso é só a cor de
   um glifo de canto.
4. **Micro-tipografia inconsistente** — 3 dialetos de trailer de truncation,
   3 separadores (`·`/`•`/`—`), 2 estilos de checkbox, 2 cursores de seleção.

### Desatualizações confirmadas no TUI-AESTHETICS.md
- `DEFAULT_ASSISTANT_READING_COLUMNS` já é **100**, não 0 (`assistant-message.ts:51`).
- H2 **não** é flat: tem barra `▎` accent (`theme.ts:1187`).
- O provedor não aparece mais ao lado do modelo no footer; o chip de thinking é
  capitalizado (`✦ High`).
- Do plano de micro-moves, só o **item 4** (elapsed na activity line) segue aberto.

---

## Tier 1 — quick wins (baixo risco, 1–5 linhas cada)

> **Status: implementado em 2026-07-03** (3 lanes paralelas + trocas de token).
> Gates: tsgo raiz limpo; biome limpo nos 21 arquivos tocados; @pit/tui
> `markdown.test.ts` 65/65 + `editor.test.ts` 196/196; suíte completa do
> coding-agent 4401 pass / 0 fail; smoke visual 60/140 sem overflow.
> Notas de implementação: 1.1 usou hook opcional `codeBlockLang` no
> `MarkdownTheme` (dim+bold) + `mdCodeBlockBorder` elevado para o azul do
> `border` (dark `#4fb6c4`, light `cyanBlue`); 1.2 confirmou que o default
> documentado `"  "` chega ao render — code blocks ganharam 2 colunas de
> respiro interno; 1.3 usou o `label` existente do MessageShell (`✗ error`,
> suprimido em abort e em activity-child); 1.6 cantos `╭`/`╰` só à esquerda,
> largura idêntica; 1.8 `moreLinesTrailer` ganhou substantivo paramétrico.

| # | Achado | Evidência | Proposta |
|---|---|---|---|
| 1.1 | Code block com borda invisível | `markdown.ts:663-684`; `dark.json:54` (`mdCodeBlockBorder: borderMuted`) | Subir o token para `border`/`borderAccent` (mesmo lift do Move 1c no editor); destacar a linha da `lang` (dim+bold) |
| 1.2 | Setting `markdown.codeBlockIndent` morto | Declarado em `markdown.ts:117`, threaded por `interactive-mode.ts:1068-1078`, documentado em `settings.md:206` — **nunca lido** no render | Consumir no case `code` ou remover campo+doc |
| 1.3 | Erro de tool framed sem sinal explícito | `tool-execution.ts:523-532` (só cor do gutter); `message-shell.ts:234-241` (`applyLabel` existe e não é usado p/ erro) | Setar label `✗ error` (ou `exit N`) no shell quando `result.isError` — mecanismo já existe |
| 1.4 | Cursor de seleção cru no config-selector | `config-selector.ts:374` (`"> "` sem cor) vs `keybinding-hints.ts:58` (`selectionCursor()` = `→ ` accent) | Trocar pelo helper canônico |
| 1.5 | Checkboxes divergentes | `ask-picker.ts:269` (`☑`/`☐`) vs `config-selector.ts:375` (`[x]`/`[ ]`) | Helper compartilhado `checkboxGlyph()` |
| 1.6 | Editor é o único bloco com canto reto | `editor.ts:691,746,754,759,837` (réguas `─` puras) | Cantos `╭`/`╰` nas pontas das réguas, sem laterais — 2 chars por régua, largura intacta |
| 1.7 | H3+ vaza `###` literal | `markdown.ts:640` (`headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText`) | Remover o prefixo cru; marcador leve dim+bold |
| 1.8 | 3 dialetos de trailer de truncation | `tool-activity.ts:51` (`… +N more lines (key to expand)`) vs `annotated-block-collapse.ts:34` (`… (N hint lines, …)`) vs `bash-command-row.ts:87-89` (`(N earlier lines, …)`) | Rotear todos por `moreLinesTrailer` (variante paramétrica) |
| 1.9 | `gutterBash` = `gutterToolSuccess` = green | `dark.json:84,86` (idem light) | `gutterBash` → gold, rimando com o glifo `$` (`tool-activity.ts:186 bash: "warning"`) |
| 1.10 | Micro-tipografia da 1ª impressão | `welcome-box.ts:119` (`—` órfão), `interactive-mode.ts:1493` (aspas retas `"` na linha de exemplos), `diagnostics-block.ts:81` (`" + "` vs `" · "` canônico) | `—`→`·`; aspas curvas `" "`; `+`→`·` |
| 1.11 | Metadados opostos na mesma cor | `activity-line.ts:294,302` (`×N` agregador e `· Ns` lentidão, ambos muted) | Elevar o `· Ns` para `warning` |
| 1.12 | Version órfã no card fallback | `welcome-box.ts:131-137,237` (tagline à esquerda, `vX.Y.Z` colado na borda direita em card largo) | Juntar `tagline · vX.Y.Z` flush-left, como o hero já faz |

## Tier 2 — projetos pequenos (ROI alto, risco médio)

**2.1 — CardFrame nos overlays/seletores** (o maior projeto de coerência).
~15 call sites usam `DynamicBorder` plano top/bottom: `theme-selector.ts:35,61`,
`thinking-selector.ts:41,68`, `model-selector.ts:103,132`, `oauth-selector.ts:57,82`,
`show-images-selector.ts:25,44`, `settings-selector.ts:438,509`,
`config-selector.ts:608,622`, `extension-selector.ts:44,75`, `extension-input.ts:47,70`,
`login-dialog.ts:46,69`, `session-selector.ts:747,755`, `tree-selector.ts:1168,1190`.
Compor o `Card` de `@pit/tui` (Step 0, já shipped) num wrapper e migrar em levas,
começando pelos seletores simétricos simples (theme/thinking/show-images).
Junto: **ligar o token órfão `cardBorder`** (`dark.json:92`/`light.json:92`,
declarado, zero consumidores, fora do schema/`ThemeColor`) para a borda dos
cards ficar tematizável. O **login-dialog** é o candidato showcase — tela de
primeiro contato, hoje a mais pobre da lane.

**2.2 — Placeholder dentro do editor** (fecha o "deferred" do doc com custo real
baixo). O ponto de injeção é único e já existe: branch de editor vazio em
`editor.ts:1264-1276` (`layoutText` empurra linha vazia com cursor). ~15 linhas:
`placeholder?: string` em `EditorOptions`, pintar em `dim` atrás do cursor quando
vazio, `setPlaceholder()`. Depois remover o `Describe a task…` flutuante
(`interactive-mode.ts:1501`). O mesmo débito existe em `extension-input.ts:35`
(`_placeholder` descartado).

**2.3 — Rounded editor frame completo: manter DEFERRED.** Confirmado caro de
verdade: `editor.ts:676-872` assume largura cheia em 4 sub-superfícies (wrap,
cursor-in-padding `:807`, autocomplete `:846-869`, history overlay `:857-868`).
O par 1.6 + 2.2 captura ~70% do efeito sem o risco.

**2.4 — Thinking visível sem âncora visual.** `assistant-message.ts:522-544`:
raciocínio renderiza como markdown italic muted direto no container — sem gutter,
indistinguível da prosa (e a diferença de cor some em 256-color). A paleta tem 6
cores `thinkingXxx` ociosas (`dark.json:74-79`). Dar um `│` lateral (via
`MessageShell` ou gutter simples) na cor do nível ativo.

**2.5 — Vocabulário de glifos nas mensagens de sistema.** 7+ call sites usam
`[bracket]` cru: `[compaction]`, `[branch]`, `[done]`, `[overthink]`, `[ttsr]`,
`[steer]`/`[queued]`, `[skill]` (`*-message.ts`). Glifo semântico por família
(◆ ⑂ ✓ ⟳ ▸) + cor de gutter existente. Junto: migrar
`SkillInvocationMessageComponent` (`skill-invocation-message.ts:11,17` — ainda
`Box` com fundo roxo cheio) para `MessageShell` gutter-only, terminando a
migração que compaction/branch já fizeram.

**2.6 — Realce de seleção com `selectedBg` em todos os seletores.** Hoje só
`session-selector.ts:496` e `tree-selector.ts:677` pintam a linha selecionada;
os outros 8 sinalizam só com `→` + cor. Copiar o padrão (preencher até `width`).

**2.7 — Indicador de scroll unificado.** `select-list.ts:154-159` tem o padrão
mais rico (`↑↓` + `(i/n)`); session/model/oauth/tree/config mostram só `(i/n)`.
Extrair helper e consumir nos 5.

**2.8 — Elapsed/slow em pending.** Item 4 do micro-moves plan (único aberto):
activity line sem elapsed em ações lentas; e `nav-group.ts` não tem o slow-timer
que `activity-line.ts:299-304` tem (`SLOW_ACTION_ELAPSED_SEC`) — portar para o
header pending do NavGroup.

## Tier 3 — registrar / opcional

- **Bg por linha no diff**: restrição real confirmada — o card framed não pinta
  bg (`tool-execution.ts:128-130`) e o `│` lateral é pintado depois do corpo
  (`message-shell.ts:249-265`); qualquer `\x1b[49m` no corpo quebraria o card.
  Exigiria componente que pinta bg na largura final. Fica com o esforço
  `SplitDiff` (side-by-side), fora de escopo.
- **Caret no wavefront do streaming** (`▌` dim na ponta do reveal,
  `assistant-message.ts:601-611` é o ponto de injeção) — aditivo, respeitar
  `isReducedMotion()`; não re-tunar constantes REVEAL_*.
- **Fallback ASCII do gauge**: `gauge-glyphs.ts:1-3` promete `●`/`○` em
  comentário, mas não há mecanismo — um setting/env que troca as constantes
  honraria a promessa para conhost/SSH sem a fonte.
- **`FALLBACK_GLYPH = "·"`** (`tool-activity.ts:202`): tools MCP ganham o glifo
  mais fraco, idêntico ao separador de contadores — considerar `◈`/`▪`.
- **Fallback MCP sem hierarquia interna** (`tool-execution.ts:218-224`): até 15
  linhas muted coladas no título — inset de 2 colunas (padrão de
  `activity-line.ts:315`).
- **Loader do bash** embute o hint de cancel na mensagem que respira
  (`bash-execution.ts:112`) — separar como `BorderedLoader` faz.
- **Bash command row**: `…` de clip inconsistente entre horizontal e vertical
  (`bash-command-row.ts:87-100`).
- **Workspace line do hero** centrada flutua solta do wordmark em terminais
  largos (`welcome-box.ts:220-221`) — alinhar ao `logoPad` do wordmark.
- **Card fallback do welcome com `paddingY: 0`** (`welcome-box.ts:157-162`) —
  conteúdo cola nas réguas; `paddingY: 1` quando `width >= 60`.
- **`thinkingHigh #8ab6d6` ≈ `border #4fb6c4`** adjacentes verticalmente no
  footer/editor — avaliar puxar a escala alta de thinking para lavender.
- **`mdListBullet`/`mdCode` ainda em `teal`** pós-migração accent→mint
  (`dark.json:52,58`) — confirmar intenção ou alinhar.
- **Microcópia de hints** divergente (navigate/move, select/choose, close/cancel)
  entre `select-list.ts:179`, `ask-picker.ts:366-371`, `settings-list.ts:243-245`,
  `config-selector.ts:186` — constantes canônicas em `keybinding-hints.ts`.
- **`EarendilAnnouncementComponent`** ainda com `DynamicBorder` plano
  (`earendil-announcement.ts:31,51`) — trocar por `Card` (easter egg, trivial).
- **Atualizar TUI-AESTHETICS.md** (desatualizações listadas no topo).

## O que está bom e não deve ser mexido

- Paridade dark/light real (mesmas chaves, greens ajustados p/ contraste, par
  light dedicado no `pitLogoGradient`); zero cores hardcoded nos seletores.
- Degradação 256-color deliberada (bicolor, não flat).
- Motion/streaming continua o ponto alto — nada aqui propõe re-tunar cadência.
- Medida de leitura de 100 colunas: manter.

## Verificação (por AGENTS.md)

Qualquer lote daqui: `npm run check` + **visual gate 60/140 cols** obrigatório
(tmux via WSL ou computer-use — [`tui-testing.md`](agents/tui-testing.md));
lotes de layout (CardFrame, placeholder) exigem o gate; trocas de token JSON
exigem checagem nos dois temas.
