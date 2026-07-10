# Pit TUI — Plano de Modernização Priorizado

> **Tipo**: Documento de análise. Nenhuma linha de código de produção foi modificada.
> **Escopo**: Experiência visual, fluidez de interação e percepção de modernidade do terminal.
> **Organização**: Por **prioridade** (P0 → P3 + Fora de escopo), não por categoria. Cada item traz contexto de código verificado, critério de aceite e risco.
> **Premissa central**: O maior risco do Pit **não é parecer datado — é estragar a fluidez de streaming que já é seu diferencial.** Por isso: metas falsas foram cortadas (60fps, smooth-scroll simulado), acessibilidade sobe para P0, e qualquer mexida no render path fica atrás de benchmark obrigatório.

---

## 1. Contexto — Estado Atual Verificado

Base técnica já excelente (confirmado por inspeção de `packages/tui` e `packages/coding-agent`):

- **Renderizador diferencial próprio** (`@pit/tui`), escreve ANSI direto no stdout com diff por célula/linha. Sem Ink/React/Yoga — decisão intencional por desempenho em alta frequência.
- **Motion já avançado**: reveal smoothing, fade wavefront, thinking breath, braille spinner phase-locked.
- **Tema "earthy"** teal `#8ad8c4` / coral / gold / lavender sobre fundo `#0c1110`.

**Importante — o que já existe no código** (evita reimplementar e corrige a versão anterior deste doc):

| Recurso | Estado real | Implicação para o plano |
|---|---|---|
| OSC 8 hyperlinks | **Já implementado** em `tui/src/utils.ts` (`parseOsc8Hyperlink`, `formatOsc8Hyperlink`, preservação de terminador) | Trabalho é **adotar** em paths/links, não implementar |
| Tema light | **Já existe** (`light.json` + `dark.json` em `theme/theme.ts`) | Trabalho é **tunar contraste**, não criar do zero |
| Detecção de capacidade | **Já existe** (`getCapabilities()`, `ColorMode` truecolor/256/16) | Reusar para fallback de gradientes/links |
| Syntax highlight de code block | **Já existe** (`utils/syntax-highlight.ts`) | Trabalho é o "chrome" (fundo/borda/label), não o highlight |
| `Card`, `cheatsheet`, `virtualized-container` | **Existem** | Estender/consistir, não criar |
| `NO_COLOR` | **NÃO ligado** no `@pit/tui` | Item genuinamente novo (P0) |
| Reduce-motion | **NÃO existe** caminho "motion off" | Item genuinamente novo (P0) |

**Defeitos objetivos** (fato, não gosto):
- Overlays, seletores e avisos secundários (ex.: MCP "did not connect") **não seguem** o polimento dos cards principais.
- Code blocks minimalistas (só borda lateral), sem fundo/label.
- Mensagem MCP "did not connect" parece erro fatal — vem de `built-ins/mcp-extension.ts`.

**Não é defeito, é gosto** (excluído do plano como objetivo): "chat muito denso / pouco respiro". Densidade alta é decisão de produto — ver P0.3.

---

## 2. Objetivos e Princípios

**Objetivo**: consistência e polimento no nível de TUIs de referência (lazygit, atuin, helix) **preservando a fluidez atual** — não virar "emulador GPU".

**Princípios inegociáveis**:
1. Manter controle total do render path (sem React/Ink/Yoga).
2. Não regredir a fluidez — é o diferencial, não a moldura.
3. Todo item tem **critério de aceite objetivo**. "Delight" e "coragem visual" não são critérios.
4. Nenhuma animação sem caminho "motion off".
5. Todo recurso avançado de terminal com **fallback** (via `getCapabilities()`).

---

## P0 — Fundamentos: Consistência + Acessibilidade + Correções
*Baixo risco, alto ROI, quase tudo cosmético/aditivo. Faça primeiro.*

### P0.1 — `Card`/frame consistente em overlays, seletores e erros de tool
- **Problema**: superfícies secundárias não usam o mesmo componente de frame dos cards principais (defeito objetivo de consistência).
- **Onde**: `tui/src/components/card.ts`, `box.ts`; seletores em `modes/interactive/components/*`.
- **O quê**: aplicar `Card` (bordas `╭╮╰╯` + `cardPaddingX`) a tool executions, erros de tool (tratamento distinto forte), resultados longos, seletores de modelo/tema/overlay.
- **Aceite**: overlays/seletores/erros usam o mesmo componente de frame; render-asserts verdes.

### P0.2 — Code blocks com "chrome" (o highlight já existe)
- **Problema**: code blocks só têm borda lateral; falta hierarquia visual.
- **Onde**: `tui/src/components/markdown.ts` (reusa `utils/syntax-highlight.ts`).
- **O quê**: fundo sutil + borda sup/inf + label de linguagem (dim+bold) + padding interno de 2 colunas. **Não** mexer no highlight já existente.
- **Aceite**: code block com label e fundo em ≥1 tema de teste; snapshot atualizado.

### P0.3 — Separadores/trailers unificados (densidade preservada)
- **Problema**: mistura de `•`/`—`/`·`; trailers de truncation inconsistentes.
- **O quê**: padronizar **um** estilo de separador e um componente único de trailer. Hierarquia usuário↔resposta via **regra/separador**, não linha vazia.
- **Regra de densidade**: densidade alta é **feature**. Só adicionar espaço quando cria hierarquia — nunca por estética. Contagem de linhas por turno **não** deve subir materialmente.
- **Aceite**: nenhum separador fora do padrão; contagem de linhas por turno estável em revisão lado a lado.

### P0.4 — Contraste em elementos críticos
- **Problema**: erros, seleção ativa e bordas de code block com contraste fraco.
- **O quê**: elevar `border` vs `borderMuted`; `cardBg` levemente distinto; cor forte + ícone em erros.
- **Aceite**: erros/seleção legíveis em fundo claro e escuro.

### P0.5 — `NO_COLOR` + reduce-motion (pré-requisito de qualquer motion novo) — **genuinamente novo**
- **Problema**: `NO_COLOR` não está ligado no `@pit/tui`; não há caminho "motion off". A UI já tem bastante motion (breath, fade, ignição); adicionar mais **sem** um "off" torna o produto cansativo/inacessível.
- **O quê**: respeitar `NO_COLOR` de forma abrangente; flag global de reduce-motion que degrada animações para estático; opção de alto contraste.
- **Por que P0**: barato e alto impacto; **tem que existir antes** de novas animações, senão cada item vira dívida de acessibilidade.
- **Aceite**: `NO_COLOR` desliga cor globalmente; reduce-motion desliga todas as animações; teste cobrindo ambos.

### P0.6 — Mensagem MCP "did not connect" calma e acionável
- **Problema**: parece erro fatal quando é só conexão sob demanda (visto nas imagens).
- **Onde**: `built-ins/mcp-extension.ts`.
- **O quê**: tom informativo + próxima ação sugerida; não usar estilo de erro.
- **Aceite**: mensagem não usa a cor/ícone de erro; texto sugere ação.

> **Gate P0**: render-asserts verdes · smoke visual em 60/80/120/140 col · **`tui/test/render-transcript.bench.ts` sem regressão** · verificação de `NO_COLOR`/reduce-motion.

---

## P1 — Polimento de UX
*Médio ROI, risco baixo-médio, aditivo. Depois do P0.*

### P1.1 — Tema light de alta qualidade (já existe base)
- **Onde**: `theme/theme.ts` (`light.json`/`dark.json`). Trabalho é **tunar contraste/legibilidade**, não criar.
- **O quê**: revisar erros/seleção/code block no `light.json`; overrides por projeto/usuário via `settings-manager`.
- **Aceite**: `light.json` passa nos render-asserts; legível em fundo claro.

### P1.2 — OSC 8 hyperlinks: adotar (primitiva já existe)
- **Onde**: primitiva em `tui/src/utils.ts`; aplicar em paths do workspace e links de markdown.
- **O quê**: emitir OSC 8 **só com detecção de capacidade** (`getCapabilities()`); fallback para texto puro. Nunca emitir às cegas.
- **Aceite**: link clicável em terminal compatível; texto limpo no incompatível.

### P1.3 — Markdown mais rico
- **O quê**: tabelas com alinhamento e bordas internas limpas; callouts/blockquotes (Nota/Aviso/Dica) com ícone+cor; task lists (`- [ ]`) com checkbox unicode.
- **Aceite**: cada elemento com snapshot; sem quebra de wrapping.

### P1.4 — Scroll e navegação (robustez, não estética)
- **O quê**: auto-scroll só avança se o usuário está no fim; indicador sutil "novo conteúdo" ao rolar para cima; indicadores de borda "mais acima/abaixo"; pular para próximo tool call.
- **Onde**: `virtualized-container.ts`.
- **Aceite**: não "rouba" scroll do usuário; indicadores corretos em conteúdo longo.

### P1.5 — Feedback de ações
- **O quê**: tool execution com barra fina + tempo decorrido (estimativa **só quando confiável** — barra falsa irrita mais que ausência); resultados longos collapsible com "ver mais"; toasts temporários (2-4s) para eventos secundários (MCP conectado, arquivo salvo).
- **Aceite**: sem estimativa quando não confiável; toasts somem sozinhos.

---

## P2 — Refinos de Fluidez
*Toca o que já é ótimo. Sempre atrás de flag + bench.*

### P2.1 — Reveal adaptativo + settle final
- **O quê**: reveal mais rápido em burst, mais "material" em taxa baixa; "settle" quando o modelo termina. **Atrás de flag.**
- **Aceite**: `render-transcript.bench.ts` sem regressão de tempo/alocação.

### P2.2 — Micro-interações com motion-off obrigatório
- **O quê**: hover-states em seleção (cor+bold ao mover a seta); crossfade curto na entrada de overlays; esconder cursor em streaming pesado e reaparecer imediato no input.
- **Aceite**: tudo degrada para estático sob reduce-motion (P0.5).

### P2.3 — Editor
- **O quê**: auto-pairing de parênteses/aspas/backticks **opt-in, desligado por default** (power users detestam imposição); syntax highlight leve no input **só se barato**; placeholder mais útil no estado vazio.
- **Aceite**: default sem auto-pair; latência de eco < 1 frame.

---

## P3 — Render Path (só com problema medido)
*Alto risco de regredir o diferencial. Não tocar preventivamente.*

- Dirty-region mais agressivo, double-buffering, throttling adaptativo: **apenas** se `render-transcript.bench.ts` provar um gargalo real.
- Double-buffering só se houver **tearing observado** — não preventivamente.
- Multi-pane experimental — só se ROI justificar.
- **Aceite**: um benchmark "antes" documentando o problema + "depois" provando ganho sem regressão.

---

## Fora de Escopo — Decisões Explícitas (não fazer)

- **Meta de "60fps estável"**: TUI é event-driven, não game loop; renderiza por evento. Perseguir 60fps aumenta CPU sem ganho. Meta correta: **zero flicker + zero regressão no bench + latência de input imperceptível**.
- **Scroll suave simulado**: animar linhas inteiras célula a célula em terminal tende a parecer *laggy*, não premium. Preferir salto limpo + indicador de posição.
- **"Adicionar respiro" como objetivo por si só**: densidade é feature (P0.3).
- **Ser "Warp-like"**: erro de categoria — Warp é um *emulador de terminal* (GPU); o Pit é um app *dentro* do terminal e não controla o emulador. Emprestar OSC 8/imagens/links, sim; imitar um emulador, não.
- **Reimplementar OSC 8 / tema light / syntax highlight**: já existem (ver §1).

---

## 3. Inspirações (sem copiar)

- **lazygit**: frames limpos, navegação fluida, micro-animações.
- **atuin**: busca instantânea, densa mas legível.
- **helix / kakoune**: feedback de comandos sem flicker.
- **opencode / Cline CLI / Cursor CLI**: coding agents comparáveis.
- **Charm (Bubbletea + Lipgloss)**: estética bonita — mas o Pit mantém render nativo (mais performático).

**Regra**: só adotar o que puder ser implementado sem sacrificar a fluidez atual nem adicionar dependências pesadas.

---

## 4. Como Executar

1. Transformar **P0** em backlog: cada item com descrição curta, **arquivos prováveis**, critério de aceite e **custo de atualização de snapshots** (render-asserts) declarado.
2. **Gate por item**: `npm run check` + testes do TUI + `tui/test/render-transcript.bench.ts` sem regressão + smoke visual em 60/80/120/140 colunas + verificação de `NO_COLOR`/reduce-motion.
3. **Medir latência de input e alocação/tempo de frame antes e depois** — nunca "FPS percebido".
4. Enviar P0, medir reação, e só então avançar. P2/P3 permanecem backlog explícito "só se ROI justificar".

---

## 5. Resumo Executivo

O Pit já é tecnicamente superior em fluidez de streaming à maioria dos agentes CLI. O erro estratégico a evitar é **tratar isso como resolvido e ir atrás de "delight" mexendo no que já é forte.**

O que realmente falta é **estreito e barato (P0)**:
- **Consistência**: cards/frames/separadores iguais em toda a interface (o defeito objetivo real).
- **Contraste onde importa**: erros, seleção, code blocks.
- **Acessibilidade cedo**: `NO_COLOR` + reduce-motion antes de mais motion.

E boa parte do "moderno" (**P1**) é *adoção* de coisas que já existem no código (OSC 8, tema light) — não implementação.

O que **não** fazer: 60fps, scroll suave simulado, "mais respiro" por estética, mexer no render path sem benchmark, ou mirar em ser "Warp-like".

Manter "nós controlamos o render" **e** proteger a fluidez existente é a decisão central. Polir a moldura sem arranhar o motor.

---

*Documento de análise, priorizado e aterrado no código real. Nenhuma linha de código de produção foi modificada.*
