# Variáveis de ambiente — economia de tokens

> Fonte: **reports/AUDITORIA-ECONOMIA-TOKENS.md §3.6**, verificada em 2026-07-03;
> revalidada na wave cirúrgica T02–T06 (2026-07-09) com flags adicionais
> (`PIT_NO_HINDSIGHT_ON_DEMAND`, `PIT_NO_CONTEXT_RETRIEVAL`, `PIT_TTSR_BUFFER_CHARS`,
> `PIT_FREQ_OUTLINE`) e correção de `PIT_NARRATION` para `isTruthyEnvFlag`.

As variáveis abaixo permitem ajustar ou desativar mecanismos do pipeline de economia
de tokens do `@pit/coding-agent`. A convenção padrão é `isTruthyEnvFlag` (aceita
`"1"`, `"true"` ou `"yes"`, insensível a maiúsculas); exceções estão marcadas na
coluna **Convenção truthy**.

| Variável | Efeito | Default | Onde é lida (arquivo:linha) | Convenção truthy |
|---|---|---|---|---|
| `PIT_PRESEND_OVERFLOW_RATIO` | Teto (ceiling) da fração da janela em que o guard pré-envio dispara compactação. Aceita `0.5`–`0.99`. Em runtime o ratio efetivo aperta dinamicamente até `0.88` conforme ocupação wire (50%→90%) e trailing tool-share (T10). | `0.95` | `agent-session-compaction.ts` | numérica (parse via `Number`) |
| `PIT_NO_DYNAMIC_PRESEND_RATIO` | Desativa o aperto dinâmico do ratio presend; usa só `PIT_PRESEND_OVERFLOW_RATIO` / default. | OFF | `agent-session-compaction.ts` | `isTruthyEnvFlag` |
| `PIT_NO_READ_DEDUPE_PRUNE` | Desativa o prune seletivo do `ReadDedupeStore` após compactação (T09). | OFF | `agent-session-compaction.ts` | `isTruthyEnvFlag` |
| `PIT_MID_TURN_PRESSURE_RATIO` | Fração da janela em que o alívio mid-turn (entre tool rounds) dispara prune-only. Mais cedo que o presend; sem compactação LLM. Aceita `0.5`–`0.99`. | `0.92` | `agent-session-compaction.ts` | numérica |
| `PIT_NO_MID_TURN_PRESSURE_GUARD` | Desativa o alívio mid-turn de pressão de wire entre tool rounds. | OFF | `agent-session-compaction.ts` | `isTruthyEnvFlag` |
| `PIT_NO_COMPACT_SIBLING_DEFAULT` | Desativa o default zero-config que roteia summarização de compactação para um sibling small-class do mesmo provider (haiku/mini/nano/flash/lite). | OFF | `agent-session-compaction.ts` | `isTruthyEnvFlag` |
| `PIT_EXTENSION_HOOK_TIMEOUT_MS` | Timeout por handler de `before_agent_start` (ms). Handlers lentos são skipados (fail-open); o `ctx.signal` do handler é abortado no timeout. | `1000` | `extensions/runner.ts` | numérica |
| `PIT_EVENT_STREAM_WARN_DEPTH` | Watermark de warn do backlog do `EventStream` (eventos enfileirados). `<=0` desativa. | `50000` | `packages/ai/src/utils/event-stream.ts` | numérica |
| `PIT_EVENT_STREAM_MAX_DEPTH` | Teto duro do backlog do `EventStream`; ao exceder, `push()` lança erro. `<=0` desativa. | `100000` | `packages/ai/src/utils/event-stream.ts` | numérica |
| `PIT_NO_PRESEND_OVERFLOW_GUARD` | Desativa o guard que compacta antes de enviar mensagem quando o payload estimado excede `PRESEND_OVERFLOW_RATIO × janela`. | OFF | `agent-session-compaction.ts:386,505` | `isTruthyEnvFlag` |
| `PIT_NO_PROACTIVE_PRUNE` | Desativa o pruning proativo de saídas de ferramentas antigas enquanto o contexto está acima do floor. | OFF | `agent-session-compaction.ts:101` · `agent-session.ts:3390` | `isTruthyEnvFlag` |
| `PIT_PROACTIVE_PRUNE_FLOOR` | Limite mínimo de tokens (absoluto) abaixo do qual o pruning proativo não age. Override numérico; se ausente usa `max(64 000, janela × 0.25)`. | `max(64 000, janela × 0.25)` | `agent-session-compaction.ts:102` · `agent-session.ts:3399` | numérica |
| `PIT_NO_LIVE_SUPERSEDE` | Desativa a supressão em tempo real de resultados de ferramentas antigas ainda em streaming quando a mesma ferramenta retorna um resultado mais recente. | OFF | `agent-session-live-prune.ts:44` | `isTruthyEnvFlag` |
| `PIT_NO_LIVE_ARG_ELISION` | Desativa a elision de argumentos de chamadas de ferramentas mutantes no wire (`_pruneContextForProvider` / prepareNextTurn). | OFF | `agent-session.ts` · `agent-session-live-prune.ts` | `isTruthyEnvFlag` |
| `PIT_NO_THINKING_CAP` | Desativa o cap dinâmico de tokens de raciocínio estendido (`thinking`) quando o contexto está sob pressão. | OFF | `agent-session.ts:3389` | `isTruthyEnvFlag` |
| `PIT_NO_DEFER_HISTORY` | Desativa o diferimento do histórico de chamadas de ferramentas (`recall_tool_output`) — ferramentas de recall de saída de ferramentas são removidas do catálogo. | OFF | `agent-session.ts:1272,1405` | `isTruthyEnvFlag` |
| `PIT_NO_RECALL_HISTORY` | Desativa o recall de histórico de conversa (`recall_history`) — ferramenta de recall de turnos é removida do catálogo. | OFF | `agent-session.ts:1120,1290` · `compaction/compaction.ts:2425` | `isTruthyEnvFlag` |
| `PIT_NO_CACHE_KEEPALIVE` | Desativa o keepalive do prompt cache Anthropic no idle (P3): ping `max_tokens:1` com o mesmo prefixo a cada ~4min30 (cap 2 por período de idle) para renovar o TTL do cache antes de expirar. Só age em modelo anthropic sem retenção longa, prefixo ≥ 15k wire tokens, sessão idle e sem compaction em voo. | OFF | `core/cache-keepalive.ts` | `isTruthyEnvFlag` |
| `PIT_NO_EXTERNAL_EDIT_SENTINEL` | Desativa a sentinela de edições externas (P4): nota proativa no início do turno quando arquivos tocados na conversa mudaram fora da sessão, com invalidação do read-dedupe do arquivo alterado. | OFF | `built-ins/external-edit-sentinel-extension.ts` | `isTruthyEnvFlag` |
| `PIT_NO_STEP_VERIFY` | Desativa o executor de verify por step do plan (P8a): `step_done` volta a ser 100% advisory — o `verify` do step não é executado e nunca bloqueia a conclusão. | OFF | `core/tools/plan.ts` | `isTruthyEnvFlag` |
| `PIT_NO_SPECULATIVE_COMPACTION` | Desativa a compaction especulativa (P2): o summary deixa de ser pré-computado em background entre rodadas de tools (banda ~80% do threshold) e a compaction real volta a pagar a chamada LLM no caminho crítico. | OFF | `agent-session-compaction.ts` (`maybeStartSpeculativeCompaction`) | `isTruthyEnvFlag` |
| `PIT_NO_SPECULATIVE_TOOLS` | Desativa a execução especulativa de tools (P1): tools read-only da allowlist (`SPECULATION_SAFE_TOOLS`) deixam de executar durante o stream (no `toolcall_end`) e voltam a esperar o fim da mensagem. Transcript/guards são idênticos nos dois modos — a flag só remove a sobreposição de I/O com o tail do stream. | OFF | `packages/agent/src/agent-loop.ts` (`SpeculationController`) · allowlist em `core/tools/index.ts` | string truthy (`1`/`true`/`yes`) |
| `PIT_TRANSFORM_CONTEXT_TIMEOUT_MS` | Timeout (ms) do hook `transformContext` no agent-loop. Timeout **falha o turn** (não skip). `0` desativa o timeout. | `60000` | `packages/agent/src/agent-loop.ts` | numérica (`0` = off) |
| `PIT_SESSION_SHUTDOWN_TIMEOUT_MS` | Timeout (ms) dos handlers de `session_shutdown` no quit/dispose. Após o prazo o teardown segue mesmo com extensão pendurada (evita TUI travada no `/quit`). `0` = sem limite. | `5000` | `extensions/runner.ts` `emitSessionShutdownEvent` | numérica (`0` = off) |
| `PIT_EXTENSION_LOAD_TIMEOUT_MS` | Timeout (ms) por extensão no import+factory no boot/`/reload`. Extensão que estoura falha com erro de load (não congela o startup). `0` = sem limite. | `30000` | `extensions/loader.ts` `loadExtension` | numérica (`0` = off) |
| `PIT_WORKTREE_GIT_TIMEOUT_MS` | Timeout (ms) de `git worktree add/remove` no spawn de subagente com worktree. Evita hang em `index.lock`. `0` = sem limite. | `60000` | `coordinator/spawn.ts` | numérica (`0` = off) |
| `PIT_AGENT_BOUNDARY_TIMEOUT_MS` | Timeout (ms) de `convertToLlm` e `getApiKey` no agent-loop. Timeout falha o turn (não skip). `0` = sem limite. | `60000` | `packages/agent/src/agent-loop.ts` | numérica (`0` = off) |
| `PIT_AGENT_LISTENER_TIMEOUT_MS` | Timeout (ms) por listener de eventos do Agent (`agent_end`, etc.). Após o prazo o loop segue (listener abandonado). `0` = sem limite. | `30000` | `packages/agent/src/agent.ts` | numérica (`0` = off) |
| `PIT_ROUND_WALL_CLOCK_MS` | Teto de wall-clock (ms) **não-rearmável** sobre uma rodada de modelo (uma tentativa de stream). Complementa o idle-timeout (que rearma a cada chunk): um stream vivo por keepalives/deltas esparsos nunca dispara o idle, mas bate neste teto e falha a rodada com erro retryable (mesmo caminho de retry/fallback). `0` = desativa. | `600000` | `packages/agent/src/agent-loop.ts` `resolveRoundWallClockMs` | numérica (`0` = off) |
| `PIT_NO_ROUND_WATCHDOG` | Kill-switch do watchdog de rodada acima (prevalece sobre `PIT_ROUND_WALL_CLOCK_MS` e sobre config). | OFF | `packages/agent/src/agent-loop.ts` | `1`/`true`/`yes` |
| `PIT_JSON_HEARTBEAT_MS` | Cadência (ms) do evento `generation_progress` no `--mode json` durante um turno ativo (`elapsedMs` + `outputChars`; chars congelados = stall, crescendo = geração saudável). | `15000` | `modes/print-mode.ts` `resolveJsonHeartbeatMs` | numérica |
| `PIT_NO_JSON_HEARTBEAT` | Kill-switch do heartbeat `generation_progress` no `--mode json`. | OFF | `modes/print-mode.ts` | `1`/`true`/`yes` |
| `PIT_NO_STRUCTURED_SUMMARY_OUTPUT` | Força o resumo de compactação a ser texto simples em vez de saída estruturada (JSON/XML). | OFF | `compaction/compaction.ts:1619` | `isTruthyEnvFlag` |
| `PIT_NO_DELTA_SUMMARIZATION` | Desativa a sumarização delta (resumo incremental de apenas o span novo desde a última compactação), forçando resumo completo. | OFF | `compaction/compaction.ts:1731` | `isTruthyEnvFlag` |
| `PIT_NO_STRUCTURAL_COMPACTION` | Força o caminho sempre-LLM na compactação, desativando o atalho de compactação estrutural (sem chamada LLM) para sessões pequenas. | OFF | `compaction/compaction.ts:2212` | `isTruthyEnvFlag` |
| `PIT_FILE_DIGESTS` | Opt-in: inclui hashes SHA dos arquivos lidos (read-only) no contexto de compactação. Arquivos modificados sempre recebem digest. | OFF | `compaction/compaction.ts:2348` | `isTruthyEnvFlag` |
| `PIT_NO_COMPACT_SUMMARY_OUTPUT` | Desativa a injeção do output do resumo compacto no contexto pós-compactação (só tem efeito em compactações não-estruturais). | OFF | `compaction/compaction.ts:2440` | `isTruthyEnvFlag` |
| `PIT_NO_SUMMARY_GROUNDING` | Desativa o grounding do resumo (âncoras de arquivo/linha injetadas no início do resumo de compactação). | OFF | `compaction/compaction.ts:2447` · `compaction/summary-grounding.ts:108` | `isTruthyEnvFlag` |
| `PIT_NO_SECRET_REDACT` | Desativa a redação automática de segredos (tokens, chaves de API) nas saídas de ferramentas antes de injetar no contexto. | OFF | `secret-redactor.ts:206` | `isTruthyEnvFlag` |
| `PIT_NO_JSON_CRUSH` | Desativa a compressão JSON (minificação + remoção de whitespace) aplicada ao conteúdo de ferramentas antes de injetar no contexto. | OFF | `tools/json-crush.ts:30` | `isTruthyEnvFlag` |
| `PIT_NO_LAZY_TOOL_SCHEMAS` | Força a inclusão completa dos schemas de todas as ferramentas no payload (desativa o envio lazy — só schema sob demanda). | OFF | `agent-session.ts:1600,1611` | `isTruthyEnvFlag` |
| `PIT_EVAL_MAX_OUTPUT_BYTES` | Teto em bytes da saída capturada por chamada do eval-kernel (JS e Python). Loops síncronos de runaway são cortados antes do timeout. | `8 388 608` (8 MB) | `eval-kernel/javascript.ts:33` · `eval-kernel/python.ts:29` | numérica (inteiro positivo) |
| `PIT_CODE_MODE_MAX_RESULT_BYTES` | Teto em bytes do resultado de ferramenta reinjetado na VM do code-mode por chamada. | `262 144` (256 KB) | `code-mode/bridge.ts:78` | numérica (inteiro positivo) |
| `PIT_SUBAGENT_MAX_BYTES` | Teto em bytes do DIGEST head+tail que um subagente injeta no contexto pai; a íntegra fica no registry em memória + espelho em disco (redigido) e é recuperável via `task({op:"read"})`. | `4 096` (4 KB) | `built-ins/coordinator-extension.ts:~240` | numérica (inteiro positivo) |
| `PIT_DEFERRED_STORE_MEMORY_CAP_BYTES` | Cap agregado de memória do deferred-output store; acima dele as entradas mais antigas fazem spill para disco (redigidas via `redactForDisk`), com `get()` híbrido memória→disco. | `16 777 216` (16 MB) | `deferred-output-store.ts` (parse no load do módulo) | numérica (inteiro ≥ 0) |
| `PIT_CACHE_RETENTION` | Kill-switch da retenção do cache de prompt (Anthropic 1 h / OpenAI 24 h vs 5 min). Tem precedência sobre QUALQUER valor decidido no call-site (env > opção explícita > default). Sem a env, o default é adaptativo: `"long"` só para a sessão interativa principal; `"short"` para subagentes (`coordinator/spawn.ts`) e runs one-shot print/JSON/RPC (`main.ts`) — write de cache long custa 2,0× o preço de input vs 1,25× do short, e leituras renovam o TTL de graça. | adaptativo (`"long"` interativo, `"short"` one-shot/subagente) | `packages/ai/src/providers/simple-options.ts` `resolveCacheRetention` (env-first) · defaults em `sdk.ts` (streamFn), `main.ts`, `coordinator/spawn.ts` | enum string: `"short"` \| `"long"` \| `"none"` |
| `PIT_NO_CONTEXT_COMPOSER` | Desativa o bloco de contexto dinâmico inteiro (outline do projeto P1 + exemplar de estilo P3). | OFF | `conditioning/context-composer.ts:380,447` | `isTruthyEnvFlag` |
| `PIT_NO_STYLE_EXEMPLAR` | Desativa apenas o exemplar de estilo (P3) no context-composer; o outline (P1) continua ativo. | OFF | `conditioning/context-composer.ts:412` | `isTruthyEnvFlag` |
| `PIT_NO_OVERTHINK_GUARD` | Legado: o overthink guard está **permanentemente desligado** para todos os modelos (`resolveOverthinkGuardForModel` sempre retorna `enabled: false`). A flag não tem mais efeito. | n/a (guard off) | `overthink-policy.ts` | legado |
| `PIT_NO_GREP_AUTO_FILES` | Desativa o auto-switch de `grep` para `files_with_matches` quando `outputMode` é omitido e o número de matches excede o threshold (25). | OFF | `tools/grep.ts` | `isTruthyEnvFlag` |
| `PIT_NO_OCCUPANCY_CAPS` | Desativa o aperto dos caps de truncamento (read/grep/bash) conforme a ocupação do contexto sobe (50%→90%). Caps de boot (`configureTruncationCaps`) continuam ativos. | OFF | `tools/truncate.ts` | `isTruthyEnvFlag` |
| `PIT_NO_MEMORY_ON_DEMAND` | Desativa a recuperação de memória sob demanda (hindsight bank consultado antes de cada turno). | OFF | `agent-session.ts:2985` | `isTruthyEnvFlag` |
| `PIT_NO_HINDSIGHT_ON_DEMAND` | Desativa o hint on-demand do hindsight bank (restaura injeção completa vs hint curto). | OFF | `agent-session.ts:3133` | `isTruthyEnvFlag` |
| `PIT_NO_CONTEXT_RETRIEVAL` | Desativa o retrieval head+tail de `project_context` (mantém só ponteiros/dedupe). | OFF | `context-files.ts:162` | `isTruthyEnvFlag` |
| `PIT_TTSR_BUFFER_CHARS` | Tamanho do buffer rolling do TTSR (chars). Aceita `512`–`65536`; valor não numérico usa o default. | `2048` | `ttsr.ts:53–61` | numérica |
| `PIT_NO_TTSR_COALESCED_FEED` | Restaura o feed do matcher TTSR por delta cru do stream (uma passada de regex por delta de ~4 chars). Sem a flag, o feed acompanha o flush coalescido de 16ms do agent-loop (~50–100× menos passadas; detecção idêntica, atraso ≤16ms), com força-feed a cada 512 chars pendentes e flush final garantido no fim da mensagem/abort. | OFF (feed coalescido ligado) | `packages/agent/src/agent-loop.ts` (`isTtsrCoalescedFeedDisabled`) | equivalente a `isTruthyEnvFlag` (local ao pacote agent) |
| `PIT_FREQ_OUTLINE` | Opt-in: inclui outlines de símbolos dos hot files no dynamic suffix do system prompt. | OFF | `agent-session.ts:1335` · `system-prompt.ts:62` | `isTruthyEnvFlag` |
| `PIT_NO_FUNCTIONAL_WEB` | Desativa o gate nativo de DoD funcional web (navigate/a11y/click/fill/console). | OFF | `verification/functional-web.ts` | `isTruthyEnvFlag` |
| `PIT_NO_HLJS_PREWARM` | Desativa o pré-aquecimento do highlight.js agendado ~300ms após o primeiro paint da TUI (modo interativo). Sem o prewarm, o load lazy de ~96ms volta a cair no fechamento do primeiro code fence da sessão, congelando spinner/reveal/teclado mid-stream. | OFF | `utils/syntax-highlight.ts` (agendado em `interactive-mode.ts` pós `ui.start()`) | `isTruthyEnvFlag` |
| `PIT_NARRATION` | Opt-in: habilita modo narração no system prompt (aceita `"1"`, `"true"`, `"yes"`). | OFF | `system-prompt.ts` | `isTruthyEnvFlag` |
| `PIT_ASYNC_REINJECT` | Opt-in (legado): reinjetar automaticamente o resultado de subagentes `spawn` no chat quando o resultado chega assíncrono. Comportamento padrão atual notifica sem reinjetar. Esc do pai aborta spawns detached; fim normal do turno não. | OFF | `agent-session.ts` (`_deliverAsyncResult` / `interrupt`) | `isTruthyEnvFlag` |
| `PIT_NO_HELP_CACHE` | Desativa o fast path de `--help` (cache em disco `<agentDir>/help-cache.json` com as flags de extensão), forçando a construção do runtime completo para renderizar o help. Invalidação automática por fingerprint (stat + hash de conteúdo) de settings/dirs de extensões/entries. | OFF | `core/help-cache.ts` (fast path em `main.ts`) | `isTruthyEnvFlag` |
| `PIT_NO_CLAUDE_VERSION_CACHE` | Desativa o cache em disco (`<agentDir>/claude-code-version.json`) da versão detectada do Claude Code CLI (keyed por path+mtime+size do binário resolvido). A detecção assíncrona via `claude --version` continua rodando (não cacheada). Pin manual: `PIT_CLAUDE_CODE_VERSION`. | OFF | `core/claude-code-version.ts` (kick-off em `main.ts`) | `isTruthyEnvFlag` |
| `PIT_NO_RESOLVE_CACHE` | Desativa o cache em disco (`<agentDir>/resolve-cache.json`) do `PackageManager.resolve()` (varredura de descoberta de extensions/skills/prompts/themes, ~100–320ms de fs sync por boot), forçando a varredura ao vivo em todo boot. Invalidação automática: assinatura do conteúdo efetivo das settings (global+projeto) + fingerprint recursivo dos dirs/manifests/entries consumidos (digest da listagem por dir — mtime de dir não detecta subdir novo no Windows — e stamps estritos de mtime para package.json/ignore files/.ts/.js). | OFF | `core/resolve-cache.ts` (integrado em `core/package-manager.ts` `resolve()`) | `isTruthyEnvFlag` |
| `PIT_NO_SKILL_PREWARM` | Desativa o pré-aquecimento paralelo (fs/promises + fan-out) do cache de frontmatter dos SKILL.md antes do load síncrono no reload de recursos. Sem a flag, ~160 leituras seriais (~200ms cold) viram I/O paralelo; com a flag, o load volta a ler serialmente. Comportamento/diagnósticos idênticos nos dois modos (o loader síncrono continua dono do resultado). | OFF | `core/skills.ts` `prewarmSkillFrontmatter` (chamado em `core/resource-loader.ts` `reload()`) | `isTruthyEnvFlag` |
| `PIT_NO_TOOL_PATH_CACHE` | Desativa o cache em disco (`<agentDir>/tool-path-cache.json`) da resolução de `fd`/`rg` no PATH do sistema (keyed por path+mtime+size do binário resolvido via `where`/`which` + fingerprint do PATH/PATHEXT). Sem cache, cada boot volta a pagar um spawn de detecção por ferramenta quando o binário não está em `<agentDir>/bin`. A resolução em si já roda em background (não bloqueia o primeiro paint da TUI). | OFF | `utils/tools-manager.ts` `getToolPath` (kick-off em background em `interactive-mode.ts` `init()`) | `isTruthyEnvFlag` |
| `PIT_NO_FUSION` | Kill-switch do turno Fusion (Panel de 2 advisors + Synthesizer). Com a flag, `runFusionSessionTurn` retorna `false` incondicionalmente antes de checar modelo/settings — o turno cai direto no fluxo solo normal (pula brief/panel/judge/verify/writer) mesmo com a Orchestration em `fusion`; a sessão continua mostrando `fusion · plan` no footer até o próximo `/permission-cycle`. | OFF (Fusion ligada) | `agent-session-fusion.ts:235` (`runFusionSessionTurn`) | `isTruthyEnvFlag` |
| `PIT_NO_TOOLNAME_GUARD` | Desativa o guard de nomes de tool no wire (sanitiza chars fora de `[a-zA-Z0-9_-]` → `_`, trunca a 64 chars, dedupa colisões com sufixo `_N`) e o remap bidirecional request↔resposta. Com a flag, `buildToolNameGuard` retorna sempre o guard no-op e nomes vão/voltam verbatim. No-op absoluto quando todos os nomes já são válidos (nunca aloca no caminho quente). Aplicado nos conversores openai-completions, openai-responses(-shared)/openai-codex e anthropic (compõe por fora do allowlist OAuth `toClaudeCodeName`). | OFF (guard ligado) | `packages/ai/src/utils/tool-name-guard.ts` (`buildToolNameGuard`); wire em `openai-completions.ts`, `openai-responses-shared.ts`, `anthropic.ts` | `flag ∈ {1,true,yes}` |
| `PIT_NO_EFFORT_RETRY` | Desativa a resiliência genérica de `reasoning_effort` × tools no wire chat-completions: um 4xx cujo corpo/mensagem menciona `reasoning_effort`/`reasoning.effort` num request com tools + effort dispara UM retry sem o campo e memoiza o modelo (por processo) para omiti-lo já no próximo request. Com a flag, o 4xx sobe sem retry. Não afeta o campo de compat opt-in `rejectsReasoningEffortWithTools`. | OFF (retry ligado) | `packages/ai/src/providers/openai-completions.ts` (`isReasoningEffortRejection`/`stripReasoningEffort`/memo) | `flag ∈ {1,true,yes}` |
| `PIT_NO_COMPACT_ARGS` | Desativa a compactação dos `arguments` de tool calls no replay de histórico para o wire OpenAI-family (completions + responses). Argumentos-objeto (caso comum) já serializam compactos; a flag só muda o caminho de argumento em string pré-serializada (transcript replay): com a flag, string vira `JSON.stringify(string)` (comportamento original); sem a flag, string JSON válida é recompactada (sem whitespace) e string malformada passa intacta (nunca quebra replay). | OFF (compactação ligada) | `packages/ai/src/providers/openai-responses-shared.ts` (`serializeToolArgs`/`compactToolArgs`) | `flag ∈ {1,true,yes}` |
| `PIT_NO_REPO_GRAPH` | Desativa a extração de arestas (import/require/use/mod resolvidos, campo `deps` do `RepoMapEntry`) durante a reindexação incremental/full-scan do Living Repo Map. Com a flag, `deps` nunca é extraído nem persistido no cache (`.pit/repo-map.jsonl`) — entries ficam symbols/decls-only, como num cache v2 — e `buildRepoGraph`/`blastRadius` (`repo-map/graph.ts`) naturalmente enxergam um grafo sem arestas. Extração de símbolos (`symbols`/`decls`) é INAFETADA nos dois modos. | OFF (extração de deps ligada) | `repo-map/living-index.ts` (`getLivingRepoMap`) | `isTruthyEnvFlag` |
| `PIT_NO_IMPACT_GUARD` | Desativa a extensão de impact graph (code-graph Fase 2) por inteiro: o advisory pós-edição ("N file(s) depend on this one…" anexado a `edit`/`write` bem-sucedidos via `blastRadius`), o rastreio de dependentes diretos não revisados (`pending`) e a trava R10 do `goal_complete` (que consulta esse registry), além do enriquecimento `predictedByGraph` no diagnóstico `verification.cross_file_escape`. Com `PIT_NO_REPO_GRAPH` ativo o mapa já não tem `deps` e a extensão degrada sozinha a no-op, sem precisar desta flag. | OFF (advisory + trava ligados) | `built-ins/impact-extension.ts` | `isTruthyEnvFlag` |
| `PIT_NO_PHASE_COLLAPSE` | Desativa o colapso retroativo das fases de atividade da TUI (grouped tool-activity). Sem a flag, cada fase de trabalho (rajada de tool calls entre dois textos do agente) encolhe para uma linha-resumo densa (`5 searches·8 commands·2 edits`) assim que é selada, reexpansível via `ctrl+o`. Com a flag, fases seladas ficam sempre no layout completo (contador + linhas promovidas), como um transcript não colapsado. Não afeta tokens (é puramente apresentação). | OFF (colapso ligado) | `modes/interactive/components/work-group.ts` (`PHASE_COLLAPSE_DISABLED`, lida no load do módulo) | `isTruthyEnvFlag` |

---

## Notas de uso

**Cap de `recall_tool_output`:** `RECALL_OUTPUT_CAP_BYTES` = 96KB (head+tail). Um único recall não deve dominar a janela; a íntegra permanece no deferred store.

**Para desativar um guard em sessão única:**

```sh
PIT_NO_PRESEND_OVERFLOW_GUARD=1 pit
```

**Ajuste fino da janela de overflow:**

```sh
PIT_PRESEND_OVERFLOW_RATIO=0.85 pit   # dispara mais cedo (contexto < 85 %)
```

**Caps de tools / ocupação:** o default do `find` (sem `limit` explícito) usa
`FIND_DEFAULT_LIMIT_CEILING = 500` e floor `100`, escalado por
`getOccupancyScale()` (`tools/find.ts`). Opt-out do scaling geral:
`PIT_NO_OCCUPANCY_CAPS`.

### Search backends (não são economia de tokens, mas `PIT_*`)

| Variável | Efeito | Default | Onde é lida | Convenção |
|---|---|---|---|---|
| `PIT_GREP_ENGINE` | Backend de `grep`/`find`: `fff` (índice warm) ou `rg` (força ripgrep + fd). Fora de um git work tree, `fff` cai automaticamente para rg/fd. | `fff` (via settings) | `settings-manager.ts` `getGrepSettings` | `fff` \| `rg` |
| `PIT_ASTGREP_ENGINE` | Backend de `ast_grep`: `napi` (in-process) ou `cli`. | `napi` | `settings-manager.ts` `getAstGrepSettings` | `napi` \| `cli` |
| `PIT_LSP_SINGLE_DIAGNOSTICS_WAIT_MS` | Timeout (ms) ao esperar diagnostics de um único arquivo no tool `lsp` (ação diagnostics). Valores ≤0 ou inválidos caem no default. | `3000` | `lsp/tool-actions.ts` `resolveSingleDiagnosticsWaitTimeoutMs` | inteiro positivo |

### Rede / keep-alive (não são economia de tokens, mas `PIT_*`)

| Variável | Efeito | Default | Onde é lida | Convenção |
|---|---|---|---|---|
| `PIT_KEEPALIVE_MS` | Idle keep-alive (ms) dos sockets do dispatcher undici global. O default do undici (4 s) é menor que o gap típico entre turnos, forçando DNS+TCP+TLS novos a quase todo turno (+40–200 ms de TTFT); o Pit usa 60 s. `keepAliveMaxTimeout` acompanha (`max(valor, 600 000)`). Valor inválido/NaN/≤0 cai no default. | `60 000` | `utils/env-flags.ts` `resolveKeepAliveOptions` · aplicada em `cli.ts` | numérica (ms, ≥ 1) |
| `PIT_NO_KEEPALIVE_TUNING` | Desativa o tuning de keep-alive por completo — o dispatcher volta aos defaults do undici (4 s), ignorando `PIT_KEEPALIVE_MS`. | OFF | `utils/env-flags.ts` `resolveKeepAliveOptions` | `isTruthyEnvFlag` |
| `PIT_NO_PROVIDER_RETRY_CLAMP` | Restaura o default de retry do SDK Anthropic (2 retries silenciosos com backoff exponencial, invisíveis à TUI). Sem a flag, o provider clampa `maxRetries` para **1** quando o caller não define: um retry rápido in-SDK absorve o 529/overloaded intermitente do tráfego OAuth sem queimar uma entrada da fallback-chain externa (que aplica cooldown de 5 min ao modelo); falhas persistentes escalam rápido para a camada externa, que tem UI. Valor explícito do caller (`options.maxRetries` / `retry.provider.maxRetries` nas settings) sempre vence. | OFF (clamp `maxRetries: 1` ligado) | `packages/ai/src/providers/anthropic.ts` `resolveClampedMaxRetries` | `isTruthyEnvFlag` |
| `PIT_NO_OAUTH_PREFRESH` | Desativa o pre-refresh de OAuth em background: sem a flag, quando `getApiKey` entrega um token ainda válido mas com `expires − now < 10 min`, dispara um refresh fire-and-forget (single-flight por provider; o file lock + re-check de `expires` pós-lock cobrem corrida entre instâncias) para tirar o POST de refresh (timeout de 30 s no pior caso) do hot path do request (+0,3–1,5 s de TTFT esporádico). O refresh síncrono em `getApiKey` permanece como fallback correto se o token expirar antes do background completar; falha do background é silenciosa. | OFF (pre-refresh ligado) | `core/auth-storage.ts` `maybePrefreshOAuthToken` | `isTruthyEnvFlag` |

### Latência do agente (não são economia de tokens, mas `PIT_*`)

Otimizações de velocidade do turno (tool calls, edições, shell, compactação),
adicionadas na rodada de otimização de latência de 2026-07-16. Todas on-by-default,
zero config; as variáveis abaixo são os kill-switches/knobs.

| Variável | Efeito | Default | Onde é lida | Convenção |
|---|---|---|---|---|
| `PIT_NO_BATCH_PARTITION` | Restaura o comportamento antigo de lotes mistos de tool calls: qualquer tool `sequential` (`ask`/`debug`/`exit_plan`/`message`) no lote força o lote INTEIRO a executar em série. Sem a flag, o lote é particionado — o subconjunto parallel-safe roda concorrente primeiro e o sequencial em ordem, com a emissão dos resultados preservada na ordem original das calls. | OFF (partição ligada) | `packages/agent/src/agent-loop.ts` `isBatchPartitionDisabled` | `1`/`true`/`yes` (local ao pacote agent) |
| `PIT_NO_ASYNC_COMPOSER_CAPTURE` | Restaura a leitura síncrona (openSync/readSync, até 256 KB na main thread) do fallback de captura de exemplar do context-composer no tool-end de reads. Sem a flag, a leitura é async fire-and-forget (best-effort, guardada por seq token contra captura stale); o fast path via `rawFileContent` é idêntico nos dois modos. | OFF (captura async ligada) | `agent-session.ts` `_handleToolExecutionEnd` | `isTruthyEnvFlag` |
| `PIT_NO_EDIT_BASE_CACHE` | Desativa o reuso, pelo `edit.execute()`, do base cache keyed por `(absolutePath, mtimeMs)` que o preview em streaming já popula — todo execute volta a ler o arquivo do disco. O reuso exige igualdade exata de `mtimeMs` (stat fresco); mismatch/miss cai no read de disco. Existe porque o reuso muda quais bytes o execute enxerga numa janela de corrida dentro do mesmo tick de mtime. | OFF (cache ligado) | `tools/edit.ts` (`baseCacheEnabled`) | `isTruthyEnvFlag` |
| `PIT_BASH_SPARE_POOL` | Tamanho do pool de shells pré-aquecidos do tool `bash` (spares keyed por contexto shell+args+cwd+env, refill assíncrono após consumo, evicção LRU + TTL idle de 30 s — o TTL limita quanto tempo um processo ocioso segura handle de cwd no Windows). `0` (ou valor inválido/não positivo) desativa o pooling por completo. | `2` | `tools/bash.ts` `resolveSparePoolSize` | numérica (inteiro ≥ 0) |
| `PIT_EXIT_STDIO_GRACE_MS` | Graça base (ms) pós-`exit` esperando o `end` de stdout/stderr antes de finalizar um comando (caso Windows de pipe herdado por descendente). A base curta é ESTENDIDA em fatias até o teto de 100 ms apenas enquanto output ainda chega (sinal de flush de daemon), então comando rápido finaliza em ~25 ms e flush de daemon nunca é clipado. Teto = `max(100, base)`. | `25` | `utils/child-process.ts` `resolveExitStdioBaseGraceMs` | numérica (ms ≥ 0) |
| `PIT_COMPACT_SOFT_RATIO` | Multiplicador da banda soft preditiva que dispara a compactação em BACKGROUND (sibling model barato, durante idle) antes do hard wall síncrono. `1.0` = banda legada (`shouldCompactSoft`); maior dispara mais cedo, tornando mais provável que o resumo esteja pronto antes do próximo send (evita a espera visível de compactação síncrona). Clamp `[1.0, 4.0]`; não numérico cai no default. O caminho hard síncrono permanece intocado como safety net. | `1.5` | `agent-session-compaction.ts` `parseCompactSoftRatio` / `shouldStartBackgroundCompaction` | numérica |

### LSP — memória de falha/silêncio (auditoria adversarial 2026-07-17)

Ambas on-by-default. Fecham dois impostos default-on do `diagnosticsOnWrite`:
servidor travado no boot (até 30s/edição, agora capado em 4s + breaker) e
servidor/arquivo que nunca publica diagnostics (4s/edição, agora ~150ms após
2 misses). Invalidação: publish real, project-loaded, config reload, TTL 5min.

| Variável | Efeito | Default | Onde é lida | Convenção |
|---|---|---|---|---|
| `PIT_NO_LSP_BOOT_BREAKER` | Desativa o circuit-breaker de falha de boot de servidor LSP — todo call volta a re-spawnar um servidor que falhou no spawn/init (comportamento legado). Sem a flag, falha genuína (abort do usuário nunca conta) entra em cooldown keyed por `command:args:initOptions:cwd`, com um retry após a janela. | OFF (breaker ligado) | `lsp/client.ts` `getOrCreateClient` | `isTruthyEnvFlag` |
| `PIT_LSP_BOOT_BREAKER_COOLDOWN_MS` | Janela de cooldown (ms) após falha de boot antes de permitir um retry. | `60000` | `lsp/client.ts` | numérica |
| `PIT_NO_LSP_SILENCE_MEMO` | Desativa o short-circuit de diagnostics silenciosos — toda edição volta a esperar os 4s completos mesmo em par arquivo+servidor que nunca publicou. | OFF (memo ligado) | `lsp/utils.ts` `effectiveDiagnosticsWaitMs` | `isTruthyEnvFlag` |
| `PIT_LSP_SILENCE_GRACE_MS` | Espera de graça (ms) usada quando o par arquivo+servidor foi marcado silencioso (≥2 misses consecutivos). | `150` | `lsp/utils.ts` | numérica |
| `PIT_NO_LSP_CROSS_FILE_SURFACE` | Desativa o surfacing de diagnostics cross-file no apêndice do writethrough — volta a mostrar só o arquivo editado. Sem a flag, publishes de OUTROS arquivos que ganharam erros novos vs baseline (ex.: gopls publica por pacote) entram no apêndice do edit, limitados a 3 arquivos × 2 diagnostics, sem nenhuma espera adicional (best-effort: lê o que já chegou no map). | OFF (surfacing ligado) | `lsp/writethrough.ts` `crossFileSurfaceDisabled` | `isTruthyEnvFlag` |

### Absorções do forgecode — onda 1 (2026-07-17)

Quatro mecanismos portados/adaptados da análise do forgecode, todos
on-by-default. Snapshots preenchem o gap de checkpoint/rewind de arquivos;
reparo de tool calls elimina retries de argumentos malformados sem round-trip;
doom-loop cíclico e retry budget endurecem o loop contra repetição improdutiva.

| Variável | Efeito | Default | Onde é lida | Convenção |
|---|---|---|---|---|
| `PIT_NO_FILE_SNAPSHOTS` | Desativa a captura de snapshot pré-mutação de arquivos (feita no choke point da fila de mutação por arquivo; pula criação de arquivo novo). Sem snapshots, a tool `undo` e o comando `/rewind` reportam indisponibilidade. | OFF (captura ligada) | `core/file-snapshots.ts` | `isTruthyEnvFlag` |
| `PIT_SNAPSHOT_MAX_PER_FILE` | Cap de snapshots retidos por arquivo (LRU — o mais antigo é descartado). | `20` | `core/file-snapshots.ts` | numérica (inteiro ≥ 1) |
| `PIT_SNAPSHOT_MAX_AGE_DAYS` | Idade máxima (dias) antes do GC preguiçoso descartar um snapshot (roda na captura). `0` = sem GC por idade. | `7` | `core/file-snapshots.ts` | numérica (≥ 0) |
| `PIT_NO_TOOLCALL_REPAIR` | Desativa a camada nativa de reparo de tool calls (tier estrutural `jsonrepair` + coerção dirigida pelo schema: `"42"`→42, `""`→null em opcionais, array/objeto stringificado, JSON duplo-encodado ≤4 níveis, extração de array, enum case-insensitive). Roda entre os rewrite registries (que continuam vencendo) e a validação — sem round-trip de modelo. Stats via `getToolArgRepairStats()`. | OFF (reparo ligado) | `packages/agent/src/tool-arg-repair.ts` (wired em `agent-loop.ts` `prepareToolCall`) | `isTruthyEnvFlag` |
| `PIT_NO_DOOM_LOOP_GUARD` | Desativa o detector de doom-loop CÍCLICO (n-gram no tail das tool calls: mesmo bloco de período 1..N repetido 3× com args idênticos → steering reminder único, com escalada se o ciclo persistir). Complementa `PIT_NO_REPEATING_PATTERN` (repetição simples), que também o desativa. | OFF (guard ligado) | `core/turn-steering-engine.ts` (detector puro em `core/doom-loop-cycle.ts`) | `isTruthyEnvFlag` |
| `PIT_NO_TOOL_RETRY_BUDGET` | Desativa o contador de retry budget por (tool, alvo) anexado inline a resultados de erro ("attempts on `edit` for this target: 2/3"), com escalada textual na exaustão (nunca bloqueia — steering apenas). Consecutivo; reseta em sucesso do par ou novo turno do usuário. | OFF (budget ligado) | `core/tool-retry-budget.ts` via Tier-4 error-hint registry (`turn-steering-engine.ts`) | `isTruthyEnvFlag` |
| `PIT_TOOL_RETRY_BUDGET` | Tamanho do budget de falhas consecutivas por (tool, alvo) antes da escalada. Inválido/≤0 cai no default (nunca zero — seria bloqueio permanente). | `3` | `core/tool-retry-budget.ts` | numérica (inteiro ≥ 1) |

### Navegador nativo (chrome devtools) — auditoria 2026-07-16

| Variável | Efeito | Default | Onde é lida | Convenção |
|---|---|---|---|---|
| `PIT_NO_CHROME_DEVTOOLS` | Desativa o subsistema chrome_devtools inteiro, independentemente de `chromeDevtools.enabled` nas settings — kill-switch rápido por invocação. | OFF (subsistema ligado) | `settings-manager.ts` `getChromeDevtoolsSettings` | `isTruthyEnvFlag` |
| `PIT_NO_CHROME_SCREENSHOT_COMPRESS` | Restaura o comportamento legado de screenshot quando a call não especifica `format`/`quality`: PNG, escala cheia em device pixels, sem cap de dimensão. Sem a flag, o default é JPEG q60 com clip em resolução CSS-pixel (scale `1/devicePixelRatio`) e cap de 4000 CSS px de altura em fullPage (com nota de truncamento no resultado) — corta o custo em tokens do caminho de imagem mais caro do agente. `format`/`quality` explícitos na call sempre vencem. | OFF (compressão ligada) | `chrome-devtools-manager.ts` `screenshot` | `isTruthyEnvFlag` |
| `PIT_NO_CHROME_ELEMENT_SOURCE_FETCH` | Desativa o fetch de source maps EXTERNOS no `element_to_source` (restrito a origens loopback, com limites de 16 MB/4 s). Source maps inline (`data:`) e o refinamento LSP (quando injetado) continuam funcionando. | OFF (fetch loopback ligado) | `chrome-devtools-manager.ts` `createElementSourceFetchText` | `isTruthyEnvFlag` |

### Harness de desenvolvimento (não são economia de tokens, mas `PIT_*`)

Guard-rails do gate local (`npm run check` / `check:fast` / E2E live), adicionados
na rodada do audit de harness 2026-07-16 (§6.1, §6.2, §6.4). Todos on-by-default,
zero config; as variáveis abaixo são os kill-switches.

| Variável | Efeito | Default | Onde é lida | Convenção truthy |
|---|---|---|---|---|
| `PIT_NO_CHECK_RETRY` | Desativa o retry automático do vitest no `check-parallel` quando o processo morre **sem** a linha de sumário `Test Files …` (crash de worker/fork, não assert). Com a flag, o crash falha o gate direto, como antes. Falhas reais de teste (sumário presente) nunca são re-rodadas. | OFF (retry 1× ligado) | `scripts/check-parallel.mjs` | `isTruthyEnvFlag` |
| `PIT_NO_E2E_AUTOSKIP` | Desativa o autoskip dos testes E2E live quando a credencial OAuth é inválida no servidor (401/403, `invalid_grant`, token revogado/expirado): com a flag, o teste falha em vez de `ctx.skip("credencial <provider> inválida — renove o login")`. Em CI (`process.env.CI` setado) o hard-fail vale sempre, independente da flag. | OFF (autoskip ligado localmente) | `packages/ai/test/live.ts` (re-exportado em `packages/coding-agent/test/live.ts`) | `isTruthyEnvFlag` |
| `PIT_NO_CHANGED_ONLY` | Faz `npm run check:fast` rodar a suite unit completa em vez do `vitest --changed` (git-aware, só testes relacionados ao diff não-commitado). Sem a flag, o changed-only já cai sozinho para a suite completa quando o diff toca arquivos core de alto fan-in (`agent-session.ts`, `agent-loop.ts`, configs de vitest, `package.json`/`tsconfig`) ou quando o git falha. | OFF (changed-only ligado) | `scripts/check-parallel.mjs` | `isTruthyEnvFlag` |
| `PIT_NO_BENCH_CACHE` | Força o token-bench a rodar de verdade no pre-commit (`check:static`), ignorando o cache por fingerprint dos inputs (§6.5). Sem a flag, um PASS com inputs idênticos (src de coding-agent/ai/agent, scripts de bench, baseline, context/legacy files, catálogo de skills em `~/.pit/agent/skills`, flags `PIT_*`) imprime `token-bench: cached ok` e pula os 4 benches tsx (~3–6 s). O check completo (pre-push) e CI **nunca** usam o cache; só um PASS é gravado (`node_modules/.cache/pit-token-bench.json`). | OFF (cache ligado no pre-commit) | `scripts/check-token-bench.mjs` (fingerprint em `scripts/lib/token-bench-cache.mjs`; `--cache` passado por `scripts/check-parallel.mjs` só no caminho `--no-vitest`) | `isTruthyEnvFlag` |

### TUI debug (não são economia de tokens, mas `PIT_*`)

| Variável | Efeito | Default | Onde é lida | Convenção |
|---|---|---|---|---|
| `PIT_TUI_DEBUG` | Grava logs de render do TUI em `/tmp/tui/` com **metadata only** (contagens de linhas, `firstChanged`, `buffer.length`, etc.) — sem `JSON.stringify` do frame completo. | OFF | `packages/tui/src/tui.ts` | `"1"` |
| `PIT_TUI_DEBUG_FULL` | Com `PIT_TUI_DEBUG=1`, inclui dump completo de `newLines` / `previousLines` / `buffer` (sem pretty-print). Caro no hot path — só para diagnóstico. | OFF | `packages/tui/src/tui.ts` | `"1"` |
| `PIT_NO_SCROLLBACK_WIPE` | Kill-switch: no full-redraw "all" (mudança de largura, `clearOnShrink`), omite só o `\x1b[3J` (limpa scrollback do emulador) e mantém `\x1b[2J\x1b[H` (limpa a tela visível). Preserva o histórico pré-sessão do terminal às custas de deixar scrollback antigo com o wrap errado após um resize de largura — trade-off deliberado, o default (`\x1b[3J` ligado) não muda. | OFF (scrollback wipe ligado) | `packages/tui/src/tui.ts` | `"1"` |
| `PIT_NO_BUNDLE` | Kill-switch do guard de launcher (`bin/pit.mjs`): força sempre rodar o src via tsx, ignorando o bundle `dist/cli.bundle.mjs` mesmo quando ele estiver fresco. Default OFF = guard ativo (roda o bundle só quando ele é mais novo que todo `.ts` sob `packages/*/src`, senão cai para o src). | OFF (guard ativo) | `bin/pit.mjs` | `1`/`true`/`yes` (insensível a caixa) |
| `PIT_LAUNCH_QUIET` | Silencia o aviso em stderr do launcher quando ele cai do bundle para o src (`src mais novo que o bundle …`). Não muda a decisão de alvo, só suprime a nota. | OFF (aviso visível) | `bin/pit.mjs` | `1`/`true`/`yes` (insensível a caixa) |
| `PIT_NO_SEND_NOW` | Kill-switch do chooser inline `[Send now] [Queue] [Cancel]`: com a flag, `Enter` com texto durante trabalho ativo (`isStreaming`/`isFusing`) volta a enfileirar direto como `followUp` (comportamento legado), sem abrir o chooser. Default OFF = chooser ligado (Enter oferece Send now → `steer`, Queue → `followUp`, Cancel devolve o texto ao compositor). `Alt+Enter` e `/steer` não são afetados pela flag. | OFF (chooser ligado) | `modes/interactive/interactive-mode.ts` (`sendNowChooserEnabled`) | `isTruthyEnvFlag` |

> A variável `PIT_NO_PRESEND_OVERFLOW_GUARD` também usava `=== "1"` em
> `agent-session-compaction.ts` (linhas 386 e 505) — corrigida para
> `isTruthyEnvFlag` no commit referente à AUDITORIA-ECONOMIA-TOKENS M23.
> `PIT_NARRATION` foi alinhada a `isTruthyEnvFlag` na wave cirúrgica T06 (2026-07).
