# Dispatch especulativo de tools read-only durante o streaming

> Status: **proposta** (não implementado). Origem: auditoria de latência de
> 2026-07-16 (a mesma rodada que produziu a seção "Latência do agente" em
> [token-economy-tuning.md](../token-economy-tuning.md)). Item classificado como
> o mais ambicioso da lista — impacto low-medium, risco medium — e por isso
> separado em proposta própria em vez de implementado junto com os demais.

## Problema

Hoje nenhum tool começa a executar antes do stream da resposta do assistant
terminar por completo, mesmo quando os argumentos do tool call já chegaram
inteiros no meio do stream.

Mecânica atual verificada:

- O provider Anthropic finaliza o JSON de argumentos e emite `toolcall_end`
  assim que o `content_block_stop` do bloco `tool_use` chega
  (`packages/ai/src/providers/anthropic.ts`, handler de `content_block_stop`;
  tools são enviadas com `eager_input_streaming: true`).
- O agent-loop, porém, apenas *observa* `toolcall_end`
  (`packages/agent/src/agent-loop.ts:903`) — usa o evento para render/registro
  e segue drenando o stream. A execução só começa depois de `done`
  (`agent-loop.ts:933`), quando `await response.result()` resolve
  (`agent-loop.ts:939`) e o chamador invoca `executeToolCalls`
  (dispatch em `agent-loop.ts:1039–1055`, com os caminhos
  `executeToolCallsSequential` / `executeToolCallsParallel` /
  `executeToolCallsPartitioned`).

O custo é o gap de wall-clock entre o primeiro `toolcall_end` e o `done` final.
Para a Anthropic os blocos `tool_use` tendem a se agrupar no fim da mensagem,
então o gap costuma ser pequeno — mas cresce em turnos multi-bloco: vários
`tool_use` em sequência, texto trailing depois do tool call, ou thinking
intercalado. Nesses turnos, um `read`/`grep` poderia ter rodado inteiro dentro
da janela em que o modelo ainda estava emitindo o resto da mensagem.

## Proposta

Ao receber `toolcall_end` de um tool **comprovadamente livre de efeitos
colaterais**, iniciar a execução especulativamente, em paralelo com o restante
do stream, e fazer o *join* dos resultados no `done` — descartando tudo se o
turno for interrompido/abortado.

### O que pode ser especulado

Apenas tools com metadado explícito de leitura. A infraestrutura já existe:

- `executionMode?: ToolExecutionMode` em `packages/agent/src/types.ts:568`
  (usado hoje pelo particionamento de lotes mistos).
- `readOnly: boolean` no catálogo do coding-agent
  (`packages/coding-agent/src/core/tools/index.ts:192`).

Proposta de gate: especular somente quando `readOnly === true` **e**
`executionMode !== "sequential"`. Na prática: `read`, `grep`, `find`, `ls`,
`symbol`/`find_symbol` e afins. Tools mutantes (`edit`, `write`, `bash`),
sequenciais (`debug`, `message`) e qualquer tool sem metadado ficam de fora —
o default é NÃO especular (fail-closed).

O flag `readOnly` vive hoje no catálogo do coding-agent, não no tipo
`AgentTool` do pacote `agent`. O gate do agent-loop precisa de um campo no
próprio tool (ex.: `speculationSafe?: boolean` em `AgentTool`, preenchido pelo
coding-agent a partir do `readOnly` do catálogo) — o pacote `agent` não deve
conhecer o catálogo do coding-agent (invariante de camadas).

### Desenho

1. **Início**: no handler de `toolcall_end` (`agent-loop.ts:903`), se o gate
   permite, validar argumentos + aplicar rewrite registry + `beforeToolCall`
   (pipeline de extensões/permissions) e iniciar a execução, guardando a
   promise num mapa `speculative: Map<toolCallId, Promise<ToolResult>>`.
2. **Join**: quando `done` chega e `executeToolCalls` roda, cada caminho
   (parallel/partitioned/sequential) consulta o mapa antes de executar: hit →
   `await` da promise já em andamento; miss → executa como hoje. A emissão de
   `message_start`/`message_end` dos resultados **não muda**: continua na ordem
   original das calls, no mesmo lugar de hoje (a especulação antecipa o
   *trabalho*, nunca a *emissão*).
3. **Descarte**: se o stream termina em interrupt (TTSR `agent-loop.ts:435`,
   overthink `agent-loop.ts:454`) ou abort, as promises especulativas são
   abortadas via o mesmo `AbortSignal` do turno e os resultados descartados
   sem emissão. Tools read-only por definição não deixam estado para desfazer.

### Restrições de segurança (obrigatórias)

- **Interrupts TTSR/overthink**: esses caminhos descartam a mensagem *depois*
  de `toolcall_end` já ter disparado. A especulação precisa ser cancelável e o
  descarte não pode emitir nada — nem resultado, nem erro. O retry do turno
  (TTSR reminder) reexecuta do zero.
- **Permissions/`beforeToolCall` antecipados**: o pipeline de `tool_call` roda
  no início da especulação, ou seja, *antes* do fim do stream. Handlers que
  assumem "a mensagem do assistant está completa quando o hook roda" quebram.
  Auditar os handlers embutidos (grounding-guard, intent-gate, permissions,
  read-guard) antes de ligar; nenhum dos hot-path handlers verificados na
  auditoria de 2026-07-16 lê a mensagem completa, mas extensões de terceiros
  podem. Mitigação: rodar o pipeline de novo no join se qualquer extensão
  não-embutida estiver registrada (ou gate: especular só com extensões
  embutidas).
- **Dedupe de reads**: o `ReadDedupeStore` registra reads no execute. Execução
  especulativa descartada (interrupt) NÃO pode registrar dedupe nem mtime
  stamps — mover os registros para o ponto de join/emissão, ou usar staging.
- **Interação com o particionamento** (`PIT_NO_BATCH_PARTITION`): a
  especulação é um refinamento do subconjunto parallel-safe; o subconjunto
  sequencial nunca especula. Sem conflito estrutural, mas os testes de ordem de
  emissão do particionamento cobrem também o caminho especulativo.
- **Sem especulação em lote com `forceSequential`**: preserva o contrato atual.

### Kill-switch

`PIT_NO_SPECULATIVE_DISPATCH=1` — desativa por completo (comportamento atual).
Nativo/on-by-default no restante, seguindo a convenção do projeto. Documentar
em `docs/token-economy-tuning.md` na seção "Latência do agente" quando
implementado.

## Fases sugeridas

1. **Fase 0 — telemetria**: medir o gap real `primeiro toolcall_end → done`
   por turno (timings já existem em `core/timings.ts`) e a fração de turnos
   multi-bloco. Se o p50 do gap for < ~50ms no uso real, parar aqui — o ganho
   não paga a complexidade. Critério de go: p50 > 100ms em turnos com ≥ 2 tool
   calls, ou p90 > 300ms.
2. **Fase 1 — read/grep/find/ls apenas**, com extensões de terceiros
   desativando a especulação automaticamente.
3. **Fase 2 — reavaliar** a lista de tools e a re-execução do pipeline de
   permissions no join, com base na telemetria da fase 1.

## Testes necessários

- Especulação hit: `toolcall_end` de read no meio do stream → resultado pronto
  no `done`, emissão na ordem original, conteúdo idêntico ao caminho normal.
- Interrupt TTSR/overthink com especulação em voo → nada emitido, dedupe/mtime
  não registrados, retry do turno reexecuta limpo.
- Abort do usuário durante especulação → promise abortada, sem vazamento.
- Lote misto (read especulado + edit + message) → partição intacta, ordem de
  emissão intacta.
- Kill-switch restaura o comportamento atual byte a byte.
- Extensão de terceiros registrada em `tool_call` → especulação desligada
  (fase 1) ou pipeline re-executado no join (fase 2).

## Impacto esperado

- **Ganho**: latência de um tool read-only por turno multi-bloco (dezenas a
  centenas de ms quando o modelo emite texto/thinking após o tool call).
  Zero ganho em turnos de tool call único no fim da mensagem (o caso mais
  comum hoje na Anthropic) — por isso a fase 0 de telemetria decide.
- **Risco**: medium — os interrupts (TTSR/overthink) e o timing dos hooks são
  os pontos delicados; ambos têm mitigação descrita acima.
- **Complexidade**: concentrada no agent-loop; nenhum tool precisa mudar.
