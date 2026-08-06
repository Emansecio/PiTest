# Revisão completa — injeções no modelo, economia de tokens e compactação (2026-08-02)

Auditoria em três frentes (3 agentes de varredura + verificação pessoal dos achados
P1 no código). Status: **relatório**; nada foi implementado.

Verificação pessoal (✔ = conferi o código na mão): premissa do sufixo dinâmico ✔
(`anthropic.ts:1044-1068` — o sufixo relocado cai DEPOIS do breakpoint pinado no
último bloco do histórico, logo é pago a preço cheio em toda rodada de tool),
browser router não-append-only ✔ (`browser-tool-routing-extension.ts:53`), regex
amplo ✔ (`:38`), seções de modo no sufixo ✔ (`permissions-extension.ts:165-176`),
hindsight no prefixo ✔ (`agent-session.ts:3874` → `system-prompt.ts:189` antes do
marker; conteúdo mutável em `hindsight/index.ts:56-63`), bench sem `skillsMode` ✔
(`bench-session-tokens.mts:335-342` vs sessão `"hint"` em `agent-session.ts:3887`),
truncagem de description em 40 chars ✔ (`tool-wire-schema.ts:14,45-48`), overflow
recovery single-shot ✔ (`agent-session-compaction.ts:1390`, latch resetado em
`agent-session.ts:2192,2290`).

---

## 1. Veredito por frente

| Frente | Veredito |
|---|---|
| Compactação | **Funcional.** 277 testes + 61 de prune passando (rodados de verdade), nenhum P1. Ressalvas de qualidade, não de correção. |
| Prefixo cacheável (system prompt) | **Enxuto e bem cuidado** — mas com 2 vetores de invalidação silenciosa (browser router, hindsight hint) e zero vigilância sobre reescritas. |
| Sufixo dinâmico | **Virou depósito.** Texto imutável (modos, goal, todos, grounded_context) pago a preço cheio em CADA rodada de tool do turno. É onde está o maior ganho por linha alterada. |
| Gate de baseline | Mede uma configuração que o produto não envia; cego a cache hit rate, caps de tool output e imagens. |

## 2. Modelo de custo (a chave de tudo)

- **Prefixo** (antes do `SYSTEM_PROMPT_DYNAMIC_MARKER`): pago 1×, depois cache-read ~0,1×. Qualquer byte que mude re-cobra o prefixo inteiro **e o histórico replicado**.
- **Sufixo** (depois do marker, relocado para `<env>` no fim da última user message, `anthropic.ts:1053-1068`): fica após o breakpoint → **nunca é cacheado**; pago a preço cheio em toda request, inclusive cada rodada de tool. Turno com 15 rodadas paga o sufixo 15×.

Consequência: mover texto **imutável** do sufixo para o prefixo (com rebuild no evento que já causa miss) é quase sempre lucro; e proteger o prefixo de reescritas vale mais do que qualquer corte de prosa.

## 3. P1 — fazer primeiro

### P1.a Browser router faz ping-pong no prefixo (maior custo unitário do sistema)
`built-ins/browser-tool-routing-extension.ts:38-63` + `agent-session.ts:3660-3705`.
`routeBrowserTools` REMOVE tools chrome quando o prompt não casa `BROWSER_INTENT`
(linha 53) — e o regex casa `site|url|dom|console|network|element` isolados, palavras
cotidianas de sessão de código. Ativa→desativa→ativa reescreve `Available tools:`
no prefixo E muda o array de tools (que carrega `cache_control` próprio) → cache
miss total do prefixo + histórico, potencialmente a cada turno.
**Fix:** ativação append-only na sessão (nunca remover); apertar o regex (exigir
co-ocorrência para palavras ambíguas); ou migrar o roteamento para discovery
(`search_tool_bm25`), que não toca no prefixo.

### P1.b `<hindsight_hint>` mutável dentro do prefixo
`agent-session.ts:3870-3876` empurra em `appendSections` → antes do marker
(`system-prompt.ts:189` vs `:209`). O bloco renderiza contagem + 5 datas/subjects
(`hindsight/index.ts:48-67`) e **toda compactação** adiciona uma entrada ao banco
(`agent-session-compaction.ts:1089-1094`) → próximo rebuild diverge o prefixo.
O próprio arquivo documenta o anti-padrão 10 linhas acima (`sessionFrequentFiles`).
`retain` com `kind: "session-summary"` deixa o modelo invalidar o prefixo sozinho.
**Fix (mínimo):** tornar o bloco estático por construção — só o ponteiro
("summaries exist; use recall(...)"), sem contagem/datas. Bump do baseline
`hindsight_hint_chars` (exact).

### P1.c Nenhuma vigilância sobre reescritas do prefixo
`agent-session.ts:3950-3993` — `_cachePrefixRebuilds`/`_cachePrefixReasons` existem
e **ninguém consome**. Vetores conhecidos: `tool-surface` (P1.a), hindsight (P1.b),
`extensions-reload`, `model-profile`, `tool-discovery-resync`.
**Fix:** `recordDiagnostic("quality.cache-prefix-rewrite")` a partir da 2ª reescrita
com custo estimado (`historyTokens × (write − read)`); expor no `/debug`; cenário
de bench que exercite reescrita.

### P1.d Texto imutável no sufixo dinâmico (pago N× por turno)
| Bloco | Tamanho | Fix |
|---|---|---|
| `<plan_mode>`/`<ask_mode>`/`<confirm_mode>` (`permissions-extension.ts:165-176`) | 889–1077 chars | mover ao prefixo; rebuild em `onModeChange` (troca de modo já causa miss) |
| `<goal>` ativo (`goal-manager.ts:283-307`) | 750 chars (~690 imutáveis) | persistence rules → prefixo ao criar goal; sufixo só `Goal: {objective}` |
| `<todos>` (`todo-manager.ts:253-273`) | ~370 de 426 chars imutáveis | instruções de uso → prefixo ou description do tool; sufixo só a lista |
| `<grounded_context>` (`context-composer.ts:56-60,572-620`) | até 800 tok POR REQUEST | emitir só na 1ª request do turno; cap padrao 800→400; gate de ocupação 50%→30% |

Ganho estimado num turno de 12 rodadas: ~6–8k tokens/turno só com essas quatro.

### P1.e Imagens escapam de todo o pipeline de economia
`compaction/prune.ts:1191-1236` (só `type === "text"`), `tool-definition-wrapper.ts:107-108`,
`mcp/tools.ts:113-116` (imagem MCP verbatim, SEM resize e SEM cap — único caminho
de tool result sem teto no sistema). Screenshot do turno 3 é reenviado íntegro
(1200–8000 tok) todo turno até compactar; 5 screenshots da mesma página = 5 cópias
permanentes. Sobrevivem até à compactação (dentro de `keepRecentTokens`).
**Fix:** (1) prune/supersede de blocos de imagem fora da janela de proteção →
`[image elided — re-capture if needed]`; (2) screenshots no set de supersede;
(3) `resizeImage()` no caminho MCP como o `read` já faz.

### P1.f Gate de baseline mede configuração irreal
`bench-session-tokens.mts:335-342` chama `buildSystemPrompt` sem `skillsMode`
(default `"full"`) e com `loadSkills()` da máquina local; a sessão real usa
`"hint"` (`agent-session.ts:3887`). `loadContextFiles` do bench lê AGENTS.md cru,
contornando os caps de `context-files.ts`. O teto está ~10k tokens acima do real.
**Fix:** `skillsMode: "hint"` + `loadProjectContextFiles` nos benches; rebaselinar
e apertar; fixture de skills para tirar a dependência de `~/.pit`.
Lacunas estruturais do gate (adicionar): caps de truncagem como métricas `max`
(`DEFAULT_MAX_BYTES`, `BASH_MAX_BYTES`, `TOOL_OUTPUT_HARD_CAP_BYTES`,
`WEB_FETCH_MAX_CHARS`, `GET_TEXT_OUTPUT_CAP_BYTES`), cenário image-heavy,
métrica `dynamic_suffix_tokens` com sufixo populado, cache hit rate.

### P1.g Steers viram mensagens user permanentes e redundantes
`messages.ts:159-168` converte todo `custom` em `role:"user"`. Turno ruim acumula
~2.550 chars permanentes (`tool-error-reflection` 344 + `doom-loop` 413 + recovery
380 + `repeated-error` 597+400 + `stagnation` 415), todos dizendo "mude de
abordagem". **Fix:** emitir no envelope `<system-reminder>` que `prune.ts:1006-1054`
já sabe podar; fundir os 4 lembretes de loop numa família com corpo compartilhado.

## 4. P2 — relevantes

1. **Supersede não cobre rede/busca** (`prune.ts:288-299`): falta `web_fetch`
   (cuja guideline instrui paginar — 5 páginas × 6,5k tok ficam para sempre),
   `web_search`, `chrome_devtools` read-only, `search_tool_bm25`, `impact`, MCP.
   Chave genérica já serve (`url`+`start_index`).
2. **Descriptions de tool cortadas em 40 chars no meio da palavra**
   (`tool-wire-schema.ts:14`): o modelo vê ~64 frases mutiladas; o `promptSnippet`
   completo já existe e é descartado no wire (`tool-definition-wrapper.ts:191-212`).
   Propagar snippet como description do wire (fallback truncagem). Alternativa do
   outro relatório: subir o cap para ~110 chars (custo cai no prefixo cacheado).
   Capacidades invisíveis críticas (schemes `pr://`/`issue://` do read, background
   do bash) → enum/pattern no schema ou snippet.
3. **Self-review roda 6 turnos no modelo caro** (`agent-session.ts:5424-5450`):
   usar o resolvedor de sibling small-class da compaction; `PIT_NO_SELF_REVIEW`
   existe e NÃO está documentado no token-economy-tuning.md.
4. **Resize de imagem 2000×2000** (`image-resize.ts:25-30`): Anthropic downscala
   para ~1568px; OpenAI cobra os tiles extras. Baixar para 1568/q75.
5. **Flags fora do doc + truthy inconsistente**: `PIT_NO_SELF_REVIEW`,
   `PIT_READ_DEDUPE=0` (polaridade invertida), `PIT_NO_SCOPED_HINDSIGHT === "1"`
   (truthy `true` é no-op silencioso!), `PIT_NO_STALE_READ_WARNING === "1"`,
   `PIT_NO_PENDING_CHECKS === "1"`, `PIT_DEFER_MCP`, `PIT_NO_ADAPTIVE_THINKING`,
   subagent concurrency. Migrar para `isTruthyEnvFlag` + seção nova no doc.
6. **`<plan_mode>`/`<ask_mode>` listam tools inexistentes na sessão**
   (`plan-mode-prompt.ts:42-47`): 7 nomes inativos por default; omite
   `memory_append` (não lê `EXTENSION_TOOL_SIDE_EFFECTS`). Filtrar por surface
   ativo + unir os dois mapas.
7. **`promptGuidelines` de built-ins são código morto** (`agent-session.ts:3752-3756`
   descarta `source === "builtin"`), mas `bench-prompt-size.mts:92-95` as inclui —
   bench superestima. Remover os campos ou o filtro; alinhar o bench.
8. **Guidelines caras no prefixo**: "Visual verification" 385 chars sempre que há
   edit/write (condicionar a preview/chrome ativos ou repo web; encurtar ~60%);
   "Todo-first" 366 chars (usar a versão compact de 149 que já existe);
   `git diff --numstat` 167 chars (mover ao snippet do bash).
9. **`<task_rigor>` quase sempre ativo** (verbo de ação dispara rigor≥1) e repete
   guidelines do prefixo. Emitir só em rigor 3, ou 1 linha.
10. **`CONTEXT.md` nunca é carregado** (`resource-loader.ts:121-137`) — 9 KB de
    glossário de domínio fora do contexto, só via read explícito. Decidir: adicionar
    aos candidatos ou apontar do AGENTS.md.
11. **Compactação — ressalvas**: (a) mega-turno só tem prune mid-turn; se estourar,
    a recuperação de overflow tenta 1× e falha de rede mata o turno; (b) sibling
    barato escreve o resumo e a verificação separada só liga ≥80k tok — faixa
    20k–80k depende do self-check do modelo pequeno; (c) 13 testes E2E ficam
    skipped sem API key — caminho overflow→compact→retry nunca roda no gate
    hermético; falta teste de resume frio do disco pós-compaction; (d) falha em
    `buildFileDigests` após o resumo pronto derruba a compactação inteira
    (`compaction.ts:1284-1290`); (e) `proactivePruneFloor = max(64k, 25% da janela)`
    = 250k tokens pagos por turno antes de qualquer prune proativo em janela de
    1M — considerar teto absoluto (~150k).
12. **`GET_TEXT_OUTPUT_CAP_BYTES` 256KB** (~78k tok num tool result) — reduzir a
    96KB + paginação `start_index`; drift de doc: wrapper diz "recall 256KB" 3×,
    `truncate.ts:172` define 96KB.
13. **`additionalContext` de hook sem teto** (`hooks-extension.ts:176-184`) e
    **mensagens `custom` de extensão nunca podadas** (`prune.ts:1187`).

## 5. P3 — polimento (lista curta)

Frases redundantes no prefixo (`system-prompt.ts:298,305,397-399,466-468,333-336`,
~500 chars ao todo); header inconsistente do frequent-files index; nota do
grounded_context 86→57 chars; doom-loop ecoa args já visíveis no transcript; LSP
writethrough repete o nome do arquivo; descrições de tool interpolam caps resolvidos
cedo demais (anunciam 50KB quando o efetivo é 100KB em janela 1M —
`grep.ts:392`, `read.ts:754`, `bash.ts:1477`); ratios de env parseados no load do
módulo (pegadinha de teste); `formatSkillsForPrompt` (~54 linhas) inalcançável no
caminho interativo.

## 6. O que já está bom (não mexer)

Split estático/dinâmico com relocação do sufixo para depois do breakpoint; breakpoint
na última tool com array não-ordenado; 4º breakpoint para o resumo de compactação;
contabilidade OAuth dos 4 breakpoints; `prompt_cache_key` por prefixo (não por
sessão) + afinidade de shard por tipo de subagente; cache keepalive com aritmética;
head+tail universal com spill para deferred store + `recall_tool_output`;
`collapseRepeatedLines`; ReadDedupeStore completo (range containment, delta,
invalidação, LRU); supersede incremental O(novas); elisão de args com marcador
honesto de write falho; prune de pastes; guard `evaluatePruneCacheEconomics`;
estimativa ancorada em usage real com calibração por modelo; pins; compactação:
presend guard dinâmico, histerese, latch de overflow, background/speculative com
exclusão mútua, fail-open sem estado corrompido, âncora perdida → mantém tudo;
baseline com comment versionado por bump; `bench-compaction-fidelity` com trava de
qualidade.

## 7. Ordem de ataque sugerida

1. ✅ **P1.a + P1.b + P1.c** — FEITO 2026-08-02 (browser router append-only com
   intenção em 2 camadas; hindsight hint constante 311→199 chars, baseline v22;
   diagnostic `quality.cache-prefix-rewrite` info/warn + linha densa no /debug +
   invariantes em cache-prefix-diagnostics.test.ts).
2. ✅ **P1.d** — FEITO 2026-08-02 (modo/goal-rules/todo-usage no prefixo com
   `_syncPromptSessionState` reconciliando 1×/turno; sufixo `<goal>`/`<todos>`
   mínimos; grounded_context caps 600/400/250 e gate 30%; ~615 tok/request a
   menos em plan+goal+todos; §"1ª request do turno" descartado — sem hook
   por-request no loop, caps+gate cobrem). Gate completo verde: 6801 testes.
3. **P1.f** (bench honesto primeiro, para medir o efeito de 1–2 com régua certa).
4. **P1.e + P2.1** (imagens + supersede de web_fetch).
5. ✅ **Lote 5 (P2.2/P2.3/P2.5 e cia.)** — FEITO 2026-08-02 (baseline v23; gate
   completo verde 6857 testes): snippet-first no wire (fallback 40→110, snippets
   de read/write/todo/web_search/bash nomeando capacidades invisíveis); steers
   podáveis via N8 (família de loop unificada −57%, ramo `custom` adicionado ao
   prune — os steers da sessão nem eram visitados); guidelines −870/−916 chars
   no prefixo (Visual verification gated por preview/chrome, numstat cortada,
   6 P3 de fraseado); plan/ask listam só a superfície real (19→8 nomes) com
   mapas de side-effect unidos explicitamente; chrome get_text 256→96KB por
   construção; hooks `<hook_context>` com teto 16KB; self-review no sibling
   small-class (resolvedor compartilhado com a compactação, pré-check de auth,
   `PIT_NO_SELF_REVIEW_SIBLING`); 4 flags migradas para isTruthyEnvFlag
   (`PIT_NO_READ_DEDUPE` novo com alias legado); 12 flags de custo documentadas.
   Decisão CONTEXT.md: fica on-demand — AGENTS.md já aponta para ele (a
   alternativa barata da proposta); sem código. Sobra: ~20 tools ainda com
   `promptGuidelines` mortas (chip de follow-up criado).
