# Estudo: Banda de Condicionamento (Band P) — tornando o condicionamento nativo no PIT

> **Documento aprovado** (estudo 2026-07-02; decisões fechadas em sessão de grill no mesmo
> dia — ver §8). Companion de [`prevention-layers.md`](prevention-layers.md). Cada fase do
> roadmap (§7) vira um spec de implementação.
>
> Método: três varreduras profundas e paralelas do código (infra de contexto/grounding,
> máquina de fluxo/plano/review, telemetria/dosagem), sintetizadas aqui. Todos os anchors
> `file:line` foram verificados contra o código atual.

---

## 1. Sumário executivo

O PIT tem hoje quatro bandas maduras de defesa — todas **reativas**: verificam o tool call
depois que o modelo o gerou (Band B), reparam depois que executou (Band C), corrigem o
comportamento depois que degradou (Band D). A única camada que molda o modelo *antes* de
gerar é o `task-rigor` — três frases de prosa no system prompt.

Este estudo propõe uma quinta banda nativa, a **Band P (pré-geração / condicionamento)**,
com cinco pilares e uma fundação transversal:

| pilar | o quê | efeito esperado |
|-|-|-|
| **P0 — Fundação** | termostato de supervisão (nível conquistado na sessão) + telemetria de eficácia persistente | pré-requisito: dosar e medir tudo o que vem abaixo |
| **P1 — Injeção de verdade** | assinaturas/tipos reais dos símbolos que o turn vai usar, injetados antes da geração | o modelo não alucina uma API que acabou de ler |
| **P2 — Gate de intenção** | micro-plano validado contra a árvore real antes do primeiro edit em tarefas de risco | mata a categoria "saiu editando com modelo mental errado" |
| **P3 — Ancoragem por exemplar** | código análogo do próprio repo mostrado junto do site de edição | estilo e idioma por imitação, não por instrução |
| **P4 — Self-review estruturado** | diff de alto risco passa por um segundo passe read-only com schema antes do "done" | pega o erro que o gerador não vê |
| **P5 — Contrato de convenções** | falha de verificação vira restrição ativa da sessão, não hint one-shot | o modelo para de repetir a mesma violação |

**A descoberta central do estudo: quase tudo já existe como matéria-prima.** O repo-map
incremental, o cliente LSP com `hover` (assinaturas reais), as duas lanes de injeção
cache-neutras, o `PlanManager` com DAG validado, os validadores de grounding **puros e
chamáveis fora dos hooks**, o padrão fusion-verify de subagente read-only com schema, o
gate `goal_complete` que recusa enquanto o check está vermelho, e o campo `outcome` no
canal de diagnostics desenhado exatamente para medir aceitação de guard. O que falta
construir de verdade são **quatro componentes novos**: o preditor de relevância, o
montador orçamentado de contexto, o correlacionador guard-fire→resultado, e o sink
persistente de telemetria. O resto é composição.

---

## 2. Diagnóstico: por que o condicionamento é a banda rasa

Levantamento de **todo** enriquecimento de contexto existente e seu gatilho:

| mecanismo | gatilho | momento |
|-|-|-|
| edit-precondition hint (mostra o near-match real) | **falha** (oldText não casou) | pós-geração |
| Tier-4 error hints | **falha** (tool result com erro) | pós-execução |
| grounding-guard "did you mean" | tool call **já gerado** | pós-geração |
| LSP hover/definition (assinaturas + código real) | **pedido explícito** do modelo | sob demanda |
| read delta framing | **re-read** do modelo | sob demanda |
| doom-loop/stagnation steers | **degradação** detectada | pós-comportamento |
| memory/hindsight hints | boot (hint mínimo, conteúdo sob demanda) | pré, mas genérico |
| task-rigor | prompt do usuário | **pré-geração ← único** |

Conclusão do levantamento (verificada): **nenhum mecanismo injeta preventivamente
assinaturas, tipos ou exemplares baseado numa predição do que o turn vai precisar.**
O harness sabe verificar se um símbolo existe (grounding), mas nunca conta ao modelo
quais símbolos existem antes de ele tentar. Para modelos fracos, essa inversão é a
diferença entre bloquear a alucinação e torná-la improvável.

---

## 3. Inventário: o que já existe e é reaproveitável

### 3.1 Infra de contexto (para P1/P3)

- **Living repo-map** (`core/repo-map/living-index.ts:353`): índice incremental
  git-fresh, persistido em `.pit/repo-map.jsonl`, ~12 símbolos/arquivo, projeção
  token-capped via `livingRepoMapToDigests`. Hoje só alimenta compaction. **Gap: só
  nomes — sem assinaturas, sem linha** (o tool `repo_map` tem kind+line, mas é full-scan).
- **LSP** (`core/lsp/`): 60+ servers com warm-up no boot; `hover` retorna assinatura+docs
  (`tool.ts:494`), `definition` retorna código real com contexto, `workspace/symbol`
  resolve nome→localização. **Gap: queries são posicionais — não existe primitivo em
  lote "N nomes → N assinaturas"; e a latência exige uso async/best-effort.**
- **Duas lanes de injeção cache-neutras** (a descoberta operacional mais importante):
  1. **Sufixo dinâmico do system prompt** (`system-prompt.ts:134`, após o
     `SYSTEM_PROMPT_DYNAMIC_MARKER`): custo de cache zero, nunca podado, rebuilt por
     turn. O `PIT_FREQ_OUTLINE` (outlines dos hot files, hoje OFF) é literalmente um
     protótipo da Band P nesta lane.
  2. **Evento `context` / transformContext** (`extensions/types.ts:632`,
     `runner.ts:1029`): dispara **antes de cada chamada ao provider**, pode inserir
     mensagem sintetizada no transcript sem tocar o prefixo cacheado. É o hook de
     precisão por turn.
- **Hazards mapeados**: conteúdo injetado como tool_result de `read/lsp/symbol/...`
  entra na lane de supersede e colapsa no próximo call idêntico
  (`agent-session-live-prune.ts:21`); mensagem custom escapa do supersede mas é
  descartada na compaction — o padrão de **re-injeção pós-compaction** já existe
  (memory/hindsight/read-guard fazem isso). `_trackPrefixStability`
  (`agent-session.ts:2809`) já mede churn de prefixo — a prova de que a banda não
  degrada o cache sai de graça.

### 3.2 Máquina de fluxo (para P2/P4/P5)

- **task-rigor** (`core/task-rigor.ts:52`): classifica risco por regex sobre o prompt
  (EN+pt-BR), níveis 0-3, dispara em `before_agent_start`. Rigor 2 já *pede* "short
  plan"; rigor 3 já *pede* "self-review the diff" — **como prosa não-enforçada**. É o
  trigger pronto do gate de intenção; não é o validador (não olha a árvore).
- **PlanManager** (`core/plan/plan-manager.ts`): a representação de intenção mais rica
  do repo — DAG imutável e versionado com `intent`/`dependsOn`/`producesArtifact`/
  `verifyCmd` por step, validação de ciclos, `topoOrder`, sobrevivência à compaction,
  artefato durável em `.pit/plans/`. O `exit_plan` (`permissions/exit-plan-tool.ts`) já
  implementa o padrão de gate com aprovação atômica e fail-closed em headless.
- **Validadores puros, chamáveis fora dos hooks** (achado-chave): `groundPath(input,
  deps)` (`path-grounding.ts:254`) e `checkExistence` via cascade repo-map→LSP
  (`grounding-guard.ts:247,366`) recebem deps injetáveis e não tocam sessão — dá para
  validar cada step de um plano contra a árvore real **sem refactor nenhum**.
- **goal_complete** (`tools/goal-complete.ts:56-101`): o template do gate de review —
  já recusa completion com checks pendentes (R8) ou vermelhos (R7).
- **Fusion verify** (`agent-session-fusion.ts:180`): subagente read-only
  (`read/grep/find/ls/symbol`, maxTurns 6, schema `VERIFICATION_SCHEMA`), veredito
  confirmed/refuted/unverified por claim. Custo: a fatia verify é poucos k tokens (o
  bench de 28k é o pipeline fusion inteiro, com 5 estágios). **É o executor pronto do
  self-review** — chamar `spawnSubagent` direto com prompt+schema de review.
- **patch-audit** (`core/patch-audit.ts:104-138`): scorer de risco de diff puro e
  exportado (write ≥160 linhas → high; ≥120 changed → high; ≥40 → medium) com
  checklists prontas como rubrica. **Gap encontrado: risco é por patch, não por
  agregado do turn — N edits pequenos nunca disparam high.**
- **verificationFixPrompt** (`agent-session.ts:328`): o ponto exato de re-injeção do
  loop de fix — hoje carrega só o tail do stdout; é onde o contrato de convenções (P5)
  se pluga.

### 3.3 Medição e dosagem (para P0)

- **Canal de diagnostics** (`packages/ai/src/utils/runtime-diagnostics.ts`): taxonomia
  com família `guard.*` completa e campo `outcome: "blocked"|"overridden"`
  **desenhado para medir aceitação de guard** — mas: em memória apenas (ring de 200
  eventos), sem timestamp, sem persistência (só dump no modo headless), e a emissão de
  `outcome` é inconsistente entre guards (read-guard/import/erasable emitem;
  grounding/learned-error não).
- **ToolCallStats** (`core/tool-call-stats.ts:41-67`): ring de sequência com
  `toolCallId`, `resultHash` e `isError` por chamada — **a metade que falta do
  correlacionador já existe**; ninguém liga "guard X disparou" ao resultado da chamada
  seguinte.
- **learned-error-store** (`core/learned-error-store.ts`): JSONL por sessão +
  agregação cross-session tolerante a linhas corruptas — o padrão de persistência
  pronto para contadores de eficácia (entries já carregam `matchedRuleId`).
- **Dosagem por tier hoje**: `STRONG_NATIVE_PROVIDERS` **duplicado** em
  `repair-note-policy.ts:22` e `overthink-policy.ts:20`, keyed só em provider string.
  O tipo `Model` já carrega `reasoning`, `contextWindow`, `maxTokens`, `cost` — a
  matéria-prima de um profile central está tipada e não é usada.
- **Labels de sessão**: `RecoverySnapshot` (level + thrash score + clean streak) +
  contagem de verification exhausted + cache-stats já computam um rótulo de qualidade
  de sessão — nunca persistido.

---

## 4. Arquitetura proposta

### P0 — Fundação transversal (pré-requisito de tudo)

**P0a. Termostato de supervisão** (`core/supervision-thermostat.ts`, novo — decisão do
grill, substitui o "capability profile" estático por tier de provider):

Princípio: **força medida na sessão, não presumida por lista.** Nenhuma tabela de
modelos para manter; o nível de supervisão é decidido pelos sinais concretos da saída
do próprio modelo, capturados pelos guards que já existem.

- **Níveis**: `assistido` (proteção máxima) → `padrão` → `leve`. Cada pilar da Band P
  lê o nível corrente e dosa seu comportamento (tabela em §5).
- **Ponto de partida**: todo modelo começa em `padrão` a cada sessão. Única exceção
  fixa no código: providers nativos `anthropic` e `openai` começam em `leve` (lista de
  2 entradas que na prática nunca muda — consolida e substitui o
  `STRONG_NATIVE_PROVIDERS` duplicado em `repair-note-policy.ts:22` e
  `overthink-policy.ts:20`). Override manual em settings existe como exceção, não como
  rotina.
- **Sinais** (todos já capturados hoje): grounding/import/path-grounding block
  (símbolo/arquivo inventado), reprovação no verification gate, oldText mismatch no
  edit-precondition, sinais de thrash do session-recovery. Regras fixas e
  determinísticas: mesmo comportamento → mesmo nível, sempre.
- **Três travas anti-oscilação**:
  1. *Assimetria*: aperta imediatamente num sinal grave; afrouxar exige streak longa de
     ações limpas (padrão do `session-recovery`, que já implementa exatamente essa
     histerese em `noteSignal`/`noteCleanTool`).
  2. *Nunca afrouxa no meio de uma tarefa*: relaxamento só na fronteira entre prompts
     do usuário; dentro de uma tarefa o nível só pode subir.
  3. *Reset por sessão*: nada acumula entre sessões — zero manutenção, zero drift, zero
     lição envelhecida.
- **Relação com a telemetria (P0b)**: o placar grava tudo (inclusive as transições de
  nível), mas **não decide nada entre sessões** — histórico é para análise nossa, não
  para autorregulação.

**P0b. Telemetria de eficácia**:
1. *Sink persistente*: listener em `onDiagnostic` gravando JSONL timestampado por
   sessão em `<agentDir>/diagnostics/` (mesmo padrão do learned-error-store, mesmo
   prune de ≤200 arquivos).
2. *Normalização*: todos os `guard.*` passam a emitir `ruleId` + `outcome` (hoje só 3
   guards emitem outcome).
3. *Correlacionador*: na emissão de um guard-fire, registrar `(ruleId, toolCallId)`;
   no próximo `tool_execution_end` da mesma tool, reconciliar com
   `isError`/`resultHash` do ToolCallStats → contador
   `fired / nextCallSucceeded / overridden` por regra.
4. *Snapshot de sessão*: no shutdown, gravar `RecoverySnapshot` + verification stats +
   cache-stats na mesma lane — o rótulo para análise offline.

Custo: ~zero em runtime (O(1) por evento, o canal já é assim). É o que transforma
"adicionar camadas" de chute em engenharia: **cada pilar abaixo nasce com métrica de
sucesso embutida**.

### P1 — Injeção de verdade (Context Composer)

O pilar de maior alavancagem. Três componentes:

1. **Preditor de relevância** (componente genuinamente novo): decide QUAIS símbolos/
   arquivos o turn vai precisar. Heurística em camadas, sem ML:
   - arquivos citados no prompt do usuário (paths/símbolos extraídos por regex +
     fuzzy contra o repo-map — os matchers `suggestClosest*` já existem);
   - alvo de edit em andamento: quando o modelo lê um arquivo, os imports desse
     arquivo apontam os vizinhos prováveis (o import-grounding já parseia imports);
   - steps do plano ativo (`producesArtifact` do PlanManager, se P2 existir);
   - hot files da sessão (FrequentFilesTracker, já pronto).
2. **Projeção com assinatura**: estender o living-index para reter `kind`+`line`
   (o extrator do tool `repo_map` já faz) e, para os top-K símbolos previstos, buscar
   assinatura real via LSP `hover` — **async, best-effort, com timeout curto**; se o
   LSP não responder a tempo, degrada para nomes (fail-open, nunca bloqueia o turn).
3. **Montador orçamentado**: compõe o bloco sob um teto de tokens dosado pelo nível do
   termostato (`assistido` = até 1.200 tokens, `leve` = 400 ou desligado) e injeta:
   - fatia persistente (outline dos alvos prováveis) → **sufixo dinâmico** (imune a
     prune, custo de cache zero);
   - fatia cirúrgica do turn (assinaturas dos símbolos do edit iminente) → **evento
     `context`**, como mensagem custom (imune a supersede; re-injetada pós-compaction
     pelo padrão memory/hindsight).

Métrica de sucesso (via P0b): taxa de block do grounding-guard e do import-grounding
deve **cair** nos turns com injeção ativa; tokens médios por task completada não podem
subir mais do que o teto orçado.

### P2 — Gate de intenção

Composição de peças existentes, um componente novo:

- **Trigger**: `classifyTaskRigor(prompt).rigor >= N` em `before_agent_start`
  (N dosado pelo nível do termostato: `assistido` → 2, `leve` → 3, configurável).
- **Representação**: micro-plano = versão mínima do `PlanStep` (3-7 steps, `intent` +
  arquivos a tocar). Não exige plan mode completo: o modelo emite via tool `plan`
  (`propose`) que já existe.
- **Validador** (novo, ~200 linhas): para cada step, `groundPath` nos paths citados e
  `checkExistence` nos símbolos citados — as funções são puras, é só montar as deps
  como os adapters fazem (receita documentada em `grounding-guard.ts:432-514`).
  Feedback de falha com os candidatos fuzzy ("step 2 cita `src/utl/helper.ts` — quis
  dizer `src/util/helper.ts`?").
- **Enforcement** (novo, o ponto de decisão do design): um guard `tool_call` que
  bloqueia o **primeiro** write/edit do prompt-cycle enquanto não houver plano validado
  — fire-once, fail-open (LSP fora → valida só paths), opt-out
  `PIT_NO_INTENT_GATE`, e **nunca** ativo em rigor < N ou em prompts triviais.
- **Entrega dos nudges**: steering engine com `deliverAs:"steer"` + latch one-shot
  (padrão da narração do session-recovery, copiável).

Risco principal: fricção em falso-positivo de classificação. Mitigação: começar como
**nudge não-bloqueante** (steer "valide seu plano") medido por P0b; promover a block
apenas se a telemetria mostrar que o nudge é ignorado e o block salva turns.

### P3 — Ancoragem por exemplar

- **Recuperação**: dado o alvo do edit, achar o análogo — mesmo diretório/sufixo de
  nome (test↔test, extension↔extension), símbolos com mesmo kind via repo-map, ou
  definition de um uso existente via LSP. Começar simples: o vizinho de diretório com
  kind igual já cobre a maioria dos casos reais (foi exatamente assim que os agentes
  desta sessão acertaram o estilo do repo: lendo o teste vizinho antes de escrever).
- **Injeção**: 10-30 linhas do exemplar via evento `context`, marcado "referência de
  estilo — siga densidade de comentário, naming e idioma", **apenas** quando um
  write/edit está iminente (o read do alvo é o sinal) e apenas nos níveis `assistido`
  e `padrão` do termostato.
- É o pilar mais barato de construir depois que P1 existir (reusa o preditor e o
  montador) — e o de efeito mais direto em "código com a cara do projeto".

### P4 — Self-review estruturado

- **Trigger**: `auditPatchResult` por patch **+ novo agregador por turn** (soma de
  changed lines do turn — fecha o gap encontrado). Mudanças grandes disparam em
  qualquer nível do termostato; médias disparam apenas no nível `assistido` (decisão
  do grill).
- **Executor**: `spawnSubagent` read-only no padrão fusion-verify (allowedTools de
  leitura, maxTurns 6, schema com findings `{claim, severity, evidence, verdict}`),
  recebendo só o diff + o contrato P5 + a checklist do patch-audit como rubrica.
  Custo estimado: poucos k tokens por review — só em diffs high, não em todo turn.
- **Gate**: findings high não resolvidos entram no fluxo do verification gate
  (re-injeção shaped como `verificationFixPrompt`, budget de attempts compartilhado) e
  bloqueiam `goal_complete` pelo mesmo mecanismo R7/R8 que já existe.
- A checklist atual do patch-audit permanece como camada base em todos os casos que
  não disparam a revisão real.

### P5 — Contrato de convenções

- **Extração**: quando o verification gate reprova, destilar a *regra* violada — para
  lint/typecheck isso é estruturado no próprio output (rule id do biome, código TS).
  Sem LLM na v1: parse dos formatos conhecidos; genérico fica para depois.
- **Persistência na sessão**: `SessionContract` — lista pequena (cap ~5 itens) de
  restrições ativas ("este projeto: `erasableSyntaxOnly` — sem enums";
  "imports com extensão `.ts`"), com dedupe e expiração por clean streak (padrão
  session-recovery).
- **Injeção**: sufixo dinâmico (persistente, custo zero de cache). Cross-session
  depois: a versão agregada pode viver no learned-error-store pattern.
- É o complemento do learned-errors: aquele memoriza *chamadas* que falharam; este
  memoriza *convenções* violadas.

---

## 5. Dosagem pelo termostato (o princípio unificador)

Cada pilar lê o **nível corrente do termostato** (não uma classe fixa de modelo) e
escala. Lembrete do fluxo: todo modelo entra em `padrão` (Claude/GPT nativos em
`leve`); sinais ruins sobem o nível na hora; streaks limpas descem o nível apenas em
fronteira de tarefa.

| pilar | `assistido` (proteção máx.) | `padrão` (entrada) | `leve` |
|-|-|-|-|
| P1 injeção | teto ~1.200 tokens | ~800 | ~400 (off se a medição mostrar efeito nulo) |
| P2 gate de intenção | **bloqueia** o 1º edit sem plano validado (rigor ≥ 2) | aviso em rigor 2, bloqueio em rigor 3 | aviso em rigor 3 |
| P3 exemplar | on | on | off |
| P4 revisor | mudanças **médias e grandes** | mudanças grandes | mudanças grandes |
| P5 contrato | on | on | on (barato e universal) |

Decisões do grill embutidas na tabela: revisão real nas mudanças grandes vale para
TODOS os níveis (inclusive `leve`); o nível `assistido` adiciona as médias. O gate P2
bloqueia nos níveis protegidos e avisa no `leve`.

A contraintuição que a tabela codifica: **quanto mais supervisão o comportamento pede,
mais verdade no contexto e menos instrução solta**; no nível `leve`, menos de tudo — o
overhead vira ruído. O repair-note já pratica isso como exceção; a Band P o torna
política, com a diferença (decidida no grill) de que o nível é *conquistado pelo
comportamento na sessão*, nunca presumido por lista de modelos.

---

## 6. Custos e riscos

| risco | mitigação |
|-|-|
| **Inflação de tokens** (P1/P3 competem com o trabalho do token-economy) | tetos orçados por tier; medir com cache-stats (`promptTokens`/turn) + gate de regressão no token-bench como já fazemos com serialize_* |
| **Latência de LSP** no caminho do turn | tudo best-effort com timeout curto; injeção degrada para nomes; nunca bloqueia o send |
| **Cache thrash** | só as duas lanes cache-neutras; `_trackPrefixStability` como verificação contínua |
| **Fricção do gate P2** em classificação errada | nascer como nudge; promover a block guiado por telemetria P0b; fail-open sempre; opt-out por env |
| **Conteúdo injetado podado/superseded** | não usar a lane de tool_result; re-injeção pós-compaction (padrão existente) |
| **Sobrecarga de instrução** (o modelo afoga) | P5 com cap de 5 itens; P1 substitui prosa por dados (assinaturas ocupam menos "atenção" que regras); dosagem por tier |
| **Review P4 alucinar findings** | schema fechado + verdict com evidence obrigatória + budget compartilhado com o verification gate (não cria loop novo) |

Custo de construção honesto: os quatro componentes novos (preditor, montador,
correlacionador, sink) são pequenos individualmente (~200-500 linhas cada), mas o
sistema só entrega valor com a composição correta — a complexidade está na
integração com compaction/prune/cache, não no código novo. Por isso o roadmap abaixo
começa pela medição.

---

## 7. Roadmap faseado

**Fase 0 — Medir antes de condicionar** (esforço: baixo-médio) — **ENTREGUE 2026-07-02**
(sink JSONL + correlacionador de eficácia + snapshot de sessão + termostato observe-only
com transições em `quality.supervision`; `ruleId`/`outcome` normalizados nos 11 guards;
timestamps no canal de diagnostics)
Sink JSONL de diagnostics + normalização de `outcome`/`ruleId` nos guards +
correlacionador guard→resultado + snapshot de sessão + **esqueleto do termostato**
(níveis definidos, sinais ligados, transições gravadas no placar — ainda sem nenhum
consumidor mudando comportamento, para observarmos as transições em sessões reais antes
de qualquer pilar obedecê-las).
*Critério de saída: (a) responder "qual guard dispara mais e quantas vezes o disparo
salvou o call seguinte" sobre sessões reais; (b) as transições de nível do termostato,
observadas passivamente, parecem certas — sem oscilação, apertando quando devia.*

**Fases 1-3 — ENTREGUES 2026-07-03** (decisão do mantenedor: implementar tudo e validar
durante o uso, já que o placar da Fase 0 instrumenta cada pilar desde a primeira sessão;
kill-switch individual por pilar). Nota de integração: o bloqueio procedural
`intent-gate-no-plan` foi excluído dos sinais de aperto do termostato — apertar porque o
modelo ainda não escreveu o plano seria um loop injusto; `intent-gate-plan-findings`
(caminho alucinado no plano) aperta normalmente.

**Fase 1 — P1 mínimo + P5** (esforço: médio)
Living-index com kind+line; injeção de outline dos alvos prováveis no sufixo dinâmico
(evolução do `PIT_FREQ_OUTLINE`, ligada por padrão para tier ≤ mid); assinaturas LSP dos
símbolos do arquivo recém-lido via evento `context`; SessionContract v1 (lint/TS parse).
*Critério: queda mensurável (P0b) nos blocks de grounding/import-grounding e nas
reprovações repetidas do verification gate, sem regressão no token-bench.*

**Fase 2 — P2 nudge→block + P4** (esforço: médio-alto)
Micro-plano com validação pura contra a árvore (nudge primeiro); agregador de risco por
turn; review subagent para diffs high com gate no goal_complete.
*Critério: taxa de first-pass do verification gate sobe; turns-até-done em tarefas rigor
3 cai; fricção (blocks falsos do gate) < 5% dos disparos.*

**Fase 3 — P3 + preditor v2** (esforço: médio)
Exemplares por vizinhança; preditor incorporando imports do alvo e steps do plano.
*Critério: aderência de estilo (proxy: findings de review P4 da categoria "estilo/idioma"
caem) e avaliação qualitativa nossa.*

Cada fase é independente e reversível (kill-switch por env + setting por seção, nos
padrões existentes). A ordem importa: **Fase 0 primeiro** — sem ela estaríamos
adicionando camadas às cegas, que é exatamente o que a auditoria anterior nos ensinou a
não fazer.

---

## 8. Decisões (grill de 2026-07-02)

Todas as questões abertas foram decididas em sessão de grill com o mantenedor:

1. **Ordem de construção**: Fase 0 (medição) primeiro, sozinha. Nada de condicionar às
   cegas.
2. **Persistência da telemetria**: só local, um arquivo por sessão (padrão
   learned-errors, com prune automático). Boletim versionado no repo pode nascer
   depois, em cima disso.
3. **Público-alvo**: prioridade é subir o nível dos modelos frágeis/menos confiáveis
   (ex.: DeepSeek, GLM, Kimi — e o mantenedor inclui o Gemini nesse grupo de menor
   confiança). Regra de ouro: nos modelos fortes, cada recurso deve ser **neutro ou
   positivo comprovado** — nunca prejudicial.
4. **Teto de tokens do P1**: 1.200/800/400 por nível do termostato, validado contra o
   token-bench na Fase 1.
5. **Gate de intenção (P2)**: bloqueia nos níveis protegidos (`assistido`, e `padrão`
   em rigor 3), avisa no nível `leve`. Se a medição mostrar bloqueios falsos demais,
   afrouxa-se com dados.
6. **Revisor (P4)**: revisão real para TODOS nas mudanças grandes; o nível `assistido`
   adiciona as mudanças médias.
7. **Contrato de convenções (P5)**: só na sessão na v1; promoção a cross-session
   guiada pela medição (regras que se repetem entre sessões são candidatas).
8. **Dosagem = termostato na sessão** (a decisão estrutural, revisada duas vezes no
   grill): nada de lista de modelos para manter e nada de reputação acumulada entre
   sessões — o mantenedor considerou a autorregulação cross-session arriscada e
   oscilante. Nível conquistado pelo comportamento na própria sessão, regras fixas,
   três travas anti-oscilação, reset por sessão. Únicas exceções fixas: `anthropic` e
   `openai` nativos começam em `leve`. Detalhe em §4-P0a.
9. **Mapa oficial**: a Band P entra no `prevention-layers.md` desde já, marcada como
   **planejada/em construção**, virando "ativa" pilar a pilar conforme as fases
   entregam.
