# Estudo de polimento visual do PIT — notificação MCP, animações e cores

> Status: **RECOMENDAÇÕES IMPLEMENTADAS** (aprovadas pelo usuário, entregues em duas
> ondas de agentes). Entregue: D1-A (mcp.notice compacto + agregação), D2 (A1 shimmer,
> A2 batimento único, A3 ignição do hero), A4 (pico lima no pulso), D4-C (paleta
> ponte mint), D5 (legibilidade dim/comentários), D6 (Z1 "Try…", Z4 ↑tok, Z5 régua).
> Pendentes por decisão: D3 (A5/A6), D7 (Z2 placeholder, Z3 chrome-leve — protótipo),
> Z6 (logo uma-letra).
> Contexto: o hero verde-neon → lima da tela de entrada (commit `4e7d1bd2`) criou uma
> identidade visual nova. Este estudo avalia (1) a notificação MCP poluente, (2) a
> qualidade das animações e (3) a paleta de cores, e propõe um caminho para cada um.

---

## 1. Notificação MCP — diagnóstico e propostas

### O que acontece hoje

Quando um servidor MCP não conecta dentro do orçamento de inicialização, a extensão
envia uma mensagem custom (`mcp-extension.ts:373`) que cai na **rota default** do
`custom-message.ts:210-225`: espaçador + **card azul** (`customMessageBg`) + rótulo
**`[mcp.notice]`** em lavanda negrito + markdown. O texto inclui o comando completo do
servidor (no caso do burp, o caminho inteiro do `java.exe` + jar + URL), o que infla o
card para 3+ linhas logo abaixo da tela de boas-vindas.

É informação útil (o servidor existe, conecta sob demanda, `/mcp` reconecta) embrulhada
no formato errado: um aviso de rotina vestido como mensagem de destaque.

### Precedente interno

O próprio arquivo já resolve isso para o fusion: linhas `pit.fusion-flow` renderizam
como **uma linha muted compacta, sem card, sem rótulo, sem espaçador**
(`custom-message.ts:186-193`). É o formato certo para avisos de rotina.

### Opções

| opção | visual | custo |
|-|-|-|
| **A (recomendada)** — linha compacta | `◦ mcp: burp não conectou em 10s — sob demanda · /mcp` em muted/dim, 1 linha, truncada na largura | baixo: registrar `mcp.notice` na rota compacta + encurtar o texto (derrubar comando/URL — detalhes ficam no `/mcp`) |
| B — card mantido, texto curto | card azul de 1 linha sem o comando | mínimo, mas continua um card para um aviso de rotina |
| C — silencioso | nada no chat; estado só via `/mcp` | zero poluição, mas o modelo e o usuário perdem o aviso de que o servidor existe |

Complemento da opção A: quando **mais de um** servidor estoura o orçamento, agregar em
uma linha única (`◦ mcp: 2 servidores aguardam conexão sob demanda · /mcp`).

**Minha recomendação: A + agregação.** O aviso continua visível para o usuário e para o
modelo (a mensagem segue na sessão), mas ocupa uma linha discreta em vez de um cartaz.

---

## 2. Animações — avaliação e propostas

### O que já existe (inventário resumido)

A base técnica é **forte** — melhor do que aparenta na tela:

- **Ticker único** a 16ms (~60fps) com *frame coalescing*: cada animação só repinta
  quando o pixel-sonda muda; ~9 de 10 ticks não geram render (`tui.ts:745-795`).
- **Spinners braille phase-locked**: todos os spinners da tela compartilham o mesmo
  relógio (frame a cada 80ms), então nunca ficam fora de fase entre si.
- **Pulso "respirando"** no loader: cosseno levantado accent ↔ dim, ciclo de 1600ms,
  24 fases em truecolor (`working-palette.ts`).
- **Respiração do rótulo de pensamento**: dim ↔ thinkingText, ciclo de 1800ms, 8
  degraus (`assistant-message.ts`).
- **Streaming com frente de onda**: o texto revela a taxa constante (1-48 chars/frame,
  catch-up de ~130ms) com **fade de 6 colunas** na borda do texto que chega.
- **Eases de 180ms smoothstep** em toda transição de estado: gutter de ferramenta
  (pendente → sucesso/erro), ícones, contadores, barra de contexto do footer.
- **Cursor** com blink clássico de 530ms; **reduced motion** global via
  `PIT_NO_MOTION`/`PIT_REDUCED_MOTION` congela tudo com elegância.

### Onde falta polimento (o que os olhos percebem)

1. **Dois corações batendo em tempos diferentes.** O pulso do spinner cicla em
   **1600ms** e a respiração do rótulo de pensamento em **1800ms**. Quando os dois
   estão visíveis (pensando + streaming), eles entram e saem de fase lentamente — uma
   dissonância sutil que o olho registra como "algo tremido" sem saber por quê.
2. **O rótulo de fase é estático.** "Thinking…", "Reading file…" só trocam de cor em
   bloco (pulso). CLIs modernos (Claude Code, por exemplo) usam um **shimmer** — uma
   varredura de brilho que atravessa o texto — que é o que dá a sensação de "vivo".
3. **O hero nasce seco.** A API de ease no mount (`wordmarkColor`) existe e nada a usa:
   o logo aparece de supetão em vez de acender.
4. **A identidade não participa das animações.** O pulso respira em teal; a marca agora
   é verde-lima. Os momentos de vida da UI não conversam com o logo.
5. **Fim de streaming é abrupto.** A frente de onda com fade some no instante em que o
   stream termina; falta um "assentamento" de ~180ms das últimas colunas até a cor
   plena.

### Propostas (em ordem de ganho ÷ esforço)

| # | proposta | efeito | esforço | risco |
|-|-|-|-|-|
| **A1** | **Shimmer no rótulo de fase**: gradiente de brilho que varre "Thinking…" da esquerda para a direita, ciclo ~1800ms, truecolor only (fallback: pulso atual) | é o maior salto de "polido e vivo" da lista; sensação imediata de atividade | médio-baixo (reusar `applyColumnGradient` com fase animada) | baixo — linha curta, ~20 células recoloridas/frame, coalescing já protege |
| **A2** | **Batimento unificado**: um único `HEARTBEAT_MS = 1800` compartilhado por pulso, respiração e shimmer, todos derivando fase do mesmo relógio | tudo que "respira" respira junto; calma perceptível | baixo (duas constantes viram uma) | nenhum |
| **A3** | **Acender o hero no mount**: ease one-shot de ~500ms do gradiente (de dim até o neon pleno) usando o `wordmarkColor` já existente | entrada com vida; primeiro frame do produto | baixo | nenhum (one-shot, reduced-motion pula) |
| **A4** | **Pico do pulso na cor da marca**: a respiração do loader passa a atingir o verde-menta/lima no pico (hoje: teal) | as animações carregam a identidade | trivial | depende da decisão de cor (§3) |
| **A5** | **Assentamento pós-stream**: ao terminar o stream, as últimas colunas fazem fade até a cor plena em 180ms (mesmo `ColorEase`) | fim de resposta suave em vez de corte | baixo | baixo |
| **A6** | **Brighten no título da ferramenta ao concluir**: além do gutter, a linha-título dá um flash sutil de 180ms na cor de sucesso/erro | feedback de conclusão mais legível na varredura do olho | baixo | baixo — pode ficar ruidoso se muitos tools concluírem juntos; mitigável limitando ao último |

Tudo acima respeita a arquitetura atual (ticker compartilhado, sonda de sujeira,
reduced-motion) — nenhuma proposta adiciona timer próprio nem passa de 60fps.

**Minha recomendação: A1 + A2 + A3 como pacote núcleo** (é o que muda a sensação),
A4 junto se a decisão de cor do §3 for a ponte, A5/A6 como refinamento depois de
vermos o núcleo em uso.

---

## 3. Cores — análise completa e opinião

### A paleta atual (tema dark) com números

Contraste WCAG sobre fundo `#0c1110` (pageBg) / `#1e1e1e` (terminal típico):

| papel | cor | contraste | leitura |
|-|-|-|-|
| `text` | `#cdd6d3` | 12.8 / 11.2 | excelente; tom levemente esverdeado (proposital, "sage") |
| `muted` | `#788a85` | 5.2 / 4.6 | bom para secundário |
| `dim` | `#54625e` | **3.0 / 2.6** | abaixo de AA (4.5:1) — ok para decoração, mas é usado em informação útil (versão, hints, `esc to interrupt`) |
| `accent` (teal) | `#8ad8c4` | 11.5 / 10.1 | ótimo |
| `success` (green) | `#8ad8a0` | 11.3 / 9.9 | ótimo |
| `error` (coral) | `#e08a72` | 7.3 / 6.4 | bom |
| `warning` (gold) | `#e0c07b` | 10.9 / 9.5 | ótimo |
| `border` | `#4fb6c4` | 8.0 / 7.0 | bom |
| `syntaxComment` | `#5a6e64` | **3.5 / 3.1** | limítrofe — comentários de código quase somem |
| logo neon | `#39ff14` | 14.0 / 12.3 | vibrante |
| logo lima | `#c9ff29` | 16.2 / 14.2 | vibrante |

**Diagnóstico da fonte (o pedido específico):** a base é saudável — `text` tem
contraste de sobra e o tom sage dá personalidade sem cansar. Os dois pontos fracos
reais são `dim` e `syntaxComment`, que estão abaixo do limiar de leitura confortável
e carregam informação que às vezes importa.

### A tensão criada pelo novo logo

A UI hoje fala **teal/lavanda** (accent, borda do editor, chip ✦ do footer, links,
gutter de usuário) e a marca agora fala **verde-neon/lima**. São famílias vizinhas
(ambas frias-esverdeadas), então não briga — mas também não conversa: o logo parece
um convidado de outra festa.

### Opções

**Opção A — Teal continua o acento; lima é só marca.**
O logo, e talvez um ou outro momento raro (bullet do workspace), ficam verdes; todo o
resto permanece. Seguro, zero risco semântico, mas a identidade nova fica confinada à
tela de entrada.

**Opção B — Migração total para verde/lima como acento.**
`accent`, borda do editor, links, tudo desloca para a família do logo. Risco real:
**verde já tem semântica** (success, diff-added, bash) — a UI inteira verde vira
"Matrix" e o olho perde a distinção entre "isso é destaque" e "isso deu certo".

**Opção C — Ponte (minha recomendação).**
Um deslocamento calibrado, preservando a semântica:

| mudança | de | para | por quê |
|-|-|-|-|
| `accent` | teal `#8ad8c4` | verde-menta `#86e6b2` (~10.5:1) | meio-caminho entre o teal atual e o lima do logo; a UI passa a "rimar" com a marca sem gritar |
| pico das animações (pulso/shimmer) | accent | verde-menta → toque de lima no ápice | identidade nos momentos de vida (liga com A4 do §2) |
| `dim` | `#54625e` | `#5f6f6a` (~3.6:1) | hints e versão voltam a ser legíveis sem competir com muted |
| `syntaxComment` | `#5a6e64` | `#6a7f74` (~4.2:1) | comentários de código legíveis |
| `success`, `border`, `lavender`, `gold`, `coral` | — | **inalterados** | semântica preservada; teal segue vivo em borda/links |
| `text` | `#cdd6d3` | **inalterado** | está ótimo; neutralizar tiraria personalidade |

O tema light recebe o mesmo tratamento com os pares escuros já definidos no gradiente
do logo (`color-interpolation.ts`).

### Por que não mexer em mais nada

`gold` para headings, `coral` para erro, `lavender` para custom/thinking-xhigh formam
um trio de temperatura que equilibra a frieza da base. Esfriar ou aquecer esse trio
desestabiliza a paleta inteira por ganho nenhum.

---

## 4. Referência: ZERO — o que os prints ensinam

O usuário trouxe três telas do agente "ZERO" como referência de gosto. Traduzindo o
que elas fazem de bom em decisões concretas para o PIT:

### O que o ZERO acerta

1. **Chrome quase zero na conversa.** Nenhum card com fundo tintado: a mensagem do
   usuário é marcada por uma **barra lateral lima** (`▌`) + negrito; ferramentas são
   `edit_file caminho` (nome em cor, argumento muted) com o diff embaixo; grupos de
   exploração viram `• Explored` com galhos de árvore (`├ List`, `└ Find *.md`) e um
   `▸ details` recolhido. O espaço em branco faz o trabalho que o PIT hoje pede aos
   fundos `userMsgBg`/`toolPendingBg`.
2. **Acento cirúrgico no logo.** Letras brancas com **uma única letra** na cor da
   marca (o "0" em lima). Contenção que grita identidade.
3. **Onboarding por exemplo, não por mecânica.** `Try "explain this codebase" · "fix
   the failing test"` — sugere tarefas reais; o atalho (`? shortcuts · / commands`)
   vem numa segunda linha dim.
4. **Placeholder dentro do editor** (`describe a task for zero…`) + glifo `❯` de
   prompt + moldura arredondada. O PIT ainda flutua a dica acima do editor
   (limitação conhecida, registrada no TUI-AESTHETICS).
5. **Linha de trabalho calma e informativa**: `∴ Working · writing · 11s · ↑ 97 tok`
   — estágio em minúscula ("writing"), tempo, tokens de saída ao vivo. O PIT mostra
   fase + tempo + `esc to interrupt` + taxa ↓; falta o contador ↑ de tokens e o
   estágio curto.
6. **Régua horizontal fina** separando blocos do turno — pontuação visual barata.

### O que NÃO copiar

- **Modelo no hero e no rodapé ao mesmo tempo** — o PIT decidiu que o footer é dono
  do modelo; duplicar cria dessincronia.
- **Verde para tudo** (user bar, grupos, status, cursor) — funciona no ZERO porque a
  paleta dele é branco+lima só; no PIT o verde já carrega semântica de sucesso/diff.
  Reforça a opção C (ponte) do §3 em vez da B (tudo-verde).

### Empréstimos propostos

| # | empréstimo | onde entra | esforço |
|-|-|-|-|
| **Z1** | Linha "Try …" com 2-3 exemplos de tarefa no hero (acima da dica de mecânica, que vira dim) | welcome | baixo |
| **Z2** | Placeholder dentro do editor + glifo `❯` | precisa de API de placeholder no `@pit/tui` (já era backlog) | médio |
| **Z3** | Conversa de chrome leve: barra `▌` na mensagem do usuário em vez de card tintado; menos fundos nas ferramentas | componentes de mensagem | médio-alto (mexe na cara de tudo — sugiro protótipo atrás de flag/tema antes de decidir) |
| **Z4** | `↑ tok` ao vivo + estágio curto (`thinking/tooling/writing`) na linha de trabalho | loader (já tem a infra de suffix) | baixo |
| **Z5** | Régua fina entre turnos | chat container | baixo |
| **Z6** | Variante de logo "uma letra acesa" (P e T brancos, **I** em lima) | alternativa ao gradiente atual — gosto pessoal, os dois são bons | trivial de testar |

## 5. Folha de decisão

| # | pergunta | opções | minha recomendação |
|-|-|-|-|
| D1 | Notificação MCP | A linha compacta · B card curto · C silencioso | **A + agregação multi-servidor** |
| D2 | Pacote núcleo de animação | A1 shimmer · A2 batimento único · A3 hero acende | **os três** |
| D3 | Refinamentos de animação | A5 assentamento pós-stream · A6 flash de conclusão | depois de usar o núcleo |
| D4 | Direção de cor | A teal-só-marca · B tudo-verde · C ponte | **C (ponte)** |
| D5 | Legibilidade | subir `dim` e `syntaxComment` | **sim, independente de D4** |
| D6 | Empréstimos ZERO leves | Z1 exemplos "Try…" · Z4 `↑ tok` + estágio · Z5 régua entre turnos · Z6 logo uma-letra | **Z1 + Z4 + Z5** (Z6 é gosto — o gradiente atual também é forte) |
| D7 | Empréstimos ZERO estruturais | Z2 placeholder no editor · Z3 conversa chrome-leve | Z2 sim (backlog conhecido); **Z3 só como protótipo atrás de flag** para você comparar ao vivo antes de decidir |

Custos combinados da recomendação completa (D1-A, D2, D4-C, D5, D6): ~8 arquivos de
implementação + testes; nenhuma mudança estrutural; tudo atrás do reduced-motion e dos
fallbacks de cor já existentes. Z2/Z3 (D7) são os únicos itens de esforço médio-alto.
