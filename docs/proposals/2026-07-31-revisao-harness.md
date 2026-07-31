# Revisão do harness — 2026-07-31

Revisão em 5 dimensões (uso de código, verbosidade, agilidade, tool calling,
economia de tokens), executada por 5 agentes em paralelo com verificação manual
posterior de cada achado (file:line conferidos no código em `refactor/deep-modules`).

**Veredito geral:** o harness está maduro nas cinco dimensões. Pontos fortes
confirmados: cadeia read-guard + edit-precondition + drift por hash; compaction
com breakpoints de cache bem posicionados; reparo de tool args em dois tiers com
stats; doom-loop result-aware em 3 tiers; prompt base ~850 tokens com tier
compact; truncamento proporcional à ocupação. Os achados abaixo são as arestas
que sobraram — todos verificados, nenhum especulativo.

Status: ☐ pendente · ⏳ em implementação · ✅ feito

## P1 — Alto impacto

| # | Status | Achado | Evidência | Fix proposto |
|---|--------|--------|-----------|--------------|
| 1 | ✅ | **Promessa fantasma no bash background** — a mensagem de promoção diz que output/exit do job "can be recovered by referencing id=bg-N", mas nenhuma ferramenta do modelo aceita job id (consumo só interno: verificação, goal-complete, functional-web). Induz doom-loop de `jobs`/`tail` em shell fresco. | `tools/bash.ts:1456`; registry em `bash.ts:250-265` | Estender o schema do `bash` com `jobId` (+`action: poll\|kill`), exclusivo de `command`; poll devolve ring buffer + exited/exitCode; reescrever a mensagem de promoção para apontar a superfície real. |
| 2 | ✅ | **`grounded_context` sem gate de ocupação** — o gate T02 (`contextOccupancyPercent < 50`) cobre só `frequent_files`/outlines; o bloco do composer é emitido incondicionalmente no sufixo dinâmico, pago a preço cheio em toda request do turno. | `system-prompt.ts:213` (gate) vs `:234-236` (sem gate) | Aplicar o mesmo gate ao `groundedContext` (1 linha). Economia ~300-800 tokens/request na metade final de sessões longas. |
| 3 | ✅ | **Duas esperas LSP em série por edit + polling de 100ms** — todo edit/write paga espera de publish fresco pré-write E pós-write (até 4s cada), e `waitForDiagnosticsResult` acorda por `sleep(100)` apesar do `publishDiagnostics` chegar por push. 0.5-3s extras por edit em repo TS grande. | `lsp/utils.ts:465-475`; `lsp/writethrough.ts:289-436`; push em `lsp/client.ts:337-347` | (a) acordar waiters no handler de `publishDiagnostics`; (b) reusar o resultado pós-write anterior como baseline pré-write quando o mtime não mudou (`_fileMtimeStore` já injetado nos tools). |
| 4 | ✅ | **AGENTS.md de subdiretório invisível** — `loadProjectContextFiles` só sobe do cwd à raiz; num monorepo, regras por pacote nunca são carregadas nem apontadas quando o agente trabalha no subtree. | `resource-loader.ts:139-201` | Built-in: no primeiro read/edit sob diretório com AGENTS.md não carregado, injetar o conteúdo (caps E6/M25a de `context-files.ts`) ou ponteiro de 1 linha. Cache TTL de fs como nos guards de grounding. |

## P2 — Médio-alto

| # | Status | Achado | Evidência | Fix proposto |
|---|--------|--------|-----------|--------------|
| 5 | ✅ | **Aritmética cache-aware enviesada pró-cache-read** — compara só input; a rota cache-read gera o resumo no modelo da sessão (output ~3× mais caro que o sibling) e `siblingInputTokens` entra inflado (`sumMessageTokens` vs serialização com caps/dedup que a rota texto realmente envia). | `compaction/cache-aware.ts:100-136`; `summarize.ts:275` e `:494-498` | Incluir `expectedSummaryTokens × cost.output` nos dois lados; medir sibling sobre o texto serializado (`SerializedWindow` memoizada já disponível). |
| 6 | ✅ | **Supersede de duplicata/N4 fura o guard de cache economics** — colapso incondicional (abaixo do floor e no defer) no meio do histórico força cold-write da cauda (~$0,35/100k Sonnet) para economizar centavos. `mutationCauses` já separa as classes. | `agent-session.ts:4409-4433`; `prune.ts:562-597` | Duplicata/N4 passam por `_shouldDeferToolPruneForCache`; M11 (mutation) continua incondicional. |
| 7 | ✅ | **Pointer heuristic descarta CLAUDE.md com regras reais** — qualquer CLAUDE.md ≤3500 chars contendo "agents.md" é dropado inteiro quando há AGENTS.md no mesmo dir. | `context-files.ts:29-43` | Restringir a arquivos ~só-ponteiro (resto não-`@`/link ≤ ~200 chars). |
| 8 | ✅ | **Barreira de fase anula concorrência com especulação (P1)** — a fase 1 de call especulada engloba o execute inteiro (`await spec.outcome`); irmãos não-especulados só começam quando o outcome mais lento settle. | `agent-loop.ts:1551-1558`; barreiras `:1636-1648`/`:1715-1724` | Pipeline prepare→execute→finalize por call num único `Promise.all`; replay de result-messages continua ordenado (já é diferido/serial). |
| 9 | ✅ | **Coerção de args duplicada em 2 camadas com regras divergentes** — `enum_case_fix` só no repair (`@pit/agent`); `stripNullishOptionalArgs`/`coerceJsonStringArrays` só na validação (`@pit/ai`); repair-notes e stats subnotificam. | `tool-arg-repair.ts:43-61`; `ai/utils/validation.ts:313-320` | Tabela única de coerção em `@pit/ai`; validação vira strict-check + relatório; um fluxo só de stats/notes. |

## P3 — Médios

- **Contrato read-before-edit não dito ao modelo** — descrição do edit hedgeia ("some embedders…") um guard incondicional (`edit.ts:304`; registro em `grounding-guard-registry.ts:66`); e o fluxo symbol→edit incentivado pela descrição do `symbol` é bloqueado (guard só credita `read`, `read-guard-extension.ts:189`). Fix: ~20 tokens de schema + creditar `symbol` como leitura (ou avisar na descrição).
- **Guidelines de verificação em dobro / conflito com escada do projeto** — a injetada do in-turn (`agent-session.ts:3806-3814`) manda rodar o gate completo e coexiste com a genérica (`system-prompt.ts:422-426`); ignora escadas tipo a do AGENTS.md do Pit ("não rode o gate por edit").
- **Lote misto reordena sem aviso** — paralelo roda antes de sequencial (`message`/`debug`), documentado só no código (`agent-loop.ts:1670-1724`). 1 frase no prompt/descrições, ou partição em segmentos.
- ✅ **Primeiro user message imortal** — N5 pula `i === firstUserIndex` sem teste de tamanho (`prune.ts:1027-1040`); paste de 40k na abertura viaja em todo request. Aplicar N5 acima de ~3× o threshold.
- ✅ **Cold-start** — `await claudeCodeVersionReady` antes do dispatch (`main.ts:905`) segura o primeiro paint em cache-miss (~3s). Mover para a fronteira do primeiro request de modelo.
- **Sem teto agregado por rodada** — caps por chamada existem (`tools/truncate.ts:47-55`), mas 8 reads de 50KB numa rodada = ~120k tokens de uma vez, pulando o precompute direto para compaction síncrona. Caps progressivos dentro da rodada.
- ✅ **Cap agregado corta o mais específico primeiro** — ordem global→cwd (`context-files.ts:112-130` + `resource-loader.ts:163-167`) faz o AGENTS.md do projeto virar ponteiro primeiro. Consumir budget na ordem inversa.
- ✅ **`emitToolCall` roda ~15 guards em série** (`extensions/runner.ts:1067-1092`) quando `markSideEffect`/`hasMutatingHandlers` já existem. Paralelizar observers; serializar só mutantes.
- ✅ **`/compact` manual nunca consome o slot especulativo** — `consumeSpeculativeCompaction` tem um único call site (auto, `agent-session-compaction.ts:1543`); resumo pronto é descartado e a chamada LLM paga de novo.
- **`frequent_files` + `grounded_context` duplicam paths** no mesmo `<env>` quando ambos ativos (~100-150 tokens/request). Suprimir a lista quando o outline existe.

## Quick wins (~1 linha cada) — ✅ todos implementados (2026-07-31)

> Dois achados da implementação: (a) o wire schema default (`compactToolsForProviderContext`)
> trunca descriptions a 40 chars e remove descriptions de params — hints que precisam
> chegar ao modelo devem ir no `promptSnippet` ou em guideline (o dialeto do grep foi
> replicado no snippet por isso); (b) `allowPaths` é inerte nos DOIS modos (auto e plan)
> — decidir entre remover de vez ou manter como reserva para um tier "ask" futuro.

- `grep.pattern` sem dialeto declarado (`grep.ts:45`) → "Rust regex (ripgrep); escape `( ) [ {` ou use `literal: true`; sem lookaround".
- `docs/token-economy-tuning.md`: file:lines quebrados pós-refactor (aponta `compaction.ts:2440` etc.; arquivo tem 1339 linhas) e semântica de `PIT_NO_COMPACT_SUMMARY_OUTPUT` errada — ela gate `trimSummaryProseAgainstOperations` (`compaction.ts:1249`), não a injeção do resumo.
- Comentário "off by default" no doom-loop (`turn-steering-engine.ts:218`) — o default é ON (`settings-manager.ts`, `enabled !== false`).
- Branch morto de `allowPaths` no modo auto (`permissions/checker.ts:260-265`) + comentários em `types.ts:54,139` citando um prompt interativo inexistente.
- `PIT_NO_BATCH_PARTITION` desliga a especulação junto (`agent-loop.ts:1341`) sem doc — desacoplar ou documentar.
- Erro de tool desconhecida lista as 16 primeiras em ordem alfabética (`agent-loop.ts:1911-1913`), dominada por `chrome_devtools_*` — ordenar por proximidade.
- Podas de prefixo: instrução todo em 3 lugares (`system-prompt.ts:364-368` + `todo.ts:88-93`); "prefira tools ao bash" em 3 pontos; "common mistakes" do read (`read.ts:747-750`, bullet 3 já neutralizado em runtime pelo dedupe).
- Tier compact perde a cláusula "confirme que a lib é dependência" (`system-prompt.ts:404-406` está dentro de `!isCompact`) — o tier dos modelos que mais alucinam imports.
- Cabeçalho-instrução do `<frequent_files>` (~25 tokens, `frequent-files.ts:376-378`) repetido por request — encurtar.
- `project_config` só destila tsconfig/biome (`project-config-context.ts`) — adicionar prettier/editorconfig best-effort.

## Nuances (mitigação parcial já existe)

- **Âncoras stride:1 no read** (`read.ts:1289-1293`): custo real (~500 tokens/read com edit_v2), mas há cap de 2KB e stride dobra sob o budget; validar cobertura antes de mudar para stride 3.
- **Verify separado da compaction (≥80k)** (`summarize.ts:595`): redundância já mitigada uma vez (gate 25k→80k); próximo passo certo é telemetria de aceitação (`compaction.verify`), não outro ajuste cego.

## Lotes de implementação sugeridos

1. **Lote A** (mensagens/docs/1-linha, risco zero): P1-2 + quick wins.
2. **Lote B** (economia de tokens, precisa teste): P2-5, P2-6, primeiro-user N5, `/compact` especulativo.
3. **Lote C** (latência, invasivo): P1-3, P2-8, cold-start, `emitToolCall` paralelo.
4. **Lote D** (contexto/monorepo): P1-4, P2-7, cap invertido, P2-9.
