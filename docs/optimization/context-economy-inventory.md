# Inventário de economia de contexto — revisado contra código

> Auditoria consolidada do subsistema de tokens/contexto do Pit.  
> **Revisão 2026-06-28:** cada item A–H validado no código; falsos positivos
> removidos; redundâncias fundidas.  
> Companion: [`docs/agents/already-built.md`](../agents/already-built.md).

> **Nota para implementação:** não implemente este inventário inteiro de uma vez.
> Comece por **K1** e avance em slices pequenos, medindo impacto antes de seguir
> para K2/K3. Itens **H** são tradeoffs: não mexer neles sem benchmark A/B.

**Legenda de veredicto**

| Veredicto | Significado |
|-----------|-------------|
| **VALID** | Gap real confirmado no código |
| **PARTIAL** | Parte já existe; item válido se **estreitado** (nota abaixo) |
| **MERGED** | Duplicata de outro ID — não implementar duas vezes |
| **REMOVED** | Falso positivo — já ships ou premissa factualmente errada |
| **TRADEOFF** | Decisão de produto / A/B — não é “falta de código” |

**Resumo pós-revisão** (atualizado pós-K5)

| Veredicto | Contagem |
|-----------|----------|
| VALID | 45 |
| PARTIAL | 24 |
| MERGED | 2 |
| REMOVED | 13 |
| TRADEOFF (H1–H8) | 8 |
| Linhas inventariadas ativas | 85 |
| **Itens acionáveis distintos** | **69** (45 VALID + 24 PARTIAL) |
| **K1–K6 shipped** | 8 slices (ver §K e §I) |

---

## Eliminados (falsos positivos)

| ID | Motivo | Evidência |
|----|--------|-----------|
| **A1** (forma original) | **REMOVED** — supersede **já roda** no send path via `transformContext` → `_pruneContextForProvider` → `pruneOldToolOutputs` → `buildSupersededToolResultIndices` | `agent-session.ts:1348-1351,2896-2908`; `compaction.ts:936` |
| **D4** | **REMOVED** — premissa errada: o bash JSON-crush lê o `fullOutputPath`, não o texto já truncado | `bash.ts:858-875,1048-1054`; `output-accumulator.ts:288-314` |
| **D7** | **REMOVED** — defer no prune grava disco + excerpt inline; corpo completo só via `recall_tool_output` | `compaction.ts:978-996`; `recall-tool-output.ts` |
| **D11** | **REMOVED** — echo cap já existe (`ECHO_MAX_STRING_POINTS = 600`) | `packages/ai/src/utils/validation.ts:22-37` |
| **F10** | **REMOVED** — `lean` default **true** (`lean: raw?.lean !== false`) | `settings-manager.ts:328-329,1822` |
| **A1′** | **REMOVED** — K3: supersede abaixo do prune floor no send path | `agent-session.ts:2961-3017` (`applySupersedeOnly` quando `contextTokens ≤ floor`) |
| **A4** (forma original) | **REMOVED** — K4: cap thinking no contexto vivo | `capThinkingForContext` + `applyOldThinkingCap` em `_pruneContextForProvider` |
| **D2** | **REMOVED** — K3: supersede imediato pós-tool-call | `agent-session-live-prune.ts` (`applyLiveContextEconomyAfterToolSuccess`) |
| **B1, B2, B6** | **REMOVED** — K2: wire estimate + presend com user pendente + footer wire | `estimateWireTokens`, `agent-session-compaction.ts`, `getContextUsage` |
| **E16** | **REMOVED** — K5: dedupe de entry points ponteiro | `context-files.ts` + `resource-loader.ts` |
| **G3** | **REMOVED** — K1: bench sintético de sessão | `scripts/bench-session-tokens.mts` |

---

## Fundidos (redundâncias)

| ID | Fundido em | Motivo |
|----|------------|--------|
| **C3** | **A4** | Mesmo gap (resolvido K4); cap thinking só em `serializeConversation` antes de K4 |
| **D1** | **A3** | Mesmo gap: elision de args de mutação só na prune, não pós-sucesso no histórico |

---

## A. Generalizações — 10 itens

| ID | Veredicto | Sugestão | Nota de revisão |
|----|-----------|----------|-----------------|
| A1′ | **REMOVED** | — | K3 — ver Eliminados |
| A2 | **PARTIAL** | Ampliar `SUPERSEDED_TOOL_RESULT_NAMES` de forma seletiva | `grep/find/ls/symbol/find_symbol` já estão cobertos; foco real é `ast_grep`, `lsp`, `repo_map`. `bash` só com allowlist/fingerprint |
| A3 | **PARTIAL** | Elision pós-sucesso no histórico assistant | K3 elide mutating tools live (`agent-session-live-prune.ts`); prune path já elide (`compaction.ts:944-962`). Gap residual: histórico antigo / tools fora da allowlist |
| A4 | **REMOVED** | — | K4 — ver Eliminados |
| A5 | **VALID** | Read dedupe pós-compact seletivo | `readDedupeStore?.clear()` incondicional em todo compact (`agent-session-compaction.ts:115`) |
| A6 | **VALID** | Caps adaptativos read/grep/bash | `adaptivePruneThreshold` não liga aos `DEFAULT_MAX_*` das tools |
| A7 | **PARTIAL** | Grep auto `files_with_matches` quando matches > N | Modo existe e a descrição já recomenda; falta auto-switch (modelo ignora hint) (`grep.ts:581`) |
| A8 | **VALID** | MCP output profiles (crush por servidor) | Wrapper uniforme 64KB (`tool-definition-wrapper.ts`) |
| A9 | **PARTIAL** | Cap em mensagens de grounding guard | Real principalmente no bash grounding (`bash-grounding.ts:82-86`); outros guards já têm top-N parcial, mas sem cap final de mensagem |
| A10 | **VALID** | `find` default menor / occupancy-scaled | `DEFAULT_LIMIT = 1000` (`find.ts:36`) |

---

## B. Estimação e presend — 10 itens

| ID | Veredicto | Sugestão | Nota de revisão |
|----|-----------|----------|-----------------|
| B1 | **REMOVED** | — | K2 — `estimateWireTokens` em `compaction.ts` |
| B2 | **REMOVED** | — | K2 — presend inclui user pendente |
| B3 | **VALID** | Calibrated trailing fudge | Sem bias `providerInput − estimate` |
| B4 | **VALID** | `PRESEND_OVERFLOW_RATIO` dinâmico | Constante 0.95 (`agent-session-compaction.ts:38`) |
| B5 | **VALID** | Mid-turn presend em `agent-loop.ts` | Só `transformContext` antes de stream; sem presend (`agent-loop.ts:514-518`) |
| B6 | **REMOVED** | — | K2 — footer expõe `wireTokens` via `getContextUsage` |
| B7 | **PARTIAL** | Fudge por densidade calibrado | Heurística dense/prose/CJK existe; sem calibração por histórico provider |
| B8 | **VALID** | Reservar thinking budget no presend | Não implementado |
| B9 | **VALID** | Presend entre tool rounds (~92%) | Distinto de B5 (threshold/ação); gap real |
| B10 | **PARTIAL** | Kill-switch granular por estágio | `PIT_NO_PRESEND_OVERFLOW_GUARD` global (`agent-session-compaction.ts:335`) |

---

## C. Compaction e summarization — 11 itens (C3 fundido em A4)

| ID | Veredicto | Sugestão | Nota de revisão |
|----|-----------|----------|-----------------|
| C1 | **PARTIAL** | Delta summarization | K6: 2ª+ compact usa `serializeConversationDelta` em `<conversation-delta>` (JSON compacto, sem thinking); gap residual: summarizer ainda gera prose completo (C2) |
| C2 | **PARTIAL** | Structured-primary context | K8+K10: JSON-primary summarizer (`STRUCTURED_SUMMARY_SCHEMA`, `normalizeStructuredSummaryOutput`) + trim pós-parse; opt-out `PIT_NO_STRUCTURED_SUMMARY_OUTPUT` / `PIT_NO_COMPACT_SUMMARY_OUTPUT` |
| C4 | **RESOLVED** | Self-correction gate mais fino | `VERIFY_MIN_INPUT_TOKENS=25000` existe; o passe agora entaila o summary contra a fonte (`buildVerificationSource` → `<conversation-delta>` + `<summary>` + regra anti-fabricação em `compaction.ts`); grounding determinístico de paths em `compaction/summary-grounding.ts` marca fabricações com `(unverified)`. Inflação ainda `length/4` (gate existente mantido) |
| C5 | **VALID** | Multipass coalescing | 2º `executeCompactionPipeline` síncrono possível (`agent-session-compaction.ts:456-477`) |
| C6 | **VALID** | Branch skip gate | Sem skip por N entries / T tokens |
| C7 | **VALID** | Branch/tool parity | Branch `skipToolResults: true`; compaction inclui tool results |
| C8 | **VALID** | Hindsight dedup pós-compact | Summaries injetados sem checar idade vs compaction |
| C9 | **VALID** | Summary single sink | Três vias paralelas (entry + message + hindsight) |
| C10 | **VALID** | Compaction por fase | Sem detector explore/implement |
| C11 | **VALID** | `keepRecent` por tool-density | `effectiveKeepRecentTokens` escala janela, não densidade de tools |
| C12 | **VALID** | Structural-only threshold tunável | `STRUCTURAL_ONLY_PROSE_THRESHOLD = 200` fixo |

---

## D. Camada de tools — 8 itens acionáveis (D1→A3, D4/D7/D11 removidos)

| ID | Veredicto | Sugestão | Nota de revisão |
|----|-----------|----------|-----------------|
| D2 | **REMOVED** | — | K3 — ver Eliminados |
| D3 | **PARTIAL** | Patch-audit mais enxuto | Não há cap explícito, mas a mensagem é checklist curto/fixo; baixo risco |
| D5 | **VALID** | Read dedupe LRU maior | `READ_DEDUPE_WINDOW = 16` |
| D6 | **VALID** | Delta read threshold tunável | Constantes fixas 1500 / 0.5 (`read.ts:94-96`) |
| D8 | **VALID** | Prioridade read-recent vs bash-old na prune | Walk por índice apenas |
| D9 | **VALID** | Coalesce grep+find live | Dedup só em `serializeConversation` para summarizer |
| D10 | **PARTIAL** | Unknown-tool list dinâmico | `UNKNOWN_TOOL_MAX_LISTED = 16` com suffix (`agent-loop.ts:986`) |
| D12 | **PARTIAL** | Repair note mais curto default | Existe mas gated por `emitRepairNotes` / modelo fraco |

---

## E. System prompt, schemas, prefix — 16 itens

| ID | Veredicto | Sugestão | Nota de revisão |
|----|-----------|----------|-----------------|
| E1 | **PARTIAL** | Lazy schemas | K5: `compactToolSchemaForWire` no wire (`tool-wire-schema.ts`, opt-out `PIT_NO_LAZY_TOOL_SCHEMAS`). Gap residual: API `description` completa (ver E9) |
| E2 | **PARTIAL** | Tools cache breakpoint separado | K5: tools sorted by name + `cache_control` no **primeiro** tool (`anthropic.ts`, `openai-completions.ts`). Gap residual: bloco hash-keyed isolado |
| E3 | **PARTIAL** | Memory recall gate | K10: `formatMemoryHintForPrompt` (paths + preview + `read()` hint); opt-out `PIT_NO_MEMORY_ON_DEMAND` restaura inject completo |
| E4 | **PARTIAL** | Hindsight on-demand | K10: `formatHindsightHintForPrompt` + `recall({ kinds: ["session-summary"] })`; opt-out `PIT_NO_HINDSIGHT_ON_DEMAND` |
| E5 | **VALID** | Guideline tiers | Bloco único; karpathy opt-in, não tiered |
| E6 | **PARTIAL** | AGENTS.md retrieval | K5: head+tail + hint `read({ path })` acima de 8k chars (`context-files.ts`, opt-out `PIT_NO_CONTEXT_RETRIEVAL`). Gap residual: recall BM25/on-demand do corpo completo |
| E7 | **PARTIAL** | Skills mais agressivo | Index mode existe; `SKILLS_FULL_LIMIT = 15` |
| E8 | **VALID** | `setActiveTools` sem rebuild total | Sempre `_rebuildSystemPrompt(..., "tool-surface")` |
| E9 | **PARTIAL** | Tool descriptions stub na API | System prompt já lista name/snippet; custo restante é schema + API `description` |
| E10 | **VALID** | Phase detector (explore/implement packs) | Tipo `explore` existe; sem switch de prompt por fase |
| E11 | **VALID** | `prepareNextTurn` para economia | Hook em `agent-loop.ts:392`; coding-agent não wired |
| E12 | **VALID** | Provider token-efficient-tools | Não integrado |
| E13 | **VALID** | Frequent-files condicional | Emitido sempre que há dados; sem gate de ocupação |
| E14 | **PARTIAL** | Dynamic suffix mínimo | Outlines capped 12 (`system-prompt.ts:135-164`); não single-line |
| E15 | **PARTIAL** | MCP defer mais agressivo | `shouldDeferMcpServer` ≥10 tools; servers pequenos eager |
| E16 | **REMOVED** | — | K5 — `context_files_chars=8568` (antes ~10.272 com AGENTS+CLAUDE duplicados) |

**Baseline prefixo (pós-K5, PiTest, 2026-06-28):** `npx tsx scripts/bench-prompt-size.mts`

| Métrica | Valor |
|---------|-------|
| `prompt_prefix_tokens` | 25531 |
| `wire_prefix_tokens` | 17814 (−30% vs prompt) |
| `context_files_chars` | 8568 |
| `skills_chars` / visíveis | 38688 / 91 |
| tool desc+param (full) | 4819 + 7605 toks |
| tool desc+param (wire) | 1571 + 3136 toks |

---

## F. Fusion, subagents, hindsight — 10 itens (F10 removido)

| ID | Veredicto | Sugestão | Nota de revisão |
|----|-----------|----------|-----------------|
| F1 | **PARTIAL** | Cap panel text antes judge/writer | K10: `capPanelText` / `FUSION_PANEL_TEXT_MAX_CHARS=6000` em judge/writer/verifier builders; bench `bench-fusion-tokens.mts` |
| F2 | **PARTIAL** | Skip verify se `unsupportedClaims` vazio | K10: `shouldSkipFusionVerify` em `orchestrator.ts` (lone survivor ainda verifica) |
| F3 | **PARTIAL** | Fusion token ledger | K8: `recordFusionSpend` em brief/panel/judge/verify/writer; `fusionSpent` no footer. Gap: panel usa estimativa chars (CLI externo) |
| F4 | **PARTIAL** | `enforceLimit` em todo `add()` | Limite é aplicado no `openBank`; gap é enforcement incremental após novas gravações |
| F5 | **VALID** | BM25 min score no recall | `score > 0` aceita qualquer hit (`bank.ts:287`) |
| F6 | **PARTIAL** | Subagent usage no footer | K7 expõe `subagentSpent` em `getContextUsage` quando budget ativo ou subagent spend > 0; sem breakdown por handle |
| F7 | **PARTIAL** | Abort subagents on dispose | Cada task tem `AbortController`; gap é abortar todos os controllers pendentes no dispose da sessão |
| F8 | **PARTIAL** | Pre-spawn vs `goal.tokenBudget` | K7 gate em `task` run/spawn/resume quando budget esgotado; sem reserva estimada pré-spawn |
| F9 | **VALID** | Fusion verify no registry pai | `new SubagentRegistry()` efêmero (`agent-session-fusion.ts:174`) |
| F11 | **PARTIAL** | Hindsight cleanup fim subagent | `enforcePerScopeLimit` no open; sem hook fim-subagent |

---

## G. Governança e medição — 12 itens

| ID | Veredicto | Sugestão | Nota de revisão |
|----|-----------|----------|-----------------|
| G1 | **PARTIAL** | Token budget governor unificado | K7+K9b: main+subagent+fusion → goal + `tokenSpendSplit` persist/reload; gate spawn; footer splits. Gap: footer breakdown por handle (F6) |
| G2 | **VALID** | Auto-tighten prune em `instabilityTurn` | Warning TUI only (`interactive-mode.ts:5776`) |
| G3 | **REMOVED** | — | K1 — `scripts/bench-session-tokens.mts` (3 cenários + METRIC) |
| G4 | **PARTIAL** | Bench fusion+coordinator | K9c — `scripts/bench-fusion-tokens.mts` (synthetic stage model + gate); gap: turno real com CLI |
| G5 | **PARTIAL** | Export prefix-rebuild reasons | Já aparece no `/cache-status`; falta export estruturado para bench/diagnóstico automatizado |
| G6 | **VALID** | A/B prune vs cache | Sem harness |
| G7 | **VALID** | A/B frequentFiles suffix | Sem harness |
| G8 | **PARTIAL** | A/B self-correction | Régua determinística em `scripts/bench-compaction-fidelity.mts` (structural recall, fabricated-flagged, false-positive) com gate no `check-token-bench.mjs`; modo `--live` para A/B manual de `generateSummary`+`verifySummary`. Falta A/B automatizado com modelo real em CI |
| G9 | **VALID** | Telemetria por tool na prune | Sem breakdown por `toolName` |
| G10 | **VALID** | Dashboard `/economy` | Não existe |
| G11 | **REMOVED** | — | K9a — `bench-session-tokens.mts` emite `mechanism=* reclaimed_tokens` (thinking_cap, prune_tool_output, supersede, arg_elision) |
| G12 | **REMOVED** | — | K8 — `scripts/check-token-bench.mjs` + `scripts/baselines/token-economy.json` no `npm run check` |

---

## H. Trade-offs — 8 itens (todos **TRADEOFF**, permanecem válidos como decisões)

| ID | Veredicto | Tema | Nota |
|----|-----------|------|------|
| H1 | TRADEOFF | Prune proativo vs cache | `proactivePruneFloor` existe; falta número |
| H2 | TRADEOFF | frequentFiles no suffix | Suffix uncached por design (`system-prompt.ts:140-148`) |
| H3 | TRADEOFF | Self-correction 2× summarizer | `selfCorrection` default true |
| H4 | TRADEOFF | readDedupe clear on compact | Comportamento atual documentado em A5 |
| H5 | TRADEOFF | Lazy schemas (E1) | K5 compacta wire; discovery/defer cobre ocultos — tradeoff qualidade de schema vs tokens |
| H6 | TRADEOFF | Thinking prune live (A4) | K4 shipped; tradeoff fidelidade do raciocínio antigo vs custo |
| H7 | TRADEOFF | Compaction agressiva vs qualidade | — |
| H8 | TRADEOFF | Arg elision vs auditoria (A3) | — |

---

## I. Já existe (não re-propor)

1. Compaction multipass, soft/background, overflow, hysteresis 8k  
2. `pruneOldToolOutputs` + supersede (no send path **acima do prune floor**)  
3. Read dedupe + delta  
4. `recall_tool_output` + defer lazy  
5. Prompt cache 4 breakpoints + dynamic marker  
6. Tool discovery BM25 + MCP defer parcial  
7. Truncation caps + wrapper 64KB  
8. Schema echo cap 600 chars (`validation.ts`) — **não D11**  
9. Repair harness completo  
10. `frequentFiles`, `proactivePruneFloor`  
11. Fusion `lean` default true — **não F10**  
12. Bash JSON-crush lê o output completo via `fullOutputPath` — **não D4**  
13. **K1** — `bench-session-tokens.mts` (explore-heavy / edit-heavy / long-reasoning)  
14. **K2** — `estimateWireTokens`, presend com user pendente, footer `wireTokens`  
15. **K3** — supersede abaixo do floor + live supersede/arg-elision pós-tool (`agent-session-live-prune.ts`)  
16. **K4** — thinking cap no contexto vivo (`capThinkingForContext`, opt-out `PIT_NO_THINKING_CAP`)  
17. **K5** — lazy wire schemas (`tool-wire-schema.ts`), tools cache no primeiro sorted tool, context retrieval head+tail, dedupe AGENTS/CLAUDE (`context-files.ts`)  
18. **K6** — delta summarization input (`serializeConversationDelta`, `<conversation-delta>`; opt-out `PIT_NO_DELTA_SUMMARIZATION`)  
19. **K7** — `TokenBudgetGovernor`: main+subagent ledger, goal sync, spawn gate, `ContextUsage` budget fields  

---

## J. Vaporware

1. Diff-limit (ADR-0002)  
2. scoped-models  
3. Compact pipeline paralelo novo do zero  

---

## K. Ordem sugerida (pós-revisão)

| Passo | IDs | Descrição |
|-------|-----|-----------|
| K1 | G3 | [`scripts/bench-session-tokens.mts`](../../scripts/bench-session-tokens.mts) — **shipped** |
| K2 | B1, B2, B6 | Wire estimate + presend com user pendente + footer wire — **shipped** |
| K3 | A3, D2, A1′ | Arg elision live + supersede imediato + supersede abaixo do floor — **shipped** |
| K4 | A4 | Cap thinking no contexto vivo — **shipped** |
| K5 | E1, E2, E6, E16 | Reduzir prefixo fixo: lazy schemas, tools breakpoint e dedupe/retrieval de context files — **shipped** |
| K6 | C1 | Delta summarization (2nd+ compact JSON input) — **shipped** |
| K7 | G1 | Token governor (unified ledger + spawn gate) — **shipped** |
| K8 | G12, C2, F3 | CI token regression gate + structured-primary trim + fusion ledger — **shipped** |
| K9 | G11, G1 persist, G4 | Mechanism METRIC breakdown + goal `tokenSpendSplit` reload + `bench-fusion-tokens` — **shipped** |
| K10 | F1, F2, E3, E4, C2 | Memory/hindsight hints on-demand, JSON summarizer, fusion panel cap + verify skip — **shipped** |
| K11 | C4, G8 | Anti-hallucinação da compactação: verify com fonte (`buildVerificationSource`), grounding determinístico (`summary-grounding.ts`), tool `recall_history` (`history-recall.ts`), role `compact` (`model-resolver.ts`), bench de fidelidade + gate CI (`bench-compaction-fidelity.mts`) — **shipped** |

**Pendente imediato (roadmap):** observar em produção as categorias `fusion.verify-skipped`, `compaction.summary-json-fallback`, `fusion.panel-char-estimate` (runtime diagnostics).

**Gaps residuais dos itens K5 (ainda PARTIAL, não reabrir como VALID):** E1 API description stub (overlap E9), E2 bloco hash-keyed isolado, E6 recall BM25 do corpo completo.

---

## Baseline sessão (`bench-session-tokens.mts`, 2026-06-28, pós-K5)

Rodar: `npx tsx scripts/bench-session-tokens.mts` (ou `--scenario=long-reasoning`).

`prefix_tokens` compartilhado (sintético): **26704**.

**K6 delta input (pós-K6, `bench-session-tokens.mts` seção `summarization-input`):**

| Cenário | serialize_prose | serialize_delta | incremental_saved |
|---------|-----------------|-----------------|-------------------|
| explore-heavy | 28989 chars | 20343 (−30%) | −29% |
| edit-heavy | 11388 | 8238 (−28%) | −25% |
| long-reasoning | 17416 | 7158 (−59%) | −55% |

| Cenário | messages_only | wire_estimate | after_live_economy | live_economy_reclaimed |
|---------|---------------|---------------|--------------------|------------------------|
| explore-heavy | 62631 | 89335 | 56747 | 32588 |
| edit-heavy | 57657 | 84361 | 28057 | 56314 |
| long-reasoning | 17830 | 44534 | 34058 | 12700 |

Notas:
- **long-reasoning:** reclaim 12700 = K4 thinking cap (wire 44534 → 34058).
- **edit-heavy:** reclaim 56314 = K3/K4 combinados (arg elision + thinking cap); maior ganho dos 3 cenários.
- **explore-heavy:** prune de tool outputs domina; live economy = after_prune neste cenário.

---

## Medido vs hipótese (pós-K5)

| Cluster | Hipótese | Medido (2026-06-28) | Status |
|---------|----------|---------------------|--------|
| K5 prefix wire (E1/E2/E6/E16) | 10–30% custo fixo | `wire_prefix` 17814 vs `prompt_prefix` 25531 (−30%) | **confirmado** (PiTest) |
| K4 thinking live (A4) | 10–40% em reasoning | long-reasoning −12700 toks (28.5%) | **confirmado** |
| K3 edit-heavy live economy | 10–30% | edit-heavy −56314 toks (66.8% do wire) | **confirmado** (cenário sintético agressivo) |
| K2 wire + presend (B1–B2) | 5–15% menos overflow | infra shipped; overflow rate não benchmarkado ainda | shipped, sem A/B |
| K6 delta summarization input (C1) | 20–50% summarizer 3ª+ | long-reasoning incremental −55%; explore −29%; edit −25% | **confirmado** (input proxy) |
| E3/E4 memory/hindsight on-demand | 10–30% prefix | bench: memory −95%, hindsight −86% (synthetic) | **confirmado** (fixture) |

---

## Estimativas restantes (hipótese — pós-K5)

| Cluster | Potencial | Confiança |
|---------|-----------|-----------|
| C2 structured-primary summarizer output | 20–40% custo output summarizer | Média |
| E3/E4 memory + hindsight on-demand | 10–30% prefix em sessões longas | Média |
| A2 expandir supersede tools | 5–15% exploratório | Baixa–média |
| G12 CI regression gate | evita regressão silenciosa | Alta (valor operacional) |

---

## Origem

- Auditoria inicial: 5 agentes paralelos (2026-06-28)  
- Revisão código: 2 agentes + verificação manual (`_pruneContextForProvider`, `validation.ts`, `lean` default)  
- Revalidação extra manual (2026-06-28): contagens corrigidas, D4 removido, E16 adicionado  
- Baselines pós-K5 (2026-06-28): `bench-prompt-size.mts` + `bench-session-tokens.mts` (3 cenários)  
- Roadmap: [`pit-agent-performance-quality-roadmap.md`](./pit-agent-performance-quality-roadmap.md)
