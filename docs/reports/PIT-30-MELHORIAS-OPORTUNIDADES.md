# Pit — 30 oportunidades de melhoria (2026-07)

> Auditoria consolidada com foco em **economia de tokens**, **performance/latência**,
> **velocidade de resposta** e **UI/UX**.  
> Base: código em `packages/`, docs em `docs/optimization/context-economy-inventory.md`,
> `docs/token-economy-tuning.md`, auditorias TUI jul/2026.  
> **Data:** 2026-07-09.

Cada item traz **onde** (arquivos), **por quê** (problema ou gap), **o quê** (proposta)
e **prioridade** estimada.

**Legenda de prioridade**

| Tag | Significado |
|-----|-------------|
| **P0** | Alto ROI, baixo risco — fazer primeiro |
| **P1** | Impacto claro, esforço moderado |
| **P2** | Polish, observabilidade ou tradeoff maior |
| **P3** | Estrutural / benchmark-gated / risco alto |

**Legenda de esforço**

| Esforço | Ordem de grandeza |
|---------|-------------------|
| S | horas |
| M | 1–3 dias |
| L | multi-dia, exige bench A/B |

---

## Resumo

| Área | Itens | IDs |
|------|-------|-----|
| Economia de tokens | 14 | T01–T14 |
| Performance / latência | 6 | P01–P06 |
| UI/UX | 5 | U01–U05 |
| Acessibilidade + docs | 4 | A01–A04 |
| Observabilidade (CI) | 1 | O01 |
| **Total** | **30** | |

---

## Status da wave cirúrgica (2026-07)

- [x] T02 — Gate frequent_files @ 50%
- [x] T03 — FIND_DEFAULT_LIMIT_CEILING 1000→500
- [x] T04 — DiagnosticContext toolName/mechanism/reclaimedTokens
- [x] T05 — Flags PIT_* no token-economy-tuning.md
- [x] T06 — PIT_NARRATION via isTruthyEnvFlag

## Status da Wave B — tokens reais (2026-07)

- [x] T01 — LAZY_TOOL_DESCRIPTION_MAX_CHARS 120→40
- [x] T11 — SUPERSEDED_TOOL_RESULT_NAMES + ast_grep/repo_map
- [x] T08 — segundo passe só em shouldCompact (hard)

## Status da Wave C — tradeoffs de contexto (2026-07)

- [x] T07 — patch tools-only (guidelines preservadas)
- [x] T09 — ReadDedupeStore.pruneExcept pós-compact
- [x] T10 — resolveDynamicPresendOverflowRatio (0.88–0.95)

## Status da Wave P — performance zero-config (2026-07)

- [x] P01 — skip hard sync compact após background (re-check live estimate)
- [x] P02 — memo `transformContext` + prune (`_ctxPruneCache`)
- [x] P03 — `emitContext` side-effects parallel (`markSideEffect`)
- [x] P06 — `prewarmProviderModule` no boot / model switch
- [~] P05 — já nativo via `PIT_CONFIG_COMMAND_TTL_MS` (30s) em `!command` auth
- [x] P04 — async ordered `message_update` (fire-and-forget chain; await at boundaries)

## Status da Wave U — UI/UX A+B (2026-07)

- [x] U02 — bash cancel hint via `Loader.setTrailingSuffix`
- [x] U04 — remove `DynamicBorder` interno no `tree-selector`
- [x] U03 — placeholder dim `Text` acima do `Input` (não `Editor.setPlaceholder`)
- [x] U01 incremental — `paintSelectedRow` / `selectedBg` no ask-picker; rules internas → blank
- [ ] U01 full — Container + `SelectorCard` deferred (risco width/Focusable)
- [ ] U05 — caret wavefront deferred (mitigações: não tocar `REVEAL_*`; budget width; kill-switch)

## Status da Wave T — TUI risco baixo / esforço S (2026-07)

- [x] M0 — spinner-ticker dirty 1Hz sob reduced-motion (elapsed `· Ns` avança)
- [x] A03 parcial — `resolveGaugeGlyphs()` via `PIT_ASCII_GAUGE` / `TERM=dumb` (●/○)
- [x] M02 — `mdQuoteBorder` → `borderMuted` (dark/light)
- [x] T01 — `wrapPlain` hard-break de tokens longos no ask-picker
- [x] Breath — `THINKING_BREATH_BUCKETS` 8→16
- [x] W01 — workspace do hero alinhado ao `logoPad` do wordmark
- [x] F04 — gauge sem partial blend sob reduced-motion
- [ ] A01 — prefers-reduced-motion do OS (ainda aberto)
- [ ] A02 — fade/gradiente 256-color (ainda aberto)

---

## Parte 1 — Economia de tokens (14)

### T01 — Descrições de tools ainda mais compactas no wire

**Status:** feito (Wave B 2026-07)

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P0 |
| **Esforço** | M |
| **Inventário** | E1/E9 (PARTIAL) |

**Onde**

- `packages/coding-agent/src/core/tool-wire-schema.ts` — `compactToolDescription()` trunca a 120 chars; `stripSchemaDescriptions()` remove descrições aninhadas do JSON Schema.
- `packages/coding-agent/src/core/agent-session.ts` — montagem do contexto provider (`compactToolsForProviderContext`, lazy schemas ~L1600).

**Por quê**

O módulo E1 já envia schemas “wire-minimal”, mas cada tool ainda carrega uma linha de descrição (~120 chars × N tools). Com 30+ tools + MCP, o bloco de tools continua sendo um dos maiores consumidores do prefixo fixo (~25k wire tokens medidos em `scripts/bench-prompt-size.mts`). Descrições longas no catálogo local permanecem intactas para validação — só o payload ao provider precisa ser mais agressivo.

**O quê**

Reduzir descrições wire para stubs de 1 linha / ~40 chars (nome + verbo), ou omitir descrição quando o nome é autoexplicativo. Manter schema completo apenas para tools ativas no turno (lazy já parcialmente faz isso).

**Impacto estimado:** −2–8k tokens/request em sessões com muitas tools.

---

### T02 — Gate de `frequent_files` por ocupação de contexto

**Status:** feito (wave cirúrgica 2026-07)

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P1 |
| **Esforço** | S |
| **Inventário** | E13 |

**Onde**

- `packages/coding-agent/src/core/system-prompt.ts` — bloco `<frequent_files>` / `<frequent_files_outline>` no **dynamic suffix** (L152–168).
- `packages/coding-agent/src/core/agent-session.ts` — `_kickoffFrequentFilesIndex`, rebuild com reason `"frequent-files-index"`.

**Por quê**

`frequent_files` é emitido sempre que há dados, sem checar ocupação. O bloco fica no suffix dinâmico (fora do cache prefix) — correto para Anthropic — mas ainda consome wire tokens e pode invalidar estratégias de cache em OpenAI/Google quando relocado para `<env>`. Em sessões já sob pressão, o índice de arquivos quentes é dispensável: o modelo já leu esses paths.

**O quê**

Só injetar `frequent_files` / `hotFileOutlines` quando `getContextUsage().percent < 50` (ou wire abaixo de um floor configurável).

**Impacto estimado:** prefixo mais estável; −200–800 tokens em sessões longas.

---

### T03 — Revisar limites default do `find` sob alta ocupação

**Status:** feito (wave cirúrgica 2026-07)

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P1 |
| **Esforço** | S |
| **Inventário** | A10 (PARTIAL — já existe scaling) |

**Onde**

- `packages/coding-agent/src/core/tools/find.ts` — `FIND_DEFAULT_LIMIT_CEILING = 1000`, `FIND_DEFAULT_LIMIT_FLOOR = 100`, `effectiveFindDefaultLimit()` escala com `getOccupancyScale()`.

**Por quê**

O scaling por ocupação **já ships** (contrário ao inventário original). O teto de 1000 ainda pode ser alto em explore-heavy quando ocupação está baixa; o floor de 100 pode ser baixo demais para tarefas legítimas de glob amplo. Vale calibrar com `scripts/bench-session-tokens.mts` em cenários explore.

**O quê**

Ajustar ceiling/floor ou incluir `find` no mesmo perfil de crush que `grep` auto-switch (`files_with_matches` quando matches > 25). Documentar defaults em `docs/token-economy-tuning.md`.

**Impacto estimado:** −500–3k tokens em sessões com muitos globs.

---

### T04 — Telemetria estruturada de prune por `toolName`

**Status:** feito (wave cirúrgica 2026-07)

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P2 |
| **Esforço** | S |
| **Inventário** | G9 |

**Onde**

- `packages/coding-agent/src/core/agent-session-live-prune.ts` — `recordDiagnostic({ category: "prune.live", context: { note: "tool=…" }})` (L69–77).
- `packages/coding-agent/src/core/compaction/compaction.ts` — prune presend / supersede.
- `packages/ai/src/utils/runtime-diagnostics.ts` — sink de diagnósticos.
- `packages/coding-agent/src/core/telemetry/session-summary.ts` — resumo JSONL ao encerrar.

**Por quê**

O `toolName` aparece em string livre no campo `note`, mas não há campo estruturado nem agregação por tool. Impossível responder “qual tool mais contribui para reclaim?” sem parsear logs. CI bench (`scripts/bench-session-tokens.mts`) já emite `METRIC mechanism=* reclaimed_tokens`, mas runtime real não quebra por tool.

**O quê**

Adicionar `toolName`, `mechanism` (`supersede` | `arg_elision` | `thinking_cap` | …) e `reclaimedTokens` como campos tipados em `recordDiagnostic`. Expor agregado em `/diagnostics` ou session summary.

**Impacto estimado:** zero tokens; habilita tuning data-driven.

---

### T05 — Documentar flags `PIT_*` faltantes

**Status:** feito (wave cirúrgica 2026-07)

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P2 |
| **Esforço** | S |

**Onde**

- `docs/token-economy-tuning.md` — inventário canônico (~37 vars).
- Código com flags **não documentadas:**
  - `PIT_NO_HINDSIGHT_ON_DEMAND` — `agent-session.ts:~3133`
  - `PIT_NO_CONTEXT_RETRIEVAL` — `context-files.ts:162`
  - `PIT_TTSR_BUFFER_CHARS` — `ttsr.ts:48–61`
  - `PIT_FREQ_OUTLINE` — `system-prompt.ts:62`, `agent-session.ts:~1335`

**Por quê**

Operadores e agentes de coding não encontram flags relevantes no doc canônico. Risco de configurar errado ou reimplementar toggles existentes.

**O quê**

Adicionar as 4+ flags à tabela em `docs/token-economy-tuning.md` com efeito, default e arquivo:linha.

**Impacto estimado:** operacional; evita regressões de tuning.

---

### T06 — Corrigir convenção de `PIT_NARRATION`

**Status:** feito (wave cirúrgica 2026-07)

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P2 |
| **Esforço** | S |

**Onde**

- `packages/coding-agent/src/core/system-prompt.ts:354` — `process.env.PIT_NARRATION === "1"`.
- `docs/token-economy-tuning.md:71` — já documenta a anomalia.

**Por quê**

Todas as outras flags usam `isTruthyEnvFlag` (`"1"`, `"true"`, `"yes"`). `PIT_NARRATION=true` silenciosamente não ativa — surpresa para quem segue a convenção do projeto.

**O quê**

Substituir por `isTruthyEnvFlag(process.env.PIT_NARRATION)` (1 linha + teste).

**Impacto estimado:** consistência; sem efeito em quem já usa `=1`.

---

### T07 — Rebuild parcial do system prompt ao togglear tools

**Status:** feito (Wave C 2026-07)

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P1 |
| **Esforço** | M |
| **Inventário** | E8 |

**Onde**

- `packages/coding-agent/src/core/agent-session.ts` — `setActiveToolsByName()` chama `_rebuildSystemPrompt(validToolNames, "tool-surface")` (L2957–3003).
- `getFixedPrefixCost()` / `getCachePrefixDiagnostics()` — medem rebuilds de prefix.

**Por quê**

Ativar/desativar uma tool (MCP, extensão, `/tools`) reconstrói o system prompt inteiro — guidelines + tool surface + dynamic marker. Isso invalida o cache prefix do provider (Anthropic/OpenAI) mesmo quando só a lista de tools mudou marginalmente.

**O quê**

Separar rebuild em camadas: patch só o bloco `<tools>` / tool-discovery index quando `reason === "tool-surface"`, sem re-renderizar guidelines estáticas.

**Impacto estimado:** menos cache miss; −0–5k tokens de re-billing por toggle em sessões longas.

---

### T08 — Coalescing de compactação multipass

**Status:** feito (Wave B 2026-07)

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P1 |
| **Esforço** | M |
| **Inventário** | C5 |

**Onde**

- `packages/coding-agent/src/core/agent-session-compaction.ts` — `executeCompactionPipeline()` pode rodar 2× síncrono (L456–477, L849–853: retry após overflow).

**Por quê**

Dois passes LLM de summarização no mesmo turn-start duplicam latência **e** tokens de summarizer. O segundo passo existe para edge cases de overflow pós-primeira compactação, mas não há debounce/coalesce.

**O quê**

Marcar “compaction in flight” e mesclar triggers presend + overflow num único pipeline; ou widen o `keepRecent` no primeiro passo quando overflow é previsível.

**Impacto estimado:** −1 chamada LLM compactação (~2–10s latência + custo summarizer).

---

### T09 — Dedupe de read pós-compactação seletivo

**Status:** feito (Wave C 2026-07)

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P1 |
| **Esforço** | M |
| **Inventário** | A5 / D5 (PARTIAL — dedupe at tool output já é sofisticado) |

**Onde**

- `packages/coding-agent/src/core/tools/read.ts` — `ReadDedupeStore.pruneExcept` + `pathFromDedupeKey`.
- `packages/coding-agent/src/core/agent-session-compaction.ts` — `pruneReadDedupeAfterCompaction` após `executeCompactionPipeline` (não há `clear()` incondicional; keep-set vazio = no-op).

**Por quê**

A tool `read` já suprime re-leituras idênticas, deltas e containment. Compaction historicamente **não** limpava o store (C9); o gap era dropar paths órfãos (fora do summary) sem perder dedupe dos arquivos ainda ancorados no frame.

**O quê**

`pruneExcept(keepPaths, isStale)`: keep = union `readFiles` + `modifiedFiles` + keys de `fileDigests`; stale via `FileMtimeStore`. Opt-out `PIT_NO_READ_DEDUPE_PRUNE=1`.

**Impacto estimado:** −1–5k tokens em sessões pós-compact com re-reads.

---

### T10 — Ratio presend dinâmico por ocupação

**Status:** feito (Wave C 2026-07)

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P1 |
| **Esforço** | M |
| **Inventário** | B4 |

**Onde**

- `packages/coding-agent/src/core/agent-session-compaction.ts` — `DEFAULT_PRESEND_OVERFLOW_RATIO = 0.95` (L53–63), override via `PIT_PRESEND_OVERFLOW_RATIO`.
- Mid-turn: `PIT_MID_TURN_PRESSURE_RATIO` default 0.92.

**Por quê**

0.95 fixo não distingue sessão explore (poucos tools grandes) vs implement (muitos edits pequenos). Pode compactar cedo demais (custo LLM + perda de contexto) ou tarde demais (overflow provider).

**O quê**

Escalar ratio com densidade de tool-results recentes ou com `wireTokens / contextWindow` EMA — ex.: 0.88–0.95. Manter env override.

**Impacto estimado:** menos compactações desnecessárias ou menos overflows; tuning fino.

---

### T11 — Supersede para `ast_grep` e `repo_map`

**Status:** feito (Wave B 2026-07)

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P1 |
| **Esforço** | M |
| **Inventário** | A2 (PARTIAL) |

**Onde**

- `packages/coding-agent/src/core/compaction/compaction.ts` — `SUPERSEDED_TOOL_RESULT_NAMES` (L1124): inclui `read`, `grep`, `find`, `ls`, `symbol`, `lsp`, `bash` — **não** inclui `ast_grep`, `repo_map`.

**Por quê**

Tools de explore estrutural retornam payloads grandes e repetitivos. Uma segunda passagem `repo_map` ou `ast_grep` no mesmo path invalida a anterior mas ambas permanecem no histórico até prune/compaction.

**O quê**

Adicionar `ast_grep` e `repo_map` ao set com chave de supersede por path/query; `bash` permanece restrito (non-reproducible — já defer on supersede M13).

**Impacto estimado:** −2–10k tokens em sessões explore-heavy.

---

### T12 — Overthink: trim-and-keep vs interrupt-and-replay

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P3 |
| **Esforço** | L |
| **Inventário** | N11 (deferred) |

**Onde**

- `packages/agent/src/overthink-guard.ts` — interrompe stream quando thinking block excede threshold sem tool call.
- `packages/coding-agent/src/core/overthink-policy.ts` — política de retry por turno.
- `packages/coding-agent/src/modes/interactive/components/overthink-steer-message.ts` — UI de steer.

**Por quê**

Hoje o guard **interrompe e re-bilha** o turno inteiro — tokens de reasoning parcial + retry completo. Em modelos open-weight (GLM, Qwen) que “overthink”, isso é caro. Alternativa: truncar o bloco thinking no limite e continuar o stream (trim-and-keep).

**O quê**

Implementar trim-and-keep com cap no bloco ativo; manter interrupt-and-replay como fallback após N trims. **Risco:** lifecycle do stream SSE, providers que rejeitam thinking truncado.

**Impacto estimado:** alto em modelos overthinkers; risco médio-alto.

---

### T13 — Prompt packs por fase (explore / implement)

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P3 |
| **Esforço** | L |
| **Inventário** | E10, C10 |

**Onde**

- `packages/coding-agent/src/core/system-prompt.ts` — bloco único de guidelines (~25k wire prefix).
- `packages/coding-agent/src/core/coordinator/builtin-agents.ts` — tipos `explore` existem para subagents, não para o agente principal.

**Por quê**

Guidelines de explore (“não editar”, “grep antes de read”) competem com guidelines de implement no mesmo prefixo fixo. Tudo enviado sempre — mesmo quando o usuário pediu “só investigue”.

**O quê**

Detector leve de fase (tool mix, intent gate, ou flag explícita) → carregar subset de guidelines. Decisão de produto: o que omitir sem degradar qualidade.

**Impacto estimado:** −3–8k tokens de prefix; alto esforço de validação.

---

### T14 — Painel `/economy` no TUI

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P3 |
| **Esforço** | L |
| **Inventário** | G10 |

**Onde**

- `packages/coding-agent/src/core/agent-session.ts` — `getContextUsage()` (L6154+): `tokens`, `wireTokens`, `percent`, `budgetSpent/Limit`, `subagentSpent`, `fusionSpent`.
- `getFixedPrefixCost()` — `staticSystemTokens`, `dynamicSystemTokens`, `toolTokens`.
- `getCachePrefixDiagnostics()` — rebuild count + reasons.
- `packages/coding-agent/src/modes/interactive/components/footer.ts` — gauge parcial já expõe percent.

**Por quê**

Dados existem espalhados; operador não vê breakdown (system vs tools vs transcript vs cache hit rate vs reclaim por mecanismo) sem `/diagnostics` raw ou session summary JSONL.

**O quê**

Comando ou overlay `/economy` com: wire vs estimate, prefix cost, cache stats, último reclaim live/prune, flags ativas.

**Impacto estimado:** zero tokens; acelera tuning manual e debug.

---

## Parte 2 — Performance e latência (6)

### P01 — Compactação presend não-bloqueante quando background já rodou

**Status:** feito (Wave P 2026-07)

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P0 |
| **Esforço** | M |

**Onde**

- `packages/coding-agent/src/core/agent-session.ts` — `_promptOnce()`: `checkCompaction()` (~L4140) e `checkPresendOverflow()` (~L4236) **antes** do provider call.
- `packages/coding-agent/src/core/agent-session-compaction.ts` — `backgroundCompactionPromise` (L133, L715–723): soft threshold dispara compactação **após** turn end.

**Por quê**

Em sessões grandes, o turn-start pode **await** compactação LLM síncrona (2–15s) antes do primeiro token. Background compaction ajuda só se o soft threshold foi atingido no turn **anterior** — presend overflow no turn atual ainda bloqueia.

**O quê**

Se `backgroundCompactionPromise` resolve recentemente e wire caiu abaixo do threshold, skip presend sync. Caso contrário, await background antes de sync. Bloquear sync apenas quando ainda acima de `PRESEND_OVERFLOW_RATIO`. Hard `shouldCompact` re-checa com `estimateContextTokens` live (usage do lastAssistant pode estar stale).

**Impacto estimado:** −2–15s time-to-first-token em sessões longas.

---

### P02 — Memoizar `transformContext` + prune quando transcript estável

**Status:** feito (Wave P 2026-07)

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P0 |
| **Esforço** | M |

**Onde**

- `packages/agent/src/agent-loop.ts` — chama `transformContext` antes de **cada** stream (~L642–646).
- `packages/coding-agent/src/core/agent-session.ts` — `transformContext` → `_pruneContextForProvider()` (L1596–1599, L3510+).
- `packages/coding-agent/src/core/extensions/runner.ts` — `emitContext()` serial (L1044+).

**Por quê**

Entre tool rounds do **mesmo turno**, o histórico pode ser idêntico ao último stream (só mudou thinking interno já descartado). Re-executar extensões serial + `estimateContextTokens` + clone/prune é O(n) no transcript a cada round.

**O quê**

Cache keyed by `(messages.length, lastMessageId, leafId)` → resultado pruneado. Invalidar em append tool result / user message / compaction.

**Impacto estimado:** −50–500ms por tool round em sessões longas.

---

### P03 — Paralelizar handlers side-effect de `emitContext`

**Status:** feito (Wave P 2026-07)

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P1 |
| **Esforço** | M |

**Onde**

- `packages/coding-agent/src/core/extensions/runner.ts` — `emitContext()` itera extensões **serial** (L1044–1077).
- Contraste: `before_agent_start` já particiona mutators serial vs side-effects parallel (L1281–1298).

**Por quê**

Extensões com I/O (MCP, hindsight inject, context composer) acumulam latência linear. `emitContext` roda em todo LLM call — hot path.

**O quê**

Classificar handlers de context como `mutate` (serial) vs `observe` (parallel), espelhando `before_agent_start`.

**Impacto estimado:** −20–200ms por LLM call com 3+ extensões.

---

### P04 — Emit assíncrono de `message_update` no agent loop

**Status:** feito (promise chain ordenada; drain antes de `message_end`)

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P1 |
| **Esforço** | M |

**Onde**

- `packages/agent/src/agent-loop.ts` — `flushPendingDelta()` enfileira `message_update` numa promise chain sem await no iterator SSE; `flushAndDrainMessageUpdates()` antes de boundaries / `message_end`.
- Coalescing a 16ms (~60fps) permanece.

**Por quê**

Listener lento (extensão, TUI) bloqueava consumo do SSE iterator → backlog no `EventStream`.

**O quê**

Fire-and-forget ordenado para deltas `message_update`; manter await em `message_end` / boundaries após drenar a chain.

**Impacto estimado:** streaming mais fluido; ordem TUI preservada.

---

### P05 — Cache de resolução de auth por provider

**Status:** já nativo (TTL `PIT_CONFIG_COMMAND_TTL_MS` 30s em `!command` auth) — sem implementação extra na Wave P

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P1 |
| **Esforço** | S |

**Onde**

- `packages/coding-agent/src/core/sdk.ts:386` — `await modelRegistry.getApiKeyAndHeaders(model)` **todo turno**.
- `packages/coding-agent/src/core/model-registry.ts` — resolução OAuth/disk.
- `packages/coding-agent/src/core/resolve-config-value.ts` — TTL de `!command`.

**Por quê**

Multi-tool turns repetem async auth 5–10× por turno. Refresh OAuth pode bloquear centenas de ms (disk lock + network).

**O quê**

Cache in-memory `{ provider, key, headers, expiresAt }` TTL 30–60s; invalidar em 401/403 ou troca de modelo.

**Impacto estimado:** −5–50ms por LLM call; mais em refresh.

---

### P06 — Prewarm do módulo provider ativo

**Status:** feito (Wave P 2026-07)

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P2 |
| **Esforço** | S |

**Onde**

- `packages/ai/src/providers/register-builtins.ts` — dynamic `import()` lazy (L160+); `prewarmProviderModule(api)`.
- `packages/coding-agent/src/core/sdk.ts` — boot após modelo resolvido.
- `packages/coding-agent/src/core/agent-session.ts` — `_emitModelSelect` (set/cycle/fallback).

**Por quê**

Primeiro request a um provider paga cold import (~50–300ms). Usuário vê delay no primeiro prompt após `/model` ou boot.

**O quê**

Após seleção de modelo (boot ou `/model`), `import()` do provider correspondente em idle/microtask. **Não** prewarm todas extensões.

**Impacto estimado:** −50–300ms one-time por sessão/provider switch.

---

## Parte 3 — UI/UX (5)

### U01 — Migrar `ask-picker` para `SelectorCard`

**Status:** incremental feito (Wave U 2026-07) — `paintSelectedRow` + remoção de rules `─` internas; full `SelectorCard`/Container deferred

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P0 |
| **Esforço** | S |

**Onde**

- `packages/coding-agent/src/modes/interactive/components/ask-picker.ts` — string-render com `cardTopBorder`/`cardBottomBorder`; focused rows usam `paintSelectedRow`.
- Referência: `selector-card.ts`, `model-selector.ts`, `config-selector.ts`.

**Por quê**

Maior inconsistência visual restante (audit jul/2026 §2.1): overlay plano com rules retas vs cards arredondados no resto do TUI. `ask` é interação frequente — impacto alto na percepção de polish.

**O quê**

Incremental (feito): `paintSelectedRow` / `selectedBg` nas opções; blank em vez de `DynamicBorder` em freeform/comment. Full: substituir por `SelectorCard`/Container em PR isolado após estabilizar width tests.

**Impacto estimado:** coerência visual; percepção de produto maduro.

---

### U02 — Hint de cancel no bash via `Loader.setTrailingSuffix`

**Status:** feito (Wave U 2026-07)

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P1 |
| **Esforço** | S |

**Onde**

- `packages/coding-agent/src/modes/interactive/components/bash-execution.ts` — mensagem `"Running…"` + `setTrailingSuffix(·key to cancel)`.
- Padrão existente: `interactive-mode.ts` `refreshLoaderTrailingSuffix()`, `bordered-loader.ts`.

**Por quê**

Loader principal já usa suffix dinâmico (token rate, interrupt hint). Bash duplicava hint no corpo — visualmente inconsistente e ocupava linha de conteúdo.

**O quê**

Mover hint para `Loader.setTrailingSuffix()`; manter corpo só com status.

**Impacto estimado:** consistência; leitura mais limpa.

---

### U03 — Placeholder no `extension-input`

**Status:** feito (Wave U 2026-07) — dim `Text` acima do `Input` (doc antigo citava `Editor.setPlaceholder`, que não se aplica)

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P1 |
| **Esforço** | S |

**Onde**

- `packages/coding-agent/src/modes/interactive/components/extension-input.ts` — `placeholder` → `Text` dim acima do `Input`.
- Padrão: `login-dialog.ts` `showPrompt`.

**Por quê**

Extensões que pedem input customizado não mostravam hint — usuário via campo vazio sem contexto. `@pit/tui` `Input` não tem API de placeholder.

**O quê**

Hint dim com o texto do placeholder acima do campo (sem mudar `@pit/tui`).

**Impacto estimado:** UX de extensões; esforço mínimo.

---

### U04 — Remover divider interno do `tree-selector`

**Status:** feito (Wave U 2026-07)

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P2 |
| **Esforço** | S |

**Onde**

- `packages/coding-agent/src/modes/interactive/components/tree-selector.ts` — `SearchLine` → `Spacer` → tree (sem `DynamicBorder`).

**Por quê**

Double chrome: card arredondado + rule horizontal interna. Audit §2.1 lista como ruído visual.

**O quê**

Remover `DynamicBorder` interno; confiar em spacing do `SelectorCard`.

**Impacto estimado:** polish visual marginal.

---

### U05 — Caret no wavefront do streaming (`assistant-message`)

**Status:** deferred (Wave U 2026-07) — mitigações documentadas; não implementar sem budget de width + kill-switch

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P2 |
| **Esforço** | M |

**Onde**

- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts` — reveal path (`REVEAL_*`, `fadeLineTail`, `applyRevealEdgeFade`).
- `packages/coding-agent/src/utils/env-flags.ts` — `isReducedMotion()`.

**Por quê**

Streaming feel já é bom (audit: **não retunar** `REVEAL_*`). Falta indicador explícito de “ainda escrevendo” no ponto de reveal — especialmente quando modelo pausa entre chunks.

**O quê (wave futura)**

Dim `▌` caret após último char revelado; omitir se `isReducedMotion()` ou turn complete. Mitigações: não alterar constantes `REVEAL_*`; contar caret no budget de width; kill-switch `PIT_NO_STREAM_CARET` ou reduced-motion; testes em `assistant-message-smoothing.test.ts`.

**Impacto estimado:** percepção de velocidade/responsividade; zero impacto real de throughput.

---

## Parte 4 — Acessibilidade e documentação (4)

### A01 — Suporte a `prefers-reduced-motion` do OS

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P2 |
| **Esforço** | M |

**Onde**

- `packages/coding-agent/src/utils/env-flags.ts:25` — `isReducedMotion()` só checa `PIT_NO_MOTION`, `PIT_REDUCED_MOTION`, `TERM=dumb`.

**Por quê**

Usuários com preferência de sistema reduzida precisam setar env manualmente. Windows/macOS/Linux expõem a preferência — Pit ignora.

**O quê**

Onde possível (Node 22+ / platform APIs), ler preferência OS como fallback. Manter env vars como override.

**Impacto estimado:** a11y; sem efeito em tokens.

---

### A02 — Degradação graciosa em terminais 256-color

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P2 |
| **Esforço** | M |

**Onde**

- `packages/tui/src/utils/color-interpolation.ts` — gradientes truecolor.
- `packages/coding-agent/src/modes/interactive/theme/theme.ts` — paleta mint/gradients.
- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts` — fade de streaming.

**Por quê**

SSH legado, conhost antigo, tmux sem truecolor: gradientes e fade colapsam ou ficam errados — experiência degradada vs flat colors intencionais.

**O quê**

Detectar `COLORTERM` / `TERM` / color level; usar paleta flat 256 quando truecolor indisponível.

**Impacto estimado:** compatibilidade terminal.

---

### A03 — Fallback runtime para glyphs do gauge

**Status:** parcial (Wave T 2026-07) — env/`TERM=dumb`; probe Unicode no boot ainda aberto

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P2 |
| **Esforço** | S |

**Onde**

- `packages/coding-agent/src/modes/interactive/components/gauge-glyphs.ts` — `resolveGaugeGlyphs()` → `●/○` com `PIT_ASCII_GAUGE=1` ou `TERM=dumb`.
- `packages/coding-agent/src/modes/interactive/components/footer.ts` / `todo-overlay.ts` — consomem o resolver.

**Por quê**

Conhost/legacy SSH renderizam tofu □ no footer gauge — informação de contexto fica ilegível.

**O quê**

Feito: fallback via env/TERM. Restante: probe Unicode no boot (como spinner) para auto-detect sem flag.

**Impacto estimado:** legibilidade em terminais limitados.

---

### A04 — Sincronizar docs TUI com código shipped

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P2 |
| **Esforço** | S |

**Onde**

- `docs/reports/TUI-AESTHETICS.md` — claims desatualizados (ex.: `DEFAULT_ASSISTANT_READING_COLUMNS = 0`; H2 flat; loader sem token chip).
- `docs/agents/tui-ux-micro-moves-plan.md` — checklist Lotes A–H ainda `[ ]` apesar de shipped.
- `docs/tui-experience-audit-2026-07.md` — parcialmente desatualizado pós Tier 1.

**Por quê**

Contribuidores e agentes reimplementam trabalho já feito ou evitam áreas “pendentes” que já ships.

**O quê**

Atualizar status, marcar checkboxes, adicionar “shipped 2026-07” com links aos testes (`activity-line-component.test.ts`, etc.).

**Impacto estimado:** velocity de contribuição; zero runtime.

---

## Parte 5 — Observabilidade CI (1)

### O01 — `PIT_TIMING=1` em smoke CI

| Campo | Detalhe |
|-------|---------|
| **Prioridade** | P1 |
| **Esforço** | S |

**Onde**

- `packages/coding-agent/src/core/extensions/runner.ts` — com `PIT_TIMING=1` emite `METRIC emit_*_ms=...` (L810, L1046, L1104, L1197).
- `.github/workflows/ci.yml` — gate `npm run check`; **sem** timing smoke hoje.
- `scripts/check-token-bench.mjs` — regression de tokens, não latência de hooks.

**Por quê**

Regressões de latência em `emit_before_agent_start`, `emit_context`, `emit_bpr` passam silenciosas. Perf work (P01–P04) precisa baseline automatizado.

**O quê**

Job smoke (ou step em check) roda cenário hermético curto com `PIT_TIMING=1`; falha se métricas excedem baseline JSON (padrão de `scripts/baselines/token-economy.json`).

**Impacto estimado:** previne regressões de latência; habilita tuning seguro.

---

## Roadmap sugerido (reempacota os 30 itens)

### Sprint 1 — impacto imediato
T01, T04, P01, P02, U01, O01

### Sprint 2 — consolidação
T07, T08, T02, T11, P03, P05, U02, U03

### Sprint 3 — estrutural / benchmark-gated
T12, T13, T14, T09, T10, P06, A01–A04, U04, U05
(P04 feito — async ordered `message_update`)

---

## Referências

| Documento | Conteúdo |
|-----------|----------|
| `docs/optimization/context-economy-inventory.md` | Backlog completo (~69 itens acionáveis) |
| `docs/token-economy-tuning.md` | Flags `PIT_*` canônicas |
| `docs/reports/AUDITORIA-ECONOMIA-TOKENS.md` | Auditoria jul/2026 (maioria IMPLEMENTED) |
| `docs/tui-experience-audit-2026-07.md` | Audit UX TUI |
| `docs/agents/tui-ux-micro-moves-plan.md` | Micro-moves A–H |
| `scripts/bench-session-tokens.mts` | Bench sintético de reclaim |
| `bench/analyze-ttfe.mts` | Time-to-first-edit |

---

## Nota sobre itens já resolvidos (não contados nos 30)

Estes mecanismos **já existem** — não reimplementar:

- Live supersede + arg elision (`agent-session-live-prune.ts`)
- Defer universal 64KB + `recall_tool_output` (`tool-definition-wrapper.ts`)
- Mid-turn pressure guard B9 (`agent-session-compaction.ts`, `prepareNextTurn`)
- Wire estimate + EMA calibration (`compaction.ts`, `token-estimate.ts`)
- Lazy tool schemas + cache breakpoint (`tool-wire-schema.ts`, providers)
- Read dedupe com containment/delta (`read.ts`)
- `find` occupancy-scaled limits (`find.ts`)
- Elapsed em ações lentas 4s+ (`activity-line.ts`, `nav-group.ts`)
