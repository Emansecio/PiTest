# Variáveis de ambiente — economia de tokens

> Fonte: **AUDITORIA-ECONOMIA-TOKENS.md §3.6**, verificada em 2026-07-03.
> Cada variável foi confirmada por grep no repositório; nenhuma da lista original
> foi removida e nenhuma variável nova foi encontrada fora do inventário.

As variáveis abaixo permitem ajustar ou desativar mecanismos do pipeline de economia
de tokens do `@pit/coding-agent`. A convenção padrão é `isTruthyEnvFlag` (aceita
`"1"`, `"true"` ou `"yes"`, insensível a maiúsculas); exceções estão marcadas na
coluna **Convenção truthy**.

| Variável | Efeito | Default | Onde é lida (arquivo:linha) | Convenção truthy |
|---|---|---|---|---|
| `PIT_PRESEND_OVERFLOW_RATIO` | Fração da janela de contexto em que o guard pré-envio dispara compactação. Aceita `0.5`–`0.99`; valores fora do intervalo são clampados; valor não numérico usa o default. | `0.95` | `agent-session-compaction.ts:61` | numérica (parse via `Number`) |
| `PIT_NO_PRESEND_OVERFLOW_GUARD` | Desativa o guard que compacta antes de enviar mensagem quando o payload estimado excede `PRESEND_OVERFLOW_RATIO × janela`. | OFF | `agent-session-compaction.ts:386,505` | `isTruthyEnvFlag` |
| `PIT_NO_PROACTIVE_PRUNE` | Desativa o pruning proativo de saídas de ferramentas antigas enquanto o contexto está acima do floor. | OFF | `agent-session-compaction.ts:101` · `agent-session.ts:3390` | `isTruthyEnvFlag` |
| `PIT_PROACTIVE_PRUNE_FLOOR` | Limite mínimo de tokens (absoluto) abaixo do qual o pruning proativo não age. Override numérico; se ausente usa `max(64 000, janela × 0.25)`. | `max(64 000, janela × 0.25)` | `agent-session-compaction.ts:102` · `agent-session.ts:3399` | numérica |
| `PIT_NO_LIVE_SUPERSEDE` | Desativa a supressão em tempo real de resultados de ferramentas antigas ainda em streaming quando a mesma ferramenta retorna um resultado mais recente. | OFF | `agent-session-live-prune.ts:44` | `isTruthyEnvFlag` |
| `PIT_NO_LIVE_ARG_ELISION` | Desativa a elision de argumentos de chamadas de ferramentas mutantes durante streaming (reduz tokens de saída visíveis). | OFF | `agent-session-live-prune.ts:49` | `isTruthyEnvFlag` |
| `PIT_NO_THINKING_CAP` | Desativa o cap dinâmico de tokens de raciocínio estendido (`thinking`) quando o contexto está sob pressão. | OFF | `agent-session.ts:3389` | `isTruthyEnvFlag` |
| `PIT_NO_DEFER_HISTORY` | Desativa o diferimento do histórico de chamadas de ferramentas (`recall_tool_output`) — ferramentas de recall de saída de ferramentas são removidas do catálogo. | OFF | `agent-session.ts:1119,1272` | `isTruthyEnvFlag` |
| `PIT_NO_RECALL_HISTORY` | Desativa o recall de histórico de conversa (`recall_history`) — ferramenta de recall de turnos é removida do catálogo. | OFF | `agent-session.ts:1120,1290` · `compaction/compaction.ts:2425` | `isTruthyEnvFlag` |
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
| `PIT_NO_MEMORY_ON_DEMAND` | Desativa a recuperação de memória sob demanda (hindsight bank consultado antes de cada turno). | OFF | `agent-session.ts:2985` | `isTruthyEnvFlag` |
| `PIT_NARRATION` | Opt-in: habilita modo narração (system prompt verboso, melhor para demonstrações/leitura humana; aumenta tokens de saída). | OFF | `system-prompt.ts:332` | `=== "1"` (anomalia — usa comparação literal, não `isTruthyEnvFlag`) |
| `PIT_ASYNC_REINJECT` | Opt-in (legado): reinjetar automaticamente o resultado de subagentes `spawn` no chat quando o resultado chega assíncrono. Comportamento padrão atual notifica sem reinjetar. | OFF | `agent-session.ts:3516` | `isTruthyEnvFlag` |

---

## Notas de uso

**Para desativar um guard em sessão única:**

```sh
PIT_NO_PRESEND_OVERFLOW_GUARD=1 pit
```

**Ajuste fino da janela de overflow:**

```sh
PIT_PRESEND_OVERFLOW_RATIO=0.85 pit   # dispara mais cedo (contexto < 85 %)
```

**Anomalias de convenção detectadas:**

| Variável | Arquivo | Problema |
|---|---|---|
| `PIT_NARRATION` | `system-prompt.ts:332` | Usa `=== "1"` em vez de `isTruthyEnvFlag` — `"true"` e `"yes"` **não** ativam esta flag |

> A variável `PIT_NO_PRESEND_OVERFLOW_GUARD` também usava `=== "1"` em
> `agent-session-compaction.ts` (linhas 386 e 505) — corrigida para
> `isTruthyEnvFlag` no commit referente à AUDITORIA-ECONOMIA-TOKENS M23.
