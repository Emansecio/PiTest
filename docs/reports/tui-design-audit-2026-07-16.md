# Auditoria de design da TUI — 16/07/2026

> Auditoria multi-agente (11 analistas + 11 verificadores céticos, modelo Fable 5) sobre toda a
> superfície visual do Pit: `packages/tui` e `packages/coding-agent/src/modes/interactive`.
> Cada achado foi confirmado no código por um segundo agente adversarial; achados especulativos,
> já mitigados ou de gosto pessoal foram rejeitados (9 rejeições). Severidades pós-verificação.

**Total: 78 achados confirmados** — 4 P1, 38 P2, 36 P3.

Legenda: **P1** prejudica a experiência diária · **P2** melhoria clara · **P3** polish. Esforço: pequeno/médio/grande.

## Sumário executivo

A fundação é forte — renderização diferencial com synchronized output, editor com wrap por grafema
e undo coalescido, tema semântico centralizado. Os agentes convergiram em que quase nada é problema
de *mecânica*: as oportunidades estão em **sinalização, consistência e microfeedback**. Seis temas
concentram a maioria dos achados:

1. **Momentos de espera mudos** (o maior tema — 12+ achados). Busca `@` sem indicador de loading,
   retomada de sessão sem feedback, relógio do turno que reseta após retry/compaction, ferramentas
   em voo sem tempo decorrido, lista de tarefas que some no instante em que completa. A latência
   não sinalizada é o que mais mina a sensação de fluidez hoje.
2. **Diffs e outputs de ferramenta** (2 dos 4 P1). Syntax highlight que apaga a distinção
   adicionado/removido no diff, `ctrl+o` que expande o histórico inteiro em vez do bloco atual,
   trailer "(ctrl+o to expand)" em conteúdo já expandido.
3. **Descobribilidade de atalhos** (1 P1). Cheatsheet do F1 cortado sem scroll (às vezes até o
   "Esc to close" some), hint "Tab/↵ apply" que mente sobre o Enter, redo inalcançável em
   terminais comuns, `ctrl+p` que troca de modelo e atropela a navegação emacs prometida.
4. **Tema e cor** (1 P1). Terminal claro sem `COLORFGBG` cai no tema dark mesmo com a detecção
   OSC 11 já implementada e não usada; `accent` e `success` quase idênticos colapsam a semântica
   de estado.
5. **Consistência entre seletores.** Cinco estilos de título de picker, wrap vs clamp na navegação,
   campos de busca invisíveis sem placeholder, borda accent que só o session selector usa.
6. **Idioma misto.** Strings em português (splash, fluxo de interrupção) numa UI toda em inglês —
   justamente nos momentos de espera e cancelamento.

**Por onde começar:** os 4 P1 + os ~20 P2 de esforço *pequeno* formam um lote de polish de alto
retorno — a maioria é uma mudança localizada num componente. Os P2 médios de fluidez (tema 1)
são o segundo lote e o que mais muda a percepção diária.

## Impressões gerais por área

### Núcleo de renderização (`@pit/tui`)

O núcleo de renderização é maduro e claramente otimizado para fluidez percebida: uso consistente de synchronized output (DEC 2026), diff por identidade de referência com reuso de prefixo, ticker de animação único com fases travadas, debounce de resize e contenção de falhas de render sem derrubar a sessão. Os pontos fracos concentram-se quase todos no comportamento em resize — perda total do scrollback ao mudar largura, duplicação do transcript no scrollback ao mudar altura, e janela de 70ms de frame "mastigado" durante o drag — além de detalhes de polish como o cursor de hardware reposicionado fora do bracket sincronizado e o banner de erro de render sem estilo que causa layout shift.

### Editor e entrada de texto

A experiência de digitação do Pit é tecnicamente excelente — cursor grapheme-aware com sticky column e tabela de decisão documentada, undo com coalescing estilo fish, kill ring completo, blink que reseta ao digitar, cue efêmero de jump mode na régua e hints de tecla no dropdown mostram cuidado raro em TUI. As fraquezas concentram-se em feedback de estados assíncronos e de modo: o autocomplete não comunica loading nem vazio (some ou nunca aparece, em silêncio), a navegação de histórico é invisível, e a seleção do popup se perde a cada tecla. Somam-se defaults de teclado não convencionais (undo em Ctrl+- sem Ctrl+Z) e pequenas inconsistências de truncamento/glifo entre Editor e Input. São ajustes majoritariamente pequenos que elevariam a fluidez percebida no uso diário.

### Componentes base (`@pit/tui`)

A fundação é notavelmente sólida para uma TUI própria: spinners phase-locked num heartbeat único (loader.ts:18-50), contador de tempo que pausa quando o agente espera o usuário, fallback empilhado para tabelas estreitas, hints rebind-aware e digit-select opt-in no SelectList — decisões que mostram cuidado real com a experiência percebida. As fraquezas se concentram em três eixos: consistência de molduras (o bloco de código meio-aberto é o desvio mais visível do vocabulário de bordas), truncamento silencioso sem elipse espalhado por listas e cheatsheet, e hierarquia tipográfica achatada no markdown (H3+ idênticos, tabelas com grade pesada). São todos ajustes localizados — nenhum exige rearquitetura — mas afetam elementos que o usuário vê dezenas de vezes por sessão.

### Mensagens do chat

A camada de mensagens do Pit tem microinterações excepcionais para um TUI — streaming com wavefront de fade e caret (assistant-message.ts:144-181), label "Thinking…" que respira em sincronia com o loader, marcador ● de deliverable com ease de cor e narração intermediária esmaecida — tudo com respeito a reduced-motion e integração OSC 133 correta para navegação entre prompts. A fraqueza central é o meio da migração "Leva 2": o idioma unificado do MessageShell (gutter fino + label) convive com remanescentes (box roxo de custom messages, três alinhamentos de linhas compactas), e a distinção usuário/assistente/sistema repousa quase inteiramente na cor de um único caractere de gutter. Ajustes pequenos — segundo sinal visual para o usuário, coluna de leitura no prompt, abort sem vermelho de erro — elevariam bastante a experiência diária sem tocar na arquitetura.

### Execução de ferramentas e diffs

A camada de exibição de ferramentas é sofisticada e claramente pensada: settle com ease de cor e crossfade spinner→✓, glifos de família width-1 com coluna estável, coalescing ×N com diffstat acumulado, elisão inteligente de `cd`/`echo` em comandos, e caps de preview com trailers em quase todo site de colapso. As fraquezas concentram-se em três pontos: (1) o diff com syntax highlight dilui o sinal add/remove a um único caractere de gutter, enfraquecendo justamente o artefato mais lido do dia; (2) o modelo de expansão é um toggle global tudo-ou-nada, que transforma "quero ver este output" em "expandiu o histórico inteiro" e produz microcopy contraditória ("to expand" em conteúdo já expandido e inalcançável); (3) a microcopy de colapso e as cores de output divergem entre sites equivalentes (dois dialetos de trailer, muted vs toolOutput, "more" vs "earlier" lines), quebrando a sensação de sistema único que o resto do design conquista.

### Seletores e diálogos

A área está no meio de uma boa consolidação: SelectorShell + SelectorCard + os helpers de keybinding-hints (cursor →, checkbox ☑/☐, scroll hint, HINT_SEPARATOR) dão um idioma visual coerente, e há cuidado real com fluidez — Esc em dois passos, debounce de filtro com flush antes de navegar, preview ao vivo de tema, altura adaptativa clampada. O problema é que a unificação parou no meio: os seletores mais antigos (oauth, config, session, tree) divergem do padrão em semântica de Esc, wrap de navegação, cor de borda, ritmo vertical e altura, e a descobribilidade da busca depende de o usuário adivinhar que um input vazio existe. Os pontos mais fracos no dia a dia são o estado vazio enganoso durante o loading de sessões e a ausência de feedback animado na espera do OAuth.

### Chrome da interface (footer, overlays, status)

O chrome do Pit está num nível raro de cuidado para TUI: gramática visual coerente (headers `● Título — …`, árvores ├─/└─ compartilhadas entre goal/todo/context), escalada de cor por estado no gauge de contexto com easing e respeito a reduced-motion, sufixos protegidos contra truncamento e colapso progressivo do footer em sessão pristina. As fraquezas são quase todas de consistência entre irmãos: o footer não usa o resolver de glifos que o todo-overlay usa, o spinner do todo pinta atividade normal de warning, o splash fala português enquanto o resto fala inglês, e o overlay de tarefas — ao contrário do goal — não dá nenhum momento de conclusão. São ajustes pequenos que fechariam o sistema que já existe em vez de criar um novo.

### Tema e cor

O sistema de tema do Pit é maduro e acima da média para TUIs: 60+ tokens semânticos com vars e hot-reload, fallback 256-color pensado (quantização com preservação de tinta, colapso de cinzas detectado no spinner), transições truecolor com respeito a reduced-motion, e uma paleta dark teal/coral/gold genuinamente harmônica com paridade estrutural quase completa no light. As fraquezas são pontuais mas visíveis no dia a dia: a colisão accent/success dilui a semântica de estado em toda a UI, a detecção de terminal claro está incompleta (o parser OSC 11 existe mas não é ligado, então o primeiro contato em terminal claro é a paleta dark ilegível), e alguns literais órfãos e fallbacks divergentes mostram que a disciplina de tokens afrouxou nas bordas do sistema.

### Transversal: consistência visual

O sistema visual do Pit é maduro e claramente pós-passe-de-design: existe infraestrutura dedicada de consistência (keybinding-hints com HINT_SEPARATOR/selectionCursor/checkboxGlyph compartilhados, SPINNER_FRAMES canônico no loader, SelectorCard/SelectorShell, MessageShell unificando os blocos de chat) e zero cores hardcoded — tudo passa por tokens de tema, o que protege dark e light. As inconsistências restantes são de adoção incompleta dessa infraestrutura, não de ausência dela: componentes mais antigos ou periféricos (footer, custom-message, session-selector, tree/user-message selectors, e as strings literais dentro do @pit/tui) ainda montam títulos, separadores, hints e bordas à mão, produzindo cinco estilos de título de seletor, dois glifos de separador na mesma linha do footer e três gramáticas de dica de tecla. O maior retorno está em terminar a migração: empurrar os helpers já existentes para os últimos redutos ad hoc.

### Transversal: feedback e fluidez

A camada de feedback do Pit está muito acima da média para TUIs: spinners phase-locked num clock monotônico compartilhado, elapsed com pausa durante asks, motivo do retry classificado, reduced-motion respeitado em toda animação, loader criado no mesmo frame do submit para eliminar o gap morto, e eases de settle nos gutters. O caminho feliz é excelente; as costuras aparecem nos caminhos de exceção — cancelar, retry, fallback, resume — onde o polish cai: Esc muda de significado conforme estado invisível, cancelamentos viram erros vermelhos sticky, o relógio do turno reseta após retry/compaction e strings em português irrompem no meio de uma UI inteira em inglês. São exatamente os momentos de maior ansiedade do usuário, e é onde o investimento marginal de polish rende mais.

### Transversal: ergonomia de teclado

A infraestrutura de teclado do Pit é excepcionalmente sólida: registry central com migração de nomes legados (core/keybindings.ts), parsing de teclas que cobre Kitty/modifyOtherKeys/legacy com cuidado raro (keys.ts), semântica de Esc consistente e bem pensada nos seletores (dois passos com filtro, fallback seguro no picker de interrupção), e o loader sempre mostra 'esc to interrupt'. O elo fraco é a camada de DESCOBERTA: o cheatsheet F1 não escala (corta sem scroll, lista plana que mistura escopos e parece cheia de conflitos), o /hotkeys omite recursos centrais (o próprio cheatsheet, Ctrl+R, duplo-Esc), e os seletores divergem entre 'hint line completa' (session) e 'nada' (tree, shell) — o poder existe, mas só quem lê o código encontra. Corrigir a superfície de ajuda e duas arestas de consistência (idioma PT/EN no interrupt, Ctrl+P emacs) elevaria muito a experiência diária sem tocar na arquitetura.

## Achados por prioridade

---

## P1 (4)

### P1-1. Cheatsheet (F1) é cortado sem scroll e lista plana mistura contextos com pseudo-conflitos

`packages/tui/src/components/cheatsheet.ts:72` · área: ergonomia-teclado · categoria: descobribilidade · esforço: medio

**Problema.** O cheatsheet renderiza TODOS os ~67 bindings resolvidos numa lista plana ordenada por id (buildCheatsheetRows, cheatsheet.ts:53-69) e o componente não tem scroll — handleInput só fecha (cheatsheet.ts:135-141). O overlay é aberto com maxHeight 80% (interactive-mode.ts:2817) e o TUI simplesmente fatia o excedente (tui.ts:1183-1184 `overlayLines.slice(0, maxHeight)`). Num terminal de 40 linhas, mais da metade da lista E o hint final 'Esc to close' (cheatsheet.ts:95, última linha = primeira a ser cortada) ficam invisíveis. Pior: sem coluna de contexto, o usuário vê Ctrl+D três vezes ('Exit when editor is empty', 'Delete session', 'Tree filter: default view'), Ctrl+L, Ctrl+P, Ctrl+T, Ctrl+O e Ctrl+R duas vezes cada — parecem conflitos, mas são escopos diferentes (editor global vs session selector vs tree selector) que nada na UI distingue.

**Sugestão.** Agrupar as linhas por escopo com cabeçalhos de seção ('Editor', 'Global', 'Session selector', 'Tree selector' — o prefixo do id já dá o agrupamento de graça) e adicionar scroll com ↑↓/PgUp/PgDn ao componente (ou layout em duas colunas quando a largura permitir). Manter o 'Esc to close' fixo como rodapé fora da área rolável.

**Nota do verificador.** Verificado integralmente. buildCheatsheetRows (cheatsheet.ts:53-69) gera lista plana ordenada por id; handleInput (cheatsheet.ts:135-141) só fecha — nenhum scroll; o TUI fatia o excedente em tui.ts:1183-1184 e o overlay abre com maxHeight 80% (interactive-mode.ts:2817). Com ~70 linhas de conteúdo, num terminal de 40 linhas mais da metade some, incluindo o hint 'Esc to close' (cheatsheet.ts:95, última linha = primeira cortada), sem nenhum indicador de corte. O problema dos pseudo-conflitos é até PIOR que o descrito: Ctrl+D aparece 4 vezes (app.exit, tui.editor.deleteCharForward, app.session.delete, app.tree.filter.default), Ctrl+C 3 vezes, e Ctrl+A/L/P/T/O/R 2 vezes cada, sem coluna de escopo. A superfície principal de descobribilidade é inutilizável em terminais baixos — P1 mantido.

### P1-2. Diff com syntax highlight perde a distinção visual de linhas adicionadas/removidas

`packages/coding-agent/src/modes/interactive/components/diff.ts:44` · área: ferramentas-diff · categoria: legibilidade · esforço: medio

**Problema.** Quando a linguagem do arquivo é conhecida (o caso normal para todo edit de código), o corpo das linhas +/− recebe apenas cores de sintaxe idênticas às linhas de contexto: diff.ts:44 pula o tint da linha quando bodyPreColored=true, e pushPlainDiffLine (diff.ts:132-134) marca preColored para qualquer corpo com lang. Resultado: numa hunk grande, linhas adicionadas, removidas e de contexto são visualmente idênticas exceto por UM caractere de sinal colorido (diff.ts:39) e negrito intra-linha em pares alinhados. Blocos puros de adição/remoção (runs desiguais, diff.ts:222-229) não têm ênfase intra-linha nenhuma — só o '+'/'−' de 1 célula distingue. Escanear 'o que mudou' num diff de 30 linhas exige ler o gutter caractere a caractere.

**Sugestão.** Adicionar tokens toolDiffAddedBg/toolDiffRemovedBg (dark e light) e aplicar um background sutil na linha inteira das linhas +/− mantendo o foreground de sintaxe — o padrão de delta/GitHub. Alternativa mais barata sem novo token: aplicar theme.bg já existente ou reservar o tint sólido de linha para o corpo e restringir syntax highlight às linhas de contexto. O sinal ± sozinho não pode ser o único portador de informação da linha.

**Nota do verificador.** Evidência bate: diff.ts:44 pula o tint quando bodyPreColored, e pushPlainDiffLine (diff.ts:132-133) marca preColored para qualquer corpo com lang — que é o caso normal (resolveLang via path do edit). Contexto também recebe syntax (diff.ts:290), então +/−/contexto ficam com corpos idênticos. Pares alinhados ainda têm bold+cor nos tokens mudados (emphasizeToken), mas runs desiguais e blocos puros de adição (o caso comum de código novo, diff.ts:222-229 e 166-176) dependem só do sinal de 1 célula. Não há token de background de diff nos temas (dark.json/light.json só têm toolDiffAdded/Removed/Context como fg). Para um coding agent onde revisar diffs é o loop central, P1 é justo.

### P1-3. Terminal claro sem COLORFGBG cai no tema dark (OSC 11 existe mas não é usado)

`packages/coding-agent/src/modes/interactive/theme/theme.ts:757` · área: tema-cor · categoria: cor-tema · esforço: medio

**Problema.** detectTerminalBackground (theme.ts:757-776) só consulta COLORFGBG e cai em dark com confidence 'low'. O parser de OSC 11 (parseOsc11BackgroundColor, theme.ts:725) e getThemeForRgbColor (theme.ts:710) existem e têm testes (test/theme-detection.test.ts:57), e o tipo TerminalThemeDetection até declara source 'terminal background' (theme.ts:679), mas nada no src consulta o terminal de verdade. Windows Terminal, iTerm2 e a maioria dos emuladores modernos NÃO exportam COLORFGBG — usuário com fundo branco recebe a paleta dark: texto #cdd6d3, muted #788a85 e mint #86e6b2 sobre branco (contraste ~1.2-1.5:1, praticamente invisível) na primeira execução.

**Sugestão.** Fazer a query OSC 11 no startup da TUI (escrever `\x1b]11;?\x07` e ler a resposta com timeout curto, ~50-100ms) e alimentar getThemeForRgbColor antes de initTheme; manter COLORFGBG e o fallback dark como degraus seguintes. A infraestrutura de parsing já está pronta e testada — falta só o handshake.

**Nota do verificador.** Fato verificado: grep em packages/coding-agent/src mostra que parseOsc11BackgroundColor e getThemeForRgbColor não têm nenhum caller fora de test/theme-detection.test.ts; detectTerminalBackground (theme.ts:757-776) só lê COLORFGBG e cai em dark; settings-manager.ts:1283 retorna undefined por default e main.ts:507 → initTheme → getDefaultTheme. Em terminal claro sem COLORFGBG a primeira execução sai com texto #cdd6d3 sobre branco (~1.5:1), quase ilegível. Duas correções ao relato: (1) iTerm2 EXPORTA COLORFGBG por padrão — o problema real é Windows Terminal, Apple Terminal e sessões ssh/tmux; (2) existe recuperação (/theme, persistido em settings), então não é 'sem saída'. Rebaixo de P0 para P1: afeta uma minoria de usuários (fundo claro + terminal sem COLORFGBG), uma única vez, com workaround — mas a experiência de primeira execução é ruim o bastante e a infra pronta+testada torna o custo/benefício do handshake OSC 11 excelente.

### P1-4. ctrl+o expande TODOS os outputs do histórico de uma vez

`packages/coding-agent/src/modes/interactive/interactive-mode.ts:4748` · área: ferramentas-diff · categoria: ergonomia-teclado · esforço: grande

**Problema.** app.tools.expand é um boolean global (toggleToolOutputExpansion → setToolsExpanded(!this.toolOutputExpanded), interactive-mode.ts:4748-4756; keybindings.ts:82 'Toggle tool output'). Para ler o output de UMA ferramenta, o usuário expande todo o scrollback: cada BashGroup expande todos os filhos com output completo (bash-group.ts:59-63 propaga setExpanded a todos os execs), cada ActivityLine mostra o corpo, cada resultado de MCP/task abre. O transcript salta de dezenas para centenas/milhares de linhas, a posição de leitura se perde, e voltar exige apertar ctrl+o de novo e re-scrollar. É a interação mais frequente do dia (conferir um diff, um erro, um output) e a mais grosseira.

**Sugestão.** Expansão com escopo: ctrl+o expande apenas o último bloco de ferramenta (ou o bloco sob o cursor/foco), e ctrl+o ctrl+o (ou shift+ctrl+o) mantém o toggle global. Nos grupos, o primeiro nível de expansão deveria mostrar a lista de comandos com previews capadas, não o output integral de cada filho.

**Nota do verificador.** Confirmado: setToolsExpanded (interactive-mode.ts:4767-4781) itera todos os filhos do chatContainer; bash-group.ts:59-63 propaga setExpanded a todos os execs. O modo grouped é o DEFAULT (settings-manager.ts:1744) e, colapsado, não mostra corpo nenhum — ActivityLine só renderiza body se expanded (activity-line.ts:302), BashGroup idem (bash-group.ts:186). Mitigações existem mas são parciais: erros auto-preview só no NavGroup (nav-group.ts:278-279) e o header de edit traz diffstat +N/−N (activity-line.ts:214-222) — mas ver o diff em si, a ação mais frequente, exige explodir o transcript inteiro. Mantido P1; a interação central do dia não tem caminho de escopo menor.

---

## P2 (38)

### P2-1. Barra de contexto do footer ignora o fallback ASCII do gauge

`packages/coding-agent/src/modes/interactive/components/footer.ts:13` · área: chrome-status · categoria: consistencia · esforço: pequeno

**Problema.** footer.ts:13 importa GAUGE_FILLED/GAUGE_EMPTY (constantes ▰/▱) diretamente e renderiza a barra CTX com elas (footer.ts:122-130), enquanto todo-overlay.ts:48 usa resolveGaugeGlyphs(), que respeita PIT_ASCII_GAUGE=1 / TERM=dumb (gauge-glyphs.ts:14-19). Num terminal cuja fonte não tem U+25B0/U+25B1, o usuário liga o kill-switch, a barra de progresso dos todos conserta — mas a barra do footer, que é o chrome mais permanente da tela (visível 100% do tempo), continua renderizando tofu.

**Sugestão.** Trocar o import direto por resolveGaugeGlyphs() em renderFooterContextBar (mesmo padrão do todo-overlay). Como o resultado depende só de env, pode ser resolvido uma vez no module load ou memoizado — não afeta o cache de render.

**Nota do verificador.** Evidência exata: footer.ts:13 importa GAUGE_FILLED/GAUGE_EMPTY cru e renderFooterContextBar (122-130) os usa, enquanto todo-overlay.ts:48 passa por resolveGaugeGlyphs() (gauge-glyphs.ts:14-19), que respeita PIT_ASCII_GAUGE/TERM=dumb. O kill-switch documentado falha justamente no chrome mais visível. Rebaixado de P1 para P2 porque só atinge usuários cujo terminal precisa do fallback — para o resto a barra renderiza normalmente.

### P2-2. Split de tokens do goal (`12k/30k/3k`) aparece sem rótulos — ninguém decodifica

`packages/coding-agent/src/modes/interactive/components/goal-overlay.ts:109` · área: chrome-status · categoria: legibilidade · esforço: pequeno

**Problema.** buildGoalMetricsLine (goal-overlay.ts:104-121) monta `iter 3 · tokens 45k/100k · 12k/30k/3k · ~80% budget · 4m12s`. O terceiro grupo é o tokenSpendSplit main/subagent/fusion (goal-overlay.ts:107-110), mas nenhum rótulo, legenda ou glifo indica isso na UI — três números separados por barra logo depois de OUTRO par com barra (used/budget), com semântica completamente diferente. É a linha que o usuário olha para decidir se aumenta o budget, e ela exige conhecer o código para ser lida.

**Sugestão.** Rotular minimamente cada parcela — ex.: `main 12k · sub 30k · fusion 3k` — ou usar glifos já estabelecidos no chrome (↑/↓ são usados no footer para in/out). Se largura for problema, mostrar o split apenas quando width comportar, mantendo `tokens 45k/100k` como resumo.

**Nota do verificador.** Confirmado em goal-overlay.ts:107-110 e :118: o split main/subagent/fusion renderiza como ` · 12k/30k/3k` logo após `tokens 45k/100k` — dois grupos com barra, semânticas distintas, zero rótulo/legenda na UI. É a linha usada para decidir aumento de budget e exige ler o código-fonte para interpretar. Legibilidade genuína, não pedantismo. P2 mantida.

### P2-3. Idioma misto no chrome: splash em português, todo o resto em inglês

`packages/coding-agent/src/modes/interactive/components/startup-screen.ts:22` · área: chrome-status · categoria: consistencia · esforço: pequeno

**Problema.** startup-screen.ts:22-23 e :57 são as únicas strings em PT do chrome ('Bem-vindo ao Pit', '/help para ajuda', 'Abertura indisponível'). Tudo ao redor é EN: a tagline do hero 'Coding agent in your terminal' (welcome-box.ts), 'Workspace'/'Resuming' (welcome-box.ts:122/128), 'Tasks'/'Goal', '⚠ compact soon' (footer.ts:715), 'done hidden' (todo-overlay.ts:140). A primeira tela e o resto da sessão falam línguas diferentes — a abertura parece de outro produto.

**Sugestão.** Escolher um idioma para o chrome inteiro (ou centralizar essas strings num único módulo de copy para trocar em bloco). Se a saudação PT é intencional, a tagline/version e os hints da mesma tela deviam acompanhar.

**Nota do verificador.** Confirmado: startup-screen.ts:22-23 ('Bem-vindo ao Pit', '/help para ajuda') e :57 ('Abertura indisponível') são as únicas strings PT; welcome-box.ts:122/128 ('Workspace', 'Resuming'), footer.ts:715 ('⚠ compact soon'), todo-overlay.ts:140 ('done hidden') e todo o resto do chrome são EN. A primeira tela de cada sessão fala outra língua que o resto do produto. P2 mantida.

### P2-4. Moldura de bloco de código meio-aberta: cantos ╮/╯ pendurados no vazio

`packages/tui/src/components/markdown.ts:953` · área: componentes-base · categoria: consistencia · esforço: pequeno

**Problema.** O bloco de código desenha réguas superior/inferior fechadas com cantos arredondados (`╭${rule}╮` em markdown.ts:953 e `╰${rule}╯` em markdown.ts:1005), mas as linhas do corpo têm apenas a goteira esquerda `│ ` (markdown.ts:949) — não existe borda vertical direita. O resultado visual é uma caixa 'quebrada': os cantos ╮ e ╯ prometem uma vertical à direita que nunca aparece, e todo bloco de código (elemento extremamente frequente num coding agent) lê como moldura mal renderizada, destoando de Card (box.ts/card.ts), que fecha corretamente os quatro lados.

**Sugestão.** Ou fechar a caixa de verdade (adicionar `│` à direita com pad até a largura, como Card faz em card.ts:98), ou assumir o desenho aberto e remover os cantos direitos: réguas `╭${rule}` / `╰${rule}` (sem ╮/╯) casam com a goteira esquerda-apenas e leem como 'régua com dobra', não como caixa quebrada. A segunda opção evita mexer na matemática de wrap do corpo.

**Nota do verificador.** Evidência bate exatamente: markdown.ts:953 emite `╭${rule}╮`, :1005 emite `╰${rule}╯`, e o corpo (:949-951) usa só a goteira esquerda `│ ` — não há vertical direita nem pad, ao contrário de Card (card.ts:98) que fecha os 4 lados. O comentário em markdown.ts:947-948 mostra que o desenho é deliberado ('Top/bottom rules span the width; lines keep the gutter'), mas os cantos direitos ficam mesmo pendurados sobre o vazio em todo bloco de código. Rebaixo de P1 para P2: é inconsistência puramente cosmética, sem perda de informação, e a correção sugerida (remover ╮/╯) é barata e segura. P1 exagera para um problema que não atrapalha nenhuma tarefa.

### P2-5. Truncamento silencioso sem elipse em listas, settings e cheatsheet

`packages/tui/src/components/select-list.ts:405` · área: componentes-base · categoria: truncamento-resize · esforço: pequeno

**Problema.** Vários pontos passam explicitamente `""` como elipse para truncateToWidth, cortando texto sem nenhum indicador de que há mais conteúdo: o label primário do SelectList (select-list.ts:405), a descrição da linha (select-list.ts:336), o valor atual no SettingsList (settings-list.ts:164) e as colunas de teclas/descrição do cheatsheet (cheatsheet.ts:86 e :90). Um nome de modelo ou descrição de comando cortado no meio ('claude-fable-5-2026' vira 'claude-fable-5-2') parece completo — o usuário não tem como saber que perdeu informação, e dois itens distintos podem ficar visualmente idênticos após o corte.

**Sugestão.** Usar a elipse padrão '…' (já é o default de truncateToWidth, utils.ts:953) nesses call sites — custa 1 célula e sinaliza corte. Onde a coluna é alinhada (valor primário do SelectList), a elipse ainda cabe no pad da coluna sem quebrar o alinhamento.

**Nota do verificador.** Todos os call sites conferem: select-list.ts:405 e :336, settings-list.ts:164, cheatsheet.ts:86 e :90 passam `""` explicitamente, anulando o default '…' de truncateToWidth (utils.ts:953). Nenhum consumidor no coding-agent define `truncatePrimary` (grep sem resultados), então o fallback sem elipse é o que roda em produção nos pickers de modelo/sessão/tema. Achado sólido e a correção é 1 célula. Rebaixo para P2 porque o dano prático (dois itens ficarem idênticos) só ocorre quando o conteúdo excede a coluna — frequente em descrições e títulos de sessão, menos no valor primário com coluna default de 32 (select-list.ts:7); não é bloqueio diário garantido como P1 sugere.

### P2-6. Tabelas markdown com separador entre TODAS as linhas dobram a altura

`packages/tui/src/components/markdown.ts:1534` · área: componentes-base · categoria: espacamento-layout · esforço: pequeno

**Problema.** renderTable insere a linha separadora `├─┼─┤` entre cada par de linhas do corpo (markdown.ts:1534-1536), não só após o header. Uma tabela de 10 linhas ocupa ~21 linhas de terminal — quase o dobro — e a grade pesada uniforme faz o separador do header (que carrega significado estrutural) desaparecer no meio de 10 réguas idênticas. Modelos emitem tabelas com frequência; o transcript fica desnecessariamente alto e difícil de escanear verticalmente.

**Sugestão.** Emitir o separador interno apenas quando a linha anterior ou a atual quebrou em múltiplas linhas físicas (rowLineCount > 1), que é o único caso em que ele desambigua; caso contrário, manter só topo, separador de header e fundo. Isso preserva legibilidade em células com wrap e devolve ~45% da altura nas tabelas comuns.

**Nota do verificador.** markdown.ts:1534-1536 confirma: `if (rowIndex < token.rows.length - 1) lines.push(separatorLine)` — separador `├─┼─┤` idêntico ao do header (:1516) entre cada par de linhas do corpo. Tabela de N linhas simples custa 2N+2 linhas em vez de N+3. Nada no código mitiga (não há distinção para linhas com wrap). A sugestão de manter o separador interno apenas quando rowLineCount > 1 preserva a única função real dele (desambiguar células com wrap) e devolve a altura no caso comum. P2 adequado.

### P2-7. No brand default a descobribilidade depende de um tip one-shot; /hotkeys não menciona o cheatsheet, Ctrl+R nem o duplo-Esc

`packages/coding-agent/src/modes/interactive/interactive-mode.ts:7005` · área: ergonomia-teclado · categoria: descobribilidade · esforço: pequeno

**Problema.** Com APP_NAME === 'pit' não há nenhum hint de startup nem empty-state (interactive-mode.ts:850 e 1568-1569 — só rebrands ganham hints). A única ponte para o mundo dos atalhos é o power tip mostrado UMA vez na vida após o primeiro turno (maybeShowPowerTip, 3957-3964, persiste `powerTipShown` imediatamente — se o usuário piscar, perdeu para sempre). E a superfície canônica /hotkeys (7005-7051) não lista: o próprio cheatsheet F1/Ctrl+/, o Ctrl+R de reverse-search do histórico (tui/keybindings.ts:125), o duplo-Esc que abre o session tree por default (settings-manager.ts:1740, default 'tree' — comportamento surpresa não documentado em lugar nenhum), nem Alt+Up já coberto ok. Recursos centrais do dia a dia ficam órfãos de qualquer trilha de descoberta.

**Sugestão.** 1) Adicionar F1/Ctrl+/ (cheatsheet), Ctrl+R (history search) e 'Esc Esc → session tree' à tabela do /hotkeys; 2) trocar o power tip one-shot por um chip dim permanente e barato no footer pristine (ex.: `F1 shortcuts`) que some após o primeiro uso do cheatsheet — custo visual próximo de zero, descoberta garantida.

**Nota do verificador.** Fatos confirmados: APP_NAME === 'pit' suprime hints de startup (interactive-mode.ts:850) e o empty-state vira um Spacer (1568-1569); maybeShowPowerTip (3957-3963) persiste powerTipShown antes de exibir o toast efêmero — one-shot literal; a tabela do /hotkeys (7005-7051) não lista F1/Ctrl+/ (cheatsheet), Ctrl+R (tui.editor.historySearch, implementado de verdade em editor.ts:1414/3018+) nem o duplo-Esc cujo default é 'tree' (settings-manager.ts:1740). Ajusto P1→P2: há mitigações reais — o power tip anuncia o cheatsheet uma vez, /help aponta para /hotkeys (6950), e /hotkeys cobre a maioria dos atalhos diários. É lacuna de documentação/descoberta com trilha parcial, não ausência total; ainda assim o duplo-Esc abrir a session tree sem estar documentado em lugar nenhum é surpresa legítima.

### P2-8. Fluxo de interrupção fala português numa UI 100% inglesa

`packages/coding-agent/src/modes/interactive/interactive-mode.ts:2651` · área: ergonomia-teclado · categoria: consistencia · esforço: pequeno

**Problema.** O picker de interrupção usa 'Parar a tarefa inteira', 'Cancelar só: <tool>' e 'Interromper o quê?' / header 'Interromper' (interactive-mode.ts:2651-2665), enquanto todo o resto da UI é inglês: o status resultante é 'Interrupted' (2681), o hint é 'Press Ctrl+C again to exit' (4301), o session selector pergunta 'Delete session?' (session-selector.ts:159). O momento mais sensível da experiência (o usuário quer PARAR o agente agora) é exatamente onde a UI troca de idioma — quebra de confiança e de escaneabilidade, e as strings do ask-picker (hints 'navigate/select/close') aparecem em inglês no mesmo card.

**Sugestão.** Padronizar as strings do promptInterruptChoice para inglês ('Stop the whole task', 'Cancel only: <tool>', 'Interrupt what?') — ou, se a intenção é i18n, centralizar todas as strings de UI num módulo único em vez de misturar idiomas por arquivo.

**Nota do verificador.** Verificado: promptInterruptChoice usa 'Parar a tarefa inteira' (interactive-mode.ts:2651), 'Cancelar só: <tool>' (2655), question 'Interromper o quê?' e header 'Interromper' (2663-2664), enquanto no mesmo fluxo o status é 'Interrupted' (2681) e 'Cancelled <tool>' / 'Tool already finished' (2689), e o ask-picker exibe hints em inglês ('navigate · enter select · esc close', ask-picker.ts:476-485) dentro do mesmo card. Mistura de idiomas real no momento mais sensível da interação, corrigível em minutos. P2 adequado.

### P2-9. Ctrl+/ (anunciado no power tip) dispara Undo em terminais sem Kitty protocol

`packages/tui/src/keys.ts:1230` · área: ergonomia-teclado · categoria: ergonomia-teclado · esforço: pequeno

**Problema.** Em terminais legacy, Ctrl+/ e Ctrl+- produzem o mesmo byte \x1f, que o parser normaliza para 'ctrl+-' (keys.ts:1230) = tui.editor.undo (tui/keybindings.ts:123); rawCtrlChar não tem representação legacy para '/' (keys.ts:734-745), então matchesKey(data, 'ctrl+/') falha e o listener do cheatsheet (interactive-mode.ts:2792-2799) nunca vê a tecla. Resultado: fora de Kitty/modifyOtherKeys, apertar o atalho de ajuda desfaz a edição do prompt em vez de abrir o cheatsheet — e o power tip anuncia exatamente 'f1/ctrl+/' via keyText (interactive-mode.ts:3961-3963), prometendo um atalho que falha de forma confusa no ambiente mais comum (Windows Terminal sem Kitty, conhost, tmux).

**Sugestão.** No power tip e nos hints, anunciar apenas F1 quando o Kitty protocol não está ativo (o estado já é conhecido em keys.ts), ou tratar \x1f como tie-break do cheatsheet quando o editor não tem o que desfazer.

**Nota do verificador.** Verificado byte a byte: em legacy, Ctrl+/ produz \x1f, que parseKey normaliza para 'ctrl+-' (keys.ts:1230) = tui.editor.undo (tui/keybindings.ts:123); rawCtrlChar não tem representação para '/' (keys.ts:734-745, retorna null), então matchesKey(data, 'ctrl+/') só casa via Kitty/modifyOtherKeys (keys.ts:1120-1126) e o listener do cheatsheet (interactive-mode.ts:2792-2799) nunca vê a tecla — o undo do editor consome. E o power tip usa keyText('tui.help.cheatsheet'), que junta TODAS as teclas com '/' (keybinding-hints.ts:29-36), anunciando literalmente 'f1/ctrl+/'. Atalho de ajuda prometido que silenciosamente desfaz a edição do prompt em conhost/tmux/terminais legacy é falha real de UX. P2 correto (F1 continua funcionando como fallback).

### P2-10. Strings PT-BR misturadas com inglês exatamente nos momentos de espera e cancelamento

`packages/coding-agent/src/modes/interactive/interactive-mode.ts:2651` · área: feedback-fluidez · categoria: consistencia · esforço: pequeno

**Problema.** A UI inteira fala inglês ("Working…", "Interrupted", "Retrying (1/4) in 5s…", "Compacting context…"), mas o overlay de interrupção usa "Parar a tarefa inteira", "Cancelar só: X", "Interromper o quê?" (interactive-mode.ts:2651-2664) e o pending_check mostra "Aguardando npm test… (2m)" (interactive-mode.ts:3701). São justamente as superfícies de espera/cancelamento — as mais carregadas emocionalmente — que trocam de idioma no meio da frase, lendo como remendo e minando a confiança na interface ("Interromper" ao lado do status "Interrupted" na mesma tela).

**Sugestão.** Padronizar todas as strings visíveis em um único idioma (inglês, que é o dominante hoje): "Stop the whole task", "Cancel only: X", "Interrupt what?", "Waiting for npm test…". Se a intenção é i18n, extrair para um dicionário em vez de literais espalhados.

**Nota do verificador.** Evidência literal confirmada: 'Parar a tarefa inteira', 'Cancelar só: X', 'Interromper o quê?', header 'Interromper' (interactive-mode.ts:2651-2664) e 'Aguardando ${event.command}…' (3701), cercados por 'Interrupted' (2681), 'Tool already finished' (2689), 'Retrying…', '✓ passed' em inglês. A inconsistência é real e visível em superfícies frequentes. Rebaixado de P1 para P2: é polish/consistência — não bloqueia nem confunde a ação (os rótulos são compreensíveis), apenas lê como remendo. A sugestão (padronizar em inglês) é correta e de esforço trivial.

### P2-11. Retomar sessão não dá nenhum feedback durante o carregamento

`packages/coding-agent/src/modes/interactive/interactive-mode.ts:5924` · área: feedback-fluidez · categoria: estados-vazios-erro · esforço: pequeno

**Problema.** handleResumeSession chama stopWorkingLoader() e então aguarda switchSession + renderCurrentSessionState (interactive-mode.ts:5924-5933) sem pintar nada: numa sessão grande (JSONL de vários MB, transcript inteiro reconstruído), a tela fica parada — status vazio e o selector recém-fechado — até "Resumed session" aparecer. O contraste interno é gritante: /reload mostra um box "Reloading keybindings, extensions…" (6518-6532) e o próprio session selector tem header "Loading … (n/m)" com progresso (session-selector.ts:140).

**Sugestão.** Mostrar um Loader no statusContainer ("Loading session…", mesma paleta do working loader) antes do await de switchSession, removido em renderCurrentSessionState. Idealmente reaproveitar o idiom do /reload para consistência.

**Nota do verificador.** Confirmado: handleResumeSession (5920-5933) chama stopWorkingLoader() e aguarda switchSession + renderCurrentSessionState sem pintar nada até 'Resumed session' (5933). O contraste interno citado procede: /reload mostra um box 'Reloading keybindings, extensions…' com render forçado antes do trabalho (6518-6533, incluindo requestRender(true) + nextTick para garantir a pintura). Ressalva: para sessões pequenas o gap é sub-segundo e imperceptível — a severidade depende do tamanho da sessão — mas resume é ação diária e sessões longas são justamente as mais retomadas. P2 mantido; a sugestão (reusar o idiom do /reload, que já resolve o problema de pintar antes de trabalho síncrono) é a correta.

### P2-12. Janela do "Press Ctrl+C again to exit" é de 500ms — menor que o tempo de leitura do próprio hint

`packages/coding-agent/src/modes/interactive/interactive-mode.ts:4271` · área: feedback-fluidez · categoria: microinteracao · esforço: pequeno

**Problema.** O double-press de saída exige o segundo Ctrl+C em <500ms (interactive-mode.ts:4271) e o hint se auto-apaga nos mesmos 500ms (4304). Ler "Press Ctrl+C again to exit" leva ~700ms-1s; quando o usuário reage, a janela já expirou — o segundo Ctrl+C limpa o editor de novo e re-arma o hint, num loop que faz a saída parecer quebrada e força um triple-tap rápido. CLIs comparáveis usam 1-2s.

**Sugestão.** Aumentar a janela e o TTL do hint para ~1500-2000ms (constante única compartilhada entre a comparação em 4271 e o setTimeout em 4304). Vale aplicar o mesmo à janela do double-Esc (500ms em 2739), que sofre do mesmo aperto.

**Nota do verificador.** Confirmado exatamente: comparação now - lastSigintTime < 500 (4271) e TTL do hint setTimeout(…, 500) (4304), dois literais 500 independentes. A dinâmica de loop descrita é real: um segundo Ctrl+C após >500ms não sai, re-arma lastSigintTime (4276) e limpa o editor de novo (4294) — quem lê o hint antes de reagir sempre perde a janela e precisa de um terceiro tap rápido. Um hint que instrui uma ação precisa dar tempo de ler + reagir; 1.5-2s é o padrão de CLIs comparáveis. Ressalva menor: estender também o double-Esc (500ms em 2739) é mais discutível — ali não há hint para ler, é um gesto tipo double-click onde 500ms é convencional; essa parte da sugestão é opcional. P2 correto para o Ctrl+C.

### P2-13. Cancelamentos iniciados pelo usuário são renderizados como erro vermelho sticky

`packages/coding-agent/src/modes/interactive/interactive-mode.ts:3786` · área: feedback-fluidez · categoria: estados-vazios-erro · esforço: pequeno

**Problema.** Esc durante o retry countdown gera auto_retry_end success:false com finalError "Retry cancelled" (agent-session.ts:6216-6221), que a TUI pinta como showError("Retry failed after 1 attempts: Retry cancelled") (interactive-mode.ts:3786-3788) — erro vermelho, sticky (EphemeralStatusController: kind error nunca auto-expira, ephemeral-status.ts:29-30), e ainda com plural errado ("1 attempts"). Cancelar compaction manual idem: showError("Compaction cancelled") (3576). O usuário pediu para cancelar e a UI responde como se algo tivesse falhado, exigindo o próximo submit para limpar o vermelho.

**Sugestão.** Distinguir cancelamento de falha: quando finalError for cancelamento (ou o evento carregar um flag aborted), usar showStatus muted "Retry cancelled" / "Compaction cancelled" com TTL normal — como já é feito para auto-compaction cancelada (3578). Corrigir o plural de attempts de quebra.

**Nota do verificador.** Cadeia confirmada: abort durante o sleep do backoff emite auto_retry_end success:false, finalError:'Retry cancelled' (agent-session.ts:6216-6221) → showError(`Retry failed after ${attempt} attempts: Retry cancelled`) (interactive-mode.ts:3786-3788), com plural errado quando attempt=1. Erros são sticky por design: ttlFor('error') retorna null (ephemeral-status.ts:29-31), então o vermelho fica até o próximo submit. Compaction manual cancelada usa showError('Compaction cancelled') (3576) enquanto auto-compaction cancelada corretamente usa showStatus (3578) — a própria base de código já tem o padrão certo a um branch de distância, o que confirma que é inconsistência e não escolha. Punir o usuário com vermelho por uma ação que ele mesmo pediu é anti-padrão claro. P2 correto.

### P2-14. Trailer '(ctrl+o to expand)' aparece em conteúdo já totalmente expandido — e ctrl+o colapsa

`packages/coding-agent/src/modes/interactive/components/tool-activity.ts:40` · área: ferramentas-diff · categoria: microinteracao · esforço: pequeno

**Problema.** capDiffPreview (tool-activity.ts:36-42) anexa moreLinesTrailer com '(ctrl+o to expand)' sempre que corta linhas — mas é chamado exatamente nos caminhos EXPANDIDOS: activity-line.ts:303-305 (if this.expanded → capDiffPreview com EDIT_EXPANDED_MAX_LINES=40) e edit-preview-shared.ts:112-118/141-144 (diffMaxLines só quando context.expanded). Um diff expandido com mais de 40 linhas mostra '… +N more lines (ctrl+o to expand)' num estado onde ctrl+o COLAPSA tudo. O hint mente, e as N linhas restantes são literalmente inalcançáveis na TUI — beco sem saída.

**Sugestão.** No estado expandido, trocar o trailer por algo honesto como '… +N more lines (diff truncado — veja o arquivo)' sem hint de tecla, ou remover o cap quando expandido (o problema de flood já é mitigado pelo colapso padrão). Ideal: um segundo nível de expansão ou paginação para diffs longos.

**Nota do verificador.** Confirmado: capDiffPreview (tool-activity.ts:36-42) só é chamado nos caminhos expandidos (activity-line.ts:302-305 sob if this.expanded; edit-preview-shared.ts:243-244 seta diffMaxLines apenas quando context.expanded) e sempre anexa expandKeyHint(). As linhas restantes são inalcançáveis na TUI. Agravante: o padrão honesto já existe no próprio codebase — bash-execution.ts:210-211 troca para '(ctrl+o to collapse)' quando expandido. Rebaixado a P2: só afeta diffs >40 linhas já majoritariamente visíveis; é hint enganoso, não quebra a interação primária. Fix trivial.

### P2-15. Grupo de bash com erro não diz qual comando falhou

`packages/coding-agent/src/modes/interactive/components/bash-group.ts:149` · área: ferramentas-diff · categoria: estados-vazios-erro · esforço: pequeno

**Problema.** Colapsado, um grupo com falha mostra apenas '✗ $ Ran 3 commands' (summary em bash-group.ts:139-150 só exibe a contagem para n>1). O estado pending tem tratamento melhor: pendingSuffix (bash-group.ts:152-159) anexa '— <comando atual>' ao header. No erro — o momento em que o usuário mais precisa de contexto — não há sufixo equivalente: para descobrir qual dos 3 comandos falhou e por quê, é preciso expandir tudo (o que, via ctrl+o global, expande o histórico inteiro).

**Sugestão.** Espelhar pendingSuffix com um errorSuffix: em estado error, anexar '— <comando que falhou>' (primeiro exec com getActivityState()==='error' e !isAborted()) em muted/coral, reutilizando commandText() que já clampa à largura.

**Nota do verificador.** Confirmado: summary (bash-group.ts:139-150) mostra só '✗ $ Ran N commands' para n>1; pendingSuffix (152-159) só roda em state==='pending'; filhos só renderizam se this.expanded (186-190). Agravante que o auditor não citou: a docstring da classe (bash-group.ts:15-17) promete 'a child that errors auto-expands', mas esse mecanismo só existe no NavGroup (nav-group.ts:278-279 setResultExpanded + capErrorPreview) — no BashGroup não há nenhum caminho de auto-expand, e o ActivityStacker não promove erros para fora do grupo. O erro é exatamente o estado que perde contexto. P2 correto; sugestão (errorSuffix espelhando pendingSuffix) é barata e reutiliza commandText.

### P2-16. Distinção usuário vs assistente depende de um único caractere de gutter colorido

`packages/coding-agent/src/modes/interactive/components/user-message.ts:46` · área: mensagens-chat · categoria: hierarquia-visual · esforço: pequeno

**Problema.** A mensagem do usuário renderiza com a MESMA cor de texto do assistente (dark.json:39 e light.json:39 definem userMessageText: "text"), mesmo Markdown, sem label — a única distinção é o `│` ciano de 1 coluna (user-message.ts:46-55). Só que quase todo bloco do transcript também tem um `│`: thinking usa MessageShell com gutter tingido (assistant-message.ts:653-656), compaction/branch/skill usam gutter lavanda, turn-done usa gutter muted. Ao rolar rapidamente, achar "o que EU perguntei" exige diferenciar matiz de um único glifo fino — especialmente fraco no tema light, onde cyanBlue sobre fundo claro perde saturação percebida.

**Sugestão.** Dar mais um sinal além da cor: renderizar o texto do usuário em bold (ou num tom levemente mais claro/escuro que o corpo), ou usar um glifo de gutter mais pesado só para o usuário (`▌` em vez de `│`), ou um label curto tipo `▸ You` na primeira linha via o mecanismo de label que o MessageShell já tem. Dois sinais redundantes (peso + cor) tornam o prompt escaneável mesmo com daltonismo ou temas customizados.

**Nota do verificador.** Fatos conferem: user-message.ts:46-55 usa MessageShell sem label ('the role is unambiguous from the color alone', diz o próprio docblock) e userMessageText: "text" em dark.json:39/light.json:39 — mesma cor do corpo. Thinking (assistant-message.ts:653-656), compaction/branch (gutterCustom) e turn-done (muted) também usam `│`. Porém a severidade P1 exagera: (1) o assistente NÃO tem gutter nenhum (AssistantMessageComponent extends Container, assistant-message.ts:186), então gutter colorido ≠ assistente; (2) todo prompt de usuário vem imediatamente após a TurnRule `─` (interactive-mode.ts:4053), um localizador forte que o auditor omitiu; (3) os blocos de sistema carregam labels (⟳ Compaction, ✓ Done), só thinking é gutter-sem-label como o user. E no light o cyanBlue é #2f7da0, um tom escurecido com contraste razoável — a alegação de 'perde saturação' é fraca. O ponto de acessibilidade (sinal único de cor num glifo de 1 coluna) permanece válido e a correção é barata, mas é P2, não P1.

### P2-17. Prosa do usuário não respeita a coluna de leitura em terminais largos

`packages/coding-agent/src/modes/interactive/components/user-message.ts:50` · área: mensagens-chat · categoria: consistencia · esforço: pequeno

**Problema.** A prosa do assistente é limitada a assistantReadingColumns (default 120, settings-manager.ts:17) via ReadingColumn (assistant-message.ts:605), e até o TurnRule respeita esse limite (turn-rule.ts:37-38). Mas UserMessageComponent adiciona o Markdown direto ao shell (user-message.ts:50-54), sem ReadingColumn — num terminal ultrawide, um prompt longo do usuário estica de borda a borda enquanto a resposta logo abaixo forma uma coluna de 120 colunas. O ritmo horizontal do transcript quebra a cada turno e parágrafos do usuário ficam com linhas longas demais para ler confortavelmente.

**Sugestão.** Envolver o Markdown do usuário no mesmo ReadingColumn usado pela prosa do assistente, passando o valor de getAssistantReadingColumns() (o componente já recebe markdownTheme; basta receber também o cap). Transcript inteiro passa a compartilhar uma única medida de leitura.

**Nota do verificador.** Confirmado integralmente. UserMessageComponent adiciona Markdown direto ao shell (user-message.ts:50-54) sem ReadingColumn; a prosa do assistente passa por ReadingColumn com cap 120 (assistant-message.ts:605, DEFAULT_ASSISTANT_READING_COLUMNS em settings-manager.ts:17), thinking também (assistant-message.ts:652), e até a TurnRule é limitada a getAssistantReadingColumns() (turn-rule.ts:37-38, interactive-mode.ts:3973). Num terminal >120 colunas, um prompt longo do usuário estoura inclusive a largura da própria rule que o precede — inconsistência visível e fix trivial. P2 correta.

### P2-18. Abort iniciado pelo usuário renderiza em vermelho de erro

`packages/coding-agent/src/modes/interactive/components/assistant-message.ts:693` · área: mensagens-chat · categoria: cor-tema · esforço: pequeno

**Problema.** Quando o usuário aborta um turno (Esc), o rodapé mostra "Operation aborted" em theme.fg("error") (assistant-message.ts:694-703) — exatamente o mesmo tratamento visual de um erro real de provider (linha 704-709). Abortar é uma ação intencional e rotineira ("mudei de ideia, deixa eu re-orientar"), mas a cada Esc o transcript ganha uma linha vermelha que grita "algo quebrou". Ao revisar a sessão depois, aborts e falhas reais ficam indistinguíveis no escaneamento por cor.

**Sugestão.** Renderizar aborts em warning ou muted (ex.: `◦ interrompido` dim), reservando o vermelho de error exclusivamente para falhas reais. O turn-done line já diferencia os dois stopReasons (turn-done-format.ts:55-60), então a informação existe — só a cor precisa acompanhar a semântica.

**Nota do verificador.** Confirmado: assistant-message.ts:693-703 renderiza 'Operation aborted' com theme.fg("error") — idêntico ao caso de erro real logo abaixo (704-709). E o próprio turn-done trata abort como caso distinto e neutro (turn-done-format.ts:55-57 emite '· aborted' num shell de gutter muted, turn-done-message.ts:11), então o transcript pode mostrar o abort em vermelho E em muted ao mesmo tempo — inconsistência interna que reforça o achado. Esc é ação rotineira de re-orientação; vermelho de erro para ação intencional é semanticamente errado. P2 correta, fix pequeno.

### P2-19. Esc fecha o diálogo direto em vez de limpar o filtro (oauth e config)

`packages/coding-agent/src/modes/interactive/components/oauth-selector.ts:186` · área: seletores-dialogos · categoria: consistencia · esforço: pequeno

**Problema.** O padrão do produto é Esc em dois passos: com filtro não-vazio, o primeiro Esc limpa a busca e só o segundo fecha (selector-shell.ts:93-101, model-selector.ts:441-448, session-selector.ts:693-702, tree-selector.ts:1005-1013). Mas o oauth-selector (oauth-selector.ts:186-188) e o config-selector (config-selector.ts:432-434) chamam onCancel imediatamente, mesmo com texto digitado na busca. Quem digitou um filtro em /login ou no seletor de recursos e aperta Esc por memória muscular perde o diálogo inteiro em vez de limpar o filtro.

**Sugestão.** Replicar a semântica de dois passos nesses dois seletores: se searchInput.getValue().length > 0, limpar o valor, re-filtrar e requestRender; só fechar quando a busca estiver vazia. É exatamente o bloco já existente em model-selector.ts:441-448 — copiar o idioma.

**Nota do verificador.** Evidência exata: oauth-selector.ts:186-188 e config-selector.ts:432-434 chamam onCancel sem checar o valor da busca, enquanto selector-shell.ts:93-101, model-selector.ts:441-448 (cujo comentário declara explicitamente a convenção 'every selector behaves uniformly'), session-selector.ts:693-702 e tree-selector.ts:1005-1013 fazem dois passos. É quebra real de convenção interna documentada. Rebaixo a P1→P2: /login tem lista curta (maxVisible 8, poucos provedores) onde filtro é raro, o custo do erro é só reabrir o diálogo (nada se perde — toggles do config salvam na hora), e os seletores de uso diário (model, session, theme) já estão corretos.

### P2-20. Campos de busca sem placeholder — a busca é invisível até você adivinhar que pode digitar

`packages/coding-agent/src/modes/interactive/components/selector-shell.ts:74` · área: seletores-dialogos · categoria: descobribilidade · esforço: pequeno

**Problema.** Todos os seletores criam `new Input()` sem placeholder: selector-shell.ts:74, model-selector.ts:160, oauth-selector.ts:66, session-selector.ts:350. Um Input vazio renderiza como uma linha em branco dentro do card — nada indica que digitar filtra a lista. O suporte a placeholder existe e já é usado no login-dialog (login-dialog.ts:55-57 com placeholderColor, e setPlaceholder em 153). O config-selector compensa com uma linha extra "Type to filter resources" (config-selector.ts:195), gastando uma linha inteira para o que um placeholder faria de graça — e o oauth-selector não tem dica nenhuma.

**Sugestão.** Passar um placeholder dim a cada Input de busca (ex.: "Buscar temas…", "Buscar modelos…", "Buscar sessões — re:regex, \"frase\""), usando o mesmo placeholderColor dim do login-dialog. No config-selector, remover a linha "Type to filter resources" do header e recuperar uma linha vertical.

**Nota do verificador.** As linhas citadas conferem (selector-shell.ts:74, model-selector.ts:160, oauth-selector.ts:66, session-selector.ts:350 criam Input sem placeholder; suporte pronto em input.ts:36-65 e usado em login-dialog.ts:55-57,153; config-selector.ts:194 gasta linha com 'Type to filter resources'). Mas a premissa central é exagerada: um Input vazio focado NÃO renderiza 'linha em branco' — renderiza prompt '> ' + cursor reverse-video (input.ts:470-489), idioma fzf que sinaliza digitação; e o tree tem 'Type to search:' (tree-selector.ts:1149-1155). O que falta é dizer O QUE a digitação faz (filtrar, sintaxe re:/"frase" do session). Melhoria válida e barata, mas P1 é inflado → P2.

### P2-21. Session selector mostra "No sessions in current folder" enquanto ainda está carregando

`packages/coding-agent/src/modes/interactive/components/session-selector.ts:483` · área: seletores-dialogos · categoria: estados-vazios-erro · esforço: pequeno

**Problema.** O SessionList nasce com lista vazia (session-selector.ts:893-900) e o load é assíncrono (loadCurrentSessions, linha 984). O render do corpo (linhas 469-487) não sabe do estado de loading — só o header sabe (linha 137-140). Resultado: ao abrir /resume, o corpo exibe imediatamente "No sessions in current folder. Press Tab to view all." enquanto o header diz "Loading…". Duas mensagens contraditórias na mesma tela; com muitas sessões (load lento, timeout de até 20s na linha 714) o estado enganoso persiste, e o usuário pode apertar Tab ou fechar achando que não há nada.

**Sugestão.** Propagar o flag de loading ao SessionList (ex.: setLoading(bool)) e, enquanto carregando com lista vazia, renderizar uma linha neutra tipo "Loading sessions…" (idealmente com o spinner já existente em SPINNER_FRAMES) em vez da mensagem de vazio. Só mostrar o empty state real quando o load tiver terminado.

**Nota do verificador.** Confirmado no código: SessionList nasce vazio (session-selector.ts:893-900), render do corpo não tem noção de loading (469-487, mensagem em 483 com conselho acionável 'Press Tab'), só o header sabe (137-140), load assíncrono dispara no construtor (984) com timeout de 20s (714). Contradição real em toda abertura de /resume — comando diário. Rebaixo P1→P2 porque a mitigação existe e é visível: o header mostra 'Loading Current Folder n/m' em accent na mesma tela, com progresso; na maioria dos casos o load resolve em fração de segundo e o estado errado é um flash. A sugestão (propagar loading ao corpo) é correta e pequena.

### P2-22. Navegação com wrap em uns seletores e clamp em outros

`packages/coding-agent/src/modes/interactive/components/model-selector.ts:396` · área: seletores-dialogos · categoria: consistencia · esforço: pequeno

**Problema.** ↑ no topo da lista dá volta para o fim no model-selector (model-selector.ts:396-405), no tree (tree-selector.ts:959-964) e no ask-picker (ask-picker.ts:279-285), mas trava no topo no session-selector (session-selector.ts:652-659), no oauth-selector (oauth-selector.ts:167-177) e no config-selector (findNextItem clampa, config-selector.ts:402-408). O mesmo gesto tem dois comportamentos diferentes dependendo de qual diálogo está aberto — quebra a previsibilidade do teclado no uso diário (Home/End já existem para saltos, então o clamp não compensa nada).

**Sugestão.** Escolher uma convenção única (wrap tende a ser melhor em listas curtas de seletor; os três que já envolvem são os mais usados) e aplicá-la nos seis componentes. É trocar o Math.max/Math.min por aritmética modular idêntica à do model-selector.

**Nota do verificador.** Todas as linhas conferem: wrap em model-selector.ts:396-405, tree-selector.ts:959-964, ask-picker.ts:279-285; clamp em session-selector.ts:652-659, oauth-selector.ts:167-177, config-selector.ts:402-408 (findNextItem 258-267). O achado é até mais forte do que reportado: o SelectList do @pit/tui (select-list.ts:222-232), usado por theme/thinking/settings via SelectorShell, também faz wrap — wrap é a maioria clara e a convenção da lib. Correção menor: o oauth-selector NEM TEM Home/End (handleInput só trata up/down/confirm/cancel), então o argumento 'Home/End já existem' não vale para ele — o que só reforça o caso do wrap ali. P2 adequado.

### P2-23. Borda accent do session selector destoa de todos os outros cards

`packages/coding-agent/src/modes/interactive/components/session-selector.ts:850` · área: seletores-dialogos · categoria: hierarquia-visual · esforço: pequeno

**Problema.** O SelectorCard tem default cardBorder (selector-card.ts:13), usado por theme, model, config, oauth, tree e ask-picker. Só o session selector passa borda accent: `new SelectorCard(1, 0, (s) => theme.fg("accent", s))` (session-selector.ts:850). Um seletor rotineiro grita em cor de destaque enquanto os demais são quietos — sem razão semântica (accent na borda deveria sinalizar algo especial, como o ask-picker que pede decisão, e nem ele usa). Também há inconsistência de ritmo vertical: session (858), tree (1269) e config (614) adicionam Spacer(1) antes do card, mas model (179), oauth (81) e theme/shell não — os overlays abrem colados ou soltos dependendo de qual é.

**Sugestão.** Usar a borda default cardBorder no session selector e padronizar o Spacer(1) externo (ou dentro do mecanismo que posiciona overlays) para que todos os seletores abram com o mesmo respiro vertical.

**Nota do verificador.** Grep de `new SelectorCard(` confirma: session-selector.ts:850 é o único seletor rotineiro com borda accent (earendil-announcement.ts:31 também usa accent, mas é anúncio — semanticamente especial, o que reforça que accent deveria sinalizar exceção). Default cardBorder em selector-card.ts:13. A inconsistência de Spacer(1) externo também confere: session:858, tree:1269, config:614 têm; model:179, oauth:81 e selector-shell:85 não — e showSelector (interactive-mode.ts:5285-5299) só troca o conteúdo do editorContainer, sem espaçamento uniforme, então os overlays realmente abrem com respiros diferentes. P2 correto.

### P2-24. Config selector não limita a altura da lista nem se adapta a resize

`packages/coding-agent/src/modes/interactive/components/config-selector.ts:237` · área: seletores-dialogos · categoria: truncamento-resize · esforço: pequeno

**Problema.** ResourceList calcula `maxVisible = Math.max(5, (terminalHeight ?? 24) - chrome)` com chrome=8 e SEM teto (config-selector.ts:235-237). Os outros seletores usam clamp(rows - 12, 5, 15) (selector-shell.ts:61, model-selector.ts:311, session-selector.ts:906). Num terminal de 50 linhas o config vira uma lista de 42 itens — densidade totalmente diferente dos irmãos; e o chrome=8 subestima (o próprio render da lista adiciona search + linha em branco nas linhas 345-346, além do scroll hint), então em terminais baixos o card pode estourar a altura. O valor também é calculado uma única vez no construtor, então redimensionar o terminal não ajusta a janela.

**Sugestão.** Adotar o mesmo clamp(rows - 12, 5, 15) dos demais e recalculá-lo por render/updateList como o model-selector faz (computeMaxVisible por chamada, model-selector.ts:309-313), para que resize funcione.

**Nota do verificador.** Confirmado integralmente: config-selector.ts:235-237 usa Math.max(5, (terminalHeight ?? 24) - 8) sem teto, calculado uma única vez no construtor (terminalHeight passado por valor em 621), enquanto selector-shell.ts:61, model-selector.ts:309-313 (recalculado por updateList, com comentário explicitando que 'resizes stick') e session-selector.ts:906 usam clamp(rows-12, 5, 15). O subdimensionamento do chrome também procede: o próprio render da lista adiciona busca + linha em branco (345-346) e scroll hint (388-394) fora dos 8 contabilizados, então em terminal baixo o card pode estourar. Densidade destoante + resize quebrado num diálogo real. P2 correto.

### P2-25. accent e success são quase a mesma cor — a semântica de estado colapsa

`packages/coding-agent/src/modes/interactive/theme/dark.json:25` · área: tema-cor · categoria: cor-tema · esforço: pequeno

**Problema.** No dark, accent = mint #86e6b2 (dark.json:25 via var :9) e success = green #8ad8a0 (:29 via :8) — contraste entre elas de 1.13:1, indistinguíveis lado a lado. No light idem: mint #177a4f vs green #3f9b54 (1.53:1). Consequência diária: seleção/cursor/gauge de contexto 'calmo' (getContextUsageColor usa accent, theme.ts:456), diff added (toolDiffAdded=green), gutter de tool com sucesso e bashMode=green ficam todos no mesmo verde — o usuário não distingue 'isto está selecionado/ativo' de 'isto deu certo'. O próprio comentário em theme.ts:454 chama o accent de 'teal accent', sinal de que a intenção original era um teal distinto do verde de sucesso.

**Sugestão.** Puxar o accent para o eixo teal/ciano da paleta (ex.: tealBright #6fe0cf no dark, tealDeep #0f6e56 no light) deixando o verde exclusivo de success/diff-added/bash. Um ajuste em 2 linhas de cada JSON re-separa seleção de estado em toda a UI.

**Nota do verificador.** Números conferidos: dark accent mint #86e6b2 (dark.json:25) vs success green #8ad8a0 (:29) = 1.13:1; light #177a4f vs #3f9b54 = 1.53:1 — de fato indistinguíveis. O comentário 'teal accent' em theme.ts:454-455 está mesmo defasado (accent é mint), evidência de drift, e getContextUsageColor usa accent no estado calmo. Rebaixo de P1 para P2: na prática seleção e sucesso quase nunca competem lado a lado exigindo discriminação por cor — posição e layout desambiguam (cursor →, selectedBg, gutter). É um refinamento de paleta legítimo e barato, não uma dor diária de confusão. Ressalva à sugestão: borderAccent já é tealBright #6fe0cf; puxar accent para o mesmo teal criaria nova colisão — precisa escolher um teal distinto de borderAccent também.

### P2-26. Lista de tarefas desaparece no exato instante em que a última completa

`packages/coding-agent/src/modes/interactive/components/todo-overlay.ts:198` · área: chrome-status · categoria: microinteracao · esforço: medio

**Problema.** todo-overlay.ts:198 (e o renderer puro em :171) retorna [] assim que data.done === data.total. O momento mais gratificante do fluxo — o último item virando ✓ e a barra chegando a 100% verde — nunca é visto: o overlay some no mesmo frame. O goal-overlay, no mesmo diretório, já resolve isso com um linger de 4s em estado success (GOAL_COMPLETE_LINGER_MS, goal-overlay.ts:19 e :191-192). A inconsistência entre os dois overlays irmãos torna o término das tarefas abrupto e sem feedback.

**Sugestão.** Replicar o padrão completeSeenAt do GoalOverlayComponent: quando done === total (com total > 0), mostrar o estado final (barra cheia + todos ✓, ou uma linha compacta 'Tasks — ✓ N/N') por ~3-4s antes de esconder. O clock injetável já existe no componente.

**Nota do verificador.** Confirmado em todo-overlay.ts:171 e :198 (retorna [] quando done === total, no mesmo frame). Sem mitigação: no transcript o tool call colapsa para 'Updated todos ×N' (tool-activity.ts:155), então o estado 100% nunca é visto em lugar nenhum. O precedente GOAL_COMPLETE_LINGER_MS=4000 no overlay irmão (goal-overlay.ts:19,191-192) mostra que o linger é o padrão da casa. Rebaixado a P2: é microinteração/polimento — nenhuma informação necessária se perde, o momento gratificante é que some.

### P2-27. Cheatsheet é cortado sem scroll em terminais baixos — inclusive o hint 'Esc to close'

`packages/tui/src/components/cheatsheet.ts:72` · área: componentes-base · categoria: truncamento-resize · esforço: medio

**Problema.** renderCheatsheet emite todas as ~36 keybindings numa lista plana (cheatsheet.ts:72-97) e o overlay que o hospeda simplesmente fatia as linhas excedentes (`overlayLines.slice(0, maxHeight)` em tui.ts:1183-1184, com maxHeight de 80% em interactive-mode.ts:2817). Num terminal de 24 linhas, metade dos atalhos some sem nenhum indicador de que há mais — e a última linha, justamente o hint 'Esc to close' (cheatsheet.ts:95), é a primeira a ser cortada. Além disso a ordenação por id interno (cheatsheet.ts:58) produz um parede de texto sem agrupamento visual (editor/select/session misturados só por prefixo alfabético).

**Sugestão.** Dar scroll ao Cheatsheet (janela + indicador ↑↓ (n/total), reutilizando o padrão já existente em select-list.ts:189-195) e ancorar o hint de fechamento fora da região rolável. De quebra, inserir uma linha em branco entre grupos de prefixo (tui.editor.*, tui.select.*, …) para quebrar a parede.

**Nota do verificador.** Cadeia inteira verificada: renderCheatsheet emite lista plana ordenada por id (cheatsheet.ts:58, :85-92) com o hint na última linha (:95); o overlay corta o excedente do fim com `overlayLines.slice(0, maxHeight)` (tui.ts:1183-1185) e maxHeight é 80% (interactive-mode.ts:2817). Num terminal de 24 linhas (~19 visíveis), parte dos atalhos e o hint somem sem indicador algum — nenhum mecanismo de scroll ou '↓ mais' existe no componente. Mitigação parcial: Esc/Ctrl+C fecham mesmo sem o hint visível (cheatsheet.ts:138), então ninguém fica preso; mas um cheatsheet que oculta silenciosamente metade dos atalhos falha na própria função de descobribilidade. P2 correto.

### P2-28. Título de seletor tem 5 estilos diferentes entre os pickers

`packages/coding-agent/src/modes/interactive/components/selector-shell.ts:69` · área: consistencia-visual · categoria: consistencia · esforço: medio

**Problema.** O mesmo elemento semântico — o título de um seletor/diálogo — é renderizado de cinco jeitos: muted+bold dentro do card (selector-shell.ts:69, usado por theme/thinking/show-images), accent+bold dentro do card (oauth-selector.ts:63, login-dialog.ts:48, extension-selector.ts:58, settings-selector.ts:151), bold sem cor com indentação manual de 2 espaços dentro do card (tree-selector.ts:1271 `theme.bold("  Session Tree")`), bold sem cor FORA do card (user-message-selector.ts:124 "Fork from Message") e o padrão `● Título —` com ponto accent usado pelos overlays (todo-overlay.ts:120, goal-overlay.ts:94). Ao navegar entre /model, /theme, /login, árvore de sessões e fork, cada diálogo parece de um app diferente — hierarquia visual do título muda de peso e posição a cada tela.

**Sugestão.** Eleger UM padrão de título (sugestão: o `● Título` accent+bold dos overlays, que já é o mais reconhecível) e movê-lo para o SelectorShell/SelectorCard como opção padrão, fazendo oauth, login, extension, tree, user-message e settings consumirem o shell em vez de montar Text ad hoc. Onde o shell não couber, exportar um helper `selectorTitle(title)` em keybinding-hints/theme e substituir as 6 construções manuais.

**Nota do verificador.** Os 5 estilos existem exatamente como descrito (selector-shell.ts:69 muted+bold; oauth-selector.ts:63, login-dialog.ts:48, extension-selector.ts:58, settings-selector.ts:151 accent+bold; tree-selector.ts:1271 bold puro indentado; user-message-selector.ts:124 bold puro fora do card; overlays/model-selector com '● Título —'). Porém P1 exagera: todos os seletores compartilham o mesmo SelectorCard, selectionCursor e HINT_SEPARATOR, então 'cada diálogo parece de um app diferente' é hipérbole — a divergência é uma linha de título com peso/cor variando. Real, vale unificar, mas é P2.

### P2-29. Mensagens de extensão são o último bloco com o idioma antigo de fundo sólido

`packages/coding-agent/src/modes/interactive/components/custom-message.ts:319` · área: consistencia-visual · categoria: consistencia · esforço: medio

**Problema.** Todo bloco de chat migrou para o MessageShell (gutter `│` colorido de 1 coluna ou frame arredondado — user-message, assistant, tool, bash, diagnostics, compaction, branch, skill, turn-done, steer todos importam message-shell). A única exceção é o render padrão de custom-message.ts:319-326: um Box de largura total com `customMessageBg` sólido, padding 1,1 e label `[tipo]` em bold com ANSI cru (`\x1b[1m[...]\x1b[22m`). No transcript, mensagens de extensões aparecem como um bloco chapado destoando do ritmo gutter+respiro do resto — exatamente o visual que a migração do shell eliminou (o próprio doc do message-shell.ts descreve esse idioma como o problema a substituir).

**Sugestão.** Fazer o render padrão de CustomMessageComponent estender MessageShell com um gutterColor próprio (ex.: `customMessageLabel`) e o label `[tipo]` no primeiro content line — o shell já suporta exatamente esse formato de label. Renderers customizados de extensão continuam com opt-out via shellDisabled.

**Nota do verificador.** Confirmado: custom-message.ts:317-326 renderiza Box de largura total com bg 'customMessageBg' e label com ANSI cru, enquanto message-shell.ts:5-10 descreve literalmente 'solid bg rows' como o idioma que o shell substitui, e 14 componentes de bloco (user, assistant, tool, bash, diagnostics, compaction, branch, skill, turn-done, steer...) já importam message-shell — custom-message é a exceção. Atenuante que mantém em P2 e não P1: os tipos custom mais frequentes (permission-blocked, doom-loop, linhas 283-300) já usam caminhos compactos sem box, e renderers customizados de extensão contornam o default; o bloco chapado só aparece no fallback.

### P2-30. Autocomplete sem estado de loading — busca @fuzzy parece morta

`packages/tui/src/components/editor.ts:2900` · área: editor-input · categoria: feedback · esforço: medio

**Problema.** A busca de arquivos via fd (@prefix) pode levar centenas de ms em repositórios grandes e o timeout é de 4s (AUTOCOMPLETE_REQUEST_TIMEOUT_MS, editor.ts:289). Durante toda a espera nada é renderizado — nenhum spinner ou linha 'buscando…'. Pior: no timeout o request é abandonado em silêncio (editor.ts:2904-2909) e a UI simplesmente não reage, deixando o usuário sem saber se o @ falhou, se digitou errado ou se deve esperar.

**Sugestão.** Após ~150ms sem resposta, renderizar uma linha dim abaixo do editor ('  buscando arquivos…', reutilizando theme.selectList.scrollInfo, como o header do history search em editor.ts:1032-1037). No timeout, mostrar brevemente 'sem resultados' em vez de sumir sem feedback.

**Nota do verificador.** Confirmado no código: durante runAutocompleteRequest (editor.ts:2879-2951) nada é renderizado até a resposta chegar, e no timeout de 4s o request é abandonado sem qualquer feedback (editor.ts:2904-2908 — aborta e 'bail without touching the UI', literalmente comentado). Zero estado de loading em todo o fluxo. Porém P1 exagera: no caso comum fd local responde em dezenas/centenas de ms com debounce de 20ms (editor.ts:278), e o timeout silencioso de 4s é cenário raro (provider pendurado). É latência percebida real em repos grandes, mas não dor diária universal. P2.

### P2-31. Enter no menu de slash command sempre executa, mesmo para comandos que pedem argumentos

`packages/tui/src/components/editor.ts:1256` · área: editor-input · categoria: microinteracao · esforço: medio

**Problema.** No confirm do autocomplete, prefixos '/' aplicam a completion e caem direto no submit (editor.ts:1256-1263 'Fall through to submit'). Para um comando com argumentHint (ex.: '/model <nome>'), Enter na sugestão dispara o comando vazio imediatamente — execução acidental — enquanto Tab insere '/model ' e espera. A assimetria Tab-vs-Enter não é comunicada (o hint diz 'Tab/↵ apply' para ambos, select-list.ts:212-214).

**Sugestão.** Quando o item selecionado tem argumentHint (a informação já flui pelo CombinedAutocompleteProvider, autocomplete.ts:327-334), Enter deveria se comportar como Tab: inserir '/cmd ' e manter o menu de argumentos; submeter direto só comandos sem argumentos.

**Nota do verificador.** Confirmado: editor.ts:1256-1258 ('Fall through to submit') submete direto qualquer completion com prefixo '/', e o hint promete o mesmo comportamento para Tab e ↵ (select-list.ts:212-214: 'Tab/↵ apply'), sem comunicar a assimetria. Para prompt templates com $ARGUMENTS (interactive-mode.ts:760-764), Enter na sugestão dispara uma chamada real ao LLM com argumento vazio — execução acidental com custo. Ressalvas de implementação: o argumentHint hoje só flui concatenado na description como texto (autocomplete.ts:327-333), então precisa virar campo estruturado no AutocompleteItem; e comandos que têm fallback interativo sem args (ex.: /model abre seletor) não devem perder o Enter-direto — a sugestão precisa distinguir esses casos. P2 mantido.

### P2-32. Ctrl+P cicla o modelo — foot-gun direto para quem usa os bindings emacs que o editor já promete

`packages/coding-agent/src/core/keybindings.ts:72` · área: ergonomia-teclado · categoria: ergonomia-teclado · esforço: medio

**Problema.** O editor suporta deliberadamente o dialeto emacs: Ctrl+B/F (cursor), Ctrl+A/E (linha), Ctrl+D, Ctrl+K, Ctrl+U, Ctrl+W, Ctrl+Y, Alt+B/F/D (tui/keybindings.ts:63-121). Mas o par que completa o dialeto está sequestrado: Ctrl+P = app.model.cycleForward (core/keybindings.ts:72-75) e Ctrl+N não faz nada no editor (só vale no session selector). Um usuário emacs que aperta Ctrl+P esperando 'linha acima' troca silenciosamente o MODELO da sessão — mudança de estado real (o próximo turno vai para outro provedor, perde cache affinity), sinalizada apenas por um showStatus efêmero (interactive-mode.ts:4695). Meio dialeto suportado é pior que nenhum: convida a memória muscular e pune no meio dela.

**Sugestão.** Mapear Ctrl+P/Ctrl+N como cursorUp/cursorDown no editor (completando o set emacs) e mover o cycle de modelo para Alt+M ou similar; no mínimo, quando o editor tem texto multi-linha, deixar Ctrl+P mover o cursor e só ciclar modelo com editor vazio.

**Nota do verificador.** Verificado: app.model.cycleForward = ctrl+p (core/keybindings.ts:72-75) enquanto o editor suporta deliberadamente o dialeto emacs — ctrl+b/f (tui/keybindings.ts:64,68), ctrl+a/e (80,84), ctrl+d/w/u/k/y, alt+b/f/d (102-122) — mas cursorUp/cursorDown só respondem a setas (61-62). Um usuário readline/emacs que aperta Ctrl+P esperando linha-acima/histórico troca o modelo da sessão, mudança de estado real sinalizada apenas por showStatus efêmero ('Switched to …', interactive-mode.ts:4695/4709). Mitigações existem (feedback visível, Shift+Ctrl+P reverte, rebindável via keybindings.json), o que impede P1, mas meio-dialeto que pune memória muscular com mudança de estado é foot-gun genuíno de uso diário. P2 mantido.

### P2-33. Esc com ferramentas em voo abre um menu em vez de interromper — quebra a promessa "esc to interrupt"

`packages/coding-agent/src/modes/interactive/interactive-mode.ts:2707` · área: feedback-fluidez · categoria: fluidez · esforço: medio

**Problema.** O sufixo do working loader promete "· esc to interrupt" (interactive-mode.ts:1776-1778), mas quando há tools pendentes o Esc abre o overlay "Interromper o quê?" (interactive-mode.ts:2707-2722 → promptInterruptChoice em 2650) em vez de parar. O mesmo Esc às vezes interrompe na hora (streaming de texto puro) e às vezes vira um menu de 2+ opções, dependendo de estado invisível ao usuário. Interromper é a ação mais urgente da UI — o momento em que o usuário vê o agente indo na direção errada — e agora exige ler um picker, navegar e confirmar, enquanto as tools continuam rodando (a opção granular frequentemente responde "Tool already finished", 2687-2689).

**Sugestão.** Restaurar Esc = interromper imediatamente e sempre (comportamento previsível, igual ao Ctrl+C em 4283-4291). Mover o cancelamento granular de uma tool para um gesto secundário e descobrível — ex.: um segundo atalho anunciado no próprio sufixo do loader quando há tools em voo ("esc interrupt · ctrl+x cancel one tool") — ou oferecer o picker só num segundo Esc dentro de ~1s. O hint e o comportamento precisam contar a mesma história.

**Nota do verificador.** O mecanismo existe como descrito: com tools pendentes, Esc abre promptInterruptChoice (interactive-mode.ts:2707-2722) enquanto o sufixo do loader promete incondicionalmente 'esc to interrupt' (1773-1778) — o hint mente, e isso precisa ser corrigido. Mas o auditor omitiu mitigações deliberadas que reduzem a severidade: a opção 'Parar a tarefa inteira' é a default/recommended (2653), e cancelar o picker (segundo Esc) cai em stop-all via o catch em 2669-2673 — comentado como 'so Esc never gets stuck' (2648); Ctrl+C interrompe imediatamente sempre (4283-4292). O pior caso é uma tecla extra (Esc→Esc ou Esc→Enter), não uma interrupção inacessível. Rebaixado de P1 para P2: o problema real é o descompasso hint/comportamento e a imprevisibilidade por estado invisível, não a urgência bloqueada. A parte não-negociável da sugestão é fazer o hint contar a verdade; remover o picker do primeiro Esc é uma escolha de design defensável mas discutível.

### P2-34. Relógio do turno reseta silenciosamente após auto-retry e compaction — o elapsed mente

`packages/coding-agent/src/modes/interactive/interactive-mode.ts:3249` · área: feedback-fluidez · categoria: feedback · esforço: medio

**Problema.** auto_retry_start chama clearStatusContainer() (interactive-mode.ts:3753), que destrói o working loader (3944-3947). Quando a tentativa recomeça, agent_start reconstrói o loader (3249-3252) e createWorkingLoader liga setElapsedEnabled(true) (1821), que reinicia o clock do zero (loader.ts:198-203: startedAtMs = Date.now()). Resultado: o usuário que esperou 2 minutos de backoff vê "Working… 3s", e a linha de turn-done (buildTurnDoneSnapshot em 3496-3500 usa getWorkingLoaderElapsedMs) reporta uma duração menor que a espera real. O mesmo acontece quando compaction_start (3545) derruba o loader no meio do turno. Todo o cuidado com pausa do clock em asks (setElapsedPaused) é desfeito nesses dois caminhos.

**Sugestão.** Preservar a origem do elapsed através de reconstruções dentro do mesmo prompt: guardar startedAtMs no InteractiveMode (capturado no submit) e passá-lo ao Loader recriado (um setElapsedOrigin(ms)), em vez de reiniciar via setElapsedEnabled. Retry e compaction passam a contar dentro do mesmo relógio que o usuário já estava vendo.

**Nota do verificador.** Cadeia verificada ponta a ponta: auto_retry_start → clearStatusContainer() (3753) destrói o loader e zera a ref (3944-3947); compaction_start idem (3545); a reconstrução em agent_start (3249-3252) ou pending_check (3702-3706) chama createWorkingLoader → setElapsedEnabled(true) (1821) que reinicia startedAtMs = Date.now() (loader.ts:198-203). buildTurnDoneSnapshot consome getWorkingLoaderElapsedMs (3496, 3505), então a linha de conclusão reporta a duração truncada. O contraste com o cuidado de setElapsedPaused em asks (1826-1831, loader.ts:216-226) confirma que a intenção do design é um clock contínuo por turno — retry e compaction furam essa intenção. P2 adequado.

### P2-35. Linhas de atividade pendentes não mostram tempo decorrido por ferramenta

`packages/coding-agent/src/modes/interactive/components/activity-line.ts:292` · área: feedback-fluidez · categoria: feedback · esforço: medio

**Problema.** Uma activity line pendente renderiza só `<spinner> <glifo> Running <alvo>` (activity-line.ts:288-299) e o loader do bash mostra "Running… · esc to cancel" sem contador (bash-execution.ts:108-116). Um `npm test` de 90s ou um subagente de 5 minutos giram um spinner idêntico ao de uma leitura de 200ms — o usuário não distingue "demorado mas normal" de "travado" no nível da linha; o único relógio é o do turno inteiro. O comentário M0 em spinner-ticker.ts:46-47 até menciona sufixos `· Ns` computados no render, mas nenhum componente de linha os renderiza de fato.

**Sugestão.** Acrescentar um sufixo dim `· Ns` na linha pendente quando a execução ultrapassar ~3s (evita ruído nas tools rápidas), reaproveitando o tick de 1s que o spinner-ticker já emite em reduced-motion. Prioridade para bash e task/subagent, as famílias tipicamente longas.

**Nota do verificador.** Confirmado por ausência verificada: grep por elapsed/Date.now em activity-line.ts retorna vazio — a linha pendente é só '<icon> <glyph> <verb> <target>' (288-299); o loader do bash usa 'Running…' + '·esc to cancel' sem contador (bash-execution.ts:108-115). O detalhe mais convincente: o comentário M0 em spinner-ticker.ts:45-48 diz explicitamente que o tick de 1s em reduced-motion existe para sufixos '· Ns' de activity/nav/bash 'computed in render()' — a infraestrutura foi construída, mas nenhum componente renderiza o sufixo. Não é gosto pessoal: distinguir 'lento mas vivo' de 'travado' no nível da linha é feedback básico para bash/subagents longos. P2 correto.

### P2-36. Linhas longas do diff quebram por wrap e a continuação perde o gutter de números

`packages/coding-agent/src/core/tools/edit-preview-shared.ts:113` · área: ferramentas-diff · categoria: truncamento-resize · esforço: medio

**Problema.** renderDiff constrói cuidadosamente a coluna 'número sinal corpo' ('the dim number column reads as a stable left gutter', diff.ts:34-38), mas o corpo é montado num Text que faz word-wrap (edit-preview-shared.ts:113-114 → text.ts:68 wrapTextWithAnsi). Uma linha de código mais larga que o terminal quebra e a continuação começa na coluna 0, sem número nem sinal — o alinhamento vira ruído e fica ambíguo se a continuação é '+', '−' ou contexto. Em terminais estreitos (split de tmux, laptop) praticamente todo diff de TS sofre disso. Bônus: EditDiffBodyText capa linhas VISUAIS pós-wrap, então uma única linha longa consome várias unidades do cap de 40.

**Sugestão.** Nas linhas de diff, clipar horizontalmente com '…' (como já se faz nos headers via truncateToWidth) em vez de wrap, ou aplicar hanging indent nas continuações alinhado à coluna do corpo (largura do gutter + sinal), preservando a leitura colunar.

**Nota do verificador.** Confirmado: o corpo do diff (renderDiff monta 'número sinal corpo' colunar, diff.ts:34-38) é entregue a um Text (edit-preview-shared.ts:113-114 e :144) cujo render usa wrapTextWithAnsi (tui/text.ts:68) — word-wrap sem hanging indent, continuação na coluna 0 sem número nem sinal. O caminho grouped (activity-line.ts:303 exec.render) passa pelo mesmo Text. Não há mitigação em nenhum dos dois caminhos (headers usam truncateToWidth, o corpo não). O bônus também confere: EditDiffBodyText capa linhas VISUAIS pós-wrap (edit-preview-shared.ts:112-117), então linhas longas comem o cap de 40. Em larguras estreitas o gutter cuidadosamente construído vira ruído. P2 adequado.

### P2-37. Resize de largura apaga todo o scrollback do terminal, inclusive o anterior à sessão

`packages/tui/src/tui.ts:1733` · área: nucleo-render · categoria: truncamento-resize · esforço: medio

**Problema.** Qualquer mudança de largura cai em fullRender("all") (tui.ts:1778-1782), que escreve \x1b[2J\x1b[H\x1b[3J (tui.ts:1733). O \x1b[3J destrói o scrollback INTEIRO do emulador — não só o frame do Pit, mas também todo o histórico do shell que o usuário tinha antes de abrir a sessão (comandos anteriores, saídas de builds, etc.). Um simples ajuste de largura da janela vira perda irreversível de contexto do terminal do usuário. Como o Pit roda inline (o primeiro render usa clearMode "none" justamente para preservar o que está na tela, tui.ts:1771-1775), essa destruição em resize contradiz o cuidado do resto do design.

**Sugestão.** Avaliar trocar o \x1b[3J por uma reimpressão do transcript com clear apenas da tela visível: a história antiga fica 'remangled' pelo reflow do terminal, mas o histórico pré-sessão sobrevive — o mesmo trade-off que Claude Code e outros TUIs inline aceitam. No mínimo, tornar o wipe de scrollback opt-out (flag PIT_*) e documentar, dado que hoje é silencioso e surpreendente.

**Nota do verificador.** Confirmado em tui.ts:1733 + 1778-1782: \x1b[3J destrói o scrollback do emulador, incluindo histórico pré-sessão. E o problema é MAIS amplo que o descrito: por causa de tui.ts:733 (previousWidth=-1 em todo resize não-Termux), até resize só de altura termina no fullRender("all") — o comentário em tui.ts:1784-1789 ("both now preserve scrollback") não se cumpre no fluxo real de resize, só em renders intermediários. Contraste real com o cuidado do primeiro render (clearMode "none", tui.ts:1771-1775). É trade-off deliberado (evitar histórico rewrapped 'lingering', comentário tui.ts:1716-1717), mas silencioso e sem opt-out; P2 justo.

### P2-38. Linha de atalhos do /tree é uma parede densa que trunca silenciosamente

`packages/coding-agent/src/modes/interactive/components/tree-selector.ts:1281` · área: seletores-dialogos · categoria: legibilidade · esforço: medio

**Problema.** O header do tree concatena TODOS os atalhos numa única TruncatedText: "↑/↓: move. ←/→: page. …: fold/branch. …: label. 1/2/3/4/5: filters (…/… cycle). …: label time" (tree-selector.ts:1281-1290). Em 80 colunas, metade some por truncamento sem reticências visíveis do conteúdo perdido — justamente os filtros e o cycle, que são os recursos menos descobríveis. O formato "key: desc." com pontos finais também diverge do idioma keyHint + HINT_SEPARATOR (" · ") usado no resto do app (keybinding-hints.ts:42-51), e monopolizar uma linha inteira com ↑/↓ (óbvio) enquanto perde "filters" inverte a prioridade.

**Sugestão.** Reordenar por raridade (filtros e fold primeiro, ↑/↓ por último ou omitido), adotar keyHint/HINT_SEPARATOR como nos outros seletores, e considerar mover os filtros para o rodapé de status que já existe (linha 720 mostra `(i/n) [no-tools]` — há espaço ali para "1-5 filters").

**Nota do verificador.** A parede existe como descrito (tree-selector.ts:1272-1290): sete grupos de atalhos numa TruncatedText única, formato 'key: desc.' divergente do idioma keyHint + ' · ' (keybinding-hints.ts:42-51), com ↑/↓ (óbvio) primeiro e filtros (menos descobríveis) por último — em 80 colunas os filtros somem. Uma imprecisão factual: 'sem reticências visíveis' está errado — TruncatedText usa truncateToWidth com ellipsis default '…' (utils.ts:953, truncated-text.ts:67), então há indicação de corte; o que não há é indicação do QUE foi cortado. A substância (priorização invertida + idioma divergente + rodapé de status em 717-720 com espaço ocioso) se sustenta. P2 correto.

---

## P3 (36)

### P3-1. Spinner de tarefa em andamento usa cor de warning para atividade normal

`packages/coding-agent/src/modes/interactive/components/todo-overlay.ts:157` · área: chrome-status · categoria: cor-tema · esforço: pequeno

**Problema.** todo-overlay.ts:157 e :160 pintam o spinner braille do item in_progress com theme.fg("warning", spinner) (âmbar). No resto do chrome, 'trabalhando' é accent: o hint do goal usa accent para '⠏ working…' (goal-overlay.ts:69) e o Loader principal respira accent→dim com pico na lima da marca (working-palette.ts:41-57). Warning está reservado no footer para estados anormais reais (no-compact, overthink, recovery — footer.ts:685-691). Um glifo âmbar piscando numa tarefa que está simplesmente rodando lê como 'algo errado'.

**Sugestão.** Usar accent no spinner do todo (o assunto ao lado já é accent, formando um par coerente), ou reutilizar workingPulsePalette para o mesmo pulso do loader principal. Reservar warning para estados de atenção.

**Nota do verificador.** Fatos corretos: todo-overlay.ts:157/160 usam theme.fg('warning', spinner); goal usa accent para '⠏ working…' (goal-overlay.ts:69); o Loader usa workingPulsePalette accent→dim (working-palette.ts:41-57); footer reserva warning para estados anormais (footer.ts:685-691). Mas a leitura 'âmbar = algo errado' é discutível — amarelo para 'em execução' é convenção difundida (CI, GitHub Actions). Sobra uma inconsistência interna real porém de um único glifo: P3, não P2.

### P3-2. Linha de statuses de extensão junta itens só com espaço simples

`packages/coding-agent/src/modes/interactive/components/footer.ts:746` · área: chrome-status · categoria: hierarquia-visual · esforço: pequeno

**Problema.** A linha 3 do footer junta os statuses de extensão com .join(" ") (footer.ts:746 e :628). Todo o resto do footer tem gramática de separadores explícita: ` · ` dentro de grupo e `  •  ` entre grupos (footer.ts:695-708), e os hints usam HINT_SEPARATOR ' · ' (keybinding-hints.ts:51). Com duas ou mais extensões ativas, textos como 'mcp: 3 ready vim: insert' viram uma corrida contínua de palavras dim sem fronteira visual entre statuses.

**Sugestão.** Usar o mesmo ` · ` (ou `  •  ` entre statuses de extensões distintas) que o resto do footer já usa, mantendo a linha na mesma gramática visual das linhas 1-2.

**Nota do verificador.** O código confere: .join(' ') em footer.ts:628 e :746, contra a gramática explícita ` · `/`  •  ` das linhas 1-2 (footer.ts:696-708) e HINT_SEPARATOR (keybinding-hints.ts:51). Porém a linha 3 só existe em footerDensity=full — o default é 'calm' (settings-manager.ts:1562, footer.ts:181), que esconde os statuses atrás do chip '+N' (footer.ts:704-707). Manifesta apenas com opt-in explícito E 2+ extensões com status: rebaixado de P2 para P3.

### P3-3. Status efêmero de warning depende só de cor (erro ganha ✗, warning não ganha nada)

`packages/coding-agent/src/modes/interactive/interactive-mode.ts:3914` · área: chrome-status · categoria: feedback · esforço: pequeno

**Problema.** paintEphemeralStatus prefixa erros com '✗' (interactive-mode.ts:3911-3913), mas o ramo de warning (interactive-mode.ts:3914-3916) só troca a cor. Como info também é uma linha colorida sem glifo, warning e info se distinguem apenas pelo matiz âmbar vs. custom/dim — canal único de cor, frágil em temas claros de baixo contraste e para daltônicos. O próprio footer já resolve isso com '⚠' textual ('⚠ compact soon', footer.ts:715; '⚠ NO-RAILS', footer.ts:731).

**Sugestão.** Prefixar warnings com '⚠ ' (mesmo glifo já usado no footer), mantendo o padrão glifo+cor por severidade: nada/dim para info, ⚠ warning, ✗ error.

**Nota do verificador.** Confirmado em interactive-mode.ts:3909-3916: o ramo error prefixa '✗ ', o ramo warning só troca a cor — warning e info se distinguem apenas por matiz. O próprio footer já estabelece o par glifo+cor com '⚠' (footer.ts:715 e :731), então a sugestão é coerente com o sistema existente. Frequência baixa e correção trivial: P3 mantida.

### P3-4. Checkbox ☑/☐ assume largura 1, mas é ambiguous-width e não tem fallback

`packages/coding-agent/src/modes/interactive/components/keybinding-hints.ts:73` · área: chrome-status · categoria: truncamento-resize · esforço: pequeno

**Problema.** checkboxGlyph (keybinding-hints.ts:73-75) documenta 'Both are width-1', mas U+2611/U+2610 são East Asian Ambiguous — em Windows Terminal com fontes/locales comuns e em terminais com ambiguous=wide eles ocupam 2 células, desalinhando as colunas de toda lista multi-select (o glifo marcado e o desmarcado podem inclusive divergir entre si). Diferente do gauge, que tem rota de fallback via PIT_ASCII_GAUGE/TERM=dumb (gauge-glyphs.ts:14-19), o checkbox não tem saída quando renderiza largo ou como tofu.

**Sugestão.** Adotar o mesmo padrão do gauge: um resolveCheckboxGlyphs() com fallback narrow-safe (ex.: '[x]'/'[ ]' ou '◉'/'○') sob o mesmo flag/TERM=dumb, mantendo a fonte única de glifo para todos os selectors.

**Nota do verificador.** Confirmado: keybinding-hints.ts:68-75 documenta 'Both are width-1', mas U+2610/U+2611 são de fato East Asian Ambiguous — em terminais com ambiguous=wide ocupam 2 células e desalinham as colunas dos selectors multi-select. Diferente do gauge (gauge-glyphs.ts:14-19), não existe rota de escape. Cenário condicional (locale/fonte/config específicos), então P3 está calibrado — mas o achado é factual, não especulativo.

### P3-5. Hints de teclado do SettingsList são hardcoded e ignoram rebinds, ao contrário do SelectList

`packages/tui/src/components/settings-list.ts:270` · área: componentes-base · categoria: consistencia · esforço: pequeno

**Problema.** O SelectList constrói seu hint via getKeybindings()/keyHintLabel, refletindo overrides do usuário e usando glifos compactos ('Tab/↵ apply · ↑↓ navigate · Esc close', select-list.ts:211-218). O SettingsList hardcoda 'Enter/Space to change · Esc to cancel' (settings-list.ts:270-279): se o usuário rebindar confirm/cancel o hint passa a mentir, e a copy diverge em estilo ('apply/close' vs 'to change/to cancel', '↵' vs 'Enter') entre dois componentes que aparecem nos mesmos fluxos de configuração — a interface fala duas línguas.

**Sugestão.** Reaproveitar keyHintLabel/prettyKeyId (exportá-los de select-list.ts ou movê-los para um módulo compartilhado de hints) no addHintLine do SettingsList, e unificar a copy no formato curto com '·' já usado pelo SelectList.

**Nota do verificador.** Confirmado dos dois lados: SelectList monta o hint rebind-aware via keyHintLabel/prettyKeyId (select-list.ts:15-48, :211-218, formato 'Tab/↵ apply · ↑↓ navigate · Esc close'), enquanto SettingsList hardcoda 'Enter/Space to change · Esc to cancel' (settings-list.ts:268-280). E o input do SettingsList usa os bindings reais `tui.select.confirm`/`tui.select.cancel` (:216-219), então com rebind o hint passa a mentir de fato. A divergência de copy entre componentes vizinhos é real. P3 adequado — rebind é raro e o fix é pequeno.

### P3-6. Bullets de lista usam hífen cru '- ' em todos os níveis de aninhamento

`packages/tui/src/components/markdown.ts:1240` · área: componentes-base · categoria: legibilidade · esforço: pequeno

**Problema.** renderList emite `"- "` literal para toda lista não-ordenada (markdown.ts:1240), em qualquer profundidade. O hífen é o glifo da fonte markdown, não de UI renderizada — destoa do vocabulário visual do resto da interface (cantos arredondados ╭╮, setas →, goteiras │) — e níveis aninhados só se distinguem pela indentação de 4 espaços (markdown.ts:1234), sem variação de marcador, o que dificulta ler a estrutura de listas profundas que os modelos produzem o tempo todo.

**Sugestão.** Trocar para marcadores de UI variando por profundidade (ex.: '• ' no nível 0, '◦ ' no 1, '· ' no 2+), já que theme.listBullet (theme.ts:1347) colore o marcador de qualquer forma. Mantém a mesma largura de 2 células, então a matemática de continuationPrefix não muda.

**Nota do verificador.** Confirmado: markdown.ts:1240 emite `"- "` literal para toda lista não-ordenada em qualquer profundidade, e níveis aninhados se distinguem só pelos 4 espaços de indent (:1234). theme.listBullet já colore o marcador (theme.ts:1347), e '• '/'◦ ' mantêm as 2 células, então a matemática do continuationPrefix (:1244) não muda — a sugestão é tecnicamente segura. A parte 'hífen destoa do vocabulário visual' é meio gosto, mas a variação de marcador por profundidade tem ganho de legibilidade objetivo em listas aninhadas (convenção de rich/glow). P3 correto como polish menor.

### P3-7. Três gramáticas e duas capitalizações para a mesma linha de dicas de tecla

`packages/tui/src/components/settings-list.ts:274` · área: consistencia-visual · categoria: descobribilidade · esforço: pequeno

**Problema.** A linha de hints no rodapé de listas tem três redações concorrentes: settings-list.ts:274-275 "Type to search · Enter/Space to change · Esc to cancel" (verbo com "to", tecla capitalizada), cheatsheet.ts:95 "Esc to close", select-list.ts:214 "Tab/↵ apply · ↑↓ navigate · Esc close" (verbo direto, "Esc" capitalizado via prettyKeyId), e os componentes do coding-agent que usam keyText() de keybinding-hints.ts:34 exibem teclas em minúsculas — ask-picker.ts:474 mostra "esc back". O usuário vê "Esc to cancel", "Esc close" e "esc back" em telas consecutivas, o que enfraquece o reconhecimento do padrão e faz a UI parecer escrita por três mãos.

**Sugestão.** Adotar a gramática canônica já definida em keybinding-hints (tecla + verbo direto, ex.: "esc close") e uma única capitalização; reescrever as strings literais de settings-list e cheatsheet no @pit/tui para o mesmo formato (ou injetar os labels via tema, como o SelectList já faz com keyHintLabel).

**Nota do verificador.** As quatro strings existem como citadas: settings-list.ts:274-275 'Esc to cancel' (verbo com to), cheatsheet.ts:95 'Esc to close', select-list.ts:214 'Esc close' (verbo direto, capitalizado via keyHintLabel), e ask-picker.ts:474 'esc back' (minúsculo via keyText de keybinding-hints.ts:34). Inconsistência real espalhada entre @pit/tui e coding-agent. Mas P2 superestima: as teclas continuam visíveis e compreensíveis em todos os formatos — a descobribilidade não é prejudicada, é polimento de microcopy. P3, effort pequeno, vale fazer.

### P3-8. Só o session-selector pinta a borda do card em accent

`packages/coding-agent/src/modes/interactive/components/session-selector.ts:850` · área: consistencia-visual · categoria: cor-tema · esforço: pequeno

**Problema.** SelectorCard define `cardBorder` como cor padrão de borda (selector-card.ts:13) e é isso que config-selector, oauth, login, extension, model, tree, settings e fusion usam. session-selector.ts:850 é o único que sobrescreve: `new SelectorCard(1, 0, (s) => theme.fg("accent", s))`. Ao abrir /resume, o card inteiro acende em accent enquanto todos os outros seletores têm moldura discreta — sem nenhuma razão semântica (não é um estado de alerta), quebrando a linguagem de que accent marca seleção/foco pontual, não chrome.

**Sugestão.** Remover o override e usar o construtor padrão `new SelectorCard()` como os demais seletores; se a intenção era dar destaque ao seletor de sessões, aplicar accent apenas no título, seguindo o padrão de título unificado.

**Nota do verificador.** Confirmado: session-selector.ts:850 é o único call site que passa borderColor accent ao SelectorCard, cujo default é cardBorder (selector-card.ts:13); nenhum comentário no código justifica o destaque, e todos os demais seletores usam o construtor padrão. Rebaixado de P2 para P3: é uma divergência pontual de cor de moldura vista só ao abrir /resume, sem custo de legibilidade — fix de uma linha, impacto pequeno.

### P3-9. Header do welcome-box quebra o padrão "● Título — detalhe"

`packages/coding-agent/src/modes/interactive/components/welcome-box.ts:122` · área: consistencia-visual · categoria: consistencia · esforço: pequeno

**Problema.** O padrão de cabeçalho de seção é `● Título — detalhe` com travessão dim: context-display.ts:45, goal-overlay.ts:94, todo-overlay.ts:120 e model-selector.ts:199. O welcome-box — a primeira coisa que o usuário vê em toda sessão — usa `● Workspace ·` com middle dot (welcome-box.ts:122), contradizendo inclusive o próprio docstring da função na linha 106, que documenta `● Workspace — PiTest/src (main)`. Como o mesmo `·` também é usado como separador de itens dentro da linha (`· shell: ~/pit`, linha 120), o delimitador título/conteúdo fica idêntico ao separador de itens.

**Sugestão.** Trocar o `·` da linha 122 por `—` dim, alinhando com os outros quatro headers e com o docstring; o `·` interno entre workspace e shell note permanece como separador de itens.

**Nota do verificador.** Confirmado com evidência forte: welcome-box.ts:122 usa '·' como delimitador do header enquanto o docstring da própria função (linha 106) documenta '● Workspace — PiTest/src (main)', e o mesmo '·' já serve de separador de itens na linha 120 ('· shell: ...') — o código contradiz a própria intenção documentada e os quatro headers irmãos (context-display, goal-overlay, todo-overlay, model-selector) usam '—' dim. P3 correto: troca de um caractere.

### P3-10. Tabelas Markdown com cantos retos num sistema todo de cantos arredondados

`packages/tui/src/components/markdown.ts:1497` · área: consistencia-visual · categoria: consistencia · esforço: pequeno

**Problema.** Toda moldura da UI é arredondada: Card (card.ts:85 `╭─╮`), editor (editor.ts:884), frames de tool no MessageShell e até os code blocks do próprio markdown.ts:953/1005 (`╭…╮`/`╰…╯`). As tabelas Markdown são a exceção: markdown.ts:1497 e 1541 desenham `┌─┬─┐` e `└─┴─┘`. Dentro de UMA mesma resposta do assistente, um code block sai arredondado e a tabela logo abaixo sai quadrada — a divergência fica lado a lado na tela.

**Sugestão.** Usar cantos arredondados nas tabelas mantendo as junções em T (`╭─┬─╮` no topo, `╰─┴─╯` na base) — combinação válida de box-drawing que preserva as colunas e unifica o idioma de moldura.

**Nota do verificador.** Confirmado: markdown.ts:1497 desenha '┌─┬─┐' e :1541 '└─┴─┘', enquanto os code blocks do MESMO arquivo (953/1005) usam '╭╮'/'╰╯', assim como Card e os frames do MessageShell — a divergência aparece lado a lado dentro de uma mesma resposta do assistente. A sugestão ('╭─┬─╮'/'╰─┴─╯') é box-drawing válido que preserva as junções de coluna. P3 adequado.

### P3-11. Indicador de scroll do ask-picker em dim, contra o muted canônico

`packages/coding-agent/src/modes/interactive/components/ask-picker.ts:389` · área: consistencia-visual · categoria: cor-tema · esforço: pequeno

**Problema.** O hint de posição `↑↓ (i/n)` tem cor canônica muted: keybinding-hints.ts:117 (`themedScrollPositionHint` — "Muted themed scroll hint") e o SelectList via scrollInfo→muted (theme.ts:1379). O ask-picker reimplementa a mesma linha localmente e pinta em dim (ask-picker.ts:385-389), um degrau mais apagado. Em temas claros a diferença dim/muted é visível; o mesmo indicador tem legibilidade diferente conforme o widget — justo no ask-picker, onde o usuário precisa perceber que há mais opções fora da janela.

**Sugestão.** Substituir o bloco local das linhas 385-390 por `themedScrollPositionHint(...)` de keybinding-hints, que já produz o mesmo texto com a cor canônica e elimina a duplicação.

**Nota do verificador.** Confirmado: ask-picker.ts:385-390 reimplementa o hint '↑↓ (i/n)' localmente e pinta em dim, enquanto o canônico themedScrollPositionHint (keybinding-hints.ts:104-118) usa muted, igual ao SelectList via scrollInfo→muted (theme.ts:1379) — o mesmo indicador tem dois níveis de contraste conforme o widget. A substituição é viável: o helper já aceita displayCurrent/displayTotal para cobrir o rowCount do ask-picker (que inclui a linha freeform). P3 correto.

### P3-12. Navegação de histórico (↑/↓) totalmente silenciosa — sem indicador de posição

`packages/tui/src/components/editor.ts:710` · área: editor-input · categoria: descobribilidade · esforço: pequeno

**Problema.** navigateHistory (editor.ts:710-730) troca o buffer inteiro sem nenhum sinal visual de que se está navegando histórico: não há contador ('3/42'), nem mudança na régua, nem distinção entre 'texto que eu digitei' e 'prompt recuperado'. O usuário que aperta ↑ sem querer num editor vazio não entende de onde veio o texto, e quem navega fundo não sabe quantos itens restam. O editor já tem o mecanismo perfeito: a régua superior mostra cue efêmero para jump mode (editor.ts:878-889).

**Sugestão.** Quando historyIndex > -1, renderizar a régua superior como '─── history 3/42 ' (mesmo padrão do jump-mode cue), desaparecendo ao voltar a -1 ou editar. Custo visual zero quando não usado.

**Nota do verificador.** Confirmado: navigateHistory (editor.ts:710-730) troca o buffer sem sinal visual algum, e o mecanismo de cue efêmero na régua já existe para jump mode (editor.ts:878-889), tornando a sugestão barata e consistente. Mas P2 superestima: nenhum shell (bash, zsh, fish) mostra contador de histórico e o modelo mental ↑=histórico é universal em CLI — o cenário 'não entende de onde veio o texto' é marginal. Melhoria legítima de polish com custo visual zero, mas não muda a experiência diária. P3.

### P3-13. Popup de autocomplete some abruptamente quando o filtro zera os resultados

`packages/tui/src/components/editor.ts:2918` · área: editor-input · categoria: estados-vazios-erro · esforço: pequeno

**Problema.** Quando o provider retorna 0 items, o editor cancela o popup inteiro (editor.ts:2918-2922) em vez de mostrar estado vazio. Um typo no meio de '/che' → '/chx' faz a lista desaparecer sem explicação; o usuário não sabe se o menu quebrou ou se não há matches, e a re-abertura no backspace (editor.ts:1907-1921) causa um pisca-pisca de layout (linhas do popup somem e voltam, empurrando o footer). O SelectList já suporta exatamente isso: renderiza '  No matches' via emptyText (select-list.ts:157-159), mas esse caminho nunca é alcançado.

**Sugestão.** Enquanto autocompleteState estiver ativo e o resultado for vazio, manter o popup com a linha 'No matches' (uma linha, mesmo estilo noMatch) por pelo menos aquele ciclo, fechando só em Esc ou ao sair do contexto de completion — estabiliza o layout e explica o vazio.

**Nota do verificador.** Confirmado no código: 0 items cancela o popup inteiro (editor.ts:2918-2922), o backspace re-triga causando o vai-e-vem de linhas (editor.ts:1907-1921 — o próprio código evidencia que o design espera continuidade), e o caminho emptyText/'No matches' do SelectList (select-list.ts:157-159) nunca é alcançado pelo autocomplete. Mas rebaixo a P3: fechar o dropdown em zero-matches é o padrão de VS Code, fish e zsh — não é um erro de design, é convenção; o ganho real da sugestão se limita a evitar o layout-shift ao corrigir um typo, cenário situacional. E manter o popup aberto 'até Esc' cria o problema inverso (popup fantasma persistente). Vale como polish opcional.

### P3-14. Placeholder trunca sem reticências no Editor (Input usa '…') e glifo '⌕' de baixa cobertura

`packages/tui/src/components/editor.ts:942` · área: editor-input · categoria: consistencia · esforço: pequeno

**Problema.** Em terminal estreito, o placeholder do Editor é cortado seco: truncateToWidth(this.placeholder!, hintBudget) sem sufixo (editor.ts:942), enquanto o Input passa '…' (input.ts:485) — o mesmo hint aparece 'Describe a ta' num e 'Describe a…' no outro. Além disso, o header do history search usa o glifo '⌕' (editor.ts:1033), U+2315, com cobertura fraca nas fontes padrão do Windows (Consolas/Cascadia) — tende a virar tofu justamente na plataforma-alvo do repo.

**Sugestão.** Passar '…' como terceiro argumento do truncateToWidth do placeholder do Editor, e trocar '⌕' por um rótulo ASCII/NerdFont-safe ('history:' ou '(reverse-i-search)') no header do Ctrl+R.

**Nota do verificador.** Ambos os fatos conferem exatamente como descritos: editor.ts:942 chama truncateToWidth sem sufixo enquanto input.ts:485 passa '…' para o mesmo tipo de placeholder — inconsistência real entre componentes irmãos; e editor.ts:1033 usa '⌕' (U+2315), glifo com cobertura fraca em Consolas — risco plausível de tofu no Windows, plataforma primária do repo (curiosamente a própria linha 1033 já usa '…' como sufixo de truncamento, reforçando a inconsistência da 942). Impacto pequeno (só terminal estreito / fonte sem o glifo), correção trivial. P3 correto.

### P3-15. SelectorShell não mostra nenhum hint — e o Esc em dois passos (limpa filtro, depois fecha) é invisível

`packages/coding-agent/src/modes/interactive/components/selector-shell.ts:91` · área: ergonomia-teclado · categoria: consistencia · esforço: pequeno

**Problema.** Os seletores baseados em SelectorShell (theme, thinking, show-images) não têm rodapé de hints por decisão explícita (selector-shell.ts:10 'No key-hint footer'), enquanto ask-picker (ask-picker.ts:476-485, formato canônico 'navigate · enter select · esc close'), settings ('enter select · esc back', settings-selector.ts:194), session e tree mostram hints. Além disso, o Esc é dois-passos quando há filtro digitado (selector-shell.ts:93-101): o primeiro Esc limpa o filtro em vez de fechar, sem nenhum feedback do porquê — o usuário vê a lista 'voltar' e o seletor continuar aberto, parecendo que o Esc falhou. O mesmo padrão existe no tree (1008-1013) e session, igualmente sem sinalização.

**Sugestão.** Adotar em todos os seletores a mesma linha canônica do ask-picker; quando há filtro ativo, trocar o rótulo para 'esc clear · esc esc close' para que o dois-passos deixe de ser um mistério.

**Nota do verificador.** Verificado: selector-shell.ts:10 documenta 'No key-hint footer' como decisão deliberada (pós de-clutter), e o Esc dois-passos existe em 93-101 sem qualquer sinalização — o mesmo padrão no tree selector (tree-selector.ts:1005-1013). O contraste com o ask-picker (ask-picker.ts:476-485) e o session selector (hint line consolidada) é real. Ressalva que mantém em P3: a ausência de footer foi escolha consciente de design contra ruído visual, então metade da sugestão briga com uma decisão documentada; a parte genuinamente valiosa é sinalizar o dois-passos do Esc quando há filtro digitado (o 'Esc parece ter falhado' é confusão real, mas rara e de baixo custo).

### P3-16. Ações sem tecla default (steer, tree, fork, resume, new) são invisíveis em todas as superfícies de ajuda

`packages/tui/src/components/cheatsheet.ts:66` · área: ergonomia-teclado · categoria: descobribilidade · esforço: pequeno

**Problema.** app.message.steer, app.session.new/tree/fork/resume têm defaultKeys [] (core/keybindings.ts:100, 111-114) — são rebindáveis via keybindings.json, mas o cheatsheet pula qualquer binding sem tecla (cheatsheet.ts:66 'if (keyList.length === 0) continue;') e o /hotkeys também não os menciona. O usuário não tem como descobrir que essas ações existem como keybindings personalizáveis; a existência do próprio keybindings.json só é descobrível lendo código ou docs.

**Sugestão.** No cheatsheet, listar bindings sem tecla numa seção final 'Unbound (configure in ~/.pit/agent/keybindings.json)' em dim — uma linha de custo, e o mecanismo de customização inteiro passa a ser autodescobrível.

**Nota do verificador.** Verificado: defaultKeys [] em core/keybindings.ts:100 (steer) e 111-114 (new/tree/fork/resume); o cheatsheet pula bindings sem tecla (cheatsheet.ts:62 'if (keyList.length === 0) continue;') e o /hotkeys (7005-7051) não menciona nem as ações nem a existência de keybindings.json. Mitigação que impede subir a severidade: as ações em si são alcançáveis por outras vias descobríveis — /new, /steer e /resume são slash commands listados no /help (core/slash-commands.ts:42-45) e a tree abre via duplo-Esc default — então o que fica invisível é só a rebindabilidade e o próprio mecanismo do keybindings.json. P3 correto; a sugestão de uma seção 'Unbound' em dim é barata e proporcional.

### P3-17. Troca de modelo por fallback aparece como "[fallback] a -> b" cru + countdown "in 0s" sem espera real

`packages/coding-agent/src/modes/interactive/interactive-mode.ts:3796` · área: feedback-fluidez · categoria: consistencia · esforço: pequeno

**Problema.** O momento mais delicado de um turno com falha — trocar de modelo pela fallback chain — usa duas vozes destoantes: o transcript recebe o texto cru `[fallback] ${from} -> ${to}: ${reason}` (interactive-mode.ts:3794-3797), com tag entre colchetes e seta ASCII, fora da linguagem visual do resto da UI (✓/✗, separador ·, glifos width-1); e o retry emite delayMs:0 (agent-session.ts:6158), fazendo o loader mostrar "Retrying (1/4) in 0s… (esc to cancel)" — um countdown de zero segundos oferecendo cancelar uma espera que não existe (e o CountdownTimer chega a tickar "-1s" se a ativação demorar, countdown-timer.ts:21-29, sem clamp).

**Sugestão.** Para delayMs === 0, trocar a mensagem por algo direto sem countdown: "<Motivo> — switching to <modelo>…"; clampar remainingSeconds em 0 no CountdownTimer. Reformatar a linha de fallback no idiom da casa: "↪ fallback · gpt-5 → sonnet-4.5 · rate limited" em warning, alinhada aos demais marcadores do transcript.

**Nota do verificador.** Tudo verificado: fallback_warning injeta `[fallback] ${from} -> ${to}: ${reason}` cru no transcript (3794-3797), fora do idiom de glifos/separadores do resto da UI; o caminho de fallback emite delayMs:0 (agent-session.ts:6158) fazendo retryMessage renderizar 'Retrying (1/4) in 0s… (esc to cancel)' (3760-3766) — countdown de zero oferecendo cancelar espera inexistente; e o CountdownTimer decrementa e chama onTick(-1) ANTES do check de expiração (countdown-timer.ts:21-29), então '-1s' pode aparecer por um tick se _activateFallbackEntry (await em 6176) demorar mais de 1s. É raro (só dispara na fallback chain) e cosmético, então P3 é a severidade certa; a sugestão (mensagem sem countdown para delayMs===0 + clamp) é proporcional.

### P3-18. Dois dialetos de trailer de colapso convivem — e justamente nas ferramentas mais usadas

`packages/coding-agent/src/modes/interactive/components/tool-activity.ts:56` · área: ferramentas-diff · categoria: consistencia · esforço: pequeno

**Problema.** moreLinesTrailer (tool-activity.ts:55-57) se declara 'One format across every collapse site' ('… +N more lines (ctrl+o to expand)'), mas os renderers das ferramentas de uso diário mantêm o formato antigo '... (N more lines, ctrl+o to expand)': read.ts:644, grep.ts:362, find.ts:253, ls.ts:126, symbol.ts:346, bash.ts:980. Numa mesma tela o usuário vê os dois formatos lado a lado (um edit e um grep no mesmo turno). Detalhe adicional: no formato canônico os parênteses ficam SEM cor (tool-activity.ts:56 — '(' e ')' no fg default, mais claros que o conteúdo muted/dim entre eles), enquanto bash-command-row.ts:130 pinta os parênteses de muted explicitamente.

**Sugestão.** Migrar read/grep/find/ls/symbol/bash para moreLinesTrailer (a função já existe e é exportada) e incluir os parênteses dentro do styling muted em moreLinesTrailer para o trailer inteiro ler como uma unidade discreta.

**Nota do verificador.** Confirmado byte a byte: formato antigo '... (N more lines, ctrl+o to expand)' em read.ts:644, grep.ts:362, find.ts:253, ls.ts:126, symbol.ts:346, bash.ts:980; canônico moreLinesTrailer em ast-edit.ts:193, ast-grep.ts:171, render-utils.ts:207 e nos caps — migração declaradamente incompleta (docstring 'One format across every collapse site', tool-activity.ts:46-53). Detalhe dos parênteses também confere: tool-activity.ts:56 deixa '(' e ')' no fg default vs bash-command-row.ts:130 que os pinta de muted. Rebaixado a P3: os dois formatos transmitem a mesma informação com quase as mesmas palavras; é inconsistência cosmética de polish, não atrito funcional diário.

### P3-19. Preview do bash mostra o FIM do output mas o trailer diz '+N more lines'

`packages/coding-agent/src/modes/interactive/components/bash-execution.ts:213` · área: ferramentas-diff · categoria: feedback · esforço: pequeno

**Problema.** A preview colapsada do `!` bash mostra as ÚLTIMAS 20 linhas (bash-execution.ts:299,305 — slice(-PREVIEW_LINES)), mas buildStatusText usa moreLinesTrailer com o noun default 'more lines' (linha 213), exibido ABAIXO do output — sugerindo que há mais linhas depois, quando as ocultas são anteriores. O próprio codebase já resolveu essa semântica em dois lugares: bash.ts:903 escreve '(N earlier lines, …)' e clampBashCommandRow usa o noun 'earlier lines' (bash-command-row.ts:128). Só este site ficou com a direção errada.

**Sugestão.** Passar 'earlier lines' como noun em bash-execution.ts:213 (moreLinesTrailer já aceita o parâmetro) e, idealmente, posicionar esse trailer ANTES do output, como faz o header do bash do agente.

**Nota do verificador.** Confirmado: preview usa slice(-PREVIEW_LINES) (bash-execution.ts:299 e :305 — últimas linhas; as ocultas são anteriores), mas buildStatusText chama moreLinesTrailer com o noun default 'more lines' (linha 213), e o statusText é anexado DEPOIS do preview no container (rebuildDisplayContent, linhas 255 e 262-265) — semanticamente aponta para a direção errada. O próprio codebase já usa 'earlier lines' nos sites equivalentes (bash-command-row.ts:128, bash.ts:903), então é um site esquecido, e moreLinesTrailer já aceita o noun como parâmetro. P3 correto: incongruência sutil, fix de uma linha.

### P3-20. Glifos de sistema com cobertura de fonte frágil (⑂, ◷, ◈)

`packages/coding-agent/src/modes/interactive/components/system-message-glyphs.ts:3` · área: mensagens-chat · categoria: legibilidade · esforço: pequeno

**Problema.** Os labels de sistema usam "⑂" (U+2442 OCR FORK) para Branch, "◷" (U+25F7) para Queued e "◈" (U+25C8) para Overthink/TTSR (system-message-glyphs.ts:3-12). U+2442 é um caractere do bloco OCR com cobertura raríssima em fontes monospace — em Consolas e várias fontes populares de terminal vira tofu (□) ou é emprestado de fallback com largura errada, desalinhando a coluna do label. Como esses glifos são a assinatura visual das mensagens de sistema, um tofu no lugar corrói a identidade do design justamente onde ele quer ser reconhecível.

**Sugestão.** Trocar pelos equivalentes de cobertura ampla: Branch → "⎇" também é arriscado, prefira "⌥"-não — use glifos do bloco geométrico/setas já provados no resto do app: Branch → "⤴" ou simplesmente "⑂"→"↳"; Queued → "…"/"·" ou "◌"; Overthink → "◆" já usado. Alternativa: manter o desenho atual mas validar cada glifo contra Cascadia Mono/Consolas/DejaVu e documentar o conjunto aprovado num único módulo (que já existe — só falta a triagem).

**Nota do verificador.** Os glifos existem como descrito (system-message-glyphs.ts:3-12) e U+2442 (⑂, bloco OCR) é de fato raríssimo em fontes monospace — risco real de tofu ou fallback com largura errada. Mas rebaixo para P3: (1) ◈ U+25C8 e ◷ U+25F7 são do bloco Geometric Shapes, com cobertura bem melhor que o auditor sugere — o caso forte é só o ⑂; (2) Branch e Queued são mensagens de baixa frequência, não experiência diária; (3) terminais modernos (Windows Terminal, iTerm, Kitty) fazem font-fallback para Segoe UI Symbol/equivalentes, então tofu literal é o pior caso, não o típico. A própria sugestão do achado é confusa e autocontraditória ('⎇ também é arriscado, prefira ⌥-não'), sinal de que nem o auditor tem substituto claro. Vale a triagem do ⑂, mas é polish, não P2.

### P3-21. Três idiomas diferentes de linha compacta de sistema desalinham a borda esquerda

`packages/coding-agent/src/modes/interactive/components/custom-message.ts:160` · área: mensagens-chat · categoria: espacamento-layout · esforço: pequeno

**Problema.** As "asides" compactas de sistema usam três alinhamentos distintos: fusion indenta com dois espaços literais antes dos badges (custom-message.ts:160 e 191: `  ${badges}...`), mcp.notice/permission-blocked/doom-loop usam prefixo `◦ ` na coluna 0 (linhas 276, 284, 295), e as demais mensagens de sistema usam o gutter `│ ` do MessageShell. No transcript real isso produz uma borda esquerda serrilhada — conteúdo começando nas colunas 0, 2 e 2-com-glifos-diferentes — quebrando o ritmo vertical que o gutter unificado de 2 colunas tenta estabelecer.

**Sugestão.** Padronizar todas as linhas compactas num único prefixo de 2 colunas alinhado a SHELL_GUTTER_COLS: `◦ ` (muted/warning conforme severidade) para asides, e os badges de fusion começando após esse mesmo prefixo. Uma helper `compactSystemLine(glyph, text, color)` centralizaria o idioma.

**Nota do verificador.** Verificado com uma correção: os três idiomas existem (fusion-summary com dois espaços literais em custom-message.ts:160/191; `◦ ` em 276, 284 e via formatDoomLoopCompactLine:64; gutter `│ ` nos MessageShell), mas o desalinhamento de CONTEÚDO é menor que o descrito — `  badges`, `◦ texto` e `│ texto` todos começam o conteúdo na coluna 2. O caso genuíno de coluna 0 é a fusion-flow timeline (custom-message.ts:266-267, TruncatedText sem prefixo nenhum). Ou seja: o problema real é a inconsistência de MARCADOR (nada vs ◦ vs │) mais um único idioma em col 0, não uma borda 'serrilhada' generalizada. Ainda assim é inconsistência legítima num transcript que investiu num gutter unificado; a helper sugerida é razoável. P3 correta.

### P3-22. Debounce de resize só no trailing deixa 70ms+ de frame corrompido durante o drag

`packages/tui/src/terminal.ts:145` · área: nucleo-render · categoria: fluidez · esforço: pequeno

**Problema.** O listener de resize (terminal.ts:145-155) usa debounce puramente trailing de 70ms (TERMINAL_RESIZE_DEBOUNCE_MS, terminal.ts:18): durante um drag contínuo NENHUM repaint acontece até o usuário parar. Enquanto isso, o emulador refaz o reflow do buffer antigo e o frame aparece rasgado/duplicado (o próprio comentário em tui.ts:727-733 descreve a duplicação progressiva). O usuário vê a UI 'quebrar' visivelmente durante todo o drag e só se recompor ao soltar.

**Sugestão.** Adotar debounce leading+trailing: disparar um repaint imediato no primeiro evento da rajada (a tela corrige logo no início do drag) e manter o trailing de 70ms para o frame final. Opcionalmente um repaint intermediário a cada ~150ms durante drags longos, para o frame nunca ficar visivelmente rasgado por mais que um instante.

**Nota do verificador.** O mecanismo é real (terminal.ts:145-153, timer resetado a cada evento — nenhum repaint via handler durante o drag). Mas o achado exagera: com spinner/streaming ativo (o caso comum de uso), o loop de render lê terminal.columns/rows direto a cada frame (tui.ts:1679-1680) e repinta durante o drag; o buraco existe só em UI ociosa, dura apenas o drag e se autocorrige 70ms após soltar. Além disso, repaint leading corrige só o primeiro instante de um drag contínuo — o valor real está no repaint periódico. Melhoria válida e barata, mas polish, não dor diária: P3.

### P3-23. Cursor de hardware reposicionado fora do bracket de synchronized output

`packages/tui/src/tui.ts:2052` · área: nucleo-render · categoria: microinteracao · esforço: pequeno

**Problema.** O frame diferencial fecha o bracket DEC 2026 em tui.ts:1999 (\x1b[?2026l) e só DEPOIS chama positionHardwareCursor (tui.ts:2052), que escreve os movimentos de cursor e o show/hide em writes separados (tui.ts:2077-2095). Com PIT_HARDWARE_CURSOR=1 (necessário para IME), o terminal pode apresentar um frame intermediário em que o cursor visível está no fim do conteúdo renderizado antes de saltar para a posição do editor — cursor 'pulando' a cada tick de streaming/digitação. Além disso, hideCursor()/showCursor() são escritos incondicionalmente todo frame (tui.ts:2091-2095), mesmo sem mudança de estado.

**Sugestão.** Incluir os escapes de posicionamento e visibilidade do cursor dentro do buffer do frame, antes do \x1b[?2026l, e só emitir \x1b[?25h/\x1b[?25l quando o estado de visibilidade realmente mudar (guardar o último estado enviado).

**Nota do verificador.** Factualmente correto: \x1b[?2026l fecha em tui.ts:1999 (e 1744 no fullRender), positionHardwareCursor escreve depois em writes separados (tui.ts:2052/1755, 2086-2088) com show/hide incondicional todo frame (2091-2095). Porém o efeito visível (cursor pulando) só existe com hardware cursor LIGADO, que é opt-in (env PIT_HARDWARE_CURSOR=1 ou setting showHardwareCursor, default false); no default o hideCursor() redundante é invisível. Correção barata e correta, mas impacto restrito a subconjunto opt-in de usuários: P3, não P2.

### P3-24. Banner de erro de render sem cor e com layout shift duplo

`packages/tui/src/tui.ts:1642` · área: nucleo-render · categoria: estados-vazios-erro · esforço: pequeno

**Problema.** renderFaultLines gera a linha "! render error: ..." como texto puro, sem nenhum estilo ANSI (tui.ts:1640-1642) — um erro crítico visualmente indistinguível do transcript. Pior: ela é APPENDADA ao fim do conteúdo (tui.ts:1695-1698), empurrando o editor/statusbar uma linha para baixo, e some sozinha após 5s (RENDER_FAULT_VISIBLE_MS, tui.ts:29), fazendo o layout pular de volta. O usuário vê a UI 'soluçar' duas vezes e pode nem perceber que era um erro.

**Sugestão.** Estilizar a linha (fg vermelho/negrito no prefixo "!", mensagem em dim) e renderizá-la como overlay não-capturante ancorado em bottom-center — o mecanismo de overlay já existe (showOverlay, tui.ts:608) — para dar destaque sem deslocar o layout do editor.

**Nota do verificador.** A evidência confere: tui.ts:1640-1642 gera texto puro sem ANSI, appendado ao fim (1695-1698), expira em 5s (tui.ts:29, 1618-1631) causando o shift duplo. Estilizar a linha é ganho legítimo e trivial. Mas: (1) é estado raro — fault interno de render, não experiência diária; (2) a sugestão de overlay é discutível: o fault nasce do próprio pipeline de render/composição (compositeOverlays roda em tui.ts:1701-1703 antes do fault line ser appendado), e a linha crua appendada é fail-safe por design (doRender captura o throw em 1645-1656). Rebaixado a P3; recomendar só a estilização, não a migração para overlay.

### P3-25. Todo render paga um hop extra de timer mesmo com a UI ociosa

`packages/tui/src/tui.ts:829` · área: nucleo-render · categoria: fluidez · esforço: pequeno

**Problema.** requestRender agenda via process.nextTick → scheduleRender → setTimeout(delay) (tui.ts:824-847). Quando o último render foi há mais de 16ms (caso típico: usuário digitando em UI ociosa), delay=0 mas o frame ainda atravessa um setTimeout completo antes de pintar — no Windows, onde timers têm granularidade grossa, isso adiciona latência mensurável ao eco de CADA tecla, o lugar onde latência percebida mais importa.

**Sugestão.** No nextTick, se `performance.now() - lastRenderAt >= MIN_RENDER_INTERVAL_MS`, chamar doRender() diretamente em vez de agendar setTimeout(0); manter o setTimeout apenas para o caso de throttling real (elapsed < 16ms). O eco de tecla em UI ociosa passa a pintar no mesmo tick de evento.

**Nota do verificador.** Caminho verificado: requestRender → nextTick → scheduleRender → setTimeout(delay) mesmo quando elapsed >= 16ms e delay=0 (tui.ts:824-847). A correção proposta é segura — o padrão de chamar doRender direto do nextTick já existe no caminho force (tui.ts:812-821). A magnitude no Windows é plausível porém não medida (setTimeout(0) no Node costuma ser ~1ms, não os ~15ms clássicos), então o ganho é pequeno-mas-real no lugar certo (eco de tecla). P3 correto como reportado.

### P3-26. Dark theme tem três cianos órfãos fora de vars; 'cor do usuário' difere entre temas

`packages/coding-agent/src/modes/interactive/theme/dark.json:26` · área: tema-cor · categoria: consistencia · esforço: pequeno

**Problema.** No dark.json, border = literal #4fb6c4 (:26), mdLink = literal #6fc0d6 (:50) e mdCodeBlockBorder repete o literal #4fb6c4 (:54) — nenhum passa pelas vars, enquanto o light.json usa a var cyanBlue para border e mdCodeBlockBorder (:26,:54). Resultado: no dark existem dois cianos quase iguais (border #4fb6c4 vs var cyanBlue #5aa7c4, 1.14:1 de diferença) que nunca foram harmonizados; gutterUser = cyanBlue (:89), então a barra da mensagem do usuário é IGUAL à borda no light mas sutilmente diferente no dark — a identidade cromática de 'usuário' muda entre temas. O comentário do schema (theme.ts:97-98) ainda diz que o user 'reutiliza border', o que já não é verdade.

**Sugestão.** Promover os literais a vars no dark.json (cyanBlue para border/mdCodeBlockBorder, um cyanLight para mdLink) e decidir conscientemente: gutterUser == border nos dois temas, ou distinto nos dois. Atualizar o comentário em theme.ts:96-98.

**Nota do verificador.** Fatos todos conferidos: dark.json border=#4fb6c4 literal (:26), mdLink=#6fc0d6 (:50), mdCodeBlockBorder=#4fb6c4 (:54), gutterUser=cyanBlue #5aa7c4 (:89); light.json usa cyanBlue para border/mdCodeBlockBorder/gutterUser (:26,:54,:89); comentário defasado em theme.ts:96-98 ('user reuses border') confirmado. Rebaixo de P2 para P3: a diferença #4fb6c4 vs #5aa7c4 (1.14:1) é imperceptível em uso real e gutter e borda do editor raramente aparecem adjacentes — nenhum usuário nota a 'identidade cromática' divergir. O valor é de manutenção/consistência do tema (e do comentário), não de experiência diária.

### P3-27. Slash-command digitado usa o token 'border' — conteúdo e moldura com a mesma cor

`packages/coding-agent/src/modes/interactive/theme/theme.ts:1392` · área: tema-cor · categoria: hierarquia-visual · esforço: pequeno

**Problema.** getEditorTheme define commandColor: theme.fg('border', ...) (theme.ts:1392) e borderColor com o mesmo token (theme.ts:1387). O texto do comando (`/model`, `/theme`…) — conteúdo interativo de primeiro plano — fica exatamente da cor da moldura do editor, achatando a hierarquia chrome vs conteúdo. Pior: um tema custom que suavize a borda (ex.: borda cinza discreta) apaga junto o destaque do comando, porque a semântica 'cor de comando' não existe no sistema de tokens.

**Sugestão.** Criar um token dedicado (ex.: `command` ou reutilizar `accent`) para commandColor, deixando `border` só para chrome. Nos JSONs built-in pode inicialmente apontar para o mesmo ciano, preservando o visual atual mas destravando a semântica.

**Nota do verificador.** Fato verificado: commandColor e borderColor usam ambos theme.fg('border') (theme.ts:1387,1392). Porém o comentário inline (theme.ts:1389-1391) mostra decisão deliberada ('matching Claude Code's input; border resolves to the blue var in both built-in themes') — nos temas built-in o visual é intencional e funciona: o comando ciano destaca-se do texto normal. O problema de 'achatar hierarquia' é discutível; o que sobrevive ao ceticismo é o gap semântico para temas custom (suavizar a borda apaga junto o destaque do comando). Rebaixo de P2 para P3: melhoria real mas de nicho (autores de tema custom), invisível no uso diário dos temas padrão.

### P3-28. BRAND_LIME #c9ff29 hardcoded no pulso do spinner briga com o tema light

`packages/coding-agent/src/modes/interactive/components/working-palette.ts:18` · área: tema-cor · categoria: cor-tema · esforço: pequeno

**Problema.** O pico do pulso 'breathing' mistura 25% de lima neon #c9ff29 sobre o accent (working-palette.ts:18,94-97). No dark funciona (accent claro → kiss mais claro ainda). No light, o accent é um verde escuro #177a4f desenhado para fundo branco; o blend de 25% para o lima clareia o pico para ~#438b45, ou seja, no instante mais 'quente' da animação o spinner PERDE contraste contra o fundo claro, e o lima saturado destoa da paleta sóbria do light. É a única cor fixa de marca em toda a camada de animação — todo o resto lê do tema.

**Sugestão.** Condicionar o brand-kiss à luminância do accent (só clarear quando o accent já é claro / tema dark), ou expor o alvo do kiss como token opcional do tema com default lima no dark e um verde profundo no light.

**Nota do verificador.** Fato verificado (working-palette.ts:18,21-23,93-97): blend de 25% para #c9ff29 no pico. Recalculei: no light o pico vira ~#449b46, contraste sobre branco cai de ~5.3:1 (accent) para ~3.5:1 — direção da queixa correta, magnitude modesta e ainda visível para um glifo decorativo. O atenuante 'é decisão de marca documentada' não segura: o próprio comentário justifica com 'matching the wordmark', mas o wordmark ABANDONOU o lima neon (color-interpolation.ts:70-74 diz explicitamente que o neon-green lia como logo de outro produto) — a justificativa está obsoleta. Rebaixo de P2 para P3: o kiss atinge só ~2-3 de 24 fases com 25% de blend; é um detalhe de polimento em animação, não algo que degrade o uso diário.

### P3-29. Rampa de thinking não tem paridade de progressão entre dark e light

`packages/coding-agent/src/modes/interactive/theme/light.json:76` · área: tema-cor · categoria: cor-tema · esforço: pequeno

**Problema.** No dark a rampa lê como progressão monotônica de matiz: low #5f9ea8 (teal) → medium #6fc0c4 (teal claro) → high #8ab6d6 (azul) → xhigh lavanda (dark.json:76-79). No light ela zigue-zagueia: low #3f7e98 (azul) → medium #1f8a7e (volta para verde-teal) → high #5f7ab0 (azul-violeta) → xhigh lavanda (light.json:76-79). Quem alterna entre temas perde o mapeamento mental 'mais para o violeta = mais thinking' — a borda do editor em medium parece MENOS intensa que low no light.

**Sugestão.** Reordenar os matizes do light para a mesma trajetória teal → azul → violeta do dark (ex.: low ~#1f8a7e, medium ~#3f7e98, high ~#5f7ab0), mantendo os valores escuros para contraste em fundo claro.

**Nota do verificador.** Verificado nos JSONs: dark (dark.json:76-79) progride ~teal(188°)→ciano(183°)→azul(205°)→lavanda(270°), aproximadamente monotônico; light (light.json:76-79) faz 198°→173°(medium #1f8a7e volta para verde-teal)→220°→270°, zigue-zague real — medium fica mais 'verde' que low. P3 está correto e honesto: só afeta quem alterna entre temas E lê a borda do editor como escala ordinal de matiz; a maioria distingue os níveis pelo indicador textual. Correção barata e sem downside, mas de impacto pequeno.

### P3-30. Fallback 256-color de wordmark/H1 vira zebra mint/lavanda por coluna

`packages/coding-agent/src/modes/interactive/theme/color-interpolation.ts:46` · área: tema-cor · categoria: cor-tema · esforço: pequeno

**Problema.** bicolorColumnColor (color-interpolation.ts:46-51) alterna accent e thinkingXhigh a cada coluna. É o fallback de wordmarkGradient (:139) e do h1Gradient (:156) — e h1Gradient colore TODO H1 de markdown (theme.ts:1335). Em terminal sem truecolor, cada heading nível 1 do assistente sai listrado mint/lavanda caractere a caractere, o que lê como renderização corrompida, não como gradiente. O próprio heroWordmarkGradient já resolveu isso melhor: cai para accent sólido (color-interpolation.ts:96) citando que banding lê pior que cor chapada.

**Sugestão.** Alinhar os fallbacks: em 256-color, h1Gradient cai para mdHeading sólido (bold+underline já diferenciam o H1) e wordmarkGradient para accent sólido, reservando o bicolor no máximo para o wordmark decorativo de boas-vindas.

**Nota do verificador.** Verificado: bicolorColumnColor alterna accent/thinkingXhigh por coluna (color-interpolation.ts:46-51), é o fallback de wordmarkGradient (:139) e h1Gradient (:156), e h1Gradient colore todo H1 de markdown (theme.ts:1335) — em terminal sem truecolor cada heading sai alternando mint/lavanda caractere a caractere, que de fato lê como glitch. A inconsistência interna é real: heroWordmarkGradient (:96) já cai para accent sólido com justificativa explícita (:84-85, 'banding reads worse than a solid accent'). P3 adequado: atinge só a minoria sem truecolor (a maioria dos emuladores modernos tem COLORTERM=truecolor), mas a correção é alinhar com um padrão que o próprio arquivo já estabeleceu.

### P3-31. Headings H3–H6 são visualmente idênticos entre si — hierarquia achatada

`packages/tui/src/components/markdown.ts:914` · área: componentes-base · categoria: hierarquia-visual · esforço: medio

**Problema.** No renderToken, todo heading de nível >= 3 cai no mesmo estilo `heading(bold(text))` (markdown.ts:914), e o comentário em markdown.ts:923-925 confirma que o prefixo literal '###' foi removido de propósito. Com o tema do app, H1 tem gradiente+underline e H2 tem a barra de acento '▎ ' (theme.ts:1335-1336), mas H3, H4, H5 e H6 — os níveis que os modelos mais usam dentro de respostas longas — rendem exatamente iguais, então a estrutura do documento colapsa: uma subseção de 4º nível tem o mesmo peso visual de uma seção de 3º.

**Sugestão.** Diferenciar ao menos H3 de H4+: por exemplo, H3 = bold colorido (atual) e H4+ = bold sem cor de heading ou com um marcador dim curto ('· ' ou '▸ '), ou expor heading3 opcional no MarkdownTheme como já existe heading1/heading2. Dois degraus a mais bastam para restaurar a sensação de outline.

**Nota do verificador.** Confirmado no código: markdown.ts:907-915 só especializa nível 1 (heading1, gradiente+underline via theme.ts:1335) e nível 2 (heading2, barra '▎ ' via theme.ts:1336); todo nível >= 3 cai em `heading(bold(text))` (:914), e o comentário :923-925 confirma a remoção intencional do prefixo '###'. Porém rebaixo para P3: H3 continua distinguível do corpo (cor+bold), e a confusão real exige respostas com outline de 4+ níveis onde a distinção H3 vs H4 importa — caso minoritário em chat de terminal. Ganho existe, mas é refinamento, não dor diária de P2.

### P3-32. Descrições do SelectList somem abruptamente abaixo de 41 colunas

`packages/tui/src/components/select-list.ts:326` · área: componentes-base · categoria: truncamento-resize · esforço: medio

**Problema.** renderItem só mostra a coluna de descrição quando `width > 40` (select-list.ts:326) e quando sobram mais de 10 células (select-list.ts:335, MIN_DESCRIPTION_WIDTH); abaixo disso a descrição desaparece por completo, sem elipse nem fallback. Ao redimensionar a janela ou usar um pane estreito, o picker de modelos/temas perde todo o contexto de uma vez em um degrau invisível — 41 colunas mostra descrição, 40 não mostra nada — o que parece bug de renderização e não degradação intencional.

**Sugestão.** Suavizar o degrau: entre ~30 e 40 colunas, mostrar a descrição truncada com '…' na linha seguinte (indentada, dim) para o item selecionado apenas — padrão que o SettingsList já usa para a descrição do item selecionado (settings-list.ts:184-191) — em vez de suprimi-la totalmente.

**Nota do verificador.** Código confere: select-list.ts:326 exige `width > 40` e :335 exige `remainingWidth > MIN_DESCRIPTION_WIDTH` (10, definido em :9); fora disso a descrição é suprimida por completo, sem fallback. O degrau existe. Mantenho P3: painéis abaixo de 41 colunas são caso de borda, ocultar a descrição é uma degradação defensável (mostrar 10 células de descrição truncada tem valor marginal), e a sugestão — descrição em linha própria para o item selecionado, como settings-list.ts:184-191 já faz — melhora mas adiciona altura variável ao picker. Vale como refinamento, não mais que isso.

### P3-33. Marcadores de paste renderizados como texto plano, sem distinção visual

`packages/tui/src/components/editor.ts:1788` · área: editor-input · categoria: hierarquia-visual · esforço: medio

**Problema.** Um paste grande vira '[paste #1 +123 lines]' inserido como texto cru (editor.ts:1788-1792). O marcador se comporta como unidade atômica (cursor pula, backspace apaga inteiro) mas visualmente é indistinguível do texto digitado — nenhum styling é aplicado no render (o único highlight existente é commandColor para '/comando', editor.ts:912-915, e o EditorTheme em 237-247 não tem slot para markers). O comportamento atômico 'surpreende' porque nada sinaliza que aquilo é um chip especial.

**Sugestão.** Adicionar um pasteMarkerColor opcional ao EditorTheme e pintar os spans dos markers (a regex PASTE_MARKER_REGEX de editor.ts:18 já localiza os spans) com dim/accent, reutilizando a técnica ANSI-safe de paintPrefixVisible.

**Nota do verificador.** Confirmado: o marker é inserido como texto cru (editor.ts:1788-1792), o EditorTheme (editor.ts:237-247) não tem slot para markers, e PASTE_MARKER_REGEX (editor.ts:18) só é usado para lógica de cursor/delete, nunca no render — nenhum styling é aplicado. Porém P2 superestima o dano: o texto '[paste #1 +123 lines]' é auto-descritivo entre colchetes e dificilmente se confunde com texto digitado; a 'surpresa' do comportamento atômico é atenuada pelo próprio formato do marker. Colorir o chip é polish desejável e consistente com commandColor, mas é refinamento, não dor diária. P3.

### P3-34. Mensagens custom sem renderer ainda usam o card roxo antigo com [customType] cru

`packages/coding-agent/src/modes/interactive/components/custom-message.ts:318` · área: mensagens-chat · categoria: consistencia · esforço: medio

**Problema.** O fallback de CustomMessageComponent renderiza um Box com fundo customMessageBg, padding 1,1 e um label bold com o tipo interno cru entre colchetes — `[pit.qualquer-coisa]` (custom-message.ts:318-335). Todo o resto do chat migrou para o idioma MessageShell de gutter fino (o próprio docblock do message-shell.ts:2-10 descreve a migração "Leva 2 — partial"). Resultado: qualquer extensão que emita uma mensagem sem renderer aparece como um cartão sólido de outro produto, com um identificador técnico como título voltado ao usuário.

**Sugestão.** Migrar o fallback para MessageShell com gutterCustom + label humanizado (derivar do customType: strip do prefixo `pit.`, kebab→palavras), mantendo o Box apenas se alguma extensão depender explicitamente dele. Fecha a migração Leva 2 e elimina o último bloco de fundo sólido do transcript.

**Nota do verificador.** Código confere exatamente: custom-message.ts:317-335 monta Box(1,1, customMessageBg) com label bold `[${customType}]` cru, e message-shell.ts:2-3 documenta a migração como 'Leva 2 — partial'. A inconsistência é real. Mas P2 superestima: é um caminho de FALLBACK — todos os tipos internos (fusion, mcp.notice, permission-blocked, doom-loop, compaction, branch, skill) têm renderização compacta própria antes de cair aqui (linhas 140-300), e extensões podem registrar customRenderer (linha 303). Só atinge extensões de terceiros sem renderer — frequência baixa no uso diário. Vale fechar a migração, mas como P3.

### P3-35. Fim de turno marcado duas vezes: linha "✓ Done" + hairline rule

`packages/coding-agent/src/modes/interactive/interactive-mode.ts:1868` · área: mensagens-chat · categoria: espacamento-layout · esforço: medio

**Problema.** Cada fronteira de turno acumula dois separadores redundantes: appendTurnDoneLine adiciona Spacer + `│ ✓ Done  1m 5s · ↑12k ↓3k` (interactive-mode.ts:1869-1874), e logo em seguida o próximo prompt insere TurnRule — blank + linha `─` (interactive-mode.ts:4053, turn-rule.ts:38) — seguido do blank do shell do usuário. São ~5 linhas de "cerimônia" entre a resposta e o próximo prompt, dizendo a mesma coisa ("o turno acabou") de duas formas visuais diferentes. Em sessões longas isso dilui a densidade útil do scrollback.

**Sugestão.** Fundir os dois sinais: renderizar as métricas do turn-done NA própria rule (ex.: `─── 1m 5s · ↑12k ↓3k ───` em borderMuted, métricas em dim), ou suprimir a rule quando uma linha ✓ Done imediatamente a precede. Um separador único e informativo dá ritmo mais limpo entre turnos.

**Nota do verificador.** Contagem confere: appendTurnDoneLine adiciona Spacer(1) + linha ✓ Done (interactive-mode.ts:1869-1874, noLeadingGap), e o próximo prompt insere TurnRule que renderiza blank + `─` (interactive-mode.ts:4053, turn-rule.ts:38), seguido do blank do shell do user — ~5 linhas de cerimônia entre resposta e próximo prompt. Ressalvas que mantêm em P3: os dois sinais não dizem exatamente a mesma coisa (Done carrega métricas e é efêmero/não-persistido; a rule é o separador estrutural que também aparece em rebuilds de histórico onde a Done line não existe), e a fusão proposta (métricas NA rule) exigiria resolver esse descasamento live vs rebuild. Ganho real de densidade em sessões longas, mas é refinamento de ritmo, não dor diária aguda.

### P3-36. Login OAuth espera sem spinner e acumula linhas de progresso

`packages/coding-agent/src/modes/interactive/components/login-dialog.ts:235` · área: seletores-dialogos · categoria: feedback · esforço: medio

**Problema.** Durante o fluxo OAuth — o momento de maior latência percebida do app — showBusy (login-dialog.ts:211-216) e showWaiting (235-240) exibem só texto dim estático, sem spinner, embora o TUI tenha SPINNER_FRAMES e spinner-ticker prontos (usados em nav-group.ts:2,69). O usuário não distingue "esperando o provedor" de "travou". Além disso, showWaiting e showProgress (245-248) fazem addChild sem clear: em fluxos de polling (GitHub Copilot) cada atualização empilha mais uma linha e o card cresce indefinidamente ao longo da espera.

**Sugestão.** Usar o spinner-ticker existente para animar a linha de status durante espera/polling, e fazer showProgress/showWaiting substituírem a última linha de status (guardar referência ao Text e setText) em vez de empilhar novas.

**Nota do verificador.** Metade do achado procede, metade não. Sem spinner: verdadeiro — showBusy (login-dialog.ts:211-216) e showWaiting (235-240) são texto dim estático, e a infra de spinner existe (spinner-ticker.ts, SPINNER_FRAMES). Mas o cenário de acumulação é exagerado/especulativo: showWaiting não tem NENHUM chamador no código (grep em packages/coding-agent/src só acha a definição), o fluxo 'GitHub Copilot' citado nem existe nos provedores atuais (anthropic, openai-codex, xai), e onProgress dispara 1-3 mensagens discretas por fluxo (anthropic.ts:419 uma vez; xai.ts:429,461,468) — poucas linhas empilhadas leem como log de progresso, não crescimento indefinido. Sobra um polish menor (animar a espera do OAuth): P2→P3.

---

*Gerado por workflow multi-agente (run `wf_82e1e964-ce8`): 8 áreas + 3 dimensões transversais,
verificação adversarial por área. ~3,7M tokens de subagentes, 916 usos de ferramenta.*
