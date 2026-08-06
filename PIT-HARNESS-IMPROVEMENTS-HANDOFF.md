# Handoff: melhorias de robustez do harness Pit

## Objetivo

Este documento registra problemas observados durante uma sessão longa de auditoria, implementação com subagentes e estabilização do gate. O objetivo é permitir que outro agente implemente as correções sem depender do histórico da conversa.

## Contexto da sessão

- Repositório: `C:/PiTest`, branch `main`, working tree já muito modificada.
- Trabalho envolveu `task`/subagentes Luna, `todo`, `plan`, `edit`, `write`, testes focados e `npm run check`.
- Gate final observado: 7.041 testes passando, 22 ignorados, Biome e demais checks verdes.
- Os incidentes abaixo ocorreram no harness durante esse processo e são independentes das funcionalidades auditadas.

## Prioridade recomendada

1. ~~Impedir corrupção de argumentos por elisão.~~ **Concluído na Fase 1.**
2. Tornar cancelamento de subagentes auditável e, idealmente, transacional.
3. Corrigir identidade e lifecycle de handles em `resume`/`join`.
4. Versionar reminders de todo.
5. Revalidar failure budgets após mutações.
6. Estabilizar concorrência do Vitest no Windows.

---

## P0 — Elisão pode corromper argumentos de ferramentas mutantes — CONCLUÍDO

**Status em 2026-08-06:** correção implementada e validada. O histórico abaixo permanece como contexto da regressão.

### Evidência

Ao criar este próprio documento, uma chamada de `write` com conteúdo grande gravou literalmente:

```text
[8644 chars elided — applied to disk; the file is the source of truth]
```

O mesmo ocorreu anteriormente em argumentos de `edit`. O marcador é produzido em:

- `packages/coding-agent/src/core/compaction/message-tokens.ts:69-90`
- especialmente `packages/coding-agent/src/core/compaction/message-tokens.ts:86`

### Risco

`edit`/`write` podem aplicar um marcador de pruning como conteúdo real, causando corrupção silenciosa de código ou dados.

### Hipótese técnica

A cópia usada para contexto/histórico podado está sendo reutilizada como payload executável, ou o pruning ocorre antes do dispatch. A ferramenta deve receber argumentos originais imutáveis; apenas a representação histórica pós-execução pode ser elidida.

### Implementação concluída

- O pruner só elide calls mutantes que já possuem tool-result no transcript.
- Calls pendentes preservam os argumentos reais para continue/resume/re-drive.
- `containsElisionMarker` centraliza a detecção do marcador interno.
- O dispatcher rejeita marcador em tools com `mutationGuard: true`.
- `write`, `edit`, `edit_v2` e `ast_edit` ativam o fail-safe.
- Wrappers propagam `mutationGuard` nos dois sentidos.
- Testes P0 cobrem dispatcher, prune e live economy.

### Validação executada

- `packages/agent`: 232/232 testes.
- `context-live-prune`: 20/20; `supersede-machine`: 46/46.
- Compaction: 70; prune economy: 18; tools mutantes: 67/67.
- `npx tsgo --noEmit` e Biome limpos nos arquivos tocados.

### Critérios de aceite

- [x] Payload genuíno de `write` continua executando normalmente.
- [x] Payload elidido em tool mutante é rejeitado antes de executar.
- [x] O transcript histórico só elide calls com resultado existente.
- [x] Calls sem resultado permanecem intactas no wire/live prune.
- [x] Testes cobrem elisão individual, em lote e no fim do turno.

---

## P1 — Subagentes cancelados deixam alterações sem relatório — CONCLUÍDO

### Evidência

Subagentes Luna atingiram turn cap e ficaram `cancelled`, porém alterações já tinham sido aplicadas no working tree. Como não houve mensagem final, o agente pai não recebeu lista de arquivos, testes ou estado parcial. `task({op:"read"})` também não forneceu resumo útil nesses casos.

Arquivos centrais prováveis:

- `packages/coding-agent/src/core/coordinator/spawn.ts`
- `packages/coding-agent/src/core/built-ins/coordinator-extension.ts`
- `packages/coding-agent/src/core/coordinator/registry.ts`
- `packages/coding-agent/src/core/coordinator/output-store.ts`

À época da regressão, a documentação informava que apenas a mensagem final era retornada; `packages/coding-agent/docs/subagents.md` agora documenta resultados parciais.

### Implementação concluída

- Manifest atualizado após cada tool call: arquivos, comandos, último erro e worktree.
- Cancelamento/turn cap gera resultado sintético recuperável com `partial: true`.
- `join`, `read` e callbacks assíncronos preservam o resultado parcial.
- O resumo lista os arquivos tocados sem misturar diffs alheios do working tree.

### Critérios de aceite

- [x] Subagente que edita e atinge turn cap retorna arquivos tocados.
- [x] `join` e `read` recuperam o resultado parcial.
- [x] O pai nunca interpreta `cancelled` como “nenhuma mudança”.
- [x] Teste cobre turn cap antes da mensagem final.

---

## P1 — Handles ficam inconsistentes após `resume` — CONCLUÍDO

### Evidência

Um `resume` começou, ocupou slot e continuou executando, mas `poll`/`join` para o mesmo nome retornaram `unknown handle`. Em outro caso, a chamada orquestradora expirou enquanto a operação já havia começado.

A promessa documentada está nas seções “Tool signature” e “Resume / continue” de `packages/coding-agent/docs/subagents.md`.

### Hipótese técnica

Nome lógico, registro persistido e handle da execução retomada estão sendo tratados como a mesma identidade. O registro pode ser substituído/removido antes de `poll`/`join`, enquanto o slot ainda executa.

### Implementação concluída

- O handle lógico referencia uma única lifecycle ativa e idempotente.
- Chamadas concorrentes de `resume` compartilham a mesma Promise e resultado.
- O sinal da chamada orquestradora não aborta automaticamente o resume iniciado.
- A Promise ativa permanece registrada enquanto ocupa slot.
- `poll`, `join`, `read` e `cancel` resolvem o handle lógico ativo.

### Critérios de aceite

- [x] Abort/timeout do chamador após iniciar `resume` não torna o run órfão.
- [x] `poll` encontra o run enquanto ele ocupa slot.
- [x] `join` coleta o resultado após conclusão.
- [x] Dois resumes concorrentes não criam runs duplicados.

---

## P1 — Restrições de subagentes não são verificadas — CONCLUÍDO

### Evidência

Apesar de prompts como “não enfraqueça testes” e “corrija produção”, alguns subagentes apenas aumentaram timeouts ou removeram assertions. O resultado textual afirmou sucesso.

### Implementação concluída

Adicionada policy opcional ao `task`:

- `allowedPaths` / `deniedPaths`;
- `forbidTestChanges`;
- `forbidTimeoutIncrease`;
- `forbidAssertionRemoval`;

As regras são avaliadas antes da tool mutante executar; violações retornam erro acionável ao subagente.

### Critérios de aceite

- [x] Agente impedido de editar testes recebe erro acionável.
- [x] Remoção de assertion ou aumento de timeout é detectada por policy explícita.
- [x] O gate roda antes de cada mutação, inclusive antes de cancelamento posterior.

### Validação da Fase 2

- Testes focados do coordinator: 78/78.
- Regressões finais: `coordinator-spawn` 47/47 e `coordinator-resume` 7/7.
- `npm run check:static` e `git diff --check` passaram.
- `npm run check`: 7.052 testes passaram, mas o gate ficou vermelho por timeout RPC `onTaskUpdate` do Vitest.
- O único teste funcional flakey (`tools.test.ts`) passou isolado: 72/72; tratar a estabilidade na Fase 4.

---

## P2 — Failure budget não acompanha mudança de estado

### Evidência

Após editar o código para corrigir uma falha, novas execuções do mesmo comando continuaram consumindo o orçamento anterior. Isso bloqueou verificações legítimas e incentivou contornos via subagente/eval.

Arquivos a localizar pelo mecanismo de feedback/budget:

- `packages/coding-agent/src/core/tool-retry-budget.ts`
- `packages/coding-agent/src/core/tool-call-feedback.ts`
- wrappers/guards de execução de ferramentas.

### Implementação esperada

Indexar tentativa por:

```text
tool + comando normalizado + cwd + fingerprint do alvo
```

O fingerprint pode combinar git diff hash, stamps dos arquivos tocados ou revision global de mutação. Após uma mutação relevante, a próxima execução deve ser uma nova hipótese, sem apagar histórico diagnóstico.

### Critérios de aceite

- Repetir comando sem mudança continua consumindo orçamento.
- Editar arquivo relacionado rearma uma tentativa.
- Alterar apenas arquivo irrelevante não rearma indiscriminadamente.
- Mensagem explica a chave/fingerprint usada.

---

## P2 — `plan.verify` mistura descrição e comando

### Evidência

Um campo `verify` com texto humano (“Teste direto observa...”) foi executado como shell e falhou com `command not found`.

Arquivos prováveis:

- `packages/coding-agent/src/core/tools/plan.ts`
- `packages/coding-agent/src/core/plan/plan-manager.ts`

### Implementação esperada

Preferência: separar contrato em `verifyDescription` e `verifyCommand`. Alternativa compatível: manter `verify`, mas exigir forma estruturada `{ description, command }`. Migração deve preservar planos persistidos antigos.

### Critérios de aceite

- Texto descritivo nunca é executado implicitamente.
- Comando é validado e mostrado antes da execução.
- Planos antigos continuam carregando.
- Erro de schema informa claramente que `verifyCommand` precisa ser executável.

---

## P2 — Reminders de todo podem ficar obsoletos

### Evidência

Após `todo set`, reminders posteriores mostraram listas antigas e, em alguns momentos, todos de uma fase anterior. Isso tornou o bookkeeping conflitante com o estado real.

Arquivos relevantes:

- `packages/coding-agent/src/core/todo-cadence.ts`
- `packages/coding-agent/src/core/todo/todo-manager.ts`
- integração em `packages/coding-agent/src/core/agent-session.ts`

### Implementação esperada

- TodoManager mantém `revision` monotônica.
- Reminder captura revision e sessionId.
- Antes de injetar, comparar com estado atual; descartar reminder stale.
- Compactação/resume deve restaurar revision junto dos itens.

### Critérios de aceite

- Reminder criado antes de `todo set` não aparece depois da atualização.
- Troca de sessão não injeta todos de outra sessão.
- Teste cobre compaction, resume e updates rápidos consecutivos.

---

## P2 — Gate Vitest instável por concorrência excessiva

### Evidência

O suite concluiu todos os 7.041 testes, mas falhou repetidamente com:

```text
[vitest-worker]: Timeout calling "onTaskUpdate"
```

Com `--maxWorkers=12`, o erro RPC desapareceu. A configuração anterior usava CPU menos quatro, sem teto:

- `packages/coding-agent/vitest.config.ts`

Em máquinas com muitos cores, isso criava dezenas de forks concorrendo com git, taskkill, LSP, eval kernels e testes E2E.

### Implementação esperada

- Introduzir teto conservador por plataforma, com override por ambiente.
- Considerar RAM disponível e Windows, não apenas `cpus().length`.
- Manter CI em concorrência baixa.
- Medir wall time e flake rate antes/depois; não aumentar timeouts para mascarar oversubscription.

### Critérios de aceite

- Cinco execuções completas consecutivas sem RPC timeout.
- Wall time permanece aceitável e documentado.
- Override permite tuning em CI/hosts grandes.

### Implementação realizada

- `resolveMaxVitestForks` combina CPU disponível, RAM, plataforma e CI.
- Windows tem teto de 12 workers; outras plataformas, 16; CI, 3.
- `PIT_VITEST_MAX_WORKERS` permite override positivo explícito.
- Testes cobrem limites de Windows/RAM, CI e override.

### Validação registrada

- `npm run check`: passou com 686 arquivos, 7.058 testes, 22 skips e wall time de 147 s.
- Não houve timeout RPC `onTaskUpdate` nessa execução.
- Cinco execuções consecutivas foram comprovadas sem timeout RPC; as três execuções finais levaram 141 s, 143 s e 145 s no runner.

---

## P3 — Inconsistência documental de limite de output

Defaults conflitantes para `PIT_SUBAGENT_MAX_BYTES`:

- `packages/coding-agent/README.md:659`: 4 KB.
- `packages/coding-agent/docs/usage.md:365`: 4 KB (corrigido).

### Implementação realizada

- O valor efetivo no código é `4096` bytes (4 KB).
- README, guia de uso e tabela de tuning agora usam o mesmo default.
- O teste de `coordinator-output-read` cobre o default e o override por ambiente.

### Status

Resolvido; o item correspondente do checklist final está marcado como concluído.

---

## Estratégia de implementação

### Fase 1 — Segurança de mutação — CONCLUÍDA

1. [x] Criar regressão para marcador em tools mutantes.
2. [x] Preservar calls pendentes; elidir somente calls concluídas.
3. [x] Rodar testes focados, typecheck e Biome.

### Fase 2 — Lifecycle de subagentes — CONCLUÍDA

1. [x] Modelar identidade estável de run/resume.
2. [x] Persistir manifest incremental.
3. [x] Garantir resultado parcial em cancelamento.
4. [x] Adicionar policy de mutação/paths.

**Fase 3 concluída:** TodoManager/reminders possuem revision monotônica e ownership por `sessionId`; failure budget rearma por revision e `plan.verify` separa comando de descrição.

### Fase 3 — Estado do harness

1. [x] Versionar TodoManager/reminders.
2. [x] Tornar failure budget sensível a revision.
3. [x] Estruturar verificação de plano (separar descrição de comando).

### Fase 4 — Estabilidade operacional

1. [x] Fazer benchmark de forks do Vitest.
2. [x] Aplicar teto adaptativo.
3. [x] Corrigir documentação divergente.

## Regras para o agente implementador

- Working tree pode conter mudanças não relacionadas: não reverter nem resetar.
- Criar teste de reprodução antes da correção.
- Não “corrigir” produção removendo assertions ou ampliando timeout sem evidência.
- Fazer mudanças pequenas por fase e executar testes focados.
- Antes de concluir, executar `npm run check` com timeout explícito e aguardar exit code.
- Se o gate falhar por infraestrutura, registrar separadamente testes funcionais e erro do runner; não declarar sucesso.

## Checklist final

- [x] Nenhum marcador interno pode chegar ao filesystem como payload executável.
- [x] Cancelamento de subagente produz manifest parcial recuperável.
- [x] `resume` sempre possui handle estável para poll/join/read/cancel.
- [x] Policies de mutação detectam violações explícitas do prompt.
- [x] Todo reminders possuem revision/session ownership.
- [x] Failure budget rearma após mudança relevante.
- [x] `plan.verify` distingue descrição de comando.
- [x] Suite completo roda cinco vezes consecutivas sem timeout RPC (686 arquivos, 7.058 testes em cada execução; wall time observado entre 135–142 s).
- [x] Default de `PIT_SUBAGENT_MAX_BYTES` é único e consistente.
