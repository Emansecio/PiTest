# Harness — Análise de melhorias para modelos abertos/chineses no Pit

> Relatório consolidado, em português, cruzando a pesquisa externa (PDF
> `Chinese Open-Source LLMs vs US Frontier Models` + `MelhoriasGeral.md` +
> `harnessbetter.md`) com o que o Pit já implementa nativamente, e mapeando
> todas as funções pré/pós edição/execução de ferramentas que existem hoje.
>
> Fontes canônicas internas: [`AGENTS.md`](AGENTS.md),
> [`docs/agents/already-built.md`](docs/agents/already-built.md),
> [`docs/agents/prevention-layers.md`](docs/agents/prevention-layers.md).
> Âncoras `file:line` verificadas no codebase.

---

## Sumário executivo

A tese central dos três documentos externos é **"para arrancar bom código de
modelos mais fracos, mexa no harness, não no prompt"**. Esse é exatamente o
paradigma de design do Pit — a camada de guards/prevenção já é o produto. Por
isso, ao cruzar as 5 recomendações do artigo e as 20 funções do `harnessbetter.md`
com o codebase, **a grande maioria já existe implementada de forma nativa e
automatizada** (sem o usuário precisar mudar settings).

O ponto de maior risco do artigo — DeepSeek V4 "inutilizável" sem o round-trip
de `reasoning_content` — **já está resolvido** no provider layer do Pit
(`packages/ai/src/providers/openai-completions.ts:900-905, 1097-1109`). Isso
sozinho coloca o Pit à frente de vários harnesses citados como quebrados
(OpenCode, Kilo Code, Roo Code, Cursor pré-patch).

O cruzamento de valor das 2–3 lacunas genuínas **rebaixa quase tudo**: só
`strict: true` em tool schemas tem upside não-trivial, e mesmo assim é
condicional a endpoint e carrega um trade-off real contra a economia de prefix
(K5) que o repo mede e valoriza.

---

## PARTE 1 — Recomendações do artigo vs. Pit (Estágios 1–5)

| Estágio | Recomendação do artigo | Estado no Pit | Âncora |
|---|---|---|---|
| 1 — Consertar transporte | Re-injetar `reasoning_content` em mensagens de assistant com tool-calls (DeepSeek V4) | **Já existe.** Auto-detecta `deepseek`/`baseUrl deepseek.com`, seta `requiresReasoningContentOnAssistantMessages` e injeta `reasoning_content` vazio quando ausente. Lê `reasoning_content`/`reasoning`/`reasoning_text`. | `packages/ai/src/providers/openai-completions.ts:58, 900-905, 1097-1109` |
| 1 — Consertar transporte | Constrained decoding / Enforcer (Kimi/GLM em self-host) | **N/A no cliente.** Enforcer é server-side (vLLM/SGLang). Pit é cliente. Ver §Parte 3 (strict tool schema). | — |
| 2 — Formato de edição | Evitar `apply_patch`; usar search/replace ou âncora por hash | **Já existe.** `edit_v2` (content-hash/hashline) é exatamente o formato "hashline" que o experimento do can.ac cita como a maior alavanca (6,7%→68,3%). | `packages/coding-agent/src/core/tools/edit-hashline.ts`, `edit-hashline-diff.ts` |
| 3 — Forçar estrutura | Simplificar schemas, menos params aninhados | **Já existe.** Lazy wire schemas (descrições compactas + strip de descrições aninhadas no fio). Opt-out `PIT_NO_LAZY_TOOL_SCHEMAS`. | `tool-wire-schema.ts` |
| 3 — Forçar estrutura | Conjunto de ferramentas pequeno por turno | **Já existe.** `toolDiscovery` (default ON): ferramentas inativas ficam de fora do schema até surgidas via `search_tool_bm25`. | `core/tools/` (tool discovery) |
| 3 — Forçar estrutura | Converter nomes de função com `.` para `_` | N/A — registry do Pit já usa underscores; aliasing de chaves já normaliza. | `core/tools/argument-prep.ts` |
| 4 — Gerenciar contexto | Compaction antes da zona de degradação (~65–85%) | **Já existe.** `adaptivePruneThreshold` com tiers de ocupação em 0,65 / 0,8 / 0,9; `proactivePruneFloor` (25% da janela); pre-send overflow guard. | `packages/coding-agent/src/core/compaction/compaction.ts:791-831` |
| 4 — Gerenciar contexto | Reinjetar regras/decisões pós-compaction | **Coberto por design.** Regras/AGENTS/context vivem no **system prompt** (preservado na compaction), não no histórico. Sumário estruturado + delta summarization. | `core/system-prompt.ts`, `compaction.ts` |
| 4 — Gerenciar contexto | Quebrar tarefas grandes em sub-agentes | **Já existe.** `task`/coordinator, subagent-guards, contabilidade de tokens. | `core/built-ins/coordinator-extension.ts` |
| 5 — Loops de correção | Self-repair com feedback concreto, orçamento de retries, escalonamento | **Já existe.** Session Recovery (lean→guided→strict), `learned-error-guard` (cross-session), `tool-error-hint-rules`, doom-loop/stagnation, retry-reason classification. | `prevention-layers.md` Band D, `learned-error-guard-extension.ts` |

**Conclusão:** todos os Estágios 1–5 do artigo já têm contrapartida nativa
automatizada.

---

## PARTE 2 — As 20 funções do `harnessbetter.md` vs. Pit

| # | Função proposta | Estado | Nota |
|---|---|---|---|
| 1 | Snapshot & Rollback semântico | Parcial | `edit-precondition` (mtime desde read) + `patch-audit` + git. Rollback granular por decisão não existe — mas git já é o mecanismo de versão e o `AGENTS.md` proíbe resets destrutivos sem permissão. |
| 2 | Timeouts escalonados com escalonamento | Parcial | `idle-timeout` + `connect-guard` + timeouts de bash. A injeção "isso está demorando, continuar?" no meio da execução não existe; aborta/retoma. |
| 3 | Replay de falhas (memória de erros) | **Já existe** | `learned-error-guard` (cross-session, por fingerprint). |
| 4 | Canary commits (sandbox espelho) | **Lacuna** | Validação em cópia antes de promover não existe. Pit aplica no workspace e roda `check` depois. |
| 5 | Entropia de contexto | **Já existe** | doom-loop/stagnation/repeating-pattern no Session Recovery. |
| 6 | Degradação graceful (modos) | Parcial | Modos de permissão (plan/ask/agent) existem, mas não são auto-rebaixados por saúde de ferramenta. |
| 7 | Orçamento de tentativas + escalonamento | **Já existe** | failure-budget + escalada guided→strict + `maxAttempts` no Session Recovery. |
| 8 | Guardião de dependências fantasma | **Já existe** | `import-grounding` bloqueia imports/pacotes inexistentes + fuzzy (`lodash-es`→`lodash`); `path-grounding`, `symbol-grounding`. Antídoto ao slopsquatting. |
| 9 | Time machine semântica (por decisão) | **Lacuna** | Versionamento por decisão do agente não existe. Valor baixo vs git. |
| 10 | Sandbox de consequências | **Já existe** | `destructive-command-guard` (quote-aware, bloqueia `rm -rf /` etc.). |
| 11 | Circuit breaker por ferramenta | **Lacuna parcial** | `learned-error-guard` bloqueia por fingerprint de falha conhecida; `failureBudget` limita por turno; mas não há cooldown cross-turn com sugestão de alternativas. Ver Parte 3. |
| 12 | Validação de schema do output | Parcial | `patch-audit` (edit/write); tools produz resultados estruturados internamente. Validação geral de schema de saída não é um mecanismo explícito. |
| 13 | Gate de validação estática pós-escrita | **Já existe (melhor: pré-escrita)** | `erasable-syntax-precondition` roda tsgo `erasableSyntaxOnly` **antes** do hit do disco. Mais barato que pós-escrita. |
| 14 | Token budget guard | **Já existe** | `token-governor` + compaction adaptativa + live prune + pre-send overflow guard. |
| 15 | Classificador de erros com roteamento | **Já existe** | `retry-reason.ts` + `tool-error-hint-rules` com taxonomia TRANSIENT/DEPENDENCY/PERMISSION/RESOURCE/SYNTAX/PATH/TIMEOUT. |
| 16 | Serialização de ações concorrentes | Parcial | Coordinator tem cap de concorrência; o loop de agente é majoritariamente sequencial por tool call. Relevância baixa. |
| 17 | Enriquecimento de erros | **Já existe** | `tool-error-hint-rules` + Repair Note (auto-gated por modelo: ON para fracos/abertos, OFF para frontier). |
| 18 | Auto-summarization de outputs longos | **Já existe** | `pruneOldToolOutputs` (head+tail), defer/recall a disco, `recall_tool_output`, schema-error echo cap. |
| 19 | Guarda de idempotência | **Já existe** | `ReadDedupeStore` (reads) + `learned-error-guard` (bloqueia repetição de falha) + doom-loop. |
| 20 | Health-check no boot | **Lacuna parcial** | Probe de provider acontece no `/login`; não há bateria preflight (python/node/git/perm/recurso) antes do 1º turno. |

**Contagem:** ~13 já existem de forma nativa; ~4 parciais; ~3 lacunas reais
(4, 9, 11 — e 20 como lacuna menor).

---

## PARTE 3 — Análise de valor das lacunas (veredito)

### Lacuna 1 — Circuit breaker por ferramenta → **Valor BAIXO**

O que já existe (mais do que parecia):
- `failureBudget`: orçamento **por turno, por nome de ferramenta** — 3 falhas de
  uma tool num turno dispara steer firme. ON por default.
  `settings-manager.ts:145, 1315`
- `doomLoopReminder`: chamadas idênticas consecutivas (threshold=2) →
  lembrete/pausa/abort. `:126`
- `crossErrorReminder`: mesmo erro normalizado across approaches (threshold=3).
  `:139`
- `learned-error-guard`: bloqueio **cross-session** por fingerprint de falha
  recorrente. `learned-error-guard-extension.ts`
- `tool-error-hint-rules`: taxonomia de classes já implementada
  (`bash-dependency-missing`, `bash-network-transient`, `bash-resource-exhausted`,
  `bash-permission-denied`, `bash-timed-out`). `tool-error-hint-rules.ts:206-256`

**Delta genuíno:** um **cooldown cross-turn**. Hoje o `failureBudget` reseta a
cada turno — o modelo pode falhar 3× no turno 1, ser steerado, falhar 3× de novo
no turno 2, sem carryover. O `learned-error-guard` já cobre o caso recorrente
histórico; **carryover com decay (`floor(count/2)`)** estende o `failureBudget`
entre turnos (default ON; opt-out `toolFeedback.failureBudget.carryover: false`).
Sucesso da tool limpa o carryover daquela tool.

**Veredito:** o modo de falha que o artigo descreve já é pressionado por quatro
mecanismos simultâneos + carryover cross-turn. O ganho incremental adicional é
marginal. Não construir camada nova.

### Lacuna 2 — Structured outputs / strict tool schema → **Valor MÉDIO (condicional)**

O que já existe:
- A infraestrutura de strict **já está wired**. `supportsStrictMode` é um compat
  flag por provider (default true, desligado para Moonshot/Together/Cloudflare
  AI Gateway). `packages/ai/src/types.ts:414`,
  `openai-completions.ts:1119`
- Mas o valor enviado é **deliberadamente `strict: false`** quando suportado:
  `openai-completions.ts:1001`
  (`...(compat.supportsStrictMode !== false && { strict: false })`)
- O Responses API / Codex usa `strict: null`. `openai-codex-responses.ts:415`

**Por que foi desligado de propósito:** ligar `strict: true` exige
`additionalProperties: false` em todo objeto e todas as keys required (com
union null para opcionais) — isso **infla** o schema e colide frontalmente com
a otimização K5 (lazy wire schemas / prefix economy / cache stability). Vários
endpoints openai-compat rejeitam o campo ou o interpretam mal. É um trade-off
real, não um esquecimento.

**Limitação decisiva:** strict só mata **erros de schema** (forma), não erros
de **função-válida-errada** nem alucinação de função não-declarada. O próprio
artigo reconhece isso. E o Pit já tem validação TypeBox + coerção + aliasing +
"Did you mean" em `validateToolArguments` (Band B), que pega a maioria dos
erros de forma **reativa** sem inflar o prefix.

**Veredito:** só vale em endpoints que suportam strict (OpenAI nativo, alguns
hosts Kimi/GLM — não Z.ai/OpenRouter arbitrários). O custo é uma regressão de
prefix economy a medir contra o ganho de validação por construção. **Único item
com upside não-trivial**, mas o caminho é um experimento A/B medido num único
endpoint bem-suportado (OpenAI nativo) comparando `bench-prompt-size` / cache
stability / taxa de schema-error, antes de qualquer generalização.

### Lacuna 3 — Canary commits / sandbox-antes-de-promover → **Valor BAIXO–MÉDIO, custo ALTO**

O que já existe:
- `erasable-syntax-precondition`: tsgo `erasableSyntaxOnly` **antes** do hit do
  disco (Band B, preventivo — mais barato que pós-escrita).
- `patch-audit`: audita diffs de edit/write depois de aplicar (Band C).
- `edit-precondition` (mtime desde read) + `read-guard`.
- Gate real e obrigatório: `npm run check` (tsgo + biome + vitest em paralelo),
  mandatório por `AGENTS.md` antes de "done".

**Delta genuíno:** aplicar edits numa cópia, rodar a suíte de testes relevante,
só então promover. Pesado: cópia do workspace + execução da suíte por edit
destrutivo. O `erasable-syntax-precondition` já pega erros de sintaxe/tipo
erasable em milissegundos; o canary adiciona **rodar a suíte real** (lógica).

**Veredito:** o artigo mostra abertos zerando em tarefas >4h, mas o gargalo ali
é context drift e long-horizon, não falta de sandbox. Como default é uma
mudança arquitetural lenta que atrasa cada edit; como opt-in por tarefa longa,
tem nicho. Não justifica como mecanismo nativo geral.

### Lacuna 4 (menor) — Health-check preflight no boot → **Valor BAIXO, custo BAIXO**

Probe de provider existe no `/login`; não há bateria (python/node/git/perm/disco)
antes do 1º turno. Puramente UX (descoberta tardia de ambiente), não move
qualidade de código dos modelos. Enquadra-se no caso "basic mechanism" que o
`already-built.md` avisa para não priorizar.

### Veredito consolidado

| Lacuna | Valor real | Custo | Já existe? | Recomendação |
|---|---|---|---|---|
| 1. Circuit breaker por tool | **Baixo** | Médio | ~95% (`failureBudget` + carryover + `learned-error-guard` + `doomLoop` + `crossError`) | Não construir camada nova. Opt-out carryover: `toolFeedback.failureBudget.carryover: false`. |
| 2. Strict tool schema | **Médio (condicional)** | Médio + trade-off | Infra existe; `strict: false` é intencional | **Único item vale perseguir** — experimento A/B medido num endpoint bem-suportado. |
| 3. Canary commits | Baixo–Médio | Alto | `erasable-syntax-precondition` + `patch-audit` + gate `check` | Não como default. Só opt-in para long-horizon, ROI duvidoso. |
| 4. Preflight boot | Baixo | Baixo | Probe de provider só | Opcional/UX. Sem valor de uplift. |

**Opinião final:** não há lacuna de alto valor para implementar agora. A ação
de maior retorno é um **experimento medido e isolado** com `strict: true` num
endpoint OpenAI nativo, medindo `bench-prompt-size` + cache stability + taxa de
schema-error antes/depois. Se o ganho de validação superar a regressão de
prefix, generaliza-se por provider via `supportsStrictMode`; se não,
documenta-se o porquê e fecha-se o item.

---

## PARTE 4 — Mapa das funções pré e pós edição/execução

A defesa roda em **4 bandas**. A ordem **dentro de cada chamada de ferramenta é
fixa e load-bearing** — cada passo pode short-circuitar com erro acionável, e
handlers posteriores veem mutações anteriores sem revalidação.

### Banda A — Ao redor do modelo (por turno, antes de qualquer tool call)

| # | Função | Quando | O que faz | Âncora |
|---|---|---|---|---|
| A1 | `transformContext` | antes do send | último hook para mutar a lista de mensagens antes do modelo ver | `agent-loop.ts:497` |
| A2 | Compaction / pre-send overflow guard | antes do send | mantém contexto sob a janela; sumariza + poda com `adaptivePruneThreshold` (tiers 0,65/0,8/0,9) e `proactivePruneFloor` (25%) | `core/compaction/`, `agent-session` |
| A3 | Build do system prompt | antes do send | lean + condicional; dados voláteis no sufixo após `SYSTEM_PROMPT_DYNAMIC_MARKER` (fora do prefix cacheado) | `core/system-prompt.ts` |
| A4 | Prompt cache breakpoints | no send | 4 breakpoints Anthropic + `prompt_cache_key` estável OpenAI | `providers/anthropic.ts` |
| A5 | `connect-guard` | durante connect | timeout de connect + abort instantâneo (anti-wedge openai-compat/deepseek) | `ai/utils/connect-guard.ts` |
| A6 | `idle-timeout` | durante stream | watchdog de body estagnado, retryable | `ai/utils/idle-timeout.ts` |
| A7 | TTSR matcher | durante stream | interrompe o stream quando a saída casa regra de stop | `agent-loop.ts` |

### Banda B — Pré execução (PREVENTIVA, pode bloquear a call errada)

Ordem fixa em `prepareToolCall` (`packages/agent/src/agent-loop.ts:1135-1236`):

| # | Função | O que faz | Âncora |
|---|---|---|---|
| B1 | **Unknown-tool guard** | tool name inválido → erro + lista de tools + "Did you mean" (Levenshtein) + hint de tool oculta via `unknownToolHintProvider` (tool discovery) | `agent-loop.ts:1144-1151, 1099-1119` |
| B2 | **`prepareArguments`** (per-tool) | alias de chaves (`file_path`→`path`, `old_string`→`oldText`, `cmd`→`command`), expansão `~`/`@`, split de `:line`, coerção JSON-string→array em campos `array` (MCP/loose-schema via `prepareArgsForLooseSchema`) | `tools/argument-prep.ts`, `agent-loop.ts:1121-1133` |
| B3 | **Tool-rewrite registry** | regras `auto` reescrevem args silenciosamente (offset/limit string→num, `C:\`→`C:/`, `2>nul`, path com `:10-20`); `suggest`/`block` rejeitam com erro acionável (`skipHints`) | `core/tool-rewrite-rules.ts`, `agent-loop.ts:1162-1189` |
| B4 | **`validateToolArguments`** | validação TypeBox + coerção primitiva (string→number/bool, ordenação de union numérico) + **`stripNullishOptionalArgs`** (drop de `null`/`{}` em opcionais) + extra-key "Did you mean"; payload ecoado truncado | `ai/utils/validation.ts`, `agent-loop.ts:1191` |
| B5 | **`beforeToolCall` firewall** (handlers em ordem de registro) | pode BLOCK ou auto-fix args; sem revalidação após mutação | `agent-loop.ts:1192-1217` |
| B6 | **Repair Note computation** | compara o que o modelo enviou vs. o que roda (pós alias/rewrite/coerção); diferença reportável vira nota para o resultado de sucesso | `agent-loop.ts:1218-1221` |

#### B5 — Firewall, em ordem de registro (`built-ins/index.ts:90-118` + `grounding-guard-registry.ts`)

| ordem | Guard | O que bloqueia/auto-fixa | Âncora |
|---|---|---|---|
| 1 | **permissions** | gate por modo de permissão (auto/plan/ask) | `permissions-extension.ts` |
| 2 | **task-rigor** | (before_agent_start) classifica risco do prompt e anexa rigor instructions; fail-open | `task-rigor-extension.ts` |
| 3 | **read-guard** | exige `read` do arquivo antes de edit; limpa na compaction | `read-guard-extension.ts` |
| 4 | **edit-precondition** | arquivo inalterado desde o último read (mtime) | `edit-precondition-extension.ts` |
| 5 | **learned-error-guard** | bloqueia call cujo fingerprint de args falhou ≥3× em ≥2 sessões prévias; fire-once por padrão | `learned-error-guard-extension.ts` |
| 6 | **grounding-guard (symbol)** | verificação pré-exec de símbolos contra a árvore real + fuzzy candidates | `grounding-guard-extension.ts` |
| 7 | **import-grounding** | bloqueia imports/pacotes inexistentes em write/edit + fuzzy (`lodash-es`→`lodash`) — antídoto ao slopsquatting | `import-grounding-extension.ts` |
| 8 | **erasable-syntax-precondition** | preflight tsgo `erasableSyntaxOnly` no edit (enum/namespace/param-properties nunca chegam ao disco) | `erasable-syntax-precondition-extension.ts` |
| 9 | **path-grounding** | verificação pré-exec de paths/globs contra o filesystem | `path-grounding-extension.ts` |
| 10 | **pattern-grounding** | verificação pré-exec de regex/glob patterns | `pattern-grounding-extension.ts` |
| 11 | **bash-grounding** | verificação pré-exec de comandos bash | `bash-grounding-extension.ts` |
| 12 | **destructive-command-guard** | speed-bump fire-once para `rm -rf ./src`, `git reset --hard`, `git clean -fd`, `git checkout .`, `git push --force` (quote-aware); re-issue confirma | `destructive-command-guard-extension.ts` |
| 13 | **hooks** | user-configurable `tool_call` hooks | `hooks-extension.ts` |
| 14 | **memory** + **mcp** | hooks de memória e MCP (prompts/resources/permissions) | `memory-extension.ts`, `mcp-extension.ts` |
| 15 | **coordinator** + **subagent-guards** | orquestração de subagentes + propagação da chain de grounding para subagentes | `coordinator-extension.ts`, `subagent-guards.ts` |

> Subagentes herdam a chain de grounding (read→edit→grounding→import→erasable→
> path→pattern→bash) via `subagentGroundingGuardFactories`
> (`grounding-guard-registry.ts:21-32`).

### Banda C — Pós execução (CORRETIVA, captura/repara)

Ordem fixa em `finalizeExecutedToolCall` (`agent-loop.ts:1316-1374`):

| # | Função | Quando | O que faz | Âncora |
|---|---|---|---|---|
| C1 | **Tier-4 error hint enrichment** | se `isError`, **antes** do `afterToolCall` | anexa hints de recuperação ao erro (registry de regras); emite `tool_error_hint_applied` | `agent-loop.ts:1328-1333, 1297-1314` |
| C2 | **Repair Note append** | se sucesso + houve auto-reparo de args | anexa `[repair]` note ao resultado de sucesso (auto-gated por modelo: ON para fracos/abertos, OFF para frontier) | `agent-loop.ts:1334-1340` |
| C3 | **`afterToolCall` hooks** | após C1/C2 | pode reescrever o resultado (content/details/terminate/isError) | `agent-loop.ts:1342-1367` |
| C4 | **`patch-audit`** (membro de C3) | após write/edit | anexa diretiva de self-review baseada no shape do patch | `patch-audit-extension.ts` |
| C5 | **read-guard mtime record** (membro de C3) | após read | registra mtime pós-read (alimenta o edit-precondition) | `read-guard-extension.ts` |

#### Tier-4 hint rules — taxonomia já implementada (`tool-error-hint-rules.ts`)

Classes de erro com roteamento distinto (o "classificador de erros" do
`harnessbetter.md` #15, já existente):

| Classe | Regras | Roteamento |
|---|---|---|
| TRANSIENT/NETWORK | `bash-network-transient` | "um retry pode funcionar; não loop" |
| DEPENDÊNCIA | `bash-dependency-missing` | "instale o dep / corrija o import; re-run não ajuda" |
| PERMISSÃO | `bash-permission-denied`, `edit-permission` | "não chmod; escalone ao humano" |
| RECURSO | `bash-resource-exhausted` | "libere espaço/reduza footprint; não retry" |
| SINTAXE/QUOTING | `bash-shell-quoting-error`, `bash-grep-regex-parse-error`, `bash-node-inline-syntax-error` | "escreva em temp file; use tool dedicado" |
| PATH | `bash-path-not-found`, `bash-path-mangled-backslashes`, `bash-unix-drive-path-on-windows`, `read-enoent-suggest-find`, `edit-enoent-verify-path`, `edit-path-type` | "use find/ls; forward slashes; verifique parent" |
| TIMEOUT | `bash-timed-out` | "background + poll; não re-issue blocking" |
| GREP-NO-MATCH | `bash-grep-exit-1-no-match` | "ausência é a resposta, não falha" |
| EDIT-ANCHOR | `edit-old-text-not-found`, `edit-hashline-anchor-stale`, `edit-overlapping-edits`, `edit-read-guard-not-read` | "re-read para fresh anchors; preserve indent" |
| SCHEMA | `edit-schema-mismatch`, `schema-maxlength-violation`, `spawn-binary-missing` | "drop keys unknown; shortene field; verifique binary" |
| LEARNED (dinâmico) | `createLearnedErrorRules` + `createSameSessionHintRule` | "você já errou isso N× em M sessões / N× neste session — mude abordagem" |

### Banda D — Ciclo de sessão/turno

| # | Hook | O que roda | Âncora |
|---|---|---|---|
| D1 | `before_agent_start` | task-rigor, mcp connect | `prevention-layers.md` Band D |
| D2 | `turn_start` | reset do edit-precondition | — |
| D3 | `session_before_compact` | `read-guard` clear, `ReadDedupeStore.clear()`, hooks | — |
| D4 | `session_start` / `session_shutdown` | permissions, mcp, hooks | — |
| D5 | **Steering cross-cutting** (reminders, não blockers) | doom-loop, stagnation, cross-error, todo-cadence, failure-budget, overthink-guard | `settings-manager.ts:122-182` |
| D6 | **Session Recovery** (`session-recovery.ts` + `TurnSteeringEngine`) | sessão começa **lean**; sinais de thrash escalam **guided→strict** (error-reflection via steer, maxAttempts +1/+2, tighter thresholds); limpa por streak de sucessos; opt-out `PIT_NO_SESSION_RECOVERY` | — |

---

## PARTE 5 — Observações de refinamento "seja qual for o modelo"

Pontos que o mapa deixa visíveis e que são alavancas de refinamento model-agnostic,
sem inventar mecanismo novo:

1. **A ordem é load-bearing.** Em B5, rewrite roda antes da validação, validação
   antes do firewall, e handlers do firewall correm em ordem de registro. Se um
   handler mutar args, o loop revalida antes da execução — args inválidos pós-mutação
   bloqueiam a call com erro acionável. Qualquer novo guard deve assumir que guards
   anteriores já reescreveram args.

2. **Supersede-collapse cobre tools read-only determinísticas.** `read`, `grep`,
   `find`, `ls`, `symbol`, `find_symbol`, `lsp` e `bash` colapsam outputs velhos
   de chamadas idênticas repetidas (head+tail), reduzindo context drift em tarefas
   longas.

3. **Tier-4 roda antes do `afterToolCall`.** Um host override vê o conteúdo
   enriquecido e pode mutá-lo. Se um guard custom quiser o erro "cru", precisa
   desabilitar o enrichment ou ler antes — armadilha conhecida.

4. **Repair Note e hint rules já são auto-gated por modelo.** ON para open/weak
   (DeepSeek/Qwen/Kimi/GLM via OpenAI-compat), OFF para frontier. Isso é o
   "uplift de modelo fraco" já operante — qualquer refinamento aqui é por-modelo
   e reavaliado a cada run/fallback.

5. **O único delta de valor não-trivial que sobrou** — `strict: true` em tool
   schemas — live em `openai-completions.ts:1001` como `strict: false` deliberado,
   com `supportsStrictMode` em `types.ts:414`. É um trade-off a medir contra K5
   (prefix economy), não um esquecimento.

---

## Referências internas

- [`AGENTS.md`](AGENTS.md) — regras, style, gate, git, TUI invariants.
- [`docs/agents/already-built.md`](docs/agents/already-built.md) — inventário do que já existe.
- [`docs/agents/prevention-layers.md`](docs/agents/prevention-layers.md) — pipeline de guards em ordem de execução.
- [`docs/agents/cli-animations.md`](docs/agents/cli-animations.md) — subsistema de motion do TUI.

## Referências externas (citadas no artigo fonte)

- Can Bölük, "I Improved 15 LLMs at Coding in One Afternoon" (blog.can.ac, 12/02/2026) — experimento do formato de edição (hashline).
- vLLM Blog, "Chasing 100% Accuracy: Debugging Kimi K2's Tool-Calling on vLLM" (28/10/2025) — Enforcer / constrained decoding.
- AkitaOnRails — benchmark prático Rails+RubyLLM (8 dimensões).
- Vals AI — harness mínimo bash-only, SWE-bench Verified por dificuldade.
- Artificial Analysis — τ²-Bench Telecom, Intelligence Index.
- Spracklen et al., "We Have a Package for You!" (arXiv 2025) — slopsquatting.
- Chroma, "Context Rot" (jul/2025) — degradação antes do limite de contexto.
