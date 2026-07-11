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
| `PIT_NO_DEFER_HISTORY` | Desativa o diferimento do histórico de chamadas de ferramentas (`recall_tool_output`) — ferramentas de recall de saída de ferramentas são removidas do catálogo. | OFF | `agent-session.ts:1119,1272` | `isTruthyEnvFlag` |
| `PIT_NO_RECALL_HISTORY` | Desativa o recall de histórico de conversa (`recall_history`) — ferramenta de recall de turnos é removida do catálogo. | OFF | `agent-session.ts:1120,1290` · `compaction/compaction.ts:2425` | `isTruthyEnvFlag` |
| `PIT_TRANSFORM_CONTEXT_TIMEOUT_MS` | Timeout (ms) do hook `transformContext` no agent-loop. Timeout **falha o turn** (não skip). `0` desativa o timeout. | `60000` | `packages/agent/src/agent-loop.ts` | numérica (`0` = off) |
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
| `PIT_CACHE_RETENTION` | Política de retenção do cache de prompt Anthropic. `"short"` usa TTL curto (5 min); qualquer outro valor (ou ausente) usa `"long"` (1 h). | `"long"` | `sdk.ts:396` | enum string: `"short"` \| `"long"` |
| `PIT_NO_CONTEXT_COMPOSER` | Desativa o bloco de contexto dinâmico inteiro (outline do projeto P1 + exemplar de estilo P3). | OFF | `conditioning/context-composer.ts:380,447` | `isTruthyEnvFlag` |
| `PIT_NO_STYLE_EXEMPLAR` | Desativa apenas o exemplar de estilo (P3) no context-composer; o outline (P1) continua ativo. | OFF | `conditioning/context-composer.ts:412` | `isTruthyEnvFlag` |
| `PIT_NO_OVERTHINK_GUARD` | Desativa o guard de overthink (interrompe ciclos de raciocínio sem progresso que inflariam os tokens de saída). | OFF | `overthink-policy.ts:27` | `isTruthyEnvFlag` |
| `PIT_NO_GREP_AUTO_FILES` | Desativa o auto-switch de `grep` para `files_with_matches` quando `outputMode` é omitido e o número de matches excede o threshold (25). | OFF | `tools/grep.ts` | `isTruthyEnvFlag` |
| `PIT_NO_OCCUPANCY_CAPS` | Desativa o aperto dos caps de truncamento (read/grep/bash) conforme a ocupação do contexto sobe (50%→90%). Caps de boot (`configureTruncationCaps`) continuam ativos. | OFF | `tools/truncate.ts` | `isTruthyEnvFlag` |
| `PIT_NO_MEMORY_ON_DEMAND` | Desativa a recuperação de memória sob demanda (hindsight bank consultado antes de cada turno). | OFF | `agent-session.ts:2985` | `isTruthyEnvFlag` |
| `PIT_NO_HINDSIGHT_ON_DEMAND` | Desativa o hint on-demand do hindsight bank (restaura injeção completa vs hint curto). | OFF | `agent-session.ts:3133` | `isTruthyEnvFlag` |
| `PIT_NO_CONTEXT_RETRIEVAL` | Desativa o retrieval head+tail de `project_context` (mantém só ponteiros/dedupe). | OFF | `context-files.ts:162` | `isTruthyEnvFlag` |
| `PIT_TTSR_BUFFER_CHARS` | Tamanho do buffer rolling do TTSR (chars). Aceita `512`–`65536`; valor não numérico usa o default. | `2048` | `ttsr.ts:53–61` | numérica |
| `PIT_FREQ_OUTLINE` | Opt-in: inclui outlines de símbolos dos hot files no dynamic suffix do system prompt. | OFF | `agent-session.ts:1335` · `system-prompt.ts:62` | `isTruthyEnvFlag` |
| `PIT_NO_FUNCTIONAL_WEB` | Desativa o gate nativo de DoD funcional web (navigate/a11y/click/fill/console). | OFF | `verification/functional-web.ts` | `isTruthyEnvFlag` |
| `PIT_NARRATION` | Opt-in: habilita modo narração no system prompt (aceita `"1"`, `"true"`, `"yes"`). | OFF | `system-prompt.ts` | `isTruthyEnvFlag` |
| `PIT_ASYNC_REINJECT` | Opt-in (legado): reinjetar automaticamente o resultado de subagentes `spawn` no chat quando o resultado chega assíncrono. Comportamento padrão atual notifica sem reinjetar. Esc do pai aborta spawns detached; fim normal do turno não. | OFF | `agent-session.ts` (`_deliverAsyncResult` / `interrupt`) | `isTruthyEnvFlag` |

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

### TUI debug (não são economia de tokens, mas `PIT_*`)

| Variável | Efeito | Default | Onde é lida | Convenção |
|---|---|---|---|---|
| `PIT_TUI_DEBUG` | Grava logs de render do TUI em `/tmp/tui/` com **metadata only** (contagens de linhas, `firstChanged`, `buffer.length`, etc.) — sem `JSON.stringify` do frame completo. | OFF | `packages/tui/src/tui.ts` | `"1"` |
| `PIT_TUI_DEBUG_FULL` | Com `PIT_TUI_DEBUG=1`, inclui dump completo de `newLines` / `previousLines` / `buffer` (sem pretty-print). Caro no hot path — só para diagnóstico. | OFF | `packages/tui/src/tui.ts` | `"1"` |

> A variável `PIT_NO_PRESEND_OVERFLOW_GUARD` também usava `=== "1"` em
> `agent-session-compaction.ts` (linhas 386 e 505) — corrigida para
> `isTruthyEnvFlag` no commit referente à AUDITORIA-ECONOMIA-TOKENS M23.
> `PIT_NARRATION` foi alinhada a `isTruthyEnvFlag` na wave cirúrgica T06 (2026-07).
