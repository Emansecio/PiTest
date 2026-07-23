# Propostas de fronteira — sobreposição temporal, antecipação e consciência externa

> **Criado:** 2026-07-22 · **Revisão v2 (auditada contra o código):** 2026-07-23
> **Status:** proposta (nenhum item implementado)
> **Companions:** [`docs/agents/already-built.md`](../agents/already-built.md) (o que já existe),
> [`docs/optimization/context-economy-inventory.md`](../optimization/context-economy-inventory.md)
> (backlog K1–K10), [`Taxonomia.md`](../../Taxonomia.md) (as 12 áreas),
> [`docs/CONTEXT.md`](../CONTEXT.md) (invariantes arquiteturais).

## O que mudou na revisão v2

A v1 foi escrita a partir dos mapas curados (`already-built.md`, inventário K). A v2
resulta de **quatro varreduras profundas no código-fonte** (uma por par de
propostas), com cada âncora verificada. Correções relevantes:

- **P2 reenquadrada** — compaction em background pós-turno **já existe**
  (`checkCompaction(..., allowBackground=true)` + `backgroundCompactionPromise`).
  A proposta deixa de ser "criar background compaction" e passa a ser "estender
  para mid-turn (entre rodadas de tools) + idle, com pré-computação ancorada".
- **P8 ganhou um pré-requisito** — o `verifyCmd` dos steps de plan é **só
  advisory** hoje: nada o executa. A "rede de segurança" do gearbox precisa
  primeiro existir (P8a, entrega independente com valor próprio).
- **P7 ganhou um ponto de integração obrigatório** — `AgentSession.setModel`
  **não** reconstrói o system prompt; a seleção de perfil exige instrumentar
  essa rota.
- **P4 e P6 viram built-in extensions** — o invariante arquitetural do projeto
  (features comportamentais vivem em extensions, não inline em
  `agent-session.ts`) se aplica diretamente; a superfície `pi.on("tool_result")`
  já entrega tudo que elas precisam.
- Âncoras desatualizadas corrigidas (ex.: `PRESEND_OVERFLOW_RATIO` está em
  `agent-session-compaction.ts:72/:81`, não na linha ~38 citada no inventário).

## Por que este documento existe

O Pit atingiu maturidade no "básico avançado": economia de contexto (K1–K10),
guards em camadas, tool repair, Fusion, memória/hindsight, compaction com
grounding anti-alucinação, execução paralela de tools, steering engine,
verification in-turn. Cada proposta abaixo foi verificada contra
`already-built.md`, contra o inventário K **e contra o código** — nenhuma
re-propõe algo que já ships.

O valor novo se concentra em eixos que o Pit ainda não explora:

| Eixo | Ideia central | Propostas |
|------|---------------|-----------|
| **Sobreposição temporal** | Trabalhar durante o *stream* do provider e durante o *idle* do usuário — janelas hoje desperdiçadas | P1, P2, P3 |
| **Antecipação** | Prever a próxima ação do modelo e preparar o resultado antes do pedido | P6 |
| **Consciência externa** | O repo muda fora da sessão; o Pit não percebe proativamente | P4 |
| **Alavancagem pequena / uplift** | Mecanismos pequenos de efeito desproporcional | P5, P7, P8 |

Restrições de produto (estilo do projeto):

- **Nativo** — sem serviços externos, sem dependências novas pesadas.
- **On-by-default com kill-switch `PIT_NO_*`** — documentado em
  [`docs/token-economy-tuning.md`](../token-economy-tuning.md) quando tocar economia.
- **Sem telemetria nova** — diagnósticos via `recordDiagnostic` existente;
  medição via benches existentes (`bench-session-tokens.mts`, `bench-prompt-size.mts`).
- **Extensions primeiro** — onde a proposta é comportamental, implementa-se
  como built-in extension (invariante de `docs/CONTEXT.md`), não inline na sessão.
- **Implementável hoje** — cada proposta traz o caminho com âncoras `file:line`
  verificadas em 2026-07-23.

---

## P1 — Execução especulativa de tools durante o stream

**Área:** 1 Harness/runtime · **Eixo:** velocidade · **Kill-switch:** `PIT_NO_SPECULATIVE_TOOLS`

### O que existe hoje (verificado)

- **A execução só começa depois do stream terminar.** `runLoop`
  (`packages/agent/src/agent-loop.ts:499-548`) consome `streamAssistantResponse`
  até a mensagem final; só então chama `executeToolCalls(...)`
  (`agent-loop.ts:563-564`). Nenhum tool executa durante o stream.
- **O evento que a proposta precisa já existe.** O stream de provider emite
  `toolcall_end` (`packages/ai/src/types.ts:389`) com o `toolCall` **completo**
  (args fechados), por call, antes do evento terminal `done`. O agent-loop já
  vê esse evento no `case` agrupado de boundaries
  (`agent-loop.ts:1004-1037`, `toolcall_end` na linha ~1009) — hoje só faz
  flush de deltas e emite `message_update`.
- **A partição parallel-safe é por tool, não por allowlist central**:
  `AgentTool.executionMode?: "sequential" | "parallel"`
  (`packages/agent/src/types.ts:577`; default parallel). Declaram-se
  sequenciais: `exit_plan` (`exit-plan-tool.ts:148`), `ask` (`tools/ask.ts:145`),
  `debug` (`tools/debug.ts:533`), `message` (`tools/message.ts:71`).
  Roteador `executeToolCalls` (`agent-loop.ts:1146-1175`) → três executoras
  (`Sequential` :1202, `Parallel` :1290, `Partitioned` :1385). Kill-switch
  precedente: `PIT_NO_BATCH_PARTITION` (`agent-loop.ts:1139-1144`).
- **Todo o funil de guards está em `prepareToolCall`**
  (`agent-loop.ts:1683-1822`), na ordem: aliases (`prepareToolCallArguments`)
  → `toolRewriteRegistry.apply` (auto/suggest/block) → `repairToolArguments`
  → `validateToolArguments` → **`config.beforeToolCall`** (:1752-1803, com
  block/abort/revalidação pós-mutação). As três executoras chamam
  `prepareToolCall` de forma idêntica — o contrato de guard é uniforme.
- **A emissão de resultados é deliberadamente serial e em ordem original**
  (`agent-loop.ts:1352-1358`): listeners persistem mensagens mutando o
  ponteiro-folha da sessão; emissão concorrente intercalaria `message_end` no
  JSONL. Qualquer especulação tem de respeitar isso.
- **Abort:** `makePerToolSignal` (`agent-loop.ts:1189-1200`) combina o signal
  do run com um controller por-tool via `AbortSignal.any`;
  `raceToolExecute` (:1893-1910) desbloqueia o loop mesmo se a tool ignorar o
  signal.

### O gap exato

Entre o `toolcall_end` do call N e o `done` da mensagem há uma janela morta —
grande quando o modelo escreve prosa após os calls, emite vários calls, ou o
provider está lento no tail. Num turn típico de exploração (3–5 reads), todo o
I/O poderia caber dentro dessa janela.

### Design

1. **Marcar elegibilidade na tool, não em lista central.** Novo campo opcional
   `speculationSafe?: boolean` em `AgentTool` (`packages/agent/src/types.ts`,
   ao lado de `executionMode`). No coding-agent, `wrapToolDefinition` /
   `buildTool` (`core/tools/index.ts:640`) seta a partir do `readOnly: true` do
   `TOOL_REGISTRY` (`tools/index.ts:182-207`) — read/grep/find/ls/symbol/
   find_symbol/repo_map/lsp. Tools sequenciais e mutantes nunca especulam.
2. **Disparo no `case "toolcall_end"`** de `streamAssistantResponse`
   (`agent-loop.ts:~1009`): se `PIT_NO_SPECULATIVE_TOOLS` ausente e a tool é
   `speculationSafe`, chamar **o mesmo `prepareToolCall`** e, se preparado com
   sucesso, `executePreparedToolCall` com um **emitter mudo** — nenhum evento
   `tool_execution_start/end` sai nesse momento (ordem do transcript
   preservada). Resultado vai para um `SpeculativeBatch: Map<toolCallId,
   Promise<PreparedOutcome>>` carregado no config do loop.
3. **Consumo no fluxo normal.** Em `executeToolCalls`, antes de preparar um
   call, consultar o `SpeculativeBatch`: hit → `await` do resultado bufferizado
   e **emissão síncrona dos eventos** (start/end) na posição correta; miss →
   caminho atual. Crucial: o call especulado **não** passa de novo por
   `prepareToolCall` — hooks com efeito colateral (grounding fire-once,
   read-guard) rodariam duas vezes.
4. **Abort e descarte.** As promises especulativas nascem sob o signal do run
   (`makePerToolSignal`); abort do stream/turn cancela. Se a mensagem final
   vier sem aquele call (edge de provider), o resultado é descartado — reads
   são idempotentes e sem efeito observável.
5. **Interação com steering/stats:** contadores (`ToolCallStats`, doom-loop,
   retry budget) são alimentados pelos eventos — como os eventos só saem no
   consumo, a contabilidade permanece idêntica ao fluxo atual.

### Sequência de entrega

1. Campo `speculationSafe` + plumbing registry → `AgentTool` (mudança inerte).
2. `SpeculativeBatch` + disparo no `toolcall_end` + consumo nas executoras,
   atrás de `PIT_NO_SPECULATIVE_TOOLS`.
3. Cobertura: turn com prosa após calls; abort mid-stream; call especulado que
   o guard bloqueia (block deve valer no consumo); miss de batch.

### Riscos e mitigação

- *Dupla execução de hooks* — resolvido por construção (item 3: consumo nunca
  re-prepara).
- *Reordenação do transcript* — resolvido pelo emitter mudo + emissão no consumo.
- *Permission prompt no meio do stream* — tools `speculationSafe` são as
  read-only já permitidas; um `beforeToolCall` que exigiria interação retorna
  block e o call cai para o fluxo normal no consumo.

**Esforço:** médio. É a proposta mais invasiva no loop (toca `@pit/agent-core`
e o contrato de eventos) — mas o funil único de `prepareToolCall` reduz o risco
a um problema de *timing*, não de *semântica*.

---

## P2 — Compaction especulativa: mid-turn e idle (revisada)

**Área:** 3 Context economy · **Eixo:** velocidade percebida + UX · **Kill-switch:** `PIT_NO_SPECULATIVE_COMPACTION`

### O que existe hoje (verificado — e que a v1 subestimava)

- **Background compaction pós-turno JÁ SHIPS.** `_handlePostAgentRun`
  (`agent-session.ts:3736`) chama `checkCompaction(this.compaction, msg, true,
  /*allowBackground*/ true)` (:3765). Na banda soft
  (`shouldStartBackgroundCompaction`, `agent-session-compaction.ts:180`;
  multiplicador `COMPACT_SOFT_RATIO = 1.5`, :160; `shouldCompactSoft` em
  `compaction.ts:601`), `runAutoCompaction` roda **sem await**, guardado em
  `ctx.backgroundCompactionPromise` (:940-945), e é joinado por
  `awaitBackgroundCompaction` antes do próximo prompt (`agent-session.ts:3725`
  e :4865).
- **O caminho hard continua bloqueante**: `checkPresendOverflow`
  (`agent-session-compaction.ts:702`, avaliada em `agent-session.ts:1709` e
  :4975) e `checkCompaction` síncrona no send path (:1699, :4872) →
  `runAutoCompaction` → `compact()` (`compaction/compaction.ts:3050`) → LLM em
  `generateSummary` (:2407). Ratio: `DEFAULT_PRESEND_OVERFLOW_RATIO = 0.95`
  (`agent-session-compaction.ts:72`), dinâmico via
  `resolveDynamicPresendOverflowRatio` (:98), floor 0.88 (:86).
- **Mid-turn não há presend nem background**: entre rodadas de tools o
  `agent-loop` só roda `transformContext` — é o gap **B9 (VALID)** do
  inventário. Um turn longo (muitas rodadas de tools) cruza a banda soft e
  chega ao hard **dentro do turn**, onde a pausa é inevitável hoje.
- **A aplicação é separável da geração**: `compact()` retorna
  `{ summary, firstKeptEntryId, tokensBefore, details }` (:3252-3257); a
  aplicação é `sessionManager.appendCompaction(...)` + `buildSessionContext()`
  + `agent.state.messages = ...` (`agent-session-compaction.ts:538-546`). O
  recorte incremental **não** é por índice: `prepareCompaction`
  (`compaction.ts:2790`) deriva o boundary de `firstKeptEntryId` da
  `CompactionEntry` anterior (:2810-2818), e `serializeConversationDelta`
  (`compaction/utils.ts:800`) recebe `Message[]`, não offset.
- **Modelo barato já resolvido**: `resolveCompactModel`
  (`agent-session-compaction.ts:411`) — role `compact` configurado, senão
  sibling pequeno same-provider (`COMPACT_SIBLING_MARKERS =
  ["haiku","mini","nano","flash","lite"]`, `model-resolver.ts:316`), fail-open
  para o modelo da sessão.
- **Sinal de idle existe**: `isIdle: () => !this.isStreaming` exposto ao host
  de extensões (`agent-session.ts:5955`). O gancho de fim de turno é
  `_handlePostAgentRun` (:3736); não existe hoje nenhum scheduler de idle.

### O gap exato (o que sobra depois de reconhecer o que existe)

1. **Mid-turn**: nenhuma avaliação de compaction entre rodadas de tools — o
   hard mid-turn bloqueia na cara do usuário (e é o momento mais comum de
   estouro em turns de execução longa).
2. **Pré-computação ancorada**: o background de hoje **compacta de verdade**
   (aplica). Não existe "gerar o summary agora, aplicar depois" — que é o que
   permitiria atravessar o threshold hard com custo zero de pausa.

### Design

1. **Presend entre rodadas** (resolve B9 junto): expor um callback
   `onToolRoundEnd` do loop para a sessão (ou usar o hook de tool-end já
   existente) que roda a mesma avaliação de `shouldStartBackgroundCompaction`
   com um ratio mid-turn (~0.92). Disparo positivo → **pré-computação**, não
   compaction aplicada.
2. **Pré-computação ancorada em entry**: rodar `compact()` até o retorno
   (summary + verify + grounding completos — `buildVerificationSource`
   `compaction.ts:2612` e `groundSummaryPaths` `summary-grounding.ts:107` já
   fazem parte do pipeline), guardando
   `{ summary, firstKeptEntryId, tokensBefore, details, anchorEntryId }` num
   slot `pendingPrecomputedCompaction` do `CompactionController` (ao lado de
   `backgroundCompactionPromise`, :245).
3. **Aplicação apply-only**: quando o threshold real chega (hard ou presend),
   se existe pré-summary cujo `firstKeptEntryId` ainda é um boundary válido da
   sessão, aplicar direto (`appendCompaction` + `buildSessionContext`). As
   mensagens entre o anchor e o presente **permanecem na janela** — exatamente
   a semântica atual de `firstKeptEntryId`. Anchor inválido (branch/rewind/
   compact manual no meio) → descartar e seguir o fluxo normal.
4. **Idle como segundo disparador**: timer curto (~2s após `agent_end`,
   guardado por `!isStreaming` e cancelado por input) roda a mesma avaliação.
   Cobre o caso "sessão parada a 80% e o próximo prompt do usuário será
   grande".
5. **Concorrência**: um pré-summary por vez; `backgroundCompactionPromise`
   (compaction real) tem prioridade — se ela está em voo, não pré-computar.

### Riscos e mitigação

- *Gasto desperdiçado* — gate alto + `resolveCompactModel` barato + no máximo
  um pré-summary pendente; descarte é o único custo.
- *Summary stale* — validade por `anchorEntryId`/`firstKeptEntryId` (mesma
  âncora que a compaction incremental já usa), com fallback total ao fluxo
  atual.
- *Interferência com o background existente* — o slot novo é subordinado:
  nunca roda em paralelo com `runAutoCompaction`.

**Esforço:** médio-baixo — a v2 é *menor* que a v1 porque o pipeline, o modelo
barato e o join já existem; o novo código é o gatilho mid-turn, o slot de
pré-computação e a validação de anchor.

---

## P3 — Keepalive do prompt cache (TTL refresh)

**Área:** 3 Context economy · **Eixo:** economia direta · **Kill-switch:** `PIT_NO_CACHE_KEEPALIVE`

### O que existe hoje (verificado)

- **4 breakpoints Anthropic, todos derivados puramente do `Context`**
  (`{ systemPrompt?, messages, tools? }`, `packages/ai/src/types.ts:365`), em
  `buildParams(model, context, isOAuthToken, options?)`
  (`providers/anthropic.ts:975`): tools (último tool name-sorted,
  `convertTools` :1335), system-static (:1016-1028; rota OAuth :1005-1015),
  last-user (`convertMessages` :1257-1279) e compaction-summary (:1286-1297).
  **Mesmo `Context` ⇒ prefixo e breakpoints idênticos por construção.**
- **Retenção é variável**: `getCacheControl` (`anthropic.ts:47`) usa TTL `"1h"`
  quando `supportsLongCacheRetention` (:55) — nesses modelos o problema quase
  desaparece; o alvo do keepalive é a retenção padrão de ~5 min.
- **A chamada de ping já tem forma pronta**: `completeSimple(model, context,
  options)` (`packages/ai/src/stream.ts:97`) com `SimpleStreamOptions`
  (`maxTokens: 1`, `apiKey`, `headers`) — a mesma forma usada pela
  summarização (`createSummarizationOptions`, `compaction.ts:2371-2372`).
  Alternativa de precisão: hook `options.onPayload?.(params, model)`
  (`streamAnthropic` :552-555) para forçar `max_tokens: 1` sem tocar no builder.
- **Gate de tamanho pronto**: `getContextUsage()` (`agent-session.ts:7019`)
  expõe `wireTokens`; `estimateWireTokens` (`compaction.ts:278`) devolve
  `systemTokens`/`toolTokens` separados (:331-338).
- **Canal de observabilidade pronto**: `recordDiagnostic` no padrão de
  `compaction.presend-overflow-guard` (`agent-session-compaction.ts:778-786`);
  `computeCacheStats` (`cache-stats.ts:55`) já mede hit-rate/instabilidade a
  partir de `usage`.

### Fundamentação econômica

Prefixo típico de sessão madura: 20–50k tokens. Expirou → o turn seguinte
re-escreve a **1.25×** o preço base. Ping de 1 token re-lê a **0.1×** e renova
o TTL. Um ping custa ~8% da re-escrita que evita; o break-even é imediato para
qualquer retorno do usuário entre 5 e ~15 min. É a proposta mais mensurável da
lista — aritmética, não estimativa.

### Design

1. **Agendador**: ao entrar em idle (`agent_end`, `!isStreaming`), timer aos
   ~4min30; a cada disparo, ping e reagendamento; **cap de 2–3 pings** (cobre
   ~15 min; depois assume ausência e deixa expirar). Input do usuário cancela —
   o turn real é o próprio refresh.
2. **Gates**: (a) provider anthropic com retenção curta — pular quando
   `supportsLongCacheRetention`; (b) `wireTokens ≥ ~15k`; (c) sem
   `backgroundCompactionPromise`/pré-summary em voo que vá mudar a janela.
3. **Contexto do ping**: exatamente `agent.state` corrente via a mesma
   montagem do send path — **nada** é adicionado ao histórico; a chamada é
   descartada (fora do transcript), então o prefixo é idêntico por construção.
   Implementação no nível da sessão (que tem auth/headers), chamando
   `completeSimple` com `maxTokens: 1`.
4. **Diagnóstico**: categoria `cache.keepalive` (`{ pings, savedEstimate }`)
   via `recordDiagnostic` — sem telemetria nova.

### Riscos e mitigação

- *Gastar com usuário ausente* — cap de pings + gate de tamanho.
- *Ping invalidar o cache* — impossível por construção (mesmo `Context`).
- *Corrida com background compaction* — gate (c): se a janela vai mudar, o
  prefixo antigo não vale a pena manter vivo.

**Esforço:** baixo. Um timer, três gates e uma chamada mínima. Primeiro da fila.

---

## P4 — Sentinela de edições externas

**Área:** 5 Guards/prevention · **Forma:** built-in extension · **Kill-switch:** `PIT_NO_EXTERNAL_EDIT_SENTINEL`

### O que existe hoje (verificado)

- **O check atual é reativo e só no momento da mutação** ("stale-read note"):
  `edit.ts:470-486` compara `mtimeStore.get(path)` com o stat atual e injeta
  nota "changed on disk since you last read it" — mas **o edit aplica mesmo
  assim**, e só quando o modelo já decidiu mutar aquele arquivo. Idem
  `write.ts:316-321` e `edit-hashline.ts:279-284`. O próprio código registra
  que "a timestamp is not a content identity" (`edit.ts:386`).
- **O store `path→mtime` por sessão já existe**: `FileMtimeStore`
  (`core/tools/file-mtime-store.ts`, LRU 256, `get`/`set`/`refreshFileMtime`),
  instância única em `agent-session.ts:918`, escrita por read
  (`read.ts:908,953,973,1024,1246`), edit (:514), edit_v2
  (`edit-hashline.ts:315`) e write (:276,:341). O refresh pós-write é
  exatamente o discriminador "foi o Pit que escreveu".
- **Handler central pós-tool existe**: `_handleToolExecutionEnd`
  (`agent-session.ts:2312`; args recuperados via `_toolCallArgsByCallId`,
  :2309/:2322), com `extractToolFileOp` (`compaction/utils.ts:109`) já
  extraindo `{path, op}` — **mas só reconhece `read`/`write`/`edit`, não
  `edit_v2`/`ast_edit`** (armadilha real; o conjunto amplo é
  `MUTATING_TOOL_NAMES`, `agent-session-tool-end.ts:12`).
- **Canal de injeção pronto**: `AgentSession.sendCustomMessage`
  (`agent-session.ts:5248`) com `deliverAs: "nextTurn"` empilhando em
  `_pendingNextTurnMessages`, drenado na montagem do turno
  (`agent-session.ts:4917-4921`) — imediatamente antes está o ponto ideal do
  sweep (~:4903, depois das guardas de streaming :4827-4840).
- **Extensões têm a superfície completa**: `pi.on("tool_result")` (payload
  tipado `ReadToolResultEvent` etc., `extensions/types.ts:878-935`),
  `turn_start`/`before_agent_start` (:1156-1160) e `context.sendMessage`
  (→ `sendCustomMessage`, `agent-session.ts:7215`).
- **O `ReadDedupeStore` não tem invalidação por entrada**: só `clear()` global
  e `pruneExcept(keepSet, isStale)` (`read.ts:121,:132-141`).

### O gap exato

Nada avisa o modelo *proativamente*. O fluxo real deste repo (Pit rodando do
src vivo, edições humanas paralelas) produz o ciclo: modelo confia no read
antigo → edit → stale-note (ou pior, sobrescrita) → re-read → re-edit. Um turn
inteiro queimado por informação que a sessão já tinha como detectar.

### Design (como built-in extension `external-edit-sentinel`)

1. **Registro**: `pi.on("tool_result")` mantém um mapa próprio
   `path → { mtimeMs, size }` para todo read/edit/edit_v2/write/ast_edit
   bem-sucedido (não depender de `extractToolFileOp`; usar os nomes do
   `MUTATING_TOOL_NAMES` + read). `size` entra como segundo discriminador
   barato porque mtime não é identidade de conteúdo.
2. **Sweep**: em `before_agent_start` (uma vez por turno de usuário; pular em
   continuação de goal — `_inGoalContinuation`, `agent-session.ts:3861`),
   `stat` paralelo sobre os paths registrados (dezenas de arquivos →
   single-digit ms). Divergência de mtime **e** (size ou hash quando
   disponível) vs o último valor registrado **e** vs `FileMtimeStore.get(path)`
   (para não acusar a própria escrita do Pit) → candidato.
3. **Entrega**: uma única nota agregada via `context.sendMessage(...,
   { deliverAs: "nextTurn" })`:
   `«3 arquivos mudaram fora da sessão desde a última leitura: src/foo.ts (+42s), … Releia antes de editar.»`
4. **Invalidação do dedupe**: novo método `ReadDedupeStore.invalidatePath(canonicalPath)`
   (espelha o laço de `pruneExcept`, `read.ts:134-141`, filtrando por
   `pathFromDedupeKey`) — o próximo read volta completo, não delta.
5. **Supressão de ruído**: silenciar quando a mudança externa é seguida de
   novo read antes do sweep; agrupar rajadas (formatter em save-hook); cap de
   uma nota por turno.

### Riscos e mitigação

- *Falso positivo com write do próprio Pit* — duplo check contra
  `FileMtimeStore` (refresh pós-write já existe em todas as tools mutantes).
- *mtime preservado por tooling* — o par (mtime,size) cobre o caso comum;
  hash opcional via `hashFile` (`file-stamps.ts:70`) só para candidatos.
- *Custo do sweep* — proporcional aos arquivos tocados na conversa, com cap
  (ex.: 128 paths mais recentes).

**Esforço:** baixo. Zero mudanças no loop; uma extension + um método novo no
`ReadDedupeStore`.

---

## P5 — `/pin`: contexto imune a esquecimento

**Área:** 3 Context economy + 10 TUI · **Eixo:** UX/inteligência · **Kill-switch:** dispensável (opt-in por natureza)

### O que existe hoje (verificado)

- **Proteção é só por recência, nunca por importância**:
  `computePruneProtectFromIndex` (`compaction.ts:1536-1551`) protege turnos
  recentes — é o análogo exato do que pins fariam por identidade.
- **Chokepoint único para supersede**: `planContextPrune` (`compaction.ts:993`)
  → `buildSupersededToolResultIndices` (:1524) é a fonte de verdade
  compartilhada por **live-prune e compaction** (o header de
  `agent-session-live-prune.ts:4-11` declara isso explicitamente — não há
  allowlist local lá). Mas supersede não é o único mecanismo: no mesmo laço
  rodam prune-por-tamanho (`compaction.ts:1934`) e elisão de args de mutação
  (:1904-1923; live: `elideMutatingToolCallArguments`).
- **Injeção junto ao summary tem dois pontos naturais**: (a) concatenar ao
  `summary` antes de `appendCompaction`
  (`agent-session-compaction.ts:538-546`) — onde `compact()` já anexa footers
  (`formatFileOperations` `compaction.ts:3211`, digests :3240, recall-history
  :3249); (b) materializar na conversão da entry `"compactionSummary"` em
  mensagem (`session-manager.ts:780-822`).
- **Precedente de seção per-turn no system prompt**: goal/todo/plan são
  appendados por turno em `agent-session.ts:4952-4965` — depois do marker
  dinâmico, logo **sem invalidar o prefixo cacheado**.
- **Padrão de persistência pronto**: `appendCustomEntry("goal",
  goal.serialize())` (`agent-session.ts:3205-3214`) com restore varrendo a
  última entry (:3306-3332). Todo e plan usam o mesmo padrão (:3285,:3293).
- **Superfícies de registro**: slash command = entrada em
  `BUILTIN_SLASH_COMMANDS` (`slash-commands.ts:49-141`) + ramo no dispatch
  (`interactive-slash-commands.ts:108`) + método no `SlashCommandHost` (padrão
  `/goal`). Tool nativa = entrada no `TOOL_REGISTRY` (`tools/index.ts:223`,
  shape :182-207) com `sideEffect: "agent"` (`extensions/types.ts:474-485`).
  Footer chip = getter + `modeBits.push(...)` (`footer.ts:629-646`, padrão
  `getRecoverySegment` :312-316).

### Design

Dois tipos de pin, mecânicas distintas:

1. **Pin de fato** (`/pin "nunca tocar em CHANGELOG.md"` ou tool `pin`):
   texto curto num `PinState` da sessão. Presença garantida por **seção
   per-turn** `<pinned>` ao lado de goal/todo/plan
   (`agent-session.ts:4952-4965`) — sobrevive a qualquer compaction porque
   nunca depende da janela; custo por turno visível e controlado pelo usuário
   (cap de itens/chars, ex.: 8 pins × 200 chars).
2. **Pin de arquivo/resultado** (`/pin src/foo.ts`): protege os tool-results
   correspondentes na janela — `if (pinnedIndices.has(i)) continue;` no topo
   dos laços de `pruneOldToolOutputs` (`compaction.ts:1878`) e
   `applySupersedeOnly` (:2000), + exclusão em
   `buildSupersededToolResultIndices` e na elisão de args. Um único ponto
   (compaction.ts) cobre live + compact, por construção.
3. **Ciclo de vida**: `/pin` lista, `/unpin <n>` remove; persistência
   `appendCustomEntry("pins", ...)` no padrão goal; footer `pin:3` denso.
4. O modelo pode pinar via tool (decisões críticas ditas pelo usuário), mas o
   dono da lista é o usuário — a tool não pode remover pins criados por humano.

### Riscos e mitigação

- *Pin de arquivo inflando a janela* — pins de arquivo protegem contra
  supersede/elisão, não contra compaction total; se a janela estoura, o pin de
  fato (barato) é o mecanismo garantido, e o de arquivo degrada com aviso.
- *Deriva de índices* — pins de arquivo referenciam `toolCallId`/entry id, não
  índice posicional; resolução para índice acontece dentro de
  `planContextPrune` a cada passada.

**Esforço:** baixo-médio. Os bypasses são poucas linhas em pontos já mapeados;
o trabalho real é o `PinState` + superfícies (command/tool/footer).

---

## P6 — Prefetch preditivo pelo grafo de código

**Área:** 4 Tools · **Forma:** built-in extension · **Kill-switch:** `PIT_NO_GRAPH_PREFETCH`

### O que existe hoje (verificado)

- **Grafo consultável com API pronta** (`core/repo-map/graph.ts`):
  `dependenciesOf` (:81), `dependentsOf` (:86, índice reverso),
  `testsCovering` (:119), `blastRadius` (:135, BFS capped). Alimentado por
  `getLivingRepoMap` (`living-index.ts:709`, `CACHE_VERSION = 4` :65,
  invalidação por commit+mtime, memo de 1s :681, kill-switches
  `PIT_NO_REPO_GRAPH`/`PIT_NO_LIVING_REPO_MAP` :718/:722).
- **O molde exato já existe**: `impact-extension.ts` se registra em
  `pi.on("tool_result")` (:258) e roda `getLivingRepoMap` + `buildRepoGraph` +
  `blastRadius` (:244-289) após tools de arquivo. O prefetcher é o mesmo
  padrão com `dependentsOf`/`dependenciesOf`/`testsCovering` no lugar de
  `blastRadius`.
- **Precedente interno de captura pós-read**: o handler da sessão já captura
  path+conteúdo do último read de forma fire-and-forget para o
  context-composer (`agent-session.ts:2382-2419`).
- **Ponto de consumo**: toda leitura passa por `ops.readFile`
  (`ReadOperations`, `read.ts:236-238`, default `fsReadFile` :260; call-sites
  :761/:826/:959). O read já recebe `mtimeStore` para baseline de mtime.
- **Padrão warm-cache-com-mtime reutilizável**: `createMtimePrefixParseCache`
  com `.prewarm(paths)` e `PREWARM_CONCURRENCY = 32`
  (`mtime-cache.ts:95-185`); e o `tsconfig-paths-cache.ts` (LRU keyed por
  mtime) como segundo precedente.

### Design

1. Extension `graph-prefetch`: em `tool_result` de `read`/`symbol`/
   `find_symbol` sobre o arquivo A, enfileira vizinhos grau-1
   (prioridade: `dependentsOf` > `dependenciesOf` > `testsCovering`) num
   prefetcher com dedupe, budget por turno (ex.: 12 arquivos) e cap de bytes.
2. Cache LRU em memória do processo (ex.: 32 entradas / 8 MB), entrada
   `{ content, mtimeMs, size }`; **zero tokens — nunca entra no contexto**.
3. Consumo: `ReadToolOptions` ganha um `warmFileCache?` opcional; `read.ts`
   consulta antes de `ops.readFile`, com hit condicionado a
   `stat.mtimeMs === cached.mtimeMs` (miss silencioso).
4. Prefetch roda em microtasks durante o stream do provider (a mesma janela
   morta da P1) e para sob pressão (tool mutante em execução).

### Honestidade sobre o ganho

Read de SSD é rápido; o ganho unitário é de ms. O valor real: (a) arquivos
grandes com outline (parse computado, não só I/O), (b) Windows (stat/open mais
caros), (c) fundação para pré-computar os hot outlines do suffix dinâmico fora
do caminho crítico. É a proposta de menor urgência — está aqui pela composição
com P1, não pelo ganho isolado.

**Esforço:** médio-baixo. Extension + um option novo no read.

---

## P7 — System prompt em camadas para modelos fracos

**Área:** 2 Providers/models + 3 Context economy · **Eixo:** weak-model uplift · **Kill-switch:** `PIT_NO_TIERED_PROMPT` (+ `PIT_TIERED_PROMPT=full|compact` para forçar)

### O que existe hoje (verificado)

- **O gate por modelo já existe e é reavaliado a cada run**:
  `shouldAutoEmitRepairNotes` (`repair-note-policy.ts:28-36`) — falso para
  `STRONG_NATIVE_PROVIDERS = {anthropic, openai-codex}` (:22) e para ids
  casando `STRONG_MODEL_ID_PATTERN = /claude|gpt-4|gpt-5|gemini|o[1-9]/i`
  (:25); override `PIT_TOOL_REPAIR_NOTE` em `resolveEmitRepairNotes` (:44-50).
  Passado **como função** ao Agent (`sdk.ts:553`) e resolvido contra o modelo
  corrente a cada run (`agent.ts:611-612`) — troca por `/model`/fallback
  re-avalia sem reconstruir nada.
- **Estrutura do prompt** (`system-prompt.ts`, `buildSystemPrompt` :100):
  parte estática = identidade, Platform, Available tools, Guidelines
  (`buildToolsAndGuidelinesSection` :284-390, ~14 bullets condicionais), docs
  pointer, `appendSystemPrompt`, `<project_context>`, Skills; marker em :149;
  suffix dinâmico depois. O texto **hardcoded** estático é ~3 KB; o prefixo
  real é dominado por `<project_context>` (variável por projeto).
- **Classificação já possível por bullet**: contrato essencial (identity,
  Platform, Available tools, edit-vs-write :352-356, run-tests :357-361,
  report-outcomes :381-383) vs nuance para modelos fortes (professional-user
  :318, match-style :342, tool-batching :346, numstat :329, path:line :376,
  comments-why :377, premise-wrong :378, narração :368, todo-first :305).
- **Ponto de integração faltante (correção da v2)**: `setModel`
  (`agent-session.ts:5490-5505`) **não** reconstrói o system prompt — nenhuma
  rota de troca de modelo chama `_rebuildSystemPrompt` (:3518). A seleção de
  perfil precisa instrumentar essa rota.
- **Cache**: o prompt cache do provider é keyed por modelo no servidor —
  trocar full↔compact **junto com** a troca de modelo não custa nada além do
  cache-miss que a troca já implica. Trocar perfil **sem** trocar modelo
  invalidaria o prefixo — por isso o perfil só muda em `setModel`.

### Design

1. Extrair o predicado para uso comum: `isWeakModelProfile(model)` em
   `repair-note-policy.ts` (mesma lógica; `shouldAutoEmitRepairNotes` passa a
   delegar).
2. `BuildSystemPromptOptions` ganha `profile: "full" | "compact"`.
   No perfil compact: manter contrato essencial integral; cortar/condensar os
   bullets de nuance para 3–4 linhas imperativas; manter `<project_context>`
   e Skills intocados (são conteúdo do usuário, não estilo).
3. Seleção em `setModel` (`agent-session.ts:5490`): calcular o perfil desejado
   para o modelo novo; mudou → `_rebuildSystemPrompt(toolNames,
   "model-profile")` (o contador `_trackPrefixStability` já registra o rebuild
   com reason, :3637). Boot faz o mesmo cálculo na primeira montagem.
4. `PIT_TIERED_PROMPT=full|compact` força (espelho de `PIT_TOOL_REPAIR_NOTE`);
   `PIT_NO_TIERED_PROMPT` desliga (sempre full).

### Fundamentação

Dois efeitos: **economia bruta** em providers OpenAI-compat sem prompt cache
eficaz (cada 1k cortado é cobrado em todo turn) e **obediência** (menos regras,
mais cumprimento — o mesmo raciocínio que já justificou o Repair Note
auto-gated). Lado de tokens mensurável com `bench-prompt-size.mts` existente.

**Esforço:** médio — estrutural é pequeno; o trabalho real é editorial
(escrever o perfil compact bem), mais o fio novo em `setModel`.

---

## P8 — Gearbox de modelos (com pré-requisito P8a)

**Área:** 2 Providers/models + 7 Task cognition · **Eixo:** economia máxima · **Kill-switches:** `PIT_NO_STEP_VERIFY` (P8a), `PIT_NO_MODEL_GEARBOX` (P8b) · **Risco:** o maior da lista — por último

### O que existe hoje (verificado — e a correção da v2)

- **Precedente de swap por contexto já ships**: plan mode troca para o role
  `plan` e restaura sem clobber — `decideRoleForPermissionMode`
  (`model-resolver.ts:780-789`; só volta se `activeRole === "plan"`, restaura
  `roleBeforePlan`), aplicado via handler de `bindPermissionModeChange`
  (`interactive-mode.ts:677-691`) → `applyModelRole` (:6074-6089) →
  `session.setModel` (`agent-session.ts:5490`). O gearbox reusa exatamente
  esse caminho.
- **Steps de plan** (`plan-manager.ts:28-35`): `{ id, intent, dependsOn,
  producesArtifact?, verifyCmd?, status }`; schema wire da tool usa
  `depends_on/produces/verify` (`tools/plan.ts:22-33`, mapeados em
  `toStepInputs` :74-83). **Não há ponteiro de step corrente** — "Ready now" é
  derivado do DAG (`systemPromptSection` :450-458); `stepDone` valida
  dependências (:309-323).
- **⚠️ Correção central da v2: `verifyCmd` é 100% advisory.** É renderizado
  (:470; artifact `exit-plan-tool.ts:96`) e gera nota de ausência
  (`verifyMissingNote`, `tools/plan.ts:91-95`) — **nada o executa**. A "rede
  de segurança" que a v1 assumia não existe ainda.
- **Sinais de anomalia prontos para o upshift**: retry budget esgotado
  (`ToolRetryBudgetTracker.observeFailure` → `exhausted`,
  `tool-retry-budget.ts:94-128`, default 3); tiers de doom-loop via
  `_noteRecoverySignal` no steering engine (`turn-steering-engine.ts:291/328/343/387`,
  consumido em `agent-session.ts:2338/2342`); "modelo perguntou" = invocação
  da tool `ask` (`tools/ask.ts:126`, via `UserInputBus.askOptions`
  `user-input-bus.ts:106` — filtrar `source.toolName === "ask"`).
- **Ledger por dimensão pronto para espelhar**: `TokenBudgetGovernor` com
  `mainTokens/subagentTokens/fusionTokens` (`token-governor.ts:11-28`,
  `recordMain/recordSubagent/recordFusion` :62-78, `flushToGoal` :111-119).
- **Footer não mostra role**: só model id (`footer.ts:492`); `activeRole` vive
  em `interactive-mode.ts:520` e não chega ao `FooterState`.

### P8a — Executor de verify por step (pré-requisito com valor próprio)

Antes de qualquer gearbox, o `verifyCmd` precisa sair do papel:

1. Em `stepDone` (via a op `step_done` da tool `plan`), se o step tem
   `verifyCmd`: executar via o executor de bash existente
   (`core/bash-executor.ts`), com timeout curto e cwd da sessão.
2. Falha → o step **não** marca `done`; o resultado da tool volta com o output
   do verify (stdout/stderr capado) e o step permanece `active` — o modelo
   corrige em vez de avançar.
3. `PIT_NO_STEP_VERIFY` restaura o comportamento advisory.

Isso vale a pena **sozinho**, sem gearbox: transforma o plan DAG de checklist
em contrato executável — e é pequeno (a infra de exec, caps e hints já existe).

### P8b — O gearbox propriamente

1. **Marcação explícita pelo planner**: campo `mechanical?: boolean` no
   `stepSchema` (`tools/plan.ts:22-33`) → `PlanStep` (`toStepInputs`). O
   modelo de planejamento (forte, em plan mode) decide o que é mecânico; o
   harness nunca adivinha. Escopo inicial: só steps `mechanical` **e** com
   `verifyCmd`.
2. **Downshift/upshift** pelo caminho existente `applyModelRole("smol")` /
   restauração no padrão `roleBeforePlan` (sem clobber de escolha manual —
   mesmo mecanismo de `decideRoleForPermissionMode`). Como não há ponteiro de
   step corrente, o gatilho é a própria tool `plan`: `step_done` do step
   anterior + próximo "ready" mechanical → downshift; qualquer saída do
   conjunto mechanical → upshift.
3. **Upshift imediato e irrevogável para o step** em: verify do step falhou
   (P8a), `RetryBudgetObservation.exhausted`, `_noteRecoverySignal` de
   doom-loop, ou tool `ask` invocada.
4. **Visibilidade**: propagar `activeRole` ao estado do footer e chip denso
   `gear:smol` ao lado do model id (`footer.ts:492`, re-render via
   `refreshModelIndicators` :5023); contabilidade por role no
   `TokenBudgetGovernor` (dimensão nova no padrão das três existentes).

### Riscos e mitigação

- *Qualidade do smol em edge cases* — escopo mínimo (mechanical+verify),
  upshift agressivo, visibilidade total no footer, e P8a garantindo que "done"
  significa "verificado".
- *Troca de modelo custa cache-miss* — real; o downshift só compensa em steps
  com várias rodadas de tools. Gate: só descer quando o step declarar
  `mechanical` (o planner já sabe o tamanho do step).

**Esforço:** P8a baixo; P8b médio-alto. P8a pode ser puxada para frente na
fila independentemente da decisão sobre P8b.

---

## Ordem recomendada e dependências

| # | Proposta | Eixo | Esforço | Risco | Observação |
|---|----------|------|---------|-------|------------|
| 1º | **P3** cache keepalive | economia | baixo | baixo | aritmética pura; gates prontos |
| 2º | **P4** sentinela externa | correção | baixo | baixo | built-in extension; `FileMtimeStore` já resolve o difícil |
| 3º | **P5** `/pin` | UX/inteligência | baixo-médio | baixo | chokepoint único em `planContextPrune` |
| 4º | **P8a** verify executor | correção | baixo | baixo | **promovida na v2** — vale sozinha e destrava P8b |
| 5º | **P2** compaction especulativa | UX/velocidade | médio-baixo | baixo | menor que a v1 — background já existe; resolve B9 junto |
| 6º | **P1** execução especulativa | velocidade | médio | médio | toca `@pit/agent-core`; funil `prepareToolCall` contém o risco |
| 7º | **P7** prompt em camadas | uplift/economia | médio | médio | trabalho editorial + fio em `setModel` |
| 8º | **P6** prefetch por grafo | velocidade | médio-baixo | baixo | compõe com P1; menor urgência |
| 9º | **P8b** gearbox | economia máxima | médio-alto | **alto** | só após P8a madura e P1–P7 estáveis |

P1+P2+P3 seguem sendo o pacote **"sobreposição temporal"**; a novidade da v2 é
P8a entrar cedo por mérito próprio.

## Regras transversais (valem para todas)

- Kill-switch `PIT_NO_*` documentado em
  [`docs/token-economy-tuning.md`](../token-economy-tuning.md) no mesmo PR que
  cria a flag (regra do AGENTS.md).
- Nenhuma proposta adiciona telemetria nova; diagnósticos usam
  `recordDiagnostic` no padrão existente (`compaction.presend-overflow-guard`).
- Especulação nunca contorna guards: P1/P2/P6 executam pelos mesmos funis de
  prepare/permission dos fluxos normais (P1 por construção — consumo nunca
  re-prepara, especulação sempre prepara).
- Features comportamentais entram como built-in extensions (P4, P6) — nunca
  inline em `agent-session.ts` (invariante de `docs/CONTEXT.md`).
- Cada proposta é um PR próprio, classificado com `area:<nome>` conforme a
  [Taxonomia](../../Taxonomia.md); nenhuma cruza 3+ áreas.
- Âncoras `file:line` deste doc foram verificadas em 2026-07-23; ao implementar,
  reconfirmar com o código corrente (o repo evolui rápido).
