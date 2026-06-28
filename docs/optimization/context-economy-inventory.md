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

**Resumo pós-revisão**

| Veredicto | Contagem |
|-----------|----------|
| VALID | 54 |
| PARTIAL | 23 |
| MERGED | 2 |
| REMOVED | 5 |
| TRADEOFF (H1–H8) | 8 |
| Linhas inventariadas ativas | 85 |
| **Itens acionáveis distintos** | **77** (54 VALID + 23 PARTIAL) |

---

## Eliminados (falsos positivos)

| ID | Motivo | Evidência |
|----|--------|-----------|
| **A1** (forma original) | **REMOVED** — supersede **já roda** no send path via `transformContext` → `_pruneContextForProvider` → `pruneOldToolOutputs` → `buildSupersededToolResultIndices` | `agent-session.ts:1348-1351,2896-2908`; `compaction.ts:936` |
| **D4** | **REMOVED** — premissa errada: o bash JSON-crush lê o `fullOutputPath`, não o texto já truncado | `bash.ts:858-875,1048-1054`; `output-accumulator.ts:288-314` |
| **D7** | **REMOVED** — defer no prune grava disco + excerpt inline; corpo completo só via `recall_tool_output` | `compaction.ts:978-996`; `recall-tool-output.ts` |
| **D11** | **REMOVED** — echo cap já existe (`ECHO_MAX_STRING_POINTS = 600`) | `packages/ai/src/utils/validation.ts:22-37` |
| **F10** | **REMOVED** — `lean` default **true** (`lean: raw?.lean !== false`) | `settings-manager.ts:328-329,1822` |

**Substituição de A1 (gap real estreito):** ver **A1′** abaixo — supersede só dispara quando
`contextTokens > proactivePruneFloor` (~64k ou 25% da janela); abaixo disso resultados
supersedidos permanecem inteiros até compact.

---

## Fundidos (redundâncias)

| ID | Fundido em | Motivo |
|----|------------|--------|
| **C3** | **A4** | Mesmo gap: cap de thinking só em `serializeConversation`, não no contexto vivo |
| **D1** | **A3** | Mesmo gap: elision de args de mutação só na prune, não pós-sucesso no histórico |

---

## A. Generalizações — 10 itens

| ID | Veredicto | Sugestão | Nota de revisão |
|----|-----------|----------|-----------------|
| A1′ | **VALID** | Supersede **abaixo do prune floor** | Colapsar superseded reads/greps mesmo quando `contextTokens ≤ proactivePruneFloor` (hoje noop em `_pruneContextForProvider:2902`) |
| A2 | **PARTIAL** | Ampliar `SUPERSEDED_TOOL_RESULT_NAMES` de forma seletiva | `grep/find/ls/symbol/find_symbol` já estão cobertos; foco real é `ast_grep`, `lsp`, `repo_map`. `bash` só com allowlist/fingerprint |
| A3 | **PARTIAL** | Elision pós-sucesso no histórico assistant | `pruneToolCallArguments` já elide na prune (`compaction.ts:944-962`); falta após tool success / fora do threshold |
| A4 | **VALID** | Cap thinking no contexto vivo | `THINKING_MAX_CHARS=1500` só em `serializeConversation` (`utils.ts:340,508-511`) |
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
| B1 | **VALID** | `estimateWireTokens()` | Só `estimateContextTokens(messages)` — sem system/tools/user (`compaction.ts:183-210`) |
| B2 | **VALID** | Presend com user pendente | Presend em `messages` **antes** de append user (`agent-session.ts:3248-3269`) |
| B3 | **VALID** | Calibrated trailing fudge | Sem bias `providerInput − estimate` |
| B4 | **VALID** | `PRESEND_OVERFLOW_RATIO` dinâmico | Constante 0.95 (`agent-session-compaction.ts:38`) |
| B5 | **VALID** | Mid-turn presend em `agent-loop.ts` | Só `transformContext` antes de stream; sem presend (`agent-loop.ts:514-518`) |
| B6 | **VALID** | Footer com wire estimate | `getContextUsage` = msgs only (`agent-session.ts:5179`) |
| B7 | **PARTIAL** | Fudge por densidade calibrado | Heurística dense/prose/CJK existe; sem calibração por histórico provider |
| B8 | **VALID** | Reservar thinking budget no presend | Não implementado |
| B9 | **VALID** | Presend entre tool rounds (~92%) | Distinto de B5 (threshold/ação); gap real |
| B10 | **PARTIAL** | Kill-switch granular por estágio | `PIT_NO_PRESEND_OVERFLOW_GUARD` global (`agent-session-compaction.ts:335`) |

---

## C. Compaction e summarization — 11 itens (C3 fundido em A4)

| ID | Veredicto | Sugestão | Nota de revisão |
|----|-----------|----------|-----------------|
| C1 | **PARTIAL** | Delta summarization | 2ª+ compact usa `<previous-summary>` prose + serialize full (`compaction.ts:1092-1203`); sem delta JSON-only |
| C2 | **PARTIAL** | Structured-primary context | Digests/`formatFileOperations` existem; LLM ainda gera prose completo |
| C4 | **PARTIAL** | Self-correction gate mais fino | `VERIFY_MIN_INPUT_TOKENS=25000` existe; inflação ainda `length/4` |
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
| D2 | **VALID** | Supersede **imediato** pós-tool-call | Diferente de A1′: colapsar no momento do result, não só no próximo LLM/prune |
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
| E1 | **PARTIAL** | Lazy schemas | **Já parcial:** tools ocultos/MCP-deferred fora do wire até ativar (`tool-discovery.ts`, `mcp-extension.ts`); ativos ainda mandam schema completo |
| E2 | **PARTIAL** | Tools cache breakpoint separado | `cache_control` no último tool (`anthropic.ts:1257`); sem bloco hash-keyed isolado |
| E3 | **VALID** | Memory recall gate | `MEMORY.md` inteiro no prefix (`memory/index.ts:79-84`) |
| E4 | **VALID** | Hindsight on-demand | Summaries no prefix cacheável, não BM25 por turn |
| E5 | **VALID** | Guideline tiers | Bloco único; karpathy opt-in, não tiered |
| E6 | **VALID** | AGENTS.md retrieval | Arquivo inteiro em `<project_context>` |
| E7 | **PARTIAL** | Skills mais agressivo | Index mode existe; `SKILLS_FULL_LIMIT = 15` |
| E8 | **VALID** | `setActiveTools` sem rebuild total | Sempre `_rebuildSystemPrompt(..., "tool-surface")` |
| E9 | **PARTIAL** | Tool descriptions stub na API | System prompt já lista name/snippet; custo restante é schema + API `description` |
| E10 | **VALID** | Phase detector (explore/implement packs) | Tipo `explore` existe; sem switch de prompt por fase |
| E11 | **VALID** | `prepareNextTurn` para economia | Hook em `agent-loop.ts:392`; coding-agent não wired |
| E12 | **VALID** | Provider token-efficient-tools | Não integrado |
| E13 | **VALID** | Frequent-files condicional | Emitido sempre que há dados; sem gate de ocupação |
| E14 | **PARTIAL** | Dynamic suffix mínimo | Outlines capped 12 (`system-prompt.ts:135-164`); não single-line |
| E15 | **PARTIAL** | MCP defer mais agressivo | `shouldDeferMcpServer` ≥10 tools; servers pequenos eager |
| E16 | **VALID** | Dedup/compactação de arquivos ponteiro (`AGENTS.md`/`CLAUDE.md`) | Loader pode carregar arquivos de contexto redundantes; bench local mostrou `AGENTS.md, CLAUDE.md` somando 10.272 chars (`resource-loader.ts:122,604-616`) |

**Baseline medido em 2026-06-28 (pós-K5):** `npx tsx scripts/bench-prompt-size.mts` →
`wire_prefix_tokens=17814`, `prompt_prefix_tokens=25531`, `system_prompt_chars=48493`,
`context_files_chars=8568`, `skills_chars=38688`, `wire_tool_desc_chars=5814`,
`wire_tool_param_chars=11603` (full tool_desc/param: 17832 / 28139).

---

## F. Fusion, subagents, hindsight — 10 itens (F10 removido)

| ID | Veredicto | Sugestão | Nota de revisão |
|----|-----------|----------|-----------------|
| F1 | **VALID** | Cap panel text antes judge/writer | `r.text` integral (`fusion/judge.ts`, `buildWriterContext`) |
| F2 | **VALID** | Skip verify se `unsupportedClaims` vazio | Gated só por `settings.verify` |
| F3 | **VALID** | Fusion token ledger | Chars/tempo sim; sem tokens synth+verify+writer |
| F4 | **PARTIAL** | `enforceLimit` em todo `add()` | Limite é aplicado no `openBank`; gap é enforcement incremental após novas gravações |
| F5 | **VALID** | BM25 min score no recall | `score > 0` aceita qualquer hit (`bank.ts:287`) |
| F6 | **VALID** | Subagent usage no footer | `getContextUsage` ignora registry |
| F7 | **PARTIAL** | Abort subagents on dispose | Cada task tem `AbortController`; gap é abortar todos os controllers pendentes no dispose da sessão |
| F8 | **VALID** | Pre-spawn vs `goal.tokenBudget` | Budget pós-turn; sem gate em spawn |
| F9 | **VALID** | Fusion verify no registry pai | `new SubagentRegistry()` efêmero (`agent-session-fusion.ts:174`) |
| F11 | **PARTIAL** | Hindsight cleanup fim subagent | `enforcePerScopeLimit` no open; sem hook fim-subagent |

---

## G. Governança e medição — 12 itens

| ID | Veredicto | Sugestão | Nota de revisão |
|----|-----------|----------|-----------------|
| G1 | **VALID** | Token budget governor unificado | Fragmentado (goal / subagent / fusion) |
| G2 | **VALID** | Auto-tighten prune em `instabilityTurn` | Warning TUI only (`interactive-mode.ts:5776`) |
| G3 | **VALID** | `bench-session-tokens.mts` | Não existe; só `bench-prompt-size.mts` |
| G4 | **VALID** | Bench fusion+coordinator | Sem cenário em `bench/scenarios/` |
| G5 | **PARTIAL** | Export prefix-rebuild reasons | Já aparece no `/cache-status`; falta export estruturado para bench/diagnóstico automatizado |
| G6 | **VALID** | A/B prune vs cache | Sem harness |
| G7 | **VALID** | A/B frequentFiles suffix | Sem harness |
| G8 | **VALID** | A/B self-correction | Sem harness |
| G9 | **VALID** | Telemetria por tool na prune | Sem breakdown por `toolName` |
| G10 | **VALID** | Dashboard `/economy` | Não existe |
| G11 | **PARTIAL** | METRIC por mecanismo | `bench-prompt-size` emite METRIC; não por feature |
| G12 | **VALID** | CI regression gate tokens | Não existe |

---

## H. Trade-offs — 8 itens (todos **TRADEOFF**, permanecem válidos como decisões)

| ID | Veredicto | Tema | Nota |
|----|-----------|------|------|
| H1 | TRADEOFF | Prune proativo vs cache | `proactivePruneFloor` existe; falta número |
| H2 | TRADEOFF | frequentFiles no suffix | Suffix uncached por design (`system-prompt.ts:140-148`) |
| H3 | TRADEOFF | Self-correction 2× summarizer | `selfCorrection` default true |
| H4 | TRADEOFF | readDedupe clear on compact | Comportamento atual documentado em A5 |
| H5 | TRADEOFF | Lazy schemas (E1) | Parcialmente mitigado por discovery/defer |
| H6 | TRADEOFF | Thinking prune live (A4) | — |
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
| K6 | C1 | Delta summarization (estreitar C2 se C1 resolver) |
| K7 | G1 | Token governor |
| K8 | — | Demais VALID por impacto medido |

---

## Baseline G3 (`bench-session-tokens.mts`, 2026-06-28)

Referência para regressão pós-K2/K3. Rodar: `npx tsx scripts/bench-session-tokens.mts`.

| Cenário | messages_only | wire_estimate | after_prune | prune_reclaimed |
|---------|---------------|---------------|-------------|-----------------|
| explore-heavy | 62631 | 89335 | 56747 | 32588 |
| edit-heavy | 57657 | 84361 | 28057 | 56314 |
| long-reasoning | 17830 | 44534 | 34058 | 12700 |

`prefix_tokens` compartilhado: **26704**. Coluna `after_prune`/`reclaimed` pós-K3 = **`after_live_economy`** / **`live_economy_reclaimed`** no bench.

---

## Estimativas (hipótese — só após G3)

| Cluster | Potencial | Confiança |
|---------|-----------|-----------|
| B1–B2 wire + presend | 5–15% menos overflow tardio | Alta |
| E1/E3/E4/E6/E16 prefix retrieval | 10–30% custo fixo em sessões com MEMORY/AGENTS grandes | Média |
| A4 thinking live | 10–40% transcript em reasoning high | Alta em sessões longas |
| A3 arg elision live | 10–30% em edit-heavy | Alta |
| A1′+D2 supersede | 5–20% exploratório | Média |
| C1 delta summarization | 20–50% custo summarizer 3ª+ compact | Média |

---

## Origem

- Auditoria inicial: 5 agentes paralelos (2026-06-28)  
- Revisão código: 2 agentes + verificação manual (`_pruneContextForProvider`, `validation.ts`, `lean` default)  
- Revalidação extra manual (2026-06-28): contagens corrigidas, D4 removido, E16 adicionado e baseline medido com `scripts/bench-prompt-size.mts`  
- Roadmap: [`pit-agent-performance-quality-roadmap.md`](./pit-agent-performance-quality-roadmap.md)
